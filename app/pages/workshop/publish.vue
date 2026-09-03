<script setup lang="ts">
import { useAuthSession } from '../../utils/auth-client'
import {
  MAX_NOVEL_TITLE_CHARS,
  MAX_NOVEL_AUTHOR_CHARS,
  MAX_NOVEL_DESC_CHARS,
  MAX_NOVEL_TXT_BYTES,
  MAX_NOVEL_PREVIEW_CHARS,
  MIN_NOVEL_CHARS,
  NOVEL_TXT_EXTENSIONS,
  countNovelChars
} from '#shared/store-novel'
import { detectNovelEncoding } from '#shared/novel-encoding'
import { SELLER_RATIO } from '#shared/store-skill'
import { TOKEN_CNY_PER_M } from '#shared/quota-packages'

// /workshop/publish — 发布 / 更新小说(创意工坊「书架」,需登录;上传 TXT 或粘贴文本)。
// 售出后发布者得售价 80%,平台收 20% 手续费,收益先挂账、在个人中心「收益」领取后到账;提交后进入管理员审核。
// 可预览字数由发布者决定:买家未购买时可免费试读正文前 N 字(0=不开放试读)。
// ?novel=<id> 为更新模式:提交新版本(版本号自动递增),审核通过前书架商城继续售卖现有版本。
const route = useRoute()
const novelId = typeof route.query.novel === 'string' ? route.query.novel : ''
const isUpdate = !!novelId
/** 更新模式下将生成的新版本号(现有最新版本 +1) */
const nextVersion = ref(0)

useHead({ title: `AI Word2World · ${isUpdate ? '更新小说' : '发布小说'}` })

const { data: session } = await useAuthSession()
if (!session.value) {
  await navigateTo(`/login?redirect=${encodeURIComponent('/workshop/publish')}`)
}

const toast = useToast()

const title = ref('')
const author = ref('')
const desc = ref('')
const price = ref('')
/** 更新模式沿用当前售价,不可修改 */
const currentPrice = ref(0)
const previewChars = ref('')

// ---- 正文:上传 TXT 或粘贴文本,统一转 File 走同一校验 ----
const mode = ref<'file' | 'paste'>('file')
const uploadFile = ref<File | null>(null)
const pasted = ref('')
const fileData = computed<File | null>(() => {
  if (mode.value === 'paste') {
    const t = pasted.value
    if (!t.trim()) return null
    return new File([t], `${title.value.trim() || 'novel'}.txt`, { type: 'text/plain' })
  }
  return uploadFile.value
})

/** 正文预校验结果(与服务端一致,尽早提示)+ 编码自动识别/预览 */
const fileMeta = ref<{
  totalChars: number
  error: string
  /** 检测到的来源编码标签;utf-8 时为空串(无需转换) */
  encoding: string
  /** true = 乱码特征占比偏高,疑似乱码 */
  garbled: boolean
  /** 解码后正文开头预览(供上传前确认) */
  preview: string
}>({ totalChars: 0, error: '', encoding: '', garbled: false, preview: '' })
/** 编码归一化后的 UTF-8 文件(提交时用它替代原文件) */
const convertedFile = ref<File | null>(null)

watch(fileData, (file) => {
  fileMeta.value = { totalChars: 0, error: '', encoding: '', garbled: false, preview: '' }
  convertedFile.value = null
  if (!file) return
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  if (!NOVEL_TXT_EXTENSIONS.includes(ext)) {
    fileMeta.value.error = '请选择 .txt 文本文件'
    return
  }
  if (file.size > MAX_NOVEL_TXT_BYTES) {
    fileMeta.value.error = `小说正文超过 ${MAX_NOVEL_TXT_BYTES / 1024 / 1024}MB 上限`
    return
  }
  void file.arrayBuffer().then((buf) => {
    try {
      const detected = detectNovelEncoding(new Uint8Array(buf))
      const text = detected.text
      const totalChars = countNovelChars(text)
      if (totalChars < MIN_NOVEL_CHARS) {
        fileMeta.value.error = `小说正文过短(至少 ${MIN_NOVEL_CHARS} 字才能上架)`
        return
      }
      // 统一转成 UTF-8 再上传:商城库内文件编码归一,买家下载/阅读不再乱码
      convertedFile.value = new File([new TextEncoder().encode(text)], file.name, { type: 'text/plain' })
      fileMeta.value.totalChars = totalChars
      fileMeta.value.encoding = detected.encoding === 'utf-8' ? '' : detected.label
      fileMeta.value.garbled = detected.confidence === 'low'
      fileMeta.value.preview = [...text].slice(0, 300).join('')
    } catch (err) {
      fileMeta.value.error = (err as Error).message
    }
  })
})

