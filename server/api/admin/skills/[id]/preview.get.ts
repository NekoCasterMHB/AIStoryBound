// server/api/admin/skills/[id]/preview.get.ts
// 管理端在线预览:读取该 skill 最新提交版本压缩包内所有 markdown 文件
// (SKILL.md、references 等)的文本内容,供审核时查阅。
// 限制:最多 MAX_MD_FILES 个、单个 ≤MAX_MD_BYTES、合计 ≤MAX_TOTAL_BYTES,超限文件跳过,防止大包拖垮接口。
import { unzipSync } from 'fflate'
import { useD1 } from '../../../../utils/d1'
import { getSkillBucket } from '../../../../utils/r2'
import { requireAdmin } from '../../../../utils/authz'
import { skillProductVersions } from '../../../../db/schema'
import { eq, desc } from 'drizzle-orm'

const MAX_MD_FILES = 30
const MAX_MD_BYTES = 200 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useD1(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 Skill id' })

  const rows = await db.select({ fileKey: skillProductVersions.fileKey })
    .from(skillProductVersions)
    .where(eq(skillProductVersions.skillId, id))
    .orderBy(desc(skillProductVersions.version))
    .limit(1)
    .all()
  const skill = rows[0]
  if (!skill) throw createError({ statusCode: 404, statusMessage: 'Skill 不存在' })

  const object = await getSkillBucket(event).get(skill.fileKey)
  if (!object) {
    throw createError({ statusCode: 404, statusMessage: 'Skill 文件不存在或已被删除' })
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(await object.arrayBuffer()))
  } catch {
    throw createError({ statusCode: 400, statusMessage: '压缩包解析失败,无法预览' })
  }

  const decoder = new TextDecoder()
  const mds: { name: string, content: string }[] = []
  let totalBytes = 0
  for (const name of Object.keys(files).sort()) {
    const bytes = files[name]
    if (!bytes || bytes.length === 0) continue
    if (mds.length >= MAX_MD_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    if (!/\.(md|markdown)$/i.test(name)) continue
    if (bytes.length > MAX_MD_BYTES) continue
    mds.push({ name, content: decoder.decode(bytes) })
    totalBytes += bytes.length
  }

  return { files: mds, skipped: Object.keys(files).length - mds.length > 0 }
})
