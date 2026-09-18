<template>
  <AppModal
    :open="open"
    :width="1100"
    hide-footer
    :closable="false"
    :mask-closable="false"
    centered
    class="new-project-modal-wrapper"
    @update:open="handleUpdateOpen"
    @cancel="handleCancel"
  >
    <div class="modal-container">
      <div class="ambient-light"></div>

      <div class="main-panel">
        <!-- 左栏：搜索 + 筛选。这里不再是「模板从哪来」的抽屉，而是筛选器 -->
        <aside class="rail">
          <div class="glow-bg"></div>

          <div class="rail-head">
            <div class="brand-tag">
              <span class="pulse-dot"></span>
              <span class="brand-text">
                {{ t('page.home.project.createFromTemplateModal.brandTag') }}
              </span>
            </div>
            <div class="search-wrapper">
              <PhMagnifyingGlass class="search-icon" />
              <input
                v-model="searchKeyword"
                type="text"
                :placeholder="t('page.home.project.createFromTemplateModal.searchPlaceholder')"
                class="search-input"
              />
            </div>
          </div>

          <div class="rail-facets">
            <div class="facet">
              <div class="facet-title">
                {{ t('page.home.project.createFromTemplateModal.facetSource') }}
              </div>
              <button
                v-for="opt in sourceFacets"
                :key="opt.key"
                class="facet-chip block"
                :class="{ active: sourceFilter.includes(opt.key) }"
                @click="toggleFacet('source', opt.key)"
              >
                <span class="chip-label">{{ opt.label }}</span>
                <span class="chip-count">{{ opt.count }}</span>
              </button>
            </div>

            <div class="facet">
              <div class="facet-title">
                {{ t('page.home.project.createFromTemplateModal.facetUse') }}
              </div>
              <div class="chip-wrap">
                <button
                  v-for="cat in categoryFacets"
                  :key="cat.key"
                  class="facet-chip"
                  :class="{ active: categoryFilter.includes(cat.key) }"
                  @click="toggleFacet('category', cat.key)"
                >
                  {{ cat.label }}
                </button>
              </div>
            </div>

            <div v-if="engineFacets.length > 1" class="facet">
              <div class="facet-title">
                {{ t('page.home.project.createFromTemplateModal.facetEngine') }}
              </div>
              <div class="chip-wrap">
                <button
                  v-for="ver in engineFacets"
                  :key="ver"
                  class="facet-chip"
                  :class="{ active: engineFilter.includes(ver) }"
                  @click="toggleFacet('engine', ver)"
                >
                  UE {{ ver }}
                </button>
              </div>
            </div>

            <button v-if="hasActiveFilter" class="clear-filters" @click="clearFilters">
              {{ t('page.home.project.createFromTemplateModal.clearFilters') }}
            </button>
          </div>

          <div class="rail-foot">
            <button class="rail-action" @click="handleAddCustomTemplate">
              <PhPlus />
              {{ t('page.home.project.createFromTemplateModal.importCustomTemplateText') }}
            </button>
            <button class="rail-action" @click="sourcesVisible = true">
              <PhGear />
              {{ t('page.home.project.createFromTemplateModal.communityManageSources') }}
            </button>
            <button class="back-btn" @click="handleCancel">
              <PhArrowLeft class="back-icon" />
              {{ t('page.home.project.createFromTemplateModal.cancelBtn') }}
            </button>
          </div>
        </aside>

        <!-- 右栏：结果列表 -->
        <section class="results">
          <button class="close-btn" @click="handleCancel">
            <PhX />
          </button>

          <div class="results-head">
            <div>
              <h2 class="results-title">
                {{ t('page.home.project.createFromTemplateModal.configTitle') }}
              </h2>
              <p class="results-count">
                {{
                  t('page.home.project.createFromTemplateModal.resultCount', {
                    count: visibleRows.length,
                    total: allRows.length
                  })
                }}
              </p>
            </div>
            <div class="head-actions">
              <select v-model="sortBy" class="sort-select">
                <option value="recommended">
                  {{ t('page.home.project.createFromTemplateModal.sortRecommended') }}
                </option>
                <option value="name">
                  {{ t('page.home.project.createFromTemplateModal.sortName') }}
                </option>
                <option value="size">
                  {{ t('page.home.project.createFromTemplateModal.sortSize') }}
                </option>
                <option value="added">
                  {{ t('page.home.project.createFromTemplateModal.sortAdded') }}
                </option>
              </select>
              <button
                v-if="hasEnabledSource"
                class="ghost-action"
                :disabled="loadingCommunity"
                @click="refreshCommunity"
              >
                <PhArrowClockwise />
                {{ t('page.home.project.createFromTemplateModal.communityRefresh') }}
              </button>
            </div>
          </div>

          <div class="notices">
            <!--
              一个源都没启用：这是默认状态，此时应用不会发出任何网络请求。
              本地一个模板都没有时不在这挤一条提示，下面会给一整屏的引导。
            -->
            <div v-if="!hasEnabledSource && allRows.length > 0" class="notice notice-accent">
              <PhCloud class="notice-icon" />
              <span class="notice-text">
                {{ t('page.home.project.createFromTemplateModal.communityOfflineDesc') }}
              </span>
              <button class="notice-btn" @click="handleEnableOfficial">
                {{ t('page.home.project.createFromTemplateModal.communityEnableOfficial') }}
              </button>
            </div>

            <!-- 下载来的模板会被 UE 打开并执行，这条不能省 -->
            <div v-if="hasEnabledSource" class="notice">
              <PhWarning class="notice-icon" />
              <span class="notice-text">
                {{ t('page.home.project.createFromTemplateModal.communitySafetyNotice') }}
              </span>
            </div>

            <!--
              逐源的失败提示：一个源挂了不影响其它源。
              别的源已经把模板拿回来了就压成一行灰字 —— 用户此刻不需要处理什么。
            -->
            <div
              v-if="failedSources.length > 0 && hasAnyTemplatesFetched"
              class="notice notice-muted"
            >
              <span class="notice-text">
                {{
                  t('page.home.project.createFromTemplateModal.communitySomeSourcesFailed', {
                    count: failedSources.length
                  })
                }}
              </span>
              <button class="link-action" @click="sourcesVisible = true">
                {{ t('page.home.project.createFromTemplateModal.communityManageSources') }}
              </button>
            </div>
            <template v-else>
              <div
                v-for="failed in failedSources"
                :key="`failed-${failed.sourceId}`"
                class="notice notice-warn"
              >
                <span class="notice-text">
                  {{
                    t('page.home.project.createFromTemplateModal.communitySourceFailed', {
                      name: failed.sourceName,
                      error: failed.error
                    })
                  }}
                </span>
              </div>
            </template>
            <div
              v-for="dirty in skippedSources"
              :key="`skipped-${dirty.sourceId}`"
              class="notice notice-warn"
            >
              <span class="notice-text">
                {{
                  t('page.home.project.createFromTemplateModal.communitySkipped', {
                    name: dirty.sourceName,
                    count: dirty.skipped
                  })
                }}
              </span>
            </div>
          </div>

          <div class="result-list">
            <div v-if="loadingTemplates || loadingCommunity" class="state-block">
              <AppSpin size="large" />
              <div class="state-text">
                {{ t('page.home.project.createFromTemplateModal.loadingTemplates') }}
              </div>
            </div>

            <!--
              全新安装的首屏：本地一个模板都没有，也没启用任何源。
              安装包里不带模板（见 docs/community-templates.md），所以这不是异常状态，
              是每个新用户都会看到的第一屏 —— 得像个正经引导，不能是一句「暂无数据」。
            -->
            <div v-else-if="allRows.length === 0 && !hasEnabledSource" class="onboard-block">
              <PhCloudArrowDown class="onboard-icon" />
              <div class="onboard-title">
                {{ t('page.home.project.createFromTemplateModal.onboardTitle') }}
              </div>
              <div class="onboard-desc">
                {{ t('page.home.project.createFromTemplateModal.onboardDesc') }}
              </div>
              <button class="onboard-btn" @click="handleEnableOfficial">
                <PhCloud class="btn-icon" />
                {{ t('page.home.project.createFromTemplateModal.communityEnableOfficial') }}
              </button>
              <div class="onboard-alt">
                <button class="link-action" @click="sourcesVisible = true">
                  {{ t('page.home.project.createFromTemplateModal.onboardPickSource') }}
                </button>
                <span class="alt-dot">·</span>
                <button class="link-action" @click="handleAddCustomTemplate">
                  {{ t('page.home.project.createFromTemplateModal.importCustomTemplateText') }}
                </button>
              </div>
            </div>

            <div v-else-if="visibleRows.length === 0" class="state-block">
              <PhFolder class="state-icon" />
              <div class="state-title">
                {{ t('page.home.project.createFromTemplateModal.emptyNoMatch') }}
              </div>
              <button v-if="hasActiveFilter || searchKeyword" class="notice-btn" @click="clearAll">
                {{ t('page.home.project.createFromTemplateModal.clearFilters') }}
              </button>
            </div>

            <template v-else>
              <div v-for="row in visibleRows" :key="row.key" class="row-group">
                <div
                  class="template-row"
                  :class="{ selected: selectedKey === row.key }"
                  @click="toggleSelect(row)"
                >
                  <div class="row-thumb">
                    <img
                      v-if="row.previewImage"
                      :src="toLocalResourceUrl(row.previewImage)"
                      class="thumb-img"
                    />
                    <component :is="getCategoryIcon(row.category)" v-else />
                  </div>
                  <div class="row-main">
                    <div class="row-title-line">
                      <span class="row-name">{{ row.name }}</span>
                      <span v-if="row.local && row.remote" class="row-badge badge-ok">
                        {{ t('page.home.project.createFromTemplateModal.communityDownloaded') }}
                      </span>
                    </div>
                    <div class="row-desc">
                      {{
                        row.description ||
                        t('page.home.project.createFromTemplateModal.noDescription')
                      }}
                    </div>
                  </div>
                  <span class="row-tag">UE {{ row.engineVersion }}</span>
                  <span class="row-tag row-tag-source">{{ sourceLabel(row.origin) }}</span>
                </div>

                <!-- 选中就地展开：详情 + 建工程，不用再翻到别处填表 -->
                <div v-if="selectedKey === row.key" class="row-detail">
                  <div class="detail-top">
                    <div class="detail-thumb">
                      <img
                        v-if="row.previewImage"
                        :src="toLocalResourceUrl(row.previewImage)"
                        class="thumb-img"
                      />
                      <component :is="getCategoryIcon(row.category)" v-else />
                    </div>
                    <div class="detail-info">
                      <div class="detail-desc">
                        {{
                          row.description ||
                          t('page.home.project.createFromTemplateModal.noDescription')
                        }}
                      </div>
                      <div class="detail-meta">
                        <span>{{
                          row.author ||
                          t('page.home.project.createFromTemplateModal.communityUnknownAuthor')
                        }}</span>
                        <span v-if="row.license" class="meta-dot">·</span>
                        <span v-if="row.license">{{ row.license }}</span>
                        <span v-if="row.version" class="meta-dot">·</span>
                        <span v-if="row.version">v{{ row.version }}</span>
                        <span v-if="row.size > 0" class="meta-dot">·</span>
                        <span v-if="row.size > 0">{{ formatFileSize(row.size) }}</span>
                      </div>
                    </div>
                  </div>

                  <!-- 本地已有：直接建工程 -->
                  <div v-if="row.local" class="detail-actions">
                    <input
                      v-model="projectName"
                      type="text"
                      :placeholder="
                        t('page.home.project.createFromTemplateModal.projectNamePlaceholder')
                      "
                      class="name-input"
                    />
                    <button class="path-badge" @click="handlePickSaveLocation">
                      {{
                        saveLocation ||
                        t('page.home.project.createFromTemplateModal.saveLocationPlaceholder')
                      }}
                    </button>
                    <button class="create-btn" :disabled="creating" @click="handleOk(row)">
                      <PhFolderPlus class="btn-icon" />
                      {{
                        creating
                          ? t('page.home.project.createFromTemplateModal.creatingBtnLabel')
                          : t('page.home.project.createFromTemplateModal.createBtnLabel')
                      }}
                    </button>
                  </div>

                  <!-- 还没下载：先下载 -->
                  <div v-else-if="row.remote" class="detail-actions">
                    <template v-if="downloading[row.key] !== undefined">
                      <AppProgress
                        :percent="downloading[row.key]"
                        :show-info="false"
                        size="small"
                        style="flex: 1"
                      />
                      <button class="ghost-action" @click="handleCancelDownload(row)">
                        {{ t('page.home.project.createFromTemplateModal.communityCancelDownload') }}
                      </button>
                    </template>
                    <template v-else>
                      <span class="detail-hint">
                        {{ t('page.home.project.createFromTemplateModal.downloadHint') }}
                      </span>
                      <button class="create-btn" @click="handleDownloadTemplate(row)">
                        <PhDownloadSimple class="btn-icon" />
                        {{ t('page.home.project.createFromTemplateModal.communityDownload') }}
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </section>
      </div>
    </div>

    <!-- 添加自定义模板模态框 -->
    <AppModal
      v-model:open="addTemplateVisible"
      :title="t('page.home.project.createFromTemplateModal.addTemplateTitle')"
      :ok-text="t('common.confirm')"
      :cancel-text="t('common.cancel')"
      @ok="handleConfirmAddTemplate"
      @cancel="handleCancelAddTemplate"
    >
      <div class="form-row">
        <span class="label">{{
          t('page.home.project.createFromTemplateModal.addTemplateNameLabel')
        }}</span>
        <a-input
          v-model:value="addTemplateName"
          :placeholder="t('page.home.project.createFromTemplateModal.addTemplateNamePlaceholder')"
          allow-clear
          style="flex: 1"
        />
      </div>
      <div class="form-row">
        <span class="label">{{
          t('page.home.project.createFromTemplateModal.addTemplateSourceLabel')
        }}</span>
        <a-space style="flex: 1">
          <a-input
            v-model:value="addTemplateSourcePath"
            :placeholder="
              t('page.home.project.createFromTemplateModal.addTemplateSourcePlaceholder')
            "
            style="flex: 1"
          />
          <AppButton @click="handlePickSourceProject">
            {{ t('page.home.project.createFromTemplateModal.addTemplatePickProject') }}
          </AppButton>
        </a-space>
      </div>
    </AppModal>

    <!-- 模板源管理 -->
    <AppModal
      v-model:open="sourcesVisible"
      :title="t('page.home.project.createFromTemplateModal.sourcesTitle')"
      hide-footer
    >
      <div class="source-list">
        <div v-for="source in sources" :key="source.id" class="source-row">
          <AppSwitch
            :checked="source.enabled"
            size="small"
            @change="(checked) => handleToggleSource(source, checked)"
          />
          <div class="source-info">
            <div class="source-name">
              {{ source.name }}
              <span v-if="source.builtin" class="source-badge">{{
                t('page.home.project.createFromTemplateModal.sourcesBuiltin')
              }}</span>
            </div>
            <div class="source-url">{{ source.url }}</div>
          </div>
          <a-popconfirm
            v-if="!source.builtin"
            :title="t('page.home.project.createFromTemplateModal.sourcesRemoveConfirm')"
            :ok-text="t('common.confirm')"
            :cancel-text="t('common.cancel')"
            @confirm="handleRemoveSource(source)"
          >
            <a class="source-remove">{{
              t('page.home.project.createFromTemplateModal.sourcesRemove')
            }}</a>
          </a-popconfirm>
        </div>
      </div>

      <div class="source-add">
        <div class="source-add-title">
          {{ t('page.home.project.createFromTemplateModal.sourcesAddTitle') }}
        </div>
        <a-input
          v-model:value="newSourceName"
          :placeholder="t('page.home.project.createFromTemplateModal.sourcesNamePlaceholder')"
          allow-clear
        />
        <a-input
          v-model:value="newSourceUrl"
          :placeholder="t('page.home.project.createFromTemplateModal.sourcesUrlPlaceholder')"
          allow-clear
        />
        <AppButton variant="primary" @click="handleAddSource">
          {{ t('page.home.project.createFromTemplateModal.sourcesAdd') }}
        </AppButton>
      </div>
    </AppModal>
  </AppModal>
