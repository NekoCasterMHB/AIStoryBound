// server/api/world-gen/upload.post.ts
// 上传原文并创建云端世界生成任务(multipart):
//   file=<txt> & mode=full|eco & charCount=<客户端解析字数> & config=<可选自建配置 JSON>
// 流程:服务端重算 sha-256 → R2 按 hash 去重存原文 → 平台模式预授权扣费 → 建任务行 → 启动 Workflow。
// 自建 key:格式校验 + 指纹准入(与 /api/ai/chat 同门槛)→ AES-GCM 加密暂存到任务行,
// 任务终态即清空(clearTaskKey / 孤儿清扫兜底);用户 key 模式不扣平台额度、只记账。
// 本地 dev(env.WORLD_GEN 缺失)回退 waitUntil 内联执行同一套管线,保证可调试。
import { and, eq } from 'drizzle-orm'
import { useD1 } from '../../utils/d1'
import { requireUser } from '../../utils/authz'
import { user as usersTable, aiConfigVerifications, worldGenTasks } from '../../db/schema'
import { uuid } from '../../../shared/novel'
import { estimateWorldGenTokens } from '../../../shared/world-gen-task'
import { isAiApiFormat } from '../../../shared/ai-config'
import { getSkillBucket } from '../../utils/r2'
import { encryptJson } from '../../utils/crypto'
import { aiConfigFingerprint } from '../../utils/ai-fingerprint'
import { worldSourceKey } from '../../utils/world-gen-pipeline'
import { startWorldGenTask } from '../../utils/world-gen-start'
import { worldGenTaskToDTO } from '../../utils/world-gen-dto'

const MAX_SOURCE_BYTES = 64 * 1024 * 1024

interface EscrowConfig {
  format?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export default defineEventHandler(async (event) => {
  const sessUser = await requireUser(event)
  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: '必须以 multipart 表单上传' })

  const filePart = parts.find(p => p.name === 'file')
  const mode = parts.find(p => p.name === 'mode')?.data.toString() === 'eco' ? 'eco' : 'full'
  const charCountRaw = Number(parts.find(p => p.name === 'charCount')?.data.toString())
  const configRaw = parts.find(p => p.name === 'config')?.data.toString()

  if (!filePart || !filePart.data?.length) {
    throw createError({ statusCode: 400, statusMessage: '缺少 txt 文件' })
  }
  if (filePart.data.length > MAX_SOURCE_BYTES) {
    throw createError({ statusCode: 413, statusMessage: '文件过大(超过 64MB),无法云端生成' })
  }

  const bytes = new Uint8Array(filePart.data)
  const hash = await sha256Hex(bytes)
  const title = (filePart.filename ?? '未命名').replace(/\.(txt|text)$/i, '').slice(0, 200) || '未命名'

  // ---- 自建 key:格式校验 + 指纹准入 + 加密暂存(与 /api/ai/chat 用户模式同一门槛) ----
  let escrow: { ciphertext: string, iv: string } | null = null
  if (configRaw) {
    let cfg: EscrowConfig
    try {
      cfg = JSON.parse(configRaw) as EscrowConfig
    } catch {
      throw createError({ statusCode: 400, statusMessage: 'config JSON 解析失败' })
    }
    if (cfg.baseUrl && cfg.apiKey) {
      if (!isAiApiFormat(cfg.format)) throw createError({ statusCode: 400, statusMessage: 'API 格式无效' })
      const normalized = {
        format: cfg.format,
        baseUrl: String(cfg.baseUrl).trim(),
        apiKey: String(cfg.apiKey).trim(),
        model: String(cfg.model || '').trim()
      }
      if (!/^https:\/\/.+/i.test(normalized.baseUrl)) {
        throw createError({ statusCode: 400, statusMessage: 'baseUrl 必须是 https 地址' })
      }
      if (normalized.baseUrl.length > 512 || normalized.apiKey.length > 256 || !normalized.model || normalized.model.length > 128) {
        throw createError({ statusCode: 400, statusMessage: '配置格式无效(baseUrl ≤512 / apiKey ≤256 / model 必填 ≤128)' })
      }
      const db = useD1(event)
      const fingerprint = await aiConfigFingerprint(event, sessUser.id, normalized)
      const verified = await db.select({ id: aiConfigVerifications.id })
        .from(aiConfigVerifications)
        .where(and(eq(aiConfigVerifications.userId, sessUser.id), eq(aiConfigVerifications.fingerprint, fingerprint)))
        .get()
      if (!verified) {
        throw createError({ statusCode: 400, statusMessage: '配置未验证或已变更,请到个人中心重新测试后再使用' })
      }
      escrow = await encryptJson(event, normalized)
    }
  }

  // ---- R2 存原文(按 hash 去重:同内容全站只存一份) ----
  const bucket = getSkillBucket(event)
  const sourceKey = worldSourceKey(hash)
  const existing = await bucket.head(sourceKey)
  if (!existing) {
    await bucket.put(sourceKey, bytes)
  }

  // ---- 平台模式:余额充足性预检(不预扣;真实消耗在管线中逐笔原子扣费,余额不足任务中止) ----
  const db = useD1(event)
  const chars = Number.isFinite(charCountRaw) && charCountRaw > 0
    ? Math.min(Math.round(charCountRaw), bytes.length) // 字符数不可能超过字节数,防客户端虚报
    : bytes.length
  const estimatedTokens = estimateWorldGenTokens(chars, mode === 'eco')
  if (!escrow && estimatedTokens > 0) {
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
  await db.insert(worldGenTasks).values({
    id: taskId,
    userId: sessUser.id,
    status: 'uploaded',
    stage: 'parse',
    stageDetail: JSON.stringify({ doneUnits: 0, totalUnits: 0 }),
    sourceHash: hash,
    sourceKey,
    fileSize: bytes.length,
    title,
    mode,
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

  // ---- 启动执行:Workflow binding 优先;无 binding(本地 dev/生产缺失)时内联兜底 ----
  const started = await startWorldGenTask(event, taskId)
  console.info('[world-gen] 任务已启动', { taskId, started })

  const row = await db.select().from(worldGenTasks).where(eq(worldGenTasks.id, taskId)).get()
  return { task: row ? worldGenTaskToDTO(row) : null, started }
})