if (isUpdate) {
  // 更新模式:校验商品归属并预填最新已提交版本的信息(售价仅展示,提交沿用)
  // 用 useRequestFetch:SSR 直链加载时服务端请求也能带上会话 cookie,避免 401 误判非本人商品
  try {
    const rf = useRequestFetch()
    const mine = await rf<{ published: import('#shared/store-novel').MyPublishedNovel[] }>('/api/store/novels/mine')
    const found = mine.published.find(n => n.id === novelId)
    if (!found) {
      toast.add({ title: '小说不存在或不属于你', color: 'error' })
      await navigateTo('/workshop?tab=novels')
    } else {
      title.value = found.title
      author.value = found.author ?? ''
      desc.value = found.desc
      currentPrice.value = found.price
      previewChars.value = String(found.previewChars)
      nextVersion.value = found.latestVersion + 1
    }
  } catch (e) {
    toast.add({ title: '加载失败', description: e instanceof Error ? e.message : String(e), color: 'error' })
    await navigateTo('/workshop?tab=novels')
  }
}

// ---- 售价估算展示 ----
/** 生效售价(非整数输入向下取整,与服务端一致) */
const settlePrice = computed(() => Math.floor(Number(price.value) || 0))
/** 到手 token:售价 × 卖家分成(与服务端 splitNovelPrice 一致) */
const earnTokens = computed(() => Math.round(settlePrice.value * SELLER_RATIO))
/** 人民币价值估算:按平台标准价格(1M token ≈ TOKEN_CNY_PER_M 元)折算 */
const estCny = computed(() => settlePrice.value / 1_000_000 * TOKEN_CNY_PER_M)

/** 可预览字数输入(非法输入按 0) */
const settlePreviewChars = computed(() => Math.floor(Number(previewChars.value) || 0))

const submitting = ref(false)