</template>

<script setup lang="ts">
import AppProgress from '@renderer/components/AppProgress.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, watch, onMounted, onUnmounted, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowClockwise,
  PhArrowLeft,
  PhCar,
  PhCloud,
  PhCloudArrowDown,
  PhCube,
  PhDotsThree,
  PhDownloadSimple,
  PhFolder,
  PhFolderPlus,
  PhGear,
  PhImage,
  PhMagnifyingGlass,
  PhPlus,
  PhRocketLaunch,
  PhVideoCamera,
  PhWarning,
  PhX
} from '@phosphor-icons/vue'
import { message } from '@/utils/messageManager'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { formatFileSize } from '@renderer/utils/tool'
import { projectTemplateAPI } from '@renderer/api/projectTemplate'
import {
  TEMPLATE_CATEGORIES,
  type CommunityFetchResult,
  type TemplateInfo,
  type TemplateOrigin,
  type TemplateSource
} from '@core/shared/projectTemplate'
import {
  buildTemplateRows,
  collectEngineVersions,
  filterAndSortRows,
  type RowSort,
  type TemplateRow
} from './templateRows'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

interface Props {
  open: boolean
}

interface Emits {
  (e: 'update:open', v: boolean): void
  (e: 'success'): void
  (e: 'cancel'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const searchKeyword = ref('')
const sourceFilter = ref<TemplateOrigin[]>([])
const categoryFilter = ref<string[]>([])
const engineFilter = ref<string[]>([])
const sortBy = ref<RowSort>('recommended')

const templates = ref<TemplateInfo[]>([])
const loadingTemplates = ref(false)
const selectedKey = ref<string | null>(null)
const projectName = ref('')
const saveLocation = ref('')
const creating = ref(false)

const addTemplateVisible = ref(false)
const addTemplateName = ref('')
const addTemplateSourcePath = ref('')

/* ========================= 社区模板源 =========================
 * 这一段唯一会联网的入口是 refreshCommunity()，而它只在「有已启用的源」时才干活。
 * 社区版默认没有任何启用的源，所以不点「启用」就不会发出任何请求 —— 改这里时请守住这条。
 *
 * 注意：随包预装的那两个模板走的是本地扫描（origin 也是 community），
 * 跟这段代码没关系。「首屏不是空的」和「不联网」因此可以同时成立。
 * ============================================================ */

const sources = ref<TemplateSource[]>([])
const communityResults = ref<CommunityFetchResult[]>([])
const loadingCommunity = ref(false)
const communityFetched = ref(false)
/** 正在下载的模板，key 与列表行的 key 一致 */
const downloading = ref<Record<string, number>>({})
const sourcesVisible = ref(false)
const newSourceName = ref('')
const newSourceUrl = ref('')

/** 是否已经有启用的源。没有就只显示「启用」引导，一个请求都不发 */
const hasEnabledSource = computed(() => sources.value.some((s) => s.enabled))

/** 抓取失败的源，逐条提示，不能因为一个源挂了就整页空白 */
const failedSources = computed(() => communityResults.value.filter((r) => r.error))

/**
 * 有没有源成功返回了模板。
 *
 * 有的话，失败的那些就不值得大红大绿地报 —— GitHub 在国内连不上是常态，
 * 而镜像源已经把模板拿回来了，用户该看到的是模板，不是一条每次都在的红字。
 * 全都失败时才把每个源的错误原因摊开，那时候用户确实需要知道为什么是空的。
 */
const hasAnyTemplatesFetched = computed(() =>
  communityResults.value.some((r) => r.templates.length > 0)
)

/** 有脏数据被丢弃的源 */
const skippedSources = computed(() => communityResults.value.filter((r) => r.skipped > 0))

const CATEGORY_ICONS: Record<string, Component> = {
  game: PhRocketLaunch,
  render: PhImage,
  film: PhVideoCamera,
  architecture: PhCube,
  automotive: PhCar,
  other: PhDotsThree
}

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  game: 'categoryGame',
  render: 'categoryRender',
  film: 'categoryFilm',
  architecture: 'categoryArchitecture',
  automotive: 'categoryAutomotive',
  other: 'categoryOther'
}

const getCategoryIcon = (category: string): Component => CATEGORY_ICONS[category] || PhFolder

const categoryLabel = (category: string): string =>
  t(`page.home.project.createFromTemplateModal.${CATEGORY_LABEL_KEYS[category] || 'categoryOther'}`)

const sourceLabel = (origin: TemplateOrigin): string =>
  origin === 'user'
    ? t('page.home.project.createFromTemplateModal.sourceMine')
    : t('page.home.project.createFromTemplateModal.sourceCommunity')

const allRows = computed<TemplateRow[]>(() =>
  buildTemplateRows(templates.value, communityResults.value)
)

const sourceFacets = computed(() =>
  (['community', 'user'] as TemplateOrigin[]).map((key) => ({
    key,
    label: sourceLabel(key),
    count: allRows.value.filter((r) => r.origin === key).length
  }))
)

/** 只列出真有模板的分类 —— 空标签点了什么都没有，纯属噪音 */
const categoryFacets = computed(() =>
  TEMPLATE_CATEGORIES.filter((key) => allRows.value.some((r) => r.category === key)).map((key) => ({
    key: key as string,
    label: categoryLabel(key)
  }))
)

const engineFacets = computed(() => collectEngineVersions(allRows.value))

const hasActiveFilter = computed(
  () =>
    sourceFilter.value.length > 0 ||
    categoryFilter.value.length > 0 ||
    engineFilter.value.length > 0
)

const visibleRows = computed(() =>
  filterAndSortRows(
    allRows.value,
    {
      keyword: searchKeyword.value,
      sources: sourceFilter.value,
      categories: categoryFilter.value,
      engineVersions: engineFilter.value
    },
    sortBy.value
  )
)

const toggleFacet = (kind: 'source' | 'category' | 'engine', key: string): void => {
  // 模板里拿到的是解包后的数组，改不动 ref，所以这里按名字取
  const list: string[] =
    kind === 'source'
      ? sourceFilter.value
      : kind === 'category'
        ? categoryFilter.value
        : engineFilter.value
  const index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else list.push(key)
  selectedKey.value = null
}

const clearFilters = (): void => {
  sourceFilter.value = []
  categoryFilter.value = []
  engineFilter.value = []
}

const clearAll = (): void => {
  clearFilters()
  searchKeyword.value = ''
}

/** 选中时把工程名预填成模板名，省一次输入；用户改过就不再覆盖 */
const toggleSelect = (row: TemplateRow): void => {
  if (selectedKey.value === row.key) {
    selectedKey.value = null
    return
  }
  selectedKey.value = row.key
  if (!projectName.value.trim()) {
    projectName.value = row.name.replace(/[^\w一-龥]+/g, '')
  }
}

/**
 * 读取模板源列表。只读本地配置文件，不联网。
 */
const loadSources = async (): Promise<void> => {
  try {
    sources.value = await projectTemplateAPI.listSources()
  } catch (err: unknown) {
    console.error('读取模板源失败:', err)
    message.error(t('page.home.project.createFromTemplateModal.sourcesLoadFailed'))
  }
}

/**
 * 抓取已启用源的清单。
 *
 * 没有启用的源时直接返回 —— 不要"顺手抓一下试试"，那就破坏离线承诺了。
 */
const refreshCommunity = async (): Promise<void> => {
  if (!hasEnabledSource.value) {
    communityResults.value = []
    return
  }
  loadingCommunity.value = true
  try {
    communityResults.value = await projectTemplateAPI.fetchCommunity()
    communityFetched.value = true
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg || t('page.home.project.createFromTemplateModal.communityFetchFailed'))
  } finally {
    loadingCommunity.value = false
  }
}

