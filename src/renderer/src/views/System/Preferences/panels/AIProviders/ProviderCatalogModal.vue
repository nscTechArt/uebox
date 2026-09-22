<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppSegmented from '@renderer/components/AppSegmented.vue'
/**
 * 厂商目录选择器。
 *
 * 选一条就把 Base URL、协议、常见模型一起填好，用户只需要补一个 API Key。
 * 目录是编译进包里的静态数据，打开这个弹窗**不产生任何网络请求**。
 *
 * ## 为什么顶上有一排分页
 *
 * 目录长到 73 家、15 个分区之后，一条直筒滚动就撑不住了：对话类 41 家占满了
 * 前两屏，剩下 32 家能力型厂商（生图、语音、向量化、3D…）全在第一屏之外，
 * 而弹窗没有滚动提示 —— 表现和「目录里没有」几乎一样。
 *
 * 根因是一份列表塞了两种心智模型：「我从哪家买算力」和「我要配哪种能力」。
 * 分页按后者切，页内保留前者的分区。分区表在 providerCatalogSections.ts。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { CatalogEntry } from '@core/shared/aiProvider'
import { Z_CATALOG } from './modalLayers'
import {
  accessOf,
  matchesKeyword,
  sectionOf,
  TAB_ORDER,
  TAB_SECTIONS,
  tabOf,
  type TabKey
} from './providerCatalogSections'

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
const activeTab = ref<TabKey>('chat')
const scrollEl = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)

const searching = computed(() => keyword.value.trim().length > 0)

// 每次打开都回到初始状态，否则弹窗会记着上次的搜索词和分页，
// 看起来像目录变少了
watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      keyword.value = ''
      activeTab.value = 'chat'
      activeIndex.value = -1
    }
  }
)

/** 当前关键词下各分页各命中多少家。搜索时直接显示在分页标题上 */
const tabCounts = computed<Record<TabKey, number>>(() => {
  const counts = Object.fromEntries(TAB_ORDER.map((tab) => [tab, 0])) as Record<TabKey, number>
  for (const entry of props.catalog) {
    if (!matchesKeyword(entry, keyword.value)) continue
    const tab = tabOf(entry)
    if (tab) counts[tab] += 1
  }
  return counts
})

/**
 * 搜到的东西在别的分页里，就把人带过去。
 *
 * 不这么做的话「在生图页搜 kimi」会得到一句「没有匹配的厂商」—— 那是**假话**，
 * 目录里明明有，只是在隔壁页。分页标题上的数字会同时告诉他发生了什么。
 */
watch([() => keyword.value, () => props.catalog], () => {
  if (!searching.value) return
  const counts = tabCounts.value
  if (counts[activeTab.value] > 0) return
  const next = TAB_ORDER.find((tab) => counts[tab] > 0)
  if (next) activeTab.value = next
})

const groups = computed(() => {
  const matched = props.catalog.filter((entry) => matchesKeyword(entry, keyword.value))

  return TAB_SECTIONS[activeTab.value]
    .map((key) => ({
      key,
      entries: matched.filter((entry) => sectionOf(entry) === key)
    }))
    .filter((group) => group.entries.length > 0)
})

/**
 * 键盘选取。
 *
 * 知道自己要什么的人根本不该看列表：敲 kimi、回车，完事。搜索时默认落在第一条
 * 上就是为了这条路 —— 不搜索时不预选（-1），免得一打开弹窗就有个看不出来源的高亮。
 */
const flatEntries = computed(() => groups.value.flatMap((group) => group.entries))

watch([() => keyword.value, activeTab], () => {
  activeIndex.value = searching.value ? 0 : -1
})

function move(delta: number): void {
  const total = flatEntries.value.length
  if (total === 0) return
  const from = activeIndex.value < 0 ? (delta > 0 ? -1 : 0) : activeIndex.value
  activeIndex.value = (from + delta + total) % total
  void nextTick(() => {
    const el = scrollEl.value?.querySelector('.catalog-card.is-active')
    // jsdom 里没有 scrollIntoView，测试跑到这儿会炸
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  })
}

function pickActive(): void {
  const entry = flatEntries.value[activeIndex.value]
  if (entry) pick(entry)
}

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
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="pickActive"
      />

      <AppSegmented
        v-model="activeTab"
        class="catalog-tabs"
        :options="TAB_ORDER"
        :aria-label="$t('aiProvider.catalog.tabsLabel')"
      >
        <template #default="{ option }">
          {{ $t(`aiProvider.catalog.tab.${option}`) }}
          <span class="catalog-tab-count">{{ tabCounts[option] }}</span>
        </template>
      </AppSegmented>

      <div ref="scrollEl" class="catalog-scroll">
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
              :class="{ 'is-active': flatEntries[activeIndex]?.id === entry.id }"
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
                <!-- 先说「要不要去申请密钥」，模型数缩成尾巴：前者才决定「我现在能不能用上」 -->
                <span class="catalog-card-desc">
                  {{ $t(`aiProvider.catalog.access.${accessOf(entry)}`) }}
                  ·
                  {{
                    entry.models.length
                      ? $t('aiProvider.catalog.modelCountShort', { count: entry.models.length })
                      : $t('aiProvider.catalog.noPresetModelsShort')
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
        <div v-if="!searching" class="catalog-group">
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
  gap: 14px;
  height: 60vh;
}

/* 搜索框和分页钉在顶上不跟着滚，只有下面的列表滚 */
.catalog-scroll {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

/* 分页条比内容窄，左对齐；5 个分页在 720 宽的弹窗里一行放得下 */
.catalog-tabs {
  align-self: flex-start;
}

.catalog-tab-count {
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.catalog-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  gap: 8px;
}

.catalog-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
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
  gap: 1px;
  min-width: 0;
}

.catalog-card:hover,
.catalog-card.is-active {
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
  line-height: 1.3;
  color: var(--color-text-primary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.catalog-card-desc {
  font-size: 11px;
  line-height: 1.3;
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.catalog-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}
</style>