async function submit() {
  const trimmedTitle = title.value.trim()
  const priceNum = Math.floor(Number(price.value))
  const pv = settlePreviewChars.value

  if (!trimmedTitle || trimmedTitle.length > MAX_NOVEL_TITLE_CHARS) {
    toast.add({ title: `书名需在 1~${MAX_NOVEL_TITLE_CHARS} 字之间`, color: 'error' })
    return
  }
  if (author.value.trim().length > MAX_NOVEL_AUTHOR_CHARS) {
    toast.add({ title: `作者名不能超过 ${MAX_NOVEL_AUTHOR_CHARS} 字`, color: 'error' })
    return
  }
  if (!desc.value.trim() || desc.value.trim().length > MAX_NOVEL_DESC_CHARS) {
    toast.add({ title: `请填写一句话简介(≤${MAX_NOVEL_DESC_CHARS} 字,展示在书架卡片上)`, color: 'error' })
    return
  }
  // 更新版本不允许变更售价(售价沿用主表当前值,前端不提交)
  if (!isUpdate && (!Number.isFinite(priceNum) || priceNum < 0)) {
    toast.add({ title: '售价需为不小于 0 的整数 token(0 表示免费)', color: 'error' })
    return
  }
  if (!fileData.value) {
    toast.add({ title: mode.value === 'paste' ? '请粘贴小说正文' : '请选择要上传的 TXT 文件', color: 'error' })
    return
  }
  if (fileMeta.value.error) {
    toast.add({ title: fileMeta.value.error, color: 'error' })
    return
  }
  if (!Number.isInteger(pv) || pv < 0 || pv > MAX_NOVEL_PREVIEW_CHARS) {
    toast.add({ title: `可预览字数需在 0~${MAX_NOVEL_PREVIEW_CHARS} 之间(0=不开放试读)`, color: 'error' })
    return
  }
  if (fileMeta.value.totalChars > 0 && pv > fileMeta.value.totalChars) {
    toast.add({ title: `可预览字数(${pv})不能超过全书字数(${fileMeta.value.totalChars})`, color: 'error' })
    return
  }

  const fd = new FormData()
  fd.append('title', trimmedTitle)
  fd.append('author', author.value.trim())
  fd.append('desc', desc.value.trim())
  if (!isUpdate) fd.append('price', String(priceNum))
  fd.append('previewChars', String(pv))
  // 优先提交编码归一化后的 UTF-8 文件(粘贴模式文本本身就是 UTF-8)
  fd.append('file', convertedFile.value ?? fileData.value)
  if (isUpdate) fd.append('novelId', novelId)

  submitting.value = true
  try {
    const res = await $fetch<{ ok: true, version: number }>('/api/store/novels', { method: 'POST', body: fd })
    toast.add({
      title: isUpdate ? `已提交新版本 v${res.version}` : '已提交审核',
      description: isUpdate ? '审核通过后会替换书架商城版本,审核期间商城继续展示现有版本' : '管理员审核通过后将在书架商城上架',
      color: 'success'
    })
    await navigateTo('/workshop?tab=novels')
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
        {{ isUpdate ? '更新小说' : '发布小说' }}
      </h1>
      <p class="mt-1 text-sm text-neutral-500">
        <template v-if="isUpdate">
          将提交为 v{{ nextVersion }}:审核通过后替换书架商城版本;审核期间商城继续展示现有版本,已购者仍可下载旧版本
        </template>
        <template v-else>
          上传 TXT 或粘贴文本即可上架售卖;可自由设定买家免费试读的字数,审核通过后进入书架商城
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
      description="您的小说每售出一份,您将获得售价的 80% token 奖励,20% 作为平台手续费;收益在成交后进入个人中心「收益」,一键领取到账。"
    />

    <UCard>
      <div class="flex flex-col gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            label="书名"
            required
          >
            <UInput
              v-model="title"
              :maxlength="MAX_NOVEL_TITLE_CHARS"
              class="w-full"
              placeholder="如:我的监禁生涯"
            />
          </UFormField>
          <UFormField label="作者(选填)">
            <UInput
              v-model="author"
              :maxlength="MAX_NOVEL_AUTHOR_CHARS"
              class="w-full"
              placeholder="原著作者名,佚名可不填"
            />
          </UFormField>
        </div>

        <UFormField
          label="一句话简介(书架卡片展示)"
          required
        >
          <UTextarea
            v-model="desc"
            :rows="2"
            autoresize
            :maxrows="4"
            :maxlength="MAX_NOVEL_DESC_CHARS"
            class="w-full"
            placeholder="用一两句话介绍这本书的看点,如:高冷上司与倔强下属的办公室暗流"
          />
        </UFormField>

        <UFormField
          v-if="!isUpdate"
          label="售价(token)"
          required
        >
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
              售价 0 视为免费,免费小说将获得更高展示与审核优先级
            </template>
          </p>
        </UFormField>
        <p
          v-else
          class="text-xs text-neutral-500"
        >
          更新版本沿用当前售价
          <span class="font-semibold text-highlighted">{{ currentPrice.toLocaleString() }} tokens</span>
          ,不可修改;如确需改价请通过其他渠道联系管理员
        </p>

        <UFormField
          label="可预览字数(买家免费试读)"
          required
        >
          <UFieldGroup class="w-full">
            <UInput
              v-model="previewChars"
              type="number"
              :min="0"
              :max="MAX_NOVEL_PREVIEW_CHARS"
              :step="1000"
              class="w-full"
              placeholder="如:5000"
              aria-label="可预览字数"
            />
            <UButton
              color="neutral"
              variant="subtle"
              label="字"
              aria-hidden="true"
              tabindex="-1"
              class="pointer-events-none select-none"
            />
          </UFieldGroup>
          <p class="mt-1 text-xs text-neutral-500">
            买家未购买时可免费阅读正文前 N 字(0=不开放试读);须小于全书字数,最多
            {{ MAX_NOVEL_PREVIEW_CHARS.toLocaleString() }} 字。试读内容即正文开头,建议留足钩子
          </p>
        </UFormField>

        <UFormField :label="mode === 'file' ? '小说正文(.txt)' : '小说正文(粘贴文本)'">
          <template #label>
            <span class="flex items-center gap-2">
              小说正文
              <span class="text-error">*</span>
              <URadioGroup
                v-model="mode"
                :items="[
                  { label: '上传 TXT', value: 'file' },
                  { label: '粘贴文本', value: 'paste' }
                ]"
                orientation="horizontal"
                size="sm"
              />
            </span>
          </template>
          <UFileUpload
            v-if="mode === 'file'"
            v-model="uploadFile"
            :accept="NOVEL_TXT_EXTENSIONS.join(',')"
            position="inside"
            layout="list"
            label="点击选择或拖拽 .txt 文件到此处"
            :description="`自动识别编码并转为 UTF-8(支持 GBK / Big5 / UTF-16 等),大小不超过 ${MAX_NOVEL_TXT_BYTES / 1024 / 1024}MB,至少 ${MIN_NOVEL_CHARS} 字`"
            class="w-full"
            :ui="{ base: 'min-h-48' }"
          />
          <UTextarea
            v-else
            v-model="pasted"
            :rows="14"
            autoresize
            :maxrows="24"
            class="w-full font-mono text-xs"
            :placeholder="`将小说全文粘贴到这里(至少 ${MIN_NOVEL_CHARS} 字,建议 UTF-8 编码)`"
          />
          <p
            v-if="fileMeta.error"
            class="mt-1 text-xs text-red-500"
          >
            {{ fileMeta.error }}
          </p>
          <template v-else-if="fileMeta.totalChars > 0">
            <p class="mt-1 text-xs text-neutral-500">
              已识别正文 {{ fileMeta.totalChars.toLocaleString() }} 字 ✓
              <template v-if="fileMeta.encoding">
                ;检测到 {{ fileMeta.encoding }} 编码,已自动转换为 UTF-8(内容不变)
              </template>
              <template v-else>
                ;UTF-8 编码
              </template>
              <template v-if="settlePreviewChars > fileMeta.totalChars">
                <span class="text-red-500">;可预览字数超过全书字数,提交前请调整</span>
              </template>
            </p>
            <UAlert
              v-if="fileMeta.garbled"
              class="mt-2"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="疑似乱码"
              description="文件编码未能可靠识别,下方预览可能乱码。建议将文件另存为 UTF-8 编码后重新上传;仍可提交,由管理员审核时处理。"
            />
            <details
              v-if="fileMeta.preview"
              class="mt-2 rounded-lg border border-neutral-200 dark:border-neutral-800"
            >
              <summary class="cursor-pointer px-3 py-1.5 text-xs text-neutral-500 select-none">
                正文开头预览(前 300 字,请确认无乱码)
              </summary>
              <p class="max-h-48 overflow-y-auto border-t border-neutral-200 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
                {{ fileMeta.preview }}
              </p>
            </details>
          </template>
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
          {{ isUpdate ? '提交后进入管理员审核,通过后才会替换书架商城版本' : '提交后将进入管理员审核,通过后才会在书架商城展示' }}
        </p>
      </div>
    </UCard>
  </div>
</template>