/** 切换某个源的启用状态。开启后立即抓一次，用户点了就该看到结果 */
const handleToggleSource = async (source: TemplateSource, enabled: boolean): Promise<void> => {
  try {
    sources.value = await projectTemplateAPI.setSourceEnabled(source.id, enabled)
    await refreshCommunity()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg)
  }
}

/**
 * 空态上的「启用官方社区库」按钮：把内置的几个源**一起**打开。
 *
 * 内置源是同一份内容的两个托管（GitHub + 国内镜像），一起开等于自带容灾：
 * 哪个通就用哪个。清单条目按 sha256 跨源去重，所以两个都通也不会重复显示。
 */
const handleEnableOfficial = async (): Promise<void> => {
  const builtins = sources.value.filter((s) => s.builtin && !s.enabled)
  if (builtins.length === 0) return
  try {
    for (const source of builtins) {
      sources.value = await projectTemplateAPI.setSourceEnabled(source.id, true)
    }
    await refreshCommunity()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** 添加自定义源 */
const handleAddSource = async (): Promise<void> => {
  const url = newSourceUrl.value.trim()
  if (!url) {
    message.warning(t('page.home.project.createFromTemplateModal.sourcesUrlRequired'))
    return
  }
  try {
    sources.value = await projectTemplateAPI.addSource(newSourceName.value.trim(), url)
    newSourceName.value = ''
    newSourceUrl.value = ''
    message.success(t('page.home.project.createFromTemplateModal.sourcesAddSuccess'))
    await refreshCommunity()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg)
  }
}

/** 删除自定义源 */
const handleRemoveSource = async (source: TemplateSource): Promise<void> => {
  try {
    sources.value = await projectTemplateAPI.removeSource(source.id)
    message.success(t('page.home.project.createFromTemplateModal.sourcesRemoveSuccess'))
    await refreshCommunity()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg)
  }
}

