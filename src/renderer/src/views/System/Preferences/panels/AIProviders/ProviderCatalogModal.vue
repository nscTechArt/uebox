<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
/**
 * 厂商目录选择器。
 *
 * 选一条就把 Base URL、协议、常见模型一起填好，用户只需要补一个 API Key。
 * 目录是编译进包里的静态数据，打开这个弹窗**不产生任何网络请求**。
 */
import { computed, ref, watch } from 'vue'
import type { CatalogEntry, CatalogGroup, ProviderKind } from '@core/shared/aiProvider'
import { Z_CATALOG } from './modalLayers'

/**
 * 品牌图标。
 *
 * eager + query=url 让打包器把 39 个 svg 收进产物并给出最终地址；
 * 不能用运行时拼路径 —— 那样打包后会 404。
 */
const LOGO_URLS = import.meta.glob('@renderer/assets/provider-logos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

function logoFor(entry: CatalogEntry): string | undefined {
  if (!entry.hasLogo) return undefined
  const key = Object.keys(LOGO_URLS).find((path) => path.endsWith(`/${entry.id}.svg`))
  return key ? LOGO_URLS[key] : undefined
}

const props = defineProps<{
  visible: boolean
  catalog: CatalogEntry[]
  /** 已经添加过的 provider id。只做标记，不禁用 —— 配两个 OpenAI 是常见需求 */
  existingIds?: string[]
}>()

const existing = computed(() => new Set(props.existingIds ?? []))

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void
  /** 选了目录里的一条 */
  (event: 'pick', entry: CatalogEntry): void
  /** 选了「自定义端点」 */
  (event: 'pick-custom'): void
}>()

const keyword = ref('')

// 每次打开都清掉上次的搜索词，否则弹窗会记着上次的过滤结果，看起来像目录变少了
watch(
  () => props.visible,
  (visible) => {
    if (visible) keyword.value = ''
  }
)

/**
 * 分组顺序：国内 → 国际 → 图片生成 → 订阅服务 → 本机 → 自建网关。
 *
 * 按**多少人会点**排，不是按「哪种方案更优雅」排。绝大多数人打开这个框是来找
 * DeepSeek、通义、OpenAI 的；本机推理零成本零配置没错，但要先装 Ollama 再拉
 * 模型，愿意走这条路的是少数。之前把本机和自定义排在最前，结果国内/国际两组
 * 被挤到可视区外面，而弹窗没有滚动提示 —— 看上去就像目录里没有这些厂商。
 *
 * 「图片生成」「向量化」紧跟在后面：它们是**按能力分**的两组，找它们的人是带着
 * 「我要配生图」「我要配知识库检索」这种明确目的来的。「自定义」不在这张表里，
 * 它单独渲染在最末尾 —— 那是「上面都没有」时的兜底，不该占掉最贵的第一屏。
 *
 * 注意这张表是**渲染白名单**：CatalogGroup 加了新值却忘了加到这里，
 * 那一组会整组不显示（而且不报错）。这不是假设 —— 「向量化」这一组加进目录
 * 之后就正好这样漏了一次：7 家厂商 20 个模型全在目录里，界面上一个都找不到。
 * 现在有 providerCatalogGroups.test.ts 守着，加了新组会直接把测试顶红。
 */
const GROUP_ORDER: SectionKey[] = [
  'cn',
  'cloud',
  'image',
  'video',
  'embedding',
  'realtime',
  'tts',
  'music',
  'model3d',
  'search',
  'subscription',
  'local',
  'gateway'
]

/**
 * 分区的键：对话类按「从哪儿买算力」分，其余按用途分。
 *
 * 两个轴合成一个键，是因为它们在界面上就是并排的一列标题 —— 但在类型上
 * 分开（CatalogGroup / ProviderKind），免得又变回一个枚举两种含义。
 */
type SectionKey = CatalogGroup | Exclude<ProviderKind, 'chat'>

function sectionOf(entry: CatalogEntry): SectionKey {
  return entry.kind === 'chat' ? (entry.group ?? 'cloud') : entry.kind
}

const groups = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  const matched = query
    ? props.catalog.filter(
        (entry) =>
          entry.displayName.toLowerCase().includes(query) ||
          entry.id.toLowerCase().includes(query) ||
          // 也搜模型名：想找 Kimi 的人未必知道厂商叫 Moonshot
          entry.models.some((model) =>
            `${model.id} ${model.displayName || ''}`.toLowerCase().includes(query)
          )
      )
    : props.catalog

  return GROUP_ORDER.map((key) => ({
    key,
    entries: matched.filter((entry) => sectionOf(entry) === key)
  })).filter((group) => group.entries.length > 0)
})

function close(): void {
  emit('update:visible', false)
}

function pick(entry: CatalogEntry): void {
  emit('pick', entry)
  close()
}

