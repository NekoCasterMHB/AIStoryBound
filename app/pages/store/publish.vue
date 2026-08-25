<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'
import {
  MAX_SKILL_DESC_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_ZIP_BYTES,
  SELLER_RATIO,
  parseSkillZip
} from '../../../shared/store-skill'
import type { SkillFileEntry } from '../../../shared/store-skill'
import { TOKEN_CNY_PER_M } from '../../../shared/quota-packages'

// /store/publish — 发布 / 更新 Skill(需登录;zip 压缩包,标准 agent skill 格式,须含 SKILL.md)。
// 售出后发布者得售价 80%,平台收 20% 手续费,收益直接进入余额;提交后进入管理员审核。
// ?skill=<id> 为更新模式:提交新版本(版本号自动递增),审核通过前商店继续售卖现有版本。
const route = useRoute()
const skillId = typeof route.query.skill === 'string' ? route.query.skill : ''
const isUpdate = !!skillId
/** 更新模式下将生成的新版本号(现有最新版本 +1) */
const nextVersion = ref(0)

useHead({ title: `AI SpankWorld · ${isUpdate ? '更新 Skill' : '发布 Skill'}` })

const { data: session } = await useAuthSession()
if (!session.value) {
  await navigateTo(`/login?redirect=${encodeURIComponent('/store/publish')}`)
}

const toast = useToast()

const name = ref('')
const desc = ref('')
const price = ref('')
const fileData = ref<File | null>(null)
const fileEntries = ref<SkillFileEntry[]>([])
const fileError = ref('')
/** Skill 编写教程弹窗 */
const guideOpen = ref(false)