/** 下载一条社区模板。下载完刷新本地列表，这一行随即变成可以建工程的 */
const handleDownloadTemplate = async (row: TemplateRow): Promise<void> => {
  if (!row.remote || downloading.value[row.key] !== undefined) return

  downloading.value = { ...downloading.value, [row.key]: 0 }
  try {
    await projectTemplateAPI.downloadCommunity(row.remote.sourceId, row.remote.template)
    message.success(
      t('page.home.project.createFromTemplateModal.communityDownloadSuccess', { name: row.name })
    )
    await loadTemplates()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(
      errorMsg || t('page.home.project.createFromTemplateModal.communityDownloadFailed')
    )
  } finally {
    const next = { ...downloading.value }
    delete next[row.key]
    downloading.value = next
  }
}

/** 取消下载 */
const handleCancelDownload = async (row: TemplateRow): Promise<void> => {
  if (!row.remote) return
  await projectTemplateAPI.cancelDownload(row.remote.sourceId, row.remote.template.id)
}

/** 下载进度订阅的取消函数 */
let unsubscribeProgress: (() => void) | null = null

const loadTemplates = async (): Promise<void> => {
  loadingTemplates.value = true
  try {
    templates.value = await projectTemplateAPI.list()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg || t('page.home.project.createFromTemplateModal.loadError'))
  } finally {
    loadingTemplates.value = false
  }
}