function pickCustom(): void {
  emit('pick-custom')
  close()
}
</script>

<template>
  <AppModal
    :open="visible"
    :title="$t('aiProvider.catalog.title')"
    hide-footer
    :width="720"
    :z-index="Z_CATALOG"
    centered
    @cancel="close"
  >
    <div class="catalog">
      <input
        v-model="keyword"
        type="text"
        class="catalog-search"
        :placeholder="$t('aiProvider.catalog.searchPlaceholder')"
      />

      <div class="catalog-scroll">
        <div v-for="group in groups" :key="group.key" class="catalog-group">
          <div class="catalog-group-title">
            {{ $t(`aiProvider.catalog.group.${group.key}`) }}
          </div>
          <div class="catalog-grid">
            <button
              v-for="entry in group.entries"
              :key="entry.id"
              type="button"
              class="catalog-card"
              @click="pick(entry)"
            >
              <img
                v-if="logoFor(entry)"
                :src="logoFor(entry)"
                class="catalog-card-logo catalog-card-logo-image"
                alt=""
                aria-hidden="true"
              />
              <span v-else class="catalog-card-logo catalog-card-logo-fallback">
                {{ entry.displayName.slice(0, 1) }}
              </span>
              <span class="catalog-card-text">
                <span class="catalog-card-name">{{ entry.displayName }}</span>
                <span class="catalog-card-desc">
                  {{
                    entry.models.length
                      ? $t('aiProvider.catalog.modelCount', { count: entry.models.length })
                      : $t('aiProvider.catalog.noPresetModels')
                  }}
                </span>
              </span>
              <!-- 标记而不是禁用：配两个 OpenAI（官方 + 自建网关）是常见需求 -->
              <span v-if="existing.has(entry.id)" class="catalog-card-added">
                {{ $t('aiProvider.catalog.added') }}
              </span>
            </button>
          </div>
        </div>

        <!-- 「上面都没有」时的兜底，所以排在最后。搜索时藏起来，免得「没有匹配的厂商」旁边还杵着一张卡 -->
        <div v-if="!keyword.trim()" class="catalog-group">
          <div class="catalog-group-title">{{ $t('aiProvider.catalog.customGroup') }}</div>
          <button type="button" class="catalog-card catalog-card-custom" @click="pickCustom">
            <span class="catalog-card-text">
              <span class="catalog-card-name">{{ $t('aiProvider.catalog.customName') }}</span>
              <span class="catalog-card-desc">{{ $t('aiProvider.catalog.customDesc') }}</span>
            </span>
          </button>
        </div>

        <div v-if="groups.length === 0" class="catalog-empty">
          {{ $t('aiProvider.catalog.noMatch') }}
        </div>
      </div>
    </div>
  </AppModal>
</template>

<style scoped lang="less">
/*
 * 和管理弹窗一样，高度是**固定一个百分比**而不是 max-height 那种上限。
 *
 * 上限的问题是搜索：每敲一个字母命中的厂商就少一批，弹窗跟着缩一次，
 * 而它是居中的 —— 搜索框自己会在屏幕上往下爬，人还在往里打字。
 */
.catalog {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 60vh;
}

/* 搜索框钉在顶上不跟着滚，只有下面的列表滚 */
.catalog-scroll {
  display: flex;
  flex-direction: column;
  gap: 18px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.catalog-search {
  width: 100%;
  min-height: 38px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;
}

.catalog-search:focus {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 0 3px var(--color-accent-border);
}

.catalog-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.catalog-group-title {
  font-size: 12px;
  color: var(--color-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.catalog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}

.catalog-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
}

.catalog-card-logo {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  object-fit: contain;
}

/* Provider SVG 可能被 Vite 内联成 data URL，放进 CSS mask 变量后会解析失败，
   所以这里保留原生 img，只按当前明暗主题把单色字形校成黑 / 白。 */
.catalog-card-logo-image {
  filter: brightness(0);
}

/* 别写成 `:global([data-theme='dark']) .catalog-card-logo-image` —— scoped 块里
   Vue 处理 `:global(...)` 时会把它后面的部分丢掉，编译出来是光秃秃的
   `[data-theme='dark']`，也就是 <html> 自己。整个应用会被 brightness(0) invert(1)
   刷成一整块纯白（打开偏好设置就白屏）。祖先选择器直接写，scoped 会给末段补
   [data-v-xxx]，本来就只命中本组件。 */
[data-theme='dark'] .catalog-card-logo-image {
  filter: brightness(0) invert(1);
}

.catalog-card-logo-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 12px;
  filter: none;
}

.catalog-card-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.catalog-card:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

.catalog-card-custom {
  border-style: dashed;
}

.catalog-card-added {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: 11px;
}

.catalog-card-name {
  font-size: 13px;
  color: var(--color-text-primary);
}

.catalog-card-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

.catalog-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}
</style>
