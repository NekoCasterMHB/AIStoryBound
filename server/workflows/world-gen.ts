// server/workflows/world-gen.ts
// 云端世界生成任务执行器(Cloudflare Workflows):
//  - 每个提取单元一个 step(自动重试/重放),合并结果与成书 overlay 走 R2 scratch;
//  - 取消:API 端点把任务行置 cancelled 后调用 env.WORLD_GEN.get(taskId).terminate(),
//    各步骤入口的 assertNotCancelled 兜底提前终止;
//  - 失败:run 顶层 catch 统一 markTaskFailed(置状态 + 按实耗结算 + 清 key 暂存);
//  - 部署重置自愈:代码更新会重置正在运行的实例(DO 内存清零,持久化数据不受影响),
//    catch 识别该错误后自动另起新实例续跑(已完成单元从 world_gen_units 跳过),而非判失败。
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import {
  createWorldGenCtx, extractUnitAt, isDeployResetError, markTask, markTaskFailed, markTaskPaused, stepAuthorAi,
  stepCheck, stepEnabled, stepFinalize, stepMerge, stepParseAndPlan, stepSupplementArcs, stepSynthesize, requireTask,
  WorldGenCancelledError, InsufficientTokensError, EXTRACT_CONCURRENCY
} from '../utils/world-gen-pipeline'
import type { WorldGenEnv } from '../utils/world-gen-pipeline'

export interface WorldGenWorkflowParams {
  taskId: string
}

export class WorldGenWorkflow extends WorkflowEntrypoint<Env, WorldGenWorkflowParams> {
  async run(event: WorkflowEvent<WorldGenWorkflowParams>, step: WorkflowStep): Promise<void> {
    const env = this.env as unknown as WorldGenEnv
    const ctx = createWorldGenCtx(env, event.payload.taskId)

    try {
      const task = await requireTask(ctx)
      if (task.status === 'cancelled') return
      await markTask(ctx, { status: 'running', error: null })

      // arcs 任务(补充配角故事线):单个步骤生成全部候选角色弧线,完成后实例结束
      if (task.kind === 'arcs') {
        await step.do('supplement-arcs', {
          retries: { limit: 1, delay: '10 second' }
        }, () => stepSupplementArcs(ctx))
        return
      }

      // 1) 解析(编码/清洗/书名页作者正则)+ 2) 切段计划(两个纯代码步合成一个)
      const { parsed, plan } = await step.do('parse-plan', {
        retries: { limit: 3, delay: '5 second', backoff: 'exponential' }
      }, () => stepParseAndPlan(ctx))

      // 3) 分块提取:author 识别(开关开启且正则未命中时)与第一批并发,后续批次并发 4 分批
      //    (每单元独立 step,重试互不影响)
      const firstBatch = plan.units.map((_, i) => i).slice(0, EXTRACT_CONCURRENCY)
      await Promise.all([
        ...(parsed.author || !stepEnabled(task, 'author')
          ? []
          : [
              step.do('author-ai', { retries: { limit: 1, delay: '5 second' } }, () => stepAuthorAi(ctx))
            ]),
        ...firstBatch.map(i =>
          step.do(`extract-unit-${i + 1}`, {
            retries: { limit: 2, delay: '10 second', backoff: 'exponential' }
          }, () => extractUnitAt(ctx, plan, i))
        )
      ])
      for (let start = firstBatch.length; start < plan.units.length; start += EXTRACT_CONCURRENCY) {
        const batch = plan.units.map((_, i) => i).slice(start, start + EXTRACT_CONCURRENCY)
        await Promise.all(batch.map(i =>
          step.do(`extract-unit-${i + 1}`, {
            retries: { limit: 2, delay: '10 second', backoff: 'exponential' }
          }, () => extractUnitAt(ctx, plan, i))
        ))
      }

      // 5) 合并 + 引用校验 + 故事线(纯代码;失败率过高在此抛出;传入切段计划防 stage_detail 被进度更新覆盖)
      await step.do('merge', {
        retries: { limit: 3, delay: '10 second', backoff: 'exponential' }
      }, () => stepMerge(ctx, plan))

      // 6) 一致性检查(开关开启时;失败降级为告警,不中止)
      if (stepEnabled(task, 'check')) {
        await step.do('check', { retries: { limit: 1, delay: '10 second' } }, () => stepCheck(ctx))
      }

      // 7) 成书(瞬时错误由 step 重试兜底;custom 关润色时内部走轻量成书)
      await step.do('synthesize', {
        retries: { limit: 3, delay: '15 second', backoff: 'exponential' }
      }, () => stepSynthesize(ctx))

      // 7.5) 配角独立故事线(开关开启时;逐单元生成,写 scratch 供 finalize 落盘;失败降级不中止)
      if (stepEnabled(task, 'arcs')) {
        await step.do('supplement-arcs', { retries: { limit: 1, delay: '10 second' } }, () => stepSupplementArcs(ctx))
      }

      // 8) 落 R2 缓存 + 入库 + 结算 + 清 key/scratch
      await step.do('finalize', {
        retries: { limit: 3, delay: '5 second', backoff: 'exponential' }
      }, () => stepFinalize(ctx))
    } catch (e) {
      if (e instanceof WorldGenCancelledError) return
      if (e instanceof InsufficientTokensError) {
        // 余额不足:任务转 paused(进度/单元明细保留),充值后在书架手动续跑,这里正常结束实例
        await markTaskPaused(ctx, e.message).catch(() => {})
        return
      }
      // 部署新代码会重置正在运行的 Workflow 实例(DO 内存清零,持久化数据不受影响)。
      // 管线步骤全部幂等,自动另起新实例续跑(已完成单元从 world_gen_units 跳过),而非判失败。
      if (isDeployResetError(e instanceof Error ? e.message : String(e))) {
        console.warn('[world-gen workflow] 实例因代码更新被重置,自动续跑', { taskId: event.payload.taskId })
        const newInstanceId = `${event.payload.taskId}-r${Date.now()}`
        try {
          await this.env.WORLD_GEN.create({ id: newInstanceId, params: { taskId: event.payload.taskId } })
        } catch (restartErr) {
          // 续跑实例创建失败(罕见):交给轮询自愈/孤儿清扫兜底,不再重复尝试
          console.error('[world-gen workflow] 自动续跑创建实例失败', { taskId: event.payload.taskId }, restartErr)
          await markTaskFailed(ctx, '任务执行被部署更新中断,自动恢复失败;请在书架取消后重新上传').catch(() => {})
        }
        return
      }
      console.error('[world-gen workflow] 任务失败', { taskId: event.payload.taskId }, e)
      await markTaskFailed(ctx, e instanceof Error ? e.message : String(e)).catch(() => {})
    }
  }
}