const handleUpdateOpen = (v: boolean): void => {
  emit('update:open', v)
}

/** 每次打开都重来一遍：上次挑的模板、填的工程名不该留到下一次 */
const resetForOpen = (): void => {
  selectedKey.value = null
  projectName.value = ''
  saveLocation.value = ''
  searchKeyword.value = ''
  clearFilters()
  loadTemplates()
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForOpen()
  }
)

const handlePickSaveLocation = async (): Promise<void> => {
  try {
    const ret = await window.api.dialog.showOpenDialog({
      title: t('page.home.project.createFromTemplateModal.saveLocation'),
      properties: ['openDirectory']
    })
    const dp = ret?.filePaths?.[0]
    if (!ret?.canceled && dp) {
      saveLocation.value = dp
    }
  } catch {
    // 用户取消或对话框异常，静默处理
  }
}

const handleOk = async (row: TemplateRow): Promise<void> => {
  const local = row.local
  if (!local) {
    message.warning(t('page.home.project.createFromTemplateModal.templateNotSelected'))
    return
  }

  const name = projectName.value.trim()
  if (!name) {
    message.warning(t('page.home.project.createFromTemplateModal.projectNameRequired'))
    return
  }

  const location = saveLocation.value.trim()
  if (!location) {
    message.warning(t('page.home.project.createFromTemplateModal.saveLocationRequired'))
    return
  }

  creating.value = true
  try {
    const uprojectPath = await projectTemplateAPI.createFromTemplate({
      templatePath: local.path,
      targetDir: location,
      projectName: name
    })

    // 导入工程到数据库
    try {
      if (uprojectPath) {
        await window.api.database.project.importByFilePath(uprojectPath)
      }
    } catch (importErr) {
      console.warn('导入工程失败:', importErr)
      // 不阻断流程，工程文件已创建成功
    }

    message.success(t('page.home.project.createFromTemplateModal.createSuccess'))
    emit('success')
    emit('update:open', false)
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg || t('page.home.project.createFromTemplateModal.createFailed'))
  } finally {
    creating.value = false
  }
}