if (isUpdate) {
  // 更新模式:校验商品归属并预填最新已提交版本的名称/说明/售价
  try {
    const mine = await $fetch<{ published: import('../../../shared/store-skill').MyPublishedSkill[] }>('/api/store/mine')
    const found = mine.published.find(s => s.id === skillId)
    if (!found) {
      toast.add({ title: 'Skill 不存在或不属于你', color: 'error' })
      await navigateTo('/store')
    } else {
      name.value = found.name
      desc.value = found.desc
      price.value = String(found.price)
      nextVersion.value = found.latestVersion + 1
    }
  } catch (e) {
    toast.add({ title: '加载失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
    await navigateTo('/store')
  }
}

// ---- 售价估算展示 ----
/** 生效售价(非整数输入向下取整,与服务端一致) */
const settlePrice = computed(() => Math.floor(Number(price.value) || 0))
/** 到手 token:售价 × 卖家分成(与服务端 splitSkillPrice 一致) */
const earnTokens = computed(() => Math.round(settlePrice.value * SELLER_RATIO))
/** 人民币价值估算:按平台标准价格(1M token ≈ TOKEN_CNY_PER_M 元)折算 */
const estCny = computed(() => settlePrice.value / 1_000_000 * TOKEN_CNY_PER_M)

// UFileUpload 选中/删除文件都会更新 fileData,统一在此校验(可解压 + 含 SKILL.md,尽早提示)
watch(fileData, (file) => {
  fileEntries.value = []
  fileError.value = ''
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.zip')) {
    fileError.value = '请选择 .zip 压缩包'
    return
  }
  if (file.size > MAX_SKILL_ZIP_BYTES) {
    fileError.value = `压缩包超过 ${MAX_SKILL_ZIP_BYTES / 1024 / 1024}MB 上限`
    return
  }
  // 客户端预校验:可解压 + 含 SKILL.md(与服务端校验一致,尽早提示)
  void file.arrayBuffer().then((buf) => {
    try {
      fileEntries.value = parseSkillZip(new Uint8Array(buf)).entries
    } catch (err) {
      fileError.value = (err as Error).message
    }
  })
})

const submitting = ref(false)

async function submit() {
  const trimmedName = name.value.trim()
  const trimmedDesc = desc.value.trim()
  const priceNum = Math.floor(Number(price.value))

  if (!trimmedName || trimmedName.length > MAX_SKILL_NAME_CHARS) {
    toast.add({ title: `Skill 名称需在 1~${MAX_SKILL_NAME_CHARS} 字之间`, color: 'error' })
    return
  }
  if (!trimmedDesc || trimmedDesc.length > MAX_SKILL_DESC_CHARS) {
    toast.add({ title: `请填写 Skill 说明(不超过 ${MAX_SKILL_DESC_CHARS} 字)`, color: 'error' })
    return
  }
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    toast.add({ title: '售价需为不小于 0 的整数 token(0 表示免费)', color: 'error' })
    return
  }
  if (!fileData.value) {
    toast.add({ title: '请选择要上传的 zip 压缩包', color: 'error' })
    return
  }
  if (fileError.value) {
    toast.add({ title: fileError.value, color: 'error' })
    return
  }

  const fd = new FormData()
  fd.append('name', trimmedName)
  fd.append('desc', trimmedDesc)
  fd.append('price', String(priceNum))
  fd.append('file', fileData.value)
  if (isUpdate) fd.append('skillId', skillId)

  submitting.value = true
  try {
    const res = await $fetch<{ ok: true, version: number }>('/api/store/skills', { method: 'POST', body: fd })
    toast.add({
      title: isUpdate ? `已提交新版本 v${res.version}` : '已提交审核',
      description: isUpdate ? '审核通过后会替换商店版本,审核期间商店继续展示现有版本' : '管理员审核通过后将在商城上架',
      color: 'success'
    })
    await navigateTo('/store')
  } catch (e) {
    toast.add({ title: isUpdate ? '更新失败' : '发布失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-6">
    <div class="mb-6">
      <h1 class="text-xl font-semibold">
        {{ isUpdate ? '更新 Skill' : '发布 Skill' }}
      </h1>
      <p class="mt-1 text-sm text-neutral-500">
        <template v-if="isUpdate">
          将提交为 v{{ nextVersion }}:审核通过后替换商店版本;审核期间商店继续展示现有版本,已购者仍可下载旧版本
        </template>
        <template v-else>
          格式要求与市面通用 agent skill 一致:压缩包内须包含 SKILL.md(含名称/说明 frontmatter 与正文说明),可附带参考文件
        </template>
      </p>
    </div>

    <!-- 收益说明(80/20) -->
    <UAlert
      class="mb-6"
      color="primary"
      variant="subtle"
      icon="i-lucide-circle-dollar-sign"
      title="收益说明"
      description="您的 Skill 每售出一份,您将获得售价的 80% token 奖励,20% 作为平台手续费;收益在成交时直接进入您的余额。"
    />

    <UCard>
      <div class="flex flex-col gap-4">
        <UFormField label="Skill 名称" required>
          <UInput v-model="name" :maxlength="MAX_SKILL_NAME_CHARS" class="w-full" placeholder="如:文案润色助手" />
        </UFormField>

        <UFormField label="说明文(商城展示)" required>
          <UTextarea
            v-model="desc"
            autoresize
            :rows="4"
            :maxlength="MAX_SKILL_DESC_CHARS"
            class="w-full"
            placeholder="介绍这个 skill 的用途、能力与使用方式,将展示在商城卡片上"
          />
        </UFormField>

        <UFormField label="售价(token)" required>
          <UFieldGroup class="w-full">
            <UInput
              v-model="price"
              type="number"
              :min="0"
              :step="10000"
              class="w-full"
              placeholder="售价"
              aria-label="售价"
            />
            <UButton
              color="neutral"
              variant="subtle"
              label="tokens"
              aria-hidden="true"
              tabindex="-1"
              class="pointer-events-none select-none"
            />
          </UFieldGroup>
          <p class="mt-1 text-xs text-neutral-500">
            <template v-if="settlePrice > 0">
              预估到账 {{ earnTokens.toLocaleString() }} token<br>
              价值约 ¥{{ estCny.toFixed(2) }}
            </template>
            <template v-else>
              售价 0 视为免费,免费 Skill 将获得更高展示与审核优先级
            </template>
          </p>
        </UFormField>

        <UFormField label="Skill 压缩包(.zip)">
          <template #label>
            <span class="flex items-center gap-1">
              Skill 压缩包(.zip)
              <span class="text-error">*</span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-circle-help"
                aria-label="如何制作一个 skill"
                @click="guideOpen = true"
              >
                如何制作一个 skill
              </UButton>
            </span>
          </template>
          <UFileUpload
            v-model="fileData"
            accept=".zip"
            position="inside"
            layout="list"
            label="点击选择或拖拽 .zip 压缩包到此处"
            :description="`压缩包须包含 SKILL.md(正文说明格式不限,中文亦可),大小不超过 ${MAX_SKILL_ZIP_BYTES / 1024 / 1024}MB`"
            class="w-full"
            :ui="{ base: 'min-h-48' }"
          />
          <p v-if="fileError" class="mt-1 text-xs text-red-500">
            {{ fileError }}
          </p>
          <p v-else-if="fileEntries.length" class="mt-1 text-xs text-neutral-500">
            已识别 {{ fileEntries.length }} 个文件,含 SKILL.md ✓
          </p>
        </UFormField>

        <UButton
          class="mt-2"
          color="primary"
          icon="i-lucide-send"
          :loading="submitting"
          block
          @click="submit"
        >
          {{ isUpdate ? '提交新版本' : '提交审核' }}
        </UButton>
        <p class="text-center text-xs text-neutral-500">
          {{ isUpdate ? '提交后进入管理员审核,通过后才会替换商店版本' : '提交后将进入管理员审核,通过后才会在商城展示' }}
        </p>
      </div>
    </UCard>

    <!-- Skill 编写教程弹窗 -->
    <UModal
      v-model:open="guideOpen"
      title="如何写出好的 Skill"
      :ui="{
        content: 'max-w-2xl',
        body: 'max-h-[70vh] overflow-y-auto px-5 py-3'
      }"
    >
      <template #body>
        <div class="space-y-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              什么是 Skill
            </h3>
            <p>
              Skill 是给 AI 用的「能力插件」:一个文件夹里装着指令文档
              <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">SKILL.md</code>
              ,以及可选的参考资料、脚本。插上去,AI 就多了一项专长。本商城采用市面通用格式,压缩包根目录必须包含
              SKILL.md。
            </p>
            <p class="mt-1">
              本平台的知识 skill 主要面向「教学 AI 如何正确进行成人玩法」:把玩法规则、互动边界与措辞风格写成指令,
              让 AI 在生成亲密互动的玩法与剧情时,始终贴合平台规范与用户偏好。
            </p>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              SKILL.md 的两部分
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li>
                <b>frontmatter</b>(开头两个 <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">---</code>
                之间的 YAML):含 <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">name</code>、<code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">description</code>。
                每次对话开始时被扫描,AI 靠它决定要不要激活此技能——description 是触发的唯一依据。
              </li>
              <li>
                <b>body</b>(Markdown 正文):技能被激活后才加载的操作指令,没触发时 AI 永远不会读到。
              </li>
              <li>
                frontmatter 只允许 5 个键:<code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">name</code>、
                <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">description</code>、
                <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">license</code>、
                <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">allowed-tools</code>、
                <code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">metadata</code>。
              </li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              可选目录
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li><code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">scripts/</code>:可执行脚本,AI 直接调用执行</li>
              <li><code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">references/</code>:参考文档,AI 需要时读取</li>
              <li><code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">assets/</code>:产出物模板,AI 复制修改后放进最终输出</li>
              <li><code class="rounded bg-neutral-100 px-1 py-0.5 text-xs dark:bg-neutral-800">agents/openai.yaml</code>:展示用「名片」(名称、简介),不影响 AI 行为</li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              写好 description(最重要)
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li>不只写「做什么」,更要写「什么时候用」。</li>
              <li>
                示例骨架:「教学 AI 如何正确进行成人玩法。Use when 用户请求亲密场景编排、玩法节奏或互动边界相关问题时」——前半句说功能,后半句列触发场景。
              </li>
              <li>
                反例:只写「成人玩法技能」五个字,用户说「帮我安排一个亲密场景」时 AI 无法判断要不要触发。
              </li>
              <li>硬性约束:须存在、≤1024 字符、不含尖括号。</li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              写好 body(给另一个 AI 的指令)
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li>
                <b>简洁是根本</b>:上下文窗口是共享工作台,skill 占得越多,留给对话的越少。建议控制在约 500 行以内。
              </li>
              <li>默认 AI 很聪明:只写它不知道的信息,每段前问自己「这段值不值得占空间」。</li>
              <li>
                统一用祈使句(「开场前先征询偏好」「用户喊停时立即切换场景」),祈使句天然就是指令,减少歧义。
              </li>
              <li>
                「不做什么」比「做什么」更精确:写完做一次反转测试,把正面指导改写成「不要做 X」通常更有效(如「措辞含蓄」→「不要直白、不要用固定台词套所有角色」)。
              </li>
              <li>
                一条具体的情境示例胜过三段抽象描述:比如直接给出一段「用户迟疑时如何温和切换」的对话样例,AI 一看就会。
              </li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              信息分层(常见错误)
            </h3>
            <ul class="space-y-1 pl-5">
              <li>
                ✗ 触发条件写在 body → 技能已触发才加载,晚了<br>
                ✓ 放到 frontmatter 的 description
              </li>
              <li>
                ✗ 参考细节全塞进 SKILL.md → body 膨胀、信息密度下降<br>
                ✓ 拆到 references/,body 只留链接
              </li>
              <li>
                ✗ 确定性操作写成文字指令 → AI 每次重新理解可能出错<br>
                ✓ 封装成 scripts/ 脚本
              </li>
              <li>
                ✗ references 互相引用 → AI 要多跳取信息<br>
                ✓ 所有文件都从 SKILL.md 直接链接
              </li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              命名与避坑
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li>技能名:只用小写字母、数字、连字符(hyphen-case),≤64 字符,优先动词开头的短词(如 fix-bug)。</li>
              <li>
                不要放 README、CHANGELOG 等「给人看的辅助文档」——AI 不需要安装指南和更新日志,每个多余文件都是噪音。
              </li>
            </ul>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              针对本项目的完整示例
            </h3>
            <p>
              以「教学 AI 正确进行成人玩法」的知识 skill 为例:description 写清触发时机,body 用祈使句 + 「不要」清单收窄行为。
            </p>
            <pre class="overflow-x-auto rounded-lg bg-neutral-100 p-3 text-xs leading-relaxed text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"><code>play-guidance/
└── SKILL.md

---
name: play-guidance
description: 教学 AI 如何正确进行成人玩法互动。Use when 用户请求亲密场景、玩法编排或角色互动时,需要遵守玩法边界与节奏。
---

# 玩法指引

- 每次开始新场景前,先征询用户的偏好与边界,不要假设默认设定
- 互动推进遵循「询问 → 确认 → 执行」的节奏,不替用户做决定
- 措辞含蓄、贴切角色与情境,避免直白、重复的固定台词
- 用户表达不适或喊停时,立即切换场景或温和结束,不追问原因
- 不要:
  - 未经确认就推进极端或让用户意外的情节
  - 用同一套模板台词套所有角色
  - 把玩法规则写成说教,应融入情境自然引导</code></pre>
            <p class="mt-1">
              把这类规则存进 references/(如每类玩法的细则表),SKILL.md 里只留链接;规则固定后也可封装成
              scripts/ 校验脚本,让 AI「执行而不读入」,省 token。
            </p>
          </section>

          <section>
            <h3 class="mb-1 font-semibold text-(--ui-text-highlighted)">
              本平台上架要求
            </h3>
            <ul class="list-disc space-y-1 pl-5">
              <li>zip 根目录含 SKILL.md(frontmatter 写名称/说明,正文写操作说明),正文格式不限,中文亦可。</li>
              <li>可附带 scripts/、references/ 等参考文件。</li>
              <li>压缩包不超过 {{ MAX_SKILL_ZIP_BYTES / 1024 / 1024 }}MB;上传后会自动预检 zip 结构与 SKILL.md。</li>
            </ul>
          </section>
        </div>
      </template>
    </UModal>
  </div>
</template>