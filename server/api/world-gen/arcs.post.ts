// server/api/world-gen/arcs.post.ts
// 创建「补充生成配角故事线」云端任务(JSON 体):
//   { workId, title, entities, storyline, config? }
// 流程:候选角色预检 → 服务端估算 token → 平台模式余额预检(不预扣)→ 插任务行(kind=arcs,
// sourceWorkId + payload 暂存输入)→ 启动 Workflow 逐单元生成(每单元原子扣费,余额不足暂停)。
// 用户自建 key:格式校验 + 指纹准入(与 /api/ai/chat 同门槛)→ AES-GCM 加密暂存到任务行,
// 任务终态即清空;用户 key 模式不扣平台额度、只记账。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { user as usersTable, aiConfigVerifications, worldGenTasks } from '../../db/schema'
import { uuid } from '../../../shared/novel'
import type { StoryBeat, WorldEntities } from '../../../shared/novel'
import { isAiApiFormat } from '../../../shared/ai-config'
import { estimateMessagesTokens } from '../../../shared/token-estimate'
import { buildCharacterArcMessages, characterArcCandidates } from '../../../shared/world-build'
import { encryptJson } from '../../utils/crypto'
import { aiConfigFingerprint } from '../../utils/ai-fingerprint'
import { ARCS_UNIT_OUTPUT_RESERVE } from '../../utils/world-gen-pipeline'
import { startWorldGenTask } from '../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../utils/world-gen-dto'

interface ArcsConfigBody {
  format?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

interface ArcsCreateBody {
  workId?: string
  title?: string
  entities?: unknown
  storyline?: unknown
  /** 全书正文(chapters.join('\n');用于登场段原文窗口,可选) */
  text?: string
  config?: ArcsConfigBody
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const body = await readBody<ArcsCreateBody>(event).catch(() => ({} as ArcsCreateBody))

  const workId = typeof body.workId === 'string' && body.workId.trim() ? body.workId.trim() : ''
  if (!workId || workId.length > 128) throw createError({ statusCode: 400, statusMessage: '缺少有效的本地作品 id' })
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  const entities = (body.entities ?? null) as WorldEntities | null
  const storyline = Array.isArray(body.storyline) ? body.storyline as StoryBeat[] : null
  if (!entities || !Array.isArray(entities.characters)) throw createError({ statusCode: 400, statusMessage: '缺少有效的实体库(entities)' })
  if (!storyline) throw createError({ statusCode: 400, statusMessage: '缺少有效的主线故事线(storyline)' })

  // 候选角色预检(与管线同一名单)
  const candidates = characterArcCandidates(entities, storyline)
  const totalUnits = candidates.length
  if (totalUnits === 0) {
    throw createError({ statusCode: 400, statusMessage: '故事线中没有登场两次以上的角色,无需生成配角故事线' })
  }

  const db = useD1(event)

  // ---- 自建 key:格式校验 + 指纹准入 → AES-GCM 加密暂存(与 /api/ai/chat 用户模式同一门槛) ----
  let escrow: { ciphertext: string, iv: string } | null = null
  const cfg = body.config
  if (cfg?.baseUrl && cfg?.apiKey) {
    if (!isAiApiFormat(cfg.format)) throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
    const normalized = {
      format: cfg.format,
      baseUrl: String(cfg.baseUrl).trim(),
      apiKey: String(cfg.apiKey).trim(),
      model: String(cfg.model || '').trim()
    }
    if (!/^https:\/\/.+/i.test(normalized.baseUrl) || !normalized.model) {
      throw createError({ statusCode: 400, statusMessage: '自建配置无效(baseUrl 必须 https、model 必填)' })
    }
    const fingerprint = await aiConfigFingerprint(event, sessUser.id, normalized)
    const verified = await db.select({ id: aiConfigVerifications.id })
      .from(aiConfigVerifications)
      .where(and(eq(aiConfigVerifications.userId, sessUser.id), eq(aiConfigVerifications.fingerprint, fingerprint)))
      .get()
    if (!verified) {
      throw createError({ statusCode: 400, statusMessage: '配置未验证或已变更,请到个人中心重新测试后再使用' })
    }
    escrow = await encryptJson(event, { baseUrl: normalized.baseUrl, apiKey: normalized.apiKey, model: normalized.model })
  }

  // ---- 平台模式:余额充足性预检(不预扣;真实消耗在管线中逐单元原子扣费,余额不足任务暂停) ----
  const inputTokens = estimateMessagesTokens(buildCharacterArcMessages(title || '小说', candidates[0]!, storyline))
  const estimatedTokens = Math.max(1, (inputTokens + ARCS_UNIT_OUTPUT_RESERVE) * totalUnits)
  if (!escrow) {
    const me = await db.select({ aiTokenBalance: usersTable.aiTokenBalance })
      .from(usersTable)
      .where(eq(usersTable.id, sessUser.id))
      .get()
    if (!me || (me.aiTokenBalance ?? 0) < estimatedTokens) {
      throw createError({
        statusCode: 402,
        statusMessage: `token 余额不足以支撑本次生成的预估消耗(约 ${estimatedTokens.toLocaleString()}),请到个人中心购买加油包或使用自己的 API Key`
      })
    }
  }

  // ---- 建任务行 ----
  const taskId = uuid()
  const now = new Date()
  const payloadText = typeof body.text === 'string' ? body.text.slice(0, 10_000_000) : undefined
  await db.insert(worldGenTasks).values({
    id: taskId,
    userId: sessUser.id,
    kind: 'arcs',
    sourceWorkId: workId,
    payload: JSON.stringify({ entities, storyline, ...(payloadText ? { text: payloadText } : {}) }),
    status: 'uploaded',
    stage: 'arcs',
    stageDetail: JSON.stringify({ doneUnits: 0, totalUnits }),
    sourceHash: '',
    sourceKey: '',
    fileSize: 0,
    title,
    mode: 'full',
    keySource: escrow ? 'user' : 'platform',
    keyCiphertext: escrow?.ciphertext ?? null,
    keyIv: escrow?.iv ?? null,
    estimatedTokens,
    reserveTaken: 0,
    tokensUsed: 0,
    warnings: '[]',
    createdAt: now,
    updatedAt: now
  }).run()

  // ---- 启动执行:Workflow binding 优先;无 binding(本地 dev)时内联兜底 ----
  const started = await startWorldGenTask(event, taskId)
  console.info('[world-gen] 配角故事线任务已启动', { taskId, workId, totalUnits, started })

  const row = await db.select().from(worldGenTasks).where(eq(worldGenTasks.id, taskId)).get()
  return { task: row ? worldGenTaskToDTO(row) : null }
})