const handleCancel = (): void => {
  emit('update:open', false)
  emit('cancel')
}

const handleAddCustomTemplate = (): void => {
  addTemplateVisible.value = true
  addTemplateName.value = ''
  addTemplateSourcePath.value = ''
}

const handlePickSourceProject = async (): Promise<void> => {
  try {
    const ret = await window.api.dialog.showOpenDialog({
      title: t('page.home.project.createFromTemplateModal.addTemplatePickProject'),
      properties: ['openDirectory']
    })
    const dp = ret?.filePaths?.[0]
    if (!ret?.canceled && dp) {
      addTemplateSourcePath.value = dp
    }
  } catch {
    // 用户取消或对话框异常，静默处理
  }
}

const handleConfirmAddTemplate = async (): Promise<void> => {
  const name = addTemplateName.value.trim()
  if (!name) {
    message.warning(t('page.home.project.createFromTemplateModal.templateNameRequired'))
    return
  }

  const sourcePath = addTemplateSourcePath.value.trim()
  if (!sourcePath) {
    message.warning(t('page.home.project.createFromTemplateModal.sourcePathRequired'))
    return
  }

  try {
    await projectTemplateAPI.addCustomTemplate({
      sourceProjectPath: sourcePath,
      templateName: name
    })

    message.success(t('page.home.project.createFromTemplateModal.addTemplateSuccess'))
    addTemplateVisible.value = false
    await loadTemplates()
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    message.error(errorMsg || t('page.home.project.createFromTemplateModal.addTemplateFailed'))
  }
}

