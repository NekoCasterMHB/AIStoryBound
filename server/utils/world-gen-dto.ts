// server/utils/world-gen-dto.ts
// 云端世界生成任务行 → 客户端 DTO(不含 key 密文、R2 key 等内部列)
import type { WorldGenMode, WorldGenStage, WorldGenTaskDTO, WorldGenTaskStatus, WorldGenKeySource, WorldGenTaskKind } from '../../shared/world-gen-task'
import { parseStageDetail } from './world-gen-pipeline'
import type { WorldGenTaskRow } from './world-gen-pipeline'

export function worldGenTaskToDTO(row: WorldGenTaskRow): WorldGenTaskDTO {
  const detail = parseStageDetail(row.stageDetail)
  let warnings: string[] = []
  try {
    const w = row.warnings ? JSON.parse(row.warnings) as unknown : []
    if (Array.isArray(w)) warnings = w.filter((s): s is string => typeof s === 'string')
  } catch {
    // 损坏按空处理
  }
  return {
    id: row.id,
    kind: (row.kind ?? 'world') as WorldGenTaskKind,
    sourceWorkId: row.sourceWorkId,
    status: row.status as WorldGenTaskStatus,
    stage: row.stage as WorldGenStage,
    stageDetail: { doneUnits: detail.doneUnits, totalUnits: detail.totalUnits },
    sourceHash: row.sourceHash,
    fileSize: row.fileSize,
    title: row.title,
    author: row.author,
    mode: row.mode as WorldGenMode,
    keySource: row.keySource as WorldGenKeySource,
    estimatedTokens: row.estimatedTokens,
    tokensUsed: row.tokensUsed,
    error: row.error,
    warnings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // 仅整书任务(world)提供成书下载;arcs 结果走 /tasks/[id]/arcs 接口
    ...(row.status === 'completed' && row.kind !== 'arcs' ? { downloadUrl: `/api/world-gen/tasks/${row.id}/download` } : {})
  }
}

/** sha-256 十六进制(小写)合法性 */
export function isValidSourceHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash)
}