const handleCancelAddTemplate = (): void => {
  addTemplateVisible.value = false
}

// 选中的那行被筛掉时收起详情，免得底下挂着一段看不见来源的表单
watch(visibleRows, (rows) => {
  if (selectedKey.value && !rows.some((r) => r.key === selectedKey.value)) {
    selectedKey.value = null
  }
})

onMounted(() => {
  loadTemplates()
  // 只读本地配置，不联网
  loadSources().then(() => {
    // 用户之前启用过源才抓。没启用过这里什么都不做，一个请求都不发。
    if (hasEnabledSource.value && !communityFetched.value) refreshCommunity()
  })
  unsubscribeProgress = projectTemplateAPI.onDownloadProgress((payload) => {
    const key = `${payload.sourceId}/${payload.templateId}`
    // 进度事件按「源/模板 id」来，而合并后的行可能用本地路径当 key，两种都要认
    const rowKey =
      downloading.value[key] !== undefined
        ? key
        : allRows.value.find(
            (r) =>
              r.remote?.sourceId === payload.sourceId &&
              r.remote?.template.id === payload.templateId
          )?.key
    if (!rowKey || downloading.value[rowKey] === undefined) return
    downloading.value = { ...downloading.value, [rowKey]: payload.percent }
  })
})

onUnmounted(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = null
})
</script>

<style lang="less">
/* 全局模态框样式 */
.new-project-modal-wrapper {
  .app-modal__panel {
    background: transparent !important;
    box-shadow: none !important;
    padding: 0 !important;
  }

  .app-modal__body {
    padding: 0 !important;
  }
}
</style>

<style lang="less" scoped>
@accent: #10b981;

.modal-container {
  position: relative;
  width: 100%;
  height: 720px;
  border-radius: 24px;
  overflow: hidden;
  background: var(--color-bg-raised);
  backdrop-filter: blur(40px) saturate(140%);
  -webkit-backdrop-filter: blur(40px) saturate(140%);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 40px 80px var(--shadow-color-strong);
  color: var(--color-text-primary);
  font-family: 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 0;
    mix-blend-mode: overlay;
  }
}

.ambient-light {
  position: absolute;
  width: 100%;
  height: 100%;
  background: var(--color-bg-surface);
  z-index: 0;
  pointer-events: none;
}

.main-panel {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  z-index: 1;
}

/* ===================================
   左栏：搜索 + 筛选
   =================================== */
.rail {
  width: 268px;
  flex-shrink: 0;
  background: var(--color-bg-surface-hover);
  display: flex;
  flex-direction: column;
  padding: 24px 20px 20px;
  border-right: 1px solid var(--color-border-subtle);
  position: relative;
  min-height: 0;
}

.glow-bg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 320px;
  background: radial-gradient(ellipse at center top, rgba(16, 185, 129, 0.15), transparent);
  opacity: 0.5;
  pointer-events: none;
  mix-blend-mode: screen;
}

.rail-head {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

.brand-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  padding: 5px 10px;
  border-radius: 9999px;
  margin-bottom: 14px;
  width: fit-content;

  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: @accent;
    animation: pulse 2s ease-in-out infinite;
    box-shadow: 0 0 8px var(--color-success-border);
  }

  .brand-text {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: var(--color-success-text);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.search-wrapper {
  position: relative;
  margin-bottom: 4px;

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-text-muted);
    font-size: 14px;
  }

  .search-input {
    width: 100%;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 10px;
    padding: 9px 12px 9px 36px;
    color: var(--color-text-primary);
    font-size: 13px;
    outline: none;
    transition: all 0.2s;

    &::placeholder {
      color: var(--color-text-disabled);
    }

    &:hover {
      background: var(--color-bg-surface-hover);
    }

    &:focus {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-success-border);
    }
  }
}

.rail-facets {
  position: relative;
  z-index: 10;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 18px;
  padding-right: 4px;

  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
  }
}

.facet {
  margin-bottom: 18px;
}

.facet-title {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  margin-bottom: 8px;
  text-transform: uppercase;
}

.chip-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.facet-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 9999px;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-selected);
  }

  &.block {
    display: flex;
    width: 100%;
    justify-content: space-between;
    margin-bottom: 6px;
    padding: 5px 8px;
    /* 去边框：来源项是普通列表行，不再是独立按钮 */
    border: none;
    border-radius: 8px;
  }

  .chip-label {
    flex: 1;
    text-align: left;
  }

  .chip-count {
    font-size: 11px;
    color: var(--color-text-primary);
  }

  &.active .chip-count {
    color: var(--color-success-text);
  }
}

.clear-filters {
  width: 100%;
  padding: 6px;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.rail-foot {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rail-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.back-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 7px 8px;
  margin-top: 4px;

  .back-icon {
    transition: transform 0.2s;
  }

  &:hover {
    color: var(--color-text-primary);

    .back-icon {
      transform: translateX(-4px);
    }
  }
}

/* ===================================
   右栏：结果列表
   =================================== */
.results {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  z-index: 20;
  font-size: 16px;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.results-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 64px 14px 28px;
  flex-shrink: 0;
}

.results-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--color-text-primary);
  margin: 0;
}

.results-count {
  font-size: 12px;
  color: var(--color-text-primary);
  margin: 4px 0 0;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-select {
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  cursor: pointer;

  option {
    background: var(--color-bg-surface);
    color: var(--color-text-primary);
  }
}

.ghost-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
}

.notices {
  padding: 0 28px;
  flex-shrink: 0;
}

.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  font-size: 12px;
  color: var(--color-text-primary);

  .notice-icon {
    font-size: 15px;
    flex-shrink: 0;
  }

  .notice-text {
    flex: 1;
    line-height: 1.5;
  }

  &.notice-accent {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
    color: var(--color-success-text);
  }

  &.notice-warn {
    background: var(--color-warning-bg);
    border-color: var(--color-warning-border);
    color: var(--color-warning-text);
  }

  &.notice-muted {
    background: transparent;
    border-color: transparent;
    padding: 4px 2px;
    color: var(--color-text-muted);
  }
}

.link-action {
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 0;
  color: var(--color-success-text);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--color-success-text);
    text-decoration: underline;
  }
}

/* 全新安装的第一屏。安装包里不带模板，所以这是新用户必经的一步 */
.onboard-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 72px 32px;
  text-align: center;

  .onboard-icon {
    font-size: 44px;
    color: var(--color-success-text);
  }

  .onboard-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .onboard-desc {
    font-size: 13px;
    line-height: 1.7;
    color: var(--color-text-primary);
    max-width: 420px;
  }

  .onboard-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-top: 4px;
    background: @accent;
    border: none;
    border-radius: 10px;
    padding: 10px 22px;
    color: var(--color-text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;

    &:hover {
      background: var(--color-success-solid);
    }
  }

  .onboard-alt {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
}

.notice-btn {
  flex-shrink: 0;
  background: var(--color-success-solid);
  border: none;
  border-radius: 6px;
  color: var(--color-text-on-solid);
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  cursor: pointer;

  &:hover {
    background: @accent;
  }
}

.result-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 28px 24px;

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }
}

.template-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.selected {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
  }
}

.row-thumb {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
  font-size: 17px;
  overflow: hidden;
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-title-line {
  display: flex;
  align-items: center;
  gap: 7px;
}

.row-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-desc {
  font-size: 12px;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.row-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);

  &.badge-ok {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }
}

.row-tag {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 5px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  white-space: nowrap;
}

.row-tag-source {
  width: 52px;
  text-align: center;
}

.row-detail {
  margin: 2px 0 10px;
  padding: 14px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.detail-top {
  display: flex;
  gap: 14px;
}

.detail-thumb {
  width: 112px;
  height: 70px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-primary);
  font-size: 24px;
  overflow: hidden;
}

.detail-info {
  flex: 1;
  min-width: 0;
}

.detail-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-primary);
}

.detail-meta {
  margin-top: 8px;
  font-size: 11px;
  color: var(--color-text-primary);

  .meta-dot {
    margin: 0 6px;
  }
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.detail-hint {
  flex: 1;
  font-size: 11px;
  color: var(--color-text-primary);
}

.name-input {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 7px 10px;
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;

  &::placeholder {
    color: var(--color-text-disabled);
  }

  &:focus {
    border-color: var(--color-success-border);
  }
}

.path-badge {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 7px 10px;
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
    border-color: var(--color-border);
  }
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  background: @accent;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  color: var(--color-text-muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;

  .btn-icon {
    font-size: 14px;
  }

  &:hover:not(:disabled) {
    background: var(--color-success-solid);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
}

.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 80px 20px;
  color: var(--color-text-primary);

  .state-icon {
    font-size: 36px;
    color: var(--color-text-muted);
  }

  .state-title,
  .state-text {
    font-size: 13px;
  }
}

/* 弹窗内的表单行（添加模板 / 模板源管理） */
.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  .label {
    width: 76px;
    flex-shrink: 0;
    font-size: 13px;
  }
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.source-info {
  flex: 1;
  min-width: 0;
}

.source-name {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-badge {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.source-url {
  font-size: 11px;
  opacity: 0.5;
  word-break: break-all;
}

.source-remove {
  flex-shrink: 0;
  font-size: 12px;
}

.source-add {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.source-add-title {
  font-size: 13px;
  font-weight: 500;
}
</style>
