<template>
  <!-- 合并视图：工程合集与工程一起展示 -->
  <section class="section project-section" @contextmenu.prevent="handleBlankAreaContextMenu">
    <header class="section-header">
      <div class="flex items-center gap-3">
        <h2 class="section-title">{{ t('page.home.project.title') }}</h2>
        <AppButton
          :title="t('page.home.project.createFromTemplate')"
          @click="handleClickCreateProject"
        >
          <template #icon><PhStorefront /></template>
        </AppButton>
        <!-- 导入已有工程：跟「用模板建新工程」是两件事，各自一个入口 -->
        <AppButton
          id="project-import-entry"
          :title="t('page.home.project.importExisting')"
          @click="openImportModal()"
        >
          <template #icon><PhPlus /></template>
        </AppButton>
        <!-- 刷新跟这两个入口是一类事（都是在动工程库本身），放在一起 -->
        <AppButton
          :loading="isRefreshingProjects"
          :title="t('page.home.project.refresh')"
          @click="handleRefreshProjects"
        >
          <template #icon><PhArrowClockwise /></template>
        </AppButton>
      </div>

      <div class="section-actions">
        <a-space>
          <!-- 版本筛选只列库里真有的版本：给一个点进去空空如也的「UE 5.2」没有意义 -->
          <a-select
            v-model:value="engineFilter"
            :options="engineOptions"
            :title="t('page.home.project.engineFilter')"
            style="width: 140px"
          />
          <a-input-search
            v-model:value="keyword"
            :placeholder="t('page.home.project.searchPlaceholder')"
            allow-clear
            style="width: 240px"
          />
        </a-space>
      </div>
    </header>

    <AppPageSkeleton v-if="initLoading" variant="projects" :count="24" />

    <template v-else>
      <!--
        分组是筛选条件，不是文件夹：这些名字多半是「UE 5.6」这类，用户要的是
        「只看 5.6 的工程」，不是「打开一个盒子看里面」。做成一排筛选按钮之后，
        网格里永远只有工程卡片一种东西，也就没有展开、收起、排版错位这些事了。
      -->
      <div v-if="filterChips.length || visibleProjects.length" class="collection-filter">
        <button
          v-for="chip in filterChips"
          :key="chip.key"
          type="button"
          class="filter-chip"
          :class="{
            active: activeFilterKey === chip.key,
            empty: chip.count === 0,
            'drop-target': dragOverFilterKey === chip.key
          }"
          :title="chip.title"
          @click="handleClickFilter(chip)"
          @contextmenu.prevent="(e) => handleFilterContextMenu(e, chip)"
          @dragenter.prevent="(e) => handleDragOverFilter(e, chip)"
          @dragover.prevent="(e) => handleDragOverFilter(e, chip)"
          @dragleave="handleDragLeaveFilter"
          @drop.prevent="(e) => handleDropOnFilter(e, chip)"
        >
          <span class="chip-label">{{ chip.label }}</span>
          <span class="chip-count">{{ chip.count }}</span>
        </button>

        <!-- 新建分组排在这一排的最后：分组的入口就该跟分组待在一起 -->
        <button
          type="button"
          class="filter-chip chip-add"
          :title="t('page.home.project.menu.createCollection')"
          @click="handleCreateCollection"
        >
          <PhPlus />
        </button>
      </div>

      <transition-group
        v-if="visibleProjects.length"
        name="list"
        tag="div"
        class="mixed-grid"
        @contextmenu.prevent.self="handleBlankAreaContextMenu"
        @dragover.prevent="handleGridDragOver"
        @drop.prevent="handleGridDrop"
      >
        <AppCard
          v-for="item in visibleProjects"
          :key="item.projectKey || item.id"
          class="project-card mixed-card draggable"
          :class="{ opening: openingProjects.has(item.projectKey) }"
          :hoverable="true"
          draggable="true"
          @dragstart="(e) => handleDragStartProject(e, item)"
          @dragend="handleDragEndProject"
          @dblclick="() => handleOpenProject(item)"
          @contextmenu.prevent="(e) => handleProjectContextMenu(e, item)"
        >
          <template #cover>
            <div class="project-thumb">
              <span
                v-if="Number(item.isPinned || 0) === 1"
                class="pin-badge"
                :title="t('page.home.project.menu.pin')"
              >
                <PhPushPin />
              </span>
              <!-- 已连接标识 -->
              <span
                v-if="isProjectConnected(item.originPath || item.projectPath)"
                class="connected-badge"
                title="已连接"
              >
                <span class="pulse-dot"></span>
                <span class="label">LINK</span>
              </span>
              <img :src="getProjectImage(item)" alt="thumb" />
              <div class="project-meta">
                <div
                  class="project-title"
                  :title="item.projectName || t('page.home.project.unnamedProject')"
                >
                  {{ item.projectName || t('page.home.project.unnamedProject') }}
                </div>
              </div>
              <span class="project-version" :title="item.EngineAssociation || ''">{{
                engineLabel(item.EngineAssociation)
              }}</span>
              <!-- 加载遮罩层 -->
              <div v-if="openingProjects.has(item.projectKey)" class="project-opening-overlay">
                <div class="opening-content">
                  <div class="opening-spinner"></div>
                  <div class="opening-text">{{ t('page.home.project.opening') }}</div>
                </div>
              </div>
            </div>
          </template>
        </AppCard>
      </transition-group>
      <!--
        通用的「暂无数据」在这里是浪费：这是新用户装完盒子看到的第一屏，
        而他此刻最需要知道的恰恰是「该怎么把工程放进来」。
      -->
      <!-- 搜不到和一个都没导入是两回事，后者才该讲怎么导入 -->
      <AppEmpty
        v-else-if="keyword.trim()"
        :title="t('page.home.project.noSearchResults', { keyword: keyword.trim() })"
        :description="t('page.home.project.noSearchResultsDesc')"
      />
      <!-- 版本筛没了：原因是这个版本，不是没工程 -->
      <AppEmpty
        v-else-if="engineFilter"
        :title="t('page.home.project.noVersionResults', { version: engineFilterLabel })"
        :description="t('page.home.project.noVersionResultsDesc')"
      />
      <!-- 筛到了一个空分组：这不是「没有工程」，别拿导入引导来答非所问 -->
      <AppEmpty
        v-else-if="activeFilterKey !== FILTER_ALL"
        :title="t('page.home.project.collection.emptyFilter')"
        :description="t('page.home.project.collection.emptyFilterDesc')"
      />
      <!-- 读失败和真的没有是两回事：后者才该教他怎么导入 -->
      <AppEmpty
        v-else-if="loadFailed"
        :title="t('page.home.project.loadFailedTitle')"
        :description="t('page.home.project.loadFailedDesc')"
      />
      <AppEmpty
        v-else
        :title="t('page.home.project.empty')"
        :description="t('page.home.project.emptyDesc')"
      />
    </template>
  </section>

  <!-- 拖着工程走的时候跟在光标边上的小标签 -->
  <DragOverlay :visible="dragOverlayVisible" :text="dragOverlayText" />

  <!-- 右键菜单组件 -->
  <ContextMenu ref="contextMenuRef" :menu-items="menuItems" @click="handleMenuClick" />
  <ContextMenu
    ref="blankContextMenuRef"
    :menu-items="blankMenuItems"
    @click="handleBlankMenuClick"
  />
  <!-- 分组按钮的右键菜单：重命名 / 解散 -->
  <ContextMenu
    ref="filterContextMenuRef"
    :menu-items="filterMenuItems"
    @click="handleFilterMenuClick"
  />

  <!-- 重命名弹窗 -->
  <RenameProjectModal
    v-model:open="renameVisible"
    v-model:name="renameInput"
    :project-key="activeProject?.projectKey || ''"
    @success="handleRenameSuccess"
  />

  <!-- 从模板创建工程弹窗 -->
  <CreateProjectFromTemplateModal
    v-model:open="createFromTemplateVisible"
    @success="handleCreateFromTemplateSuccess"
  />

  <!-- 导入本机已有工程弹窗 -->
  <ImportProjectModal
    v-model:open="importProjectVisible"
    @success="handleCreateFromTemplateSuccess"
  />

  <!-- 分组取名弹窗：新建和重命名共用一个 -->
  <CollectionNameModal
    v-model:open="collectionModalVisible"
    v-model:name="collectionModalName"
    :collection-key="collectionModalKey"
    @success="handleCollectionNameSuccess"
  />

  <!-- 图片裁剪弹窗 -->
  <AppModal
    v-model:open="cropperModalVisible"
    :title="t('page.home.project.cropCover')"
    :width="600"
    :mask-closable="false"
    :destroy-on-close="true"
    :ok-text="t('common.confirm')"
    :cancel-text="t('common.cancel')"
    @ok="handleCropConfirm"
    @cancel="handleCropCancel"
  >
    <div style="width: 100%; height: 400px">
      <VueCropper
        ref="cropperRef"
        :img="cropperImage"
        :auto-crop="true"
        :auto-crop-width="600"
        :auto-crop-height="600"
        :center-box="true"
        :fixed="true"
        :fixed-number="[1, 1]"
        :info="false"
      />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppCard from '@renderer/components/AppCard.vue'
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppPageSkeleton from '@renderer/components/AppPageSkeleton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { message } from '@renderer/utils/messageManager'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'
import { confirmDialog } from '@renderer/utils/dialog'
import {
  PhArrowClockwise,
  PhCode,
  PhFolderMinus,
  PhFolderOpen,
  PhFolderPlus,
  PhImage,
  PhPencilSimple,
  PhPlayCircle,
  PhPlugs,
  PhPlus,
  PhSelectionSlash,
  PhPushPin,
  PhStorefront,
  PhTrash
} from '@phosphor-icons/vue'
import 'vue-cropper/dist/index.css'
import { VueCropper } from 'vue-cropper/dist/vue-cropper.es.js'
import { rankProjectSearch } from '@renderer/utils/projectSearch'
import { useProjects } from '@renderer/hooks/useProjects'
import { useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import { useEngineVersionLabel } from '@renderer/hooks/useEngineVersionLabel'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import RenameProjectModal from './RenameProjectModal.vue'
import CreateProjectFromTemplateModal from './CreateProjectFromTemplateModal.vue'
import ImportProjectModal from './ImportProjectModal.vue'
import CollectionNameModal from './CollectionNameModal.vue'
import DragOverlay from '@renderer/components/DragOverlay.vue'
import { h, ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// 已通过 WebSocket 连接的工程列表
/**
 * 订阅、退订、首拉都交给 useConnectedProjects。
 *
 * 原来是手写的，而且顺序是反的：先 `await getProjects()` 再订阅。页面在这段
 * await 里被卸载（首页没有 keepAlive，切个标签就卸）时，onUnmounted 摘到的是
 * null，订阅随后才建起来 —— 再也摘不掉。`?? []` 保持读的地方还是数组。
 */
const connectedProjectsRaw = useConnectedProjects()
const connectedProjects = computed(() => connectedProjectsRaw.value ?? [])
let unsubscribeLibraryChanged: (() => void) | null = null

/**
 * 检查工程是否已通过 WebSocket 连接（基于项目路径匹配，避免同名项目误判）
 * 注意：前端 originPath 是 .uproject 文件路径，后端 projectPath 是项目目录路径
 *
 * 边界情况处理：
 * - 空值/undefined：直接返回 false
 * - 大小写不一致：统一转小写（Windows 不区分大小写）
 * - 斜杠方向不一致：统一转正斜杠
 * - 末尾斜杠：统一移除
 * - 双斜杠：压缩为单斜杠
 * - 空白字符：移除首尾空白
 * - UNC 路径：保留 // 开头
 */
const isProjectConnected = (projectFilePath: string | null | undefined): boolean => {
  // 边界情况：空值或纯空白字符串
  if (!projectFilePath || !projectFilePath.trim()) return false

  /**
   * 路径标准化函数
   * @param p 原始路径
   * @returns 标准化后的路径
   */
  const normalize = (p: string): string => {
    if (!p || !p.trim()) return ''
    let result = p
      .trim() // 移除首尾空白
      .toLowerCase() // 统一小写
      .replace(/\\/g, '/') // 统一斜杠方向
    // 处理双斜杠（但保留 UNC 路径开头的 //）
    const isUNC = result.startsWith('//')
    result = result.replace(/\/+/g, '/') // 多个斜杠压缩为一个
    if (isUNC && !result.startsWith('//')) {
      result = '/' + result // 恢复 UNC 路径的第二个斜杠
    }
    result = result.replace(/\/+$/, '') // 移除末尾斜杠
    return result
  }

  /**
   * 从 .uproject 文件路径提取项目目录路径
   * @param filePath .uproject 文件路径或目录路径
   * @returns 项目目录路径
   */
  const getProjectDir = (filePath: string): string => {
    const normalized = normalize(filePath)
    if (!normalized) return ''
    // 如果路径以 .uproject 结尾，则去掉文件名部分
    if (normalized.endsWith('.uproject')) {
      const lastSlash = normalized.lastIndexOf('/')
      return lastSlash > 0 ? normalized.substring(0, lastSlash) : normalized
    }
    return normalized
  }

  const projectDir = getProjectDir(projectFilePath)
  // 边界情况：提取目录后为空
  if (!projectDir) return false

  return connectedProjects.value.some((p) => {
    // isConnected 可能是 undefined，默认视为已连接
    const connected = p.isConnected !== false
    const backendPath = normalize(p.projectPath || '')
    // 边界情况：后端路径为空
    if (!backendPath) return false
    return connected && backendPath === projectDir
  })
}

type ProjectRecord = {
  projectKey: string
  projectName?: string | null
  projectPath?: string | null
  originPath?: string | null
  EngineAssociation?: string | null
  id?: number
  isPinned?: number | null
  projectData?: string | null
  projectConfig?: string | null
  image?: string | null
  note?: string | null
  sort_order?: number | null
  created_at?: string
  updated_at?: string
}

const {
  projects,
  handleImportSingle,
  handleImportDirectory,
  filteredProjects,
  keyword,
  getProjectImage,
  loadAllProjects,
  loadFailed
} = useProjects()

// 自编译引擎的 EngineAssociation 是一串 GUID，卡片上要翻成 5.8 这样的版本号
const { ensureEngineLabels, engineLabel } = useEngineVersionLabel()
watch(
  projects,
  (list) => {
    void ensureEngineLabels(list.map((p: ProjectRecord) => p.EngineAssociation))
  },
  { immediate: true }
)

type ProjectCollectionRecord = {
  id?: number
  collectionKey: string
  name?: string | null
  description?: string | null
  color?: string | null
  icon?: string | null
  sort_order?: number | null
  isPinned?: number | null
  created_at?: string
  updated_at?: string
  items?: ProjectRecord[]
}

const collections = ref<ProjectCollectionRecord[]>([])
const projectsInCollections = ref<Set<string>>(new Set())
const isRefreshingProjects = ref(false)

// 正在打开的项目（用于显示加载动效）
const openingProjects = ref<Set<string>>(new Set())

// 初始化加载状态（防止初始动画闪烁）。两趟请求都回来了才放行 —— 只等收藏夹的话，
// 没建过收藏夹的用户几乎立刻就放行，而那时工程还没拉回来，空态会闪一下
// 「暂无项目，拖一个 .uproject 进来」，正好对着已经导入了十几个工程的人说。
const initLoading = ref(true)

const loadCollections = async () => {
  try {
    const ret = await window.api.database.projectCollection.getAll()
    const list = (ret as any)?.data || []
    // 映射项目缩略图 URL（数据库返回的可能是文件名或 远程图片 URL）
    const mapped = await Promise.all(
      list.map(async (c: ProjectCollectionRecord) => {
        const items = c.items || []
        const withThumbs = await Promise.all(
          items.map(async (p) => {
            const img = String(p.image || '')
            // 如果是完整 URL（http/https 或 file:///），直接使用
            if (
              img.startsWith('http://') ||
              img.startsWith('https://') ||
              img.startsWith('file:')
            ) {
              return p
            }
            // 否则是文件名，需要转换为 file:/// URL
            if (img) {
              const r = await window.api.path.getPublicThumbnailUrl(img)
              if (r?.success && r.data) {
                return { ...p, image: r.data }
              }
            }
            return p
          })
        )
        return { ...c, items: withThumbs }
      })
    )

    // 空分组也要留着：分组现在是用户自己建的，建完就是空的，等着往里拖工程
    collections.value = mapped

    projectsInCollections.value = new Set()
    collections.value.forEach((c: ProjectCollectionRecord) => {
      ;(c.items || []).forEach((p) => projectsInCollections.value.add(p.projectKey))
    })
  } catch (err) {
    // 静默失败即可
  }
}

const handleClickCreateProject = () => {
  createFromTemplateVisible.value = true
}

const refreshProjectSectionData = async () => {
  await Promise.all([loadAllProjects(), loadCollections()])
}

const reload = async () => {
  await refreshProjectSectionData()
}

const openImportModal = (): void => {
  importProjectVisible.value = true
}

defineExpose({ reload })

onMounted(async () => {
  // 订阅放在任何 await 之前：await 期间被卸载的话，onUnmounted 摘到的是 null，
  // 订阅随后才建起来 —— 再也摘不掉。
  //
  // 「我的项目」里多了工程就重读一遍。加工程不只发生在用户点导入的时候 ——
  // Agent 建的工程、UE 连上时补登记的工程，都在用户没操作这个页面的时候进库，
  // 不听这个事件的话卡片要等到下次切页面才出现
  unsubscribeLibraryChanged = window.api.database.project.onLibraryChanged(() => {
    // 首屏那一趟还在跑就别另起一趟：两边写同一个 projects ref，谁后回来谁说了算，
    // 慢的那趟（首屏要给每个工程拉缩略图）会把新工程盖没
    if (initLoading.value) return
    void refreshProjectSectionData()
  })

  try {
    await Promise.all([loadCollections(), loadAllProjects()])
    // 自编译引擎的版本号还要再去主进程查一趟。等它回来，恢复出来的版本筛选
    // 才对得上选项表 —— 否则校验会把「UE 5.8」当成不存在的版本清掉
    await ensureEngineLabels(projects.value.map((p: ProjectRecord) => p.EngineAssociation))
  } finally {
    // finally：哪一趟炸了都不能把页面永远停在骨架屏上
    initLoading.value = false
    // 数据齐了，从这一刻起筛选状态才接受「这个分组/版本还在不在」的校验
    filterRestored.value = true
  }
})

onUnmounted(() => {
  if (unsubscribeLibraryChanged) {
    unsubscribeLibraryChanged()
    unsubscribeLibraryChanged = null
  }
})

// ========================
// 分组筛选
// ========================

/** 「全部」和「未分组」不是真的合集，用这两个哨兵值占位 */
const FILTER_ALL = '__all__'
const FILTER_UNGROUPED = '__ungrouped__'

/**
 * 筛到哪一组、哪个版本要记住。
 *
 * 首页没有 keepAlive，切个标签就整个卸载 —— 用户点开「UE 5.5」，去助手问一句话
 * 再回来，看到的是全部工程，得重新找那颗按钮。搜索词不记：输入框是当场的动作，
 * 回来还留着反而像工程少了。
 */
const FILTER_STORAGE_KEY = 'home.projectFilter'

const readSavedFilter = (): { collection?: string; version?: string } => {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    const saved = raw ? JSON.parse(raw) : null
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    // 存的东西坏了就当没存过，不能让首页挂在这儿
    return {}
  }
}

const savedFilter = readSavedFilter()

const activeFilterKey = ref<string>(savedFilter.collection || FILTER_ALL)

/** 每个合集的成员 projectKey，筛选时用来过滤 */
const collectionMembers = computed(() => {
  const map = new Map<string, Set<string>>()
  collections.value.forEach((c) => {
    map.set(c.collectionKey, new Set((c.items || []).map((p) => p.projectKey)))
  })
  return map
})

/** 一个工程现在在哪几个分组里 —— 同一个工程可以既在「UE 5.5」又在「教学用」 */
const collectionsOfProject = (projectKey: string): ProjectCollectionRecord[] =>
  collections.value.filter((c) => (c.items || []).some((p) => p.projectKey === projectKey))

// ========================
// 引擎版本筛选
// ========================

const engineFilter = ref(savedFilter.version || '')

/**
 * 只列库里真有的版本。给一个点进去空空如也的「UE 5.2」，用户得先点一下才知道
 * 这里没有 5.2 的工程 —— 那一下是白点的。
 */
const engineOptions = computed(() => [
  { value: '', label: t('page.home.project.allEngineVersions') },
  ...Array.from(new Set(projects.value.map((p) => engineLabel(p.EngineAssociation))))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => ({
      value: version,
      label: version === 'N/A' ? t('page.home.project.unknownEngineVersion') : `UE ${version}`
    }))
])

/** 空态里要说人话：选的是「版本未知」时，不能写成「没有 UE N/A 的工程」 */
const engineFilterLabel = computed(
  () => engineOptions.value.find((option) => option.value === engineFilter.value)?.label ?? ''
)

/**
 * 版本选项是按当前解析出来的版本算的，库里没有这个版本了就别停在一个空筛选上。
 *
 * 首屏那阵子不能校验：工程、分组、自编译引擎的版本号是三趟异步回来的，
 * 校验跑在前头的话，刚恢复出来的「UE 5.8」会被一个还没凑齐的选项表判成不存在，
 * 当场清掉 —— 用户看到的就是「记住了个寂寞」。
 */
const filterRestored = ref(false)

const dropMissingEngineFilter = ([options, ready]: [Array<{ value: string }>, boolean]): void => {
  if (!ready) return
  if (!options.some((option) => option.value === engineFilter.value)) engineFilter.value = ''
}

watch([engineOptions, filterRestored], dropMissingEngineFilter)

/**
 * 搜索词和版本一起收窄。分组按钮的计数和网格里的卡片都读这一份 ——
 * 两边算的不是同一批工程的话，按钮上标着 6、点进去只有 2，那个 6 就是在骗人。
 */
const searchedProjects = computed(() => {
  const version = engineFilter.value
  if (!version) return filteredProjects.value
  return filteredProjects.value.filter((p) => engineLabel(p.EngineAssociation) === version)
})

// 当前筛选下该显示哪些工程。搜索和筛选是叠加的：选了 5.6 再搜，就只在这一组里搜
const baseProjects = computed(() => {
  const list = searchedProjects.value
  const active = activeFilterKey.value
  if (active === FILTER_ALL) return list
  if (active === FILTER_UNGROUPED) {
    return list.filter((p) => !projectsInCollections.value.has(p.projectKey))
  }
  const members = collectionMembers.value.get(active)
  if (!members) return list
  return list.filter((p) => members.has(p.projectKey))
})

// 排序后的项目列表（用于拖拽排序）
const sortedProjectKeys = ref<string[]>([])

// 实际显示的项目列表（支持置顶+排序）
const visibleProjects = computed(() => {
  // 如果还没有初始化排序，使用原始顺序
  if (sortedProjectKeys.value.length === 0) {
    return baseProjects.value
  }

  // 根据sortedProjectKeys排序
  const projectMap = new Map(baseProjects.value.map((p) => [p.projectKey, p]))
  const sorted: ProjectRecord[] = []

  sortedProjectKeys.value.forEach((key) => {
    const proj = projectMap.get(key)
    if (proj) {
      sorted.push(proj)
      projectMap.delete(key)
    }
  })

  // 添加新项目（不在sortedProjectKeys中的）
  projectMap.forEach((proj) => sorted.push(proj))

  // 分离置顶和非置顶项目
  const pinnedProjects = sorted.filter((p) => p.isPinned === 1)
  const normalProjects = sorted.filter((p) => p.isPinned !== 1)

  // 置顶项目在前，非置顶项目在后
  return rankProjectSearch([...pinnedProjects, ...normalProjects], keyword.value)
})

// ========================
// 分组筛选条
// ========================

type FilterChip = {
  key: string
  label: string
  title: string
  count: number
  /** 真合集才有；「全部」「未分组」是 null */
  collectionKey: string | null
}

/**
 * 筛选按钮。个数按当前的搜索词和版本筛选算 —— 搜「real」的时候还标着
 * 「UE 5.5 · 15」，点进去只有 2 个，那个 15 就是在骗人。
 */
const filterChips = computed<FilterChip[]>(() => {
  const list = searchedProjects.value
  const chips: FilterChip[] = [
    {
      key: FILTER_ALL,
      label: t('page.home.project.collection.filterAll'),
      title: t('page.home.project.collection.filterAll'),
      count: list.length,
      collectionKey: null
    }
  ]

  collections.value.forEach((col) => {
    const members = collectionMembers.value.get(col.collectionKey)
    const name = col.name || t('page.home.project.unnamedCollection')
    chips.push({
      key: col.collectionKey,
      label: name,
      title: t('page.home.project.collection.filterHint', { name }),
      count: members ? list.filter((p) => members.has(p.projectKey)).length : 0,
      collectionKey: col.collectionKey
    })
  })

  const ungrouped = list.filter((p) => !projectsInCollections.value.has(p.projectKey)).length
  // 一个分组都没有的时候不必单列「未分组」，那等于把「全部」说两遍
  if (collections.value.length) {
    chips.push({
      key: FILTER_UNGROUPED,
      label: t('page.home.project.collection.filterUngrouped'),
      title: t('page.home.project.collection.filterUngroupedHint'),
      count: ungrouped,
      collectionKey: null
    })
  }

  return chips
})

// 分组没了（解散、或者成员被移光）就别停在一个不存在的筛选上。
// 同样要等首屏数据齐了再校验，否则恢复出来的分组会被一张空的分组表判死
const dropMissingCollectionFilter = ([chips, ready]: [FilterChip[], boolean]): void => {
  if (!ready) return
  if (!chips.some((chip) => chip.key === activeFilterKey.value)) {
    activeFilterKey.value = FILTER_ALL
  }
}

watch([filterChips, filterRestored], dropMissingCollectionFilter)

// 用户自己切了筛选才存，恢复的那一下写回同样的值也无所谓
watch([activeFilterKey, engineFilter], ([collection, version]) => {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ collection, version }))
  } catch {
    // 存不下就算了，筛选状态丢了远不如把页面崩掉严重
  }
})

const handleClickFilter = (chip: FilterChip): void => {
  // 再点一下已选中的分组＝回到全部，省得专门去够「全部」那颗
  activeFilterKey.value = activeFilterKey.value === chip.key ? FILTER_ALL : chip.key
}

// 拖工程到分组按钮上＝加进这个分组（原来的分组还留着）；拖到「未分组」上＝退出所有分组
const dragOverFilterKey = ref<string | null>(null)

/**
 * 每次 dragover 都必须重新写一遍 dropEffect：不写的话 Chromium 按默认的 copy 去跟
 * effectAllowed('move') 对，对不上就落成 none —— 光标变成禁用图标，drop 事件干脆不发。
 * 「全部」不是一个能放东西的地方，那里就显式回一个 none，禁用图标正是对的反馈。
 */
const handleDragOverFilter = (e: DragEvent, chip: FilterChip): void => {
  if (!draggingProjectKey.value) return
  if (chip.key === FILTER_ALL) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    return
  }
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverFilterKey.value = chip.key
}

const handleDragLeaveFilter = (): void => {
  dragOverFilterKey.value = null
}

const handleDropOnFilter = async (e: DragEvent, chip: FilterChip): Promise<void> => {
  const projectKey = draggingProjectKey.value || e.dataTransfer?.getData('text/project-key') || ''
  dragOverFilterKey.value = null
  draggingProjectKey.value = null
  if (!projectKey || chip.key === FILTER_ALL) return

  if (chip.key === FILTER_UNGROUPED) {
    await removeProjectFromCollection(projectKey)
    return
  }
  await addProjectToCollection(projectKey, chip.key)
}

const addProjectToCollection = async (projectKey: string, collectionKey: string): Promise<void> => {
  try {
    const ret = await window.api.database.projectCollection.addProject(projectKey, collectionKey)
    const res = ret as { success?: boolean; data?: boolean } | boolean
    const ok = typeof res === 'boolean' ? res : Boolean(res?.success && res?.data)
    if (ok) {
      message.success(t('page.home.project.joinedCollection'))
      await refreshProjectSectionData()
    } else {
      message.error(t('page.home.project.joinCollectionFailed'))
    }
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error ? error.message : t('page.home.project.joinCollectionFailed')
    message.error(errMsg)
  }
}

/**
 * 把工程移出分组。不给 collectionKey 就是退出它所在的全部分组（拖到「未分组」上
 * 就是这个意思）。分组本身留着（哪怕空了）—— 它是用户自己建的，该不该留是用户的事，
 * 右键「解散分组」才是删它的入口。
 */
const removeProjectFromCollection = async (
  projectKey: string,
  collectionKey?: string | null
): Promise<void> => {
  const owners = collectionsOfProject(projectKey)
  if (!owners.length) return
  if (collectionKey && !owners.some((c) => c.collectionKey === collectionKey)) return

  try {
    const res = await window.api.database.projectCollection.removeProject(projectKey, collectionKey)
    const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
    if (!ok) {
      message.error(t('page.home.project.messages.removeFromCollectionFailed'))
      return
    }

    message.success(t('page.home.project.messages.removeFromCollectionSuccess'))
    await refreshProjectSectionData()
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error
        ? error.message
        : t('page.home.project.messages.removeFromCollectionFailed')
    message.error(errMsg)
  }
}

// 分组按钮的右键菜单：重命名 / 解散
const filterContextMenuRef = ref<{ show: (x: number, y: number) => void } | null>(null)
const activeFilterChip = ref<FilterChip | null>(null)

const filterMenuItems = computed<MenuItem[]>(() => [
  { key: 'rename-collection', label: t('page.home.project.menu.rename'), icon: PhPencilSimple },
  {
    key: 'dissolve-collection',
    label: t('page.home.project.collection.dissolve'),
    icon: PhSelectionSlash,
    danger: true
  }
])

const handleFilterContextMenu = (e: MouseEvent, chip: FilterChip): void => {
  // 「全部」「未分组」不是真分组，没有可改的东西
  if (!chip.collectionKey) return
  e.stopPropagation()
  activeFilterChip.value = chip
  filterContextMenuRef.value?.show(e.clientX, e.clientY)
}

const handleFilterMenuClick = async (key: string): Promise<void> => {
  const chip = activeFilterChip.value
  if (!chip?.collectionKey) return
  const collectionKey = chip.collectionKey

  if (key === 'rename-collection') {
    openCollectionModal(collectionKey, chip.label)
    return
  }

  if (key === 'dissolve-collection') {
    // 空分组里什么都没有，解散它没有任何东西可丢 —— 问一句纯属挡路。
    // 注意用真实成员数，chip.count 是跟着搜索词走的，搜不到不等于里面没有。
    const memberCount = collectionMembers.value.get(collectionKey)?.size ?? 0
    if (memberCount === 0) {
      await dissolveCollection(collectionKey)
      return
    }
    confirmDialog({
      title: t('page.home.project.collection.dissolveTitle', { name: chip.label }),
      content: t('page.home.project.collection.dissolveContent'),
      okText: t('page.home.project.collection.dissolve'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk: () => dissolveCollection(collectionKey)
    })
  }
}

const dissolveCollection = async (collectionKey: string): Promise<void> => {
  try {
    // 这个接口会先把成员全部放回「未分组」，再删掉分组本身；工程一个都不会丢
    const res = await window.api.database.projectCollection.delete(collectionKey)
    const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
    if (!ok) {
      message.error(t('page.home.project.collection.dissolveFailed'))
      return
    }
    message.success(t('page.home.project.collection.dissolveSuccess'))
    await refreshProjectSectionData()
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error ? error.message : t('page.home.project.collection.dissolveFailed')
    message.error(errMsg)
  }
}

// 分组取名弹窗：collectionModalKey 有值就是改名，null 就是新建
const collectionModalVisible = ref(false)
const collectionModalName = ref('')
const collectionModalKey = ref<string | null>(null)

const openCollectionModal = (collectionKey: string | null, name: string): void => {
  collectionModalKey.value = collectionKey
  collectionModalName.value = name
  collectionModalVisible.value = true
}

/**
 * 刚建好的分组是空的。直接选中它，用户看到的是空态里那句「把工程拖到分组按钮上」，
 * 而不是回到全部、自己猜下一步该干嘛。改名不动当前筛选。
 */
const handleCollectionNameSuccess = async (payload: {
  collectionKey: string
  created: boolean
}): Promise<void> => {
  await refreshProjectSectionData()
  if (payload.created) {
    activeFilterKey.value = payload.collectionKey
  }
}

// 监听baseProjects变化，更新sortedProjectKeys
watch(
  baseProjects,
  (newProjects) => {
    const currentKeys = new Set(sortedProjectKeys.value)
    const newKeys = newProjects.map((p) => p.projectKey)
    const newKeySet = new Set(newKeys)

    // 检查是否有新增或删除的项目
    const hasChanges =
      newKeys.length !== sortedProjectKeys.value.length ||
      newKeys.some((k) => !currentKeys.has(k)) ||
      sortedProjectKeys.value.some((k) => !newKeySet.has(k))

    // 只在首次初始化或项目列表有增删时更新
    if (sortedProjectKeys.value.length === 0 || hasChanges) {
      // 分离置顶和非置顶项目
      const pinnedProjects = newProjects.filter((p) => p.isPinned === 1)
      const normalProjects = newProjects.filter((p) => p.isPinned !== 1)

      // 分别按sort_order排序
      const sortByOrder = (a: ProjectRecord, b: ProjectRecord) => {
        const orderA = a.sort_order ?? 0
        const orderB = b.sort_order ?? 0
        return orderA - orderB
      }

      pinnedProjects.sort(sortByOrder)
      normalProjects.sort(sortByOrder)

      // 合并：置顶在前
      sortedProjectKeys.value = [
        ...pinnedProjects.map((p) => p.projectKey),
        ...normalProjects.map((p) => p.projectKey)
      ]
    }
  },
  { immediate: true }
)

// 拖拽交互：项目拖到分组按钮上
const draggingProjectKey = ref<string | null>(null)

/**
 * 拖着走的时候跟在光标边上的那个小条。原来是把整张卡片缩一缩当拖拽影像，
 * 二百多像素的图片糊在光标下面，正好挡住要拖去的那个分组按钮。
 * 资产库拖资产到文件夹就是这么做的：系统影像置空，自己画一个小标签。
 */
const dragOverlayVisible = ref(false)
const dragOverlayText = ref('')

/**
 * 拖拽开始时记录被拖拽的项目
 */
const handleDragStartProject = (e: DragEvent, item: ProjectRecord): void => {
  draggingProjectKey.value = item.projectKey

  if (e.dataTransfer) {
    // 1x1 的透明画布把系统默认的拖拽影像顶掉
    const emptyCanvas = document.createElement('canvas')
    emptyCanvas.width = 1
    emptyCanvas.height = 1
    e.dataTransfer.setDragImage(emptyCanvas, 0, 0)
    e.dataTransfer.effectAllowed = 'move'
    // 便于在 drop 端读取
    try {
      e.dataTransfer.setData('text/project-key', item.projectKey)
    } catch {
      // 忽略错误
    }
  }

  dragOverlayText.value = item.projectName || t('page.home.project.unnamedProject')
  dragOverlayVisible.value = true
}

const handleDragEndProject = (): void => {
  dragOverlayVisible.value = false
  dragOverlayText.value = ''
  draggingProjectKey.value = null
  dragOverFilterKey.value = null
  insertPosition.value = null
}

// ========================
// 拖拽排序功能
// ========================

// 拖拽排序状态
const insertPosition = ref<number | null>(null) // 插入位置索引

/**
 * 处理grid的dragover事件，检测插入位置
 * 修复：使用最近距离算法替代简单的线性扫描，解决多行Grid排序错乱问题
 */
const handleGridDragOver = (e: DragEvent): void => {
  if (!draggingProjectKey.value) return

  // 网格里松手是排序，同样得把 dropEffect 写成 move，否则光标一路都是禁用图标
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  // 获取mixed-grid中只包含project-card的元素
  const target = e.target as HTMLElement
  const grid = target.closest('.mixed-grid') as HTMLElement
  if (!grid) return

  const projectCards = Array.from(grid.querySelectorAll('.project-card'))

  if (projectCards.length === 0) {
    insertPosition.value = null
    return
  }

  // 寻找距离鼠标最近的卡片
  let closestIndex = -1
  let minDistance = Infinity

  for (let i = 0; i < projectCards.length; i++) {
    const card = projectCards[i] as HTMLElement
    const rect = card.getBoundingClientRect()

    // 计算卡片中心点
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    // 计算鼠标到卡片中心的距离（平方）
    const dist = Math.pow(e.clientX - cx, 2) + Math.pow(e.clientY - cy, 2)

    if (dist < minDistance) {
      minDistance = dist
      closestIndex = i
    }
  }

  // 根据相对于最近卡片的位置确定插入点
  if (closestIndex !== -1) {
    const closestCard = projectCards[closestIndex] as HTMLElement
    const rect = closestCard.getBoundingClientRect()
    const cx = rect.left + rect.width / 2

    // 如果鼠标在卡片中心左侧，插入到该卡片前；否则插入到该卡片后
    if (e.clientX < cx) {
      insertPosition.value = closestIndex
    } else {
      insertPosition.value = closestIndex + 1
    }
  } else {
    insertPosition.value = projectCards.length
  }
}

/**
 * 处理grid的drop事件，执行排序
 */
const handleGridDrop = async (): Promise<void> => {
  if (insertPosition.value === null || !draggingProjectKey.value) {
    insertPosition.value = null
    return
  }

  const dragKey = draggingProjectKey.value
  const newIndex = insertPosition.value

  // 找到draggingProject在当前数组中的索引
  const currentIndex = sortedProjectKeys.value.indexOf(dragKey)

  if (currentIndex === -1) {
    insertPosition.value = null
    return
  }

  // 重新排列数组
  const newKeys = [...sortedProjectKeys.value]
  // 移除原位置
  newKeys.splice(currentIndex, 1)
  // 插入新位置
  const adjustedIndex = newIndex > currentIndex ? newIndex - 1 : newIndex
  newKeys.splice(adjustedIndex, 0, dragKey)

  // 更新排序
  sortedProjectKeys.value = newKeys

  // 持久化到数据库：分别处理置顶和非置顶项目
  try {
    // 获取所有项目，区分置顶和非置顶
    const allProjects = baseProjects.value
    const projectMap = new Map(allProjects.map((p) => [p.projectKey, p]))

    const pinnedKeys: string[] = []
    const normalKeys: string[] = []

    newKeys.forEach((key) => {
      const project = projectMap.get(key)
      if (project) {
        if (project.isPinned === 1) {
          pinnedKeys.push(key)
        } else {
          normalKeys.push(key)
        }
      }
    })

    // 分别更新置顶和非置顶项目的sort_order
    const updates: Array<{ key: string; sort_order: number }> = []

    pinnedKeys.forEach((key, index) => {
      updates.push({ key, sort_order: index })
    })

    normalKeys.forEach((key, index) => {
      updates.push({ key, sort_order: index })
    })

    // 批量更新
    for (const { key, sort_order } of updates) {
      await window.api.database.project.update(key, { sort_order } as any)
    }
  } catch (error) {
    console.error('保存排序失败:', error)
  }

  // 清除状态
  insertPosition.value = null
}

// 右键菜单逻辑
const contextMenuRef = ref<{ show: (x: number, y: number) => void } | null>(null)
const activeProject = ref<ProjectRecord | null>(null)
const blankContextMenuRef = ref<{ show: (x: number, y: number) => void } | null>(null)

// 当前项目的 sln 文件路径（如果是 C++ 工程）
const activeSlnPath = ref<string | null>(null)

// 当前项目的 UnrealAgentLink 状态，决定右键菜单显示「安装」还是「移除」
const activeUalinkStatus = ref<UnrealAgentLinkStatus | null>(null)

const menuItems = ref<MenuItem[]>([])

const blankMenuItems = computed<MenuItem[]>(() => [
  { key: 'import-project', label: t('page.home.project.menu.import'), icon: PhFolderOpen },
  { key: 'create-project', label: t('page.home.project.menu.create'), icon: PhPlus },
  {
    key: 'create-collection',
    label: t('page.home.project.menu.createCollection'),
    icon: PhFolderPlus
  }
])

/**
 * 构建项目右键菜单项
 * 菜单分为三个功能区，用分割线隔开：
 * - 第一区：高频启动与访问（打开工程、打开sln工程、打开目录）
 * - 第二区：项目管理与整理（置顶项目、重命名、更换封面）
 * - 第三区：危险/破坏性操作（移除项目）
 * @param pinned - 是否已置顶
 * @param slnPath - sln 文件路径（C++ 工程）
 * @param ualink - UnrealAgentLink 状态，null 表示还没查出来
 * @param memberships - 这个工程所在的分组，每个给一条「移出「XXX」」
 */
const buildMenuItems = (
  pinned: boolean,
  slnPath: string | null,
  ualink: UnrealAgentLinkStatus | null,
  memberships: ProjectCollectionRecord[]
): MenuItem[] => {
  const items: MenuItem[] = [
    // === 第一区：高频启动与访问 ===
    { key: 'open-project', label: t('page.home.project.menu.open'), icon: PhPlayCircle }
  ]

  // 如果是 C++ 工程（存在 sln 文件），添加"打开 sln"菜单项
  if (slnPath) {
    items.push({ key: 'open-sln', label: t('page.home.project.menu.openSln'), icon: PhCode })
  }

  items.push(
    {
      key: 'open-location',
      label: t('page.home.project.menu.openLocation'),
      icon: PhFolderOpen
    },
    { type: 'divider' },
    // === 第二区：项目管理与整理 ===
    {
      key: 'pin',
      label: pinned ? t('page.home.project.menu.unpin') : t('page.home.project.menu.pin'),
      icon: PhPushPin
    },
    { key: 'rename', label: t('page.home.project.menu.rename'), icon: PhPencilSimple },
    { key: 'change-cover', label: t('page.home.project.menu.changeCover'), icon: PhImage }
  )

  // UnrealAgentLink 的装/删。状态还没查出来时先不显示，免得闪一下改文案
  if (ualink) {
    items.push(
      ualink.installed
        ? {
            key: 'ualink-remove',
            label: t('page.home.project.menu.ualinkRemove'),
            icon: PhPlugs
          }
        : {
            key: 'ualink-install',
            label: t('page.home.project.menu.ualinkInstall'),
            icon: PhPlugs
          }
    )
  }

  // 「移出分组」只是把工程放回外面，工程本身还在库里，所以不算破坏性操作。
  // 一个工程可以同时在几个分组里，所以每个分组各给一条 —— 点哪条退哪个组，
  // 不用先切到那个分组再来右键
  for (const collection of memberships) {
    items.push({
      key: `remove-from-collection:${collection.collectionKey}`,
      label: t('page.home.project.menu.removeFromNamedCollection', {
        name: collection.name || t('page.home.project.unnamedCollection')
      }),
      icon: PhFolderMinus
    })
  }

  items.push(
    { type: 'divider' },
    // === 第三区：危险/破坏性操作 ===
    { key: 'remove', label: t('page.home.project.menu.remove'), icon: PhTrash, danger: true }
  )

  return items
}

/**
 * 处理项目右键菜单
 * 异步检测是否为 C++ 工程（目录下是否有 .sln 文件）
 */
const handleProjectContextMenu = async (e: MouseEvent, item: ProjectRecord): Promise<void> => {
  e.preventDefault()
  e.stopPropagation()
  activeProject.value = item
  activeSlnPath.value = null // 重置 sln 路径
  activeUalinkStatus.value = null

  // 根据置顶状态更新菜单文案
  const pinned = Number(item.isPinned || 0) === 1
  const memberships = collectionsOfProject(item.projectKey)

  // 先显示基础菜单（不含 sln 与插件选项）
  menuItems.value = buildMenuItems(pinned, null, null, memberships)
  contextMenuRef.value?.show(e.clientX, e.clientY)

  // 异步检测是否为 C++ 工程
  const projectDir = item.projectPath
  if (projectDir) {
    try {
      const result = await window.api.database.project.findSlnFile(projectDir)
      if (result?.success && result.data) {
        activeSlnPath.value = result.data
      }
    } catch (error) {
      // 静默处理错误，不影响菜单显示
      console.warn('检测 sln 文件失败:', error)
    }
  }

  // 异步查 UnrealAgentLink 状态
  const uprojectPath = item.originPath
  if (uprojectPath) {
    try {
      const result = await window.api.database.project.ualinkStatus(uprojectPath)
      if (result?.success && result.data) {
        activeUalinkStatus.value = result.data
      }
    } catch (error) {
      console.warn('检测 UnrealAgentLink 状态失败:', error)
    }
  }

  menuItems.value = buildMenuItems(
    pinned,
    activeSlnPath.value,
    activeUalinkStatus.value,
    memberships
  )
}

const createFromTemplateVisible = ref(false)
const importProjectVisible = ref(false)

const handleBlankAreaContextMenu = (e: MouseEvent) => {
  // 若右键发生在项目卡片内，交由项目菜单处理
  const target = e.target as HTMLElement
  if (target && (target.closest('.project-card') || target.closest('.filter-chip'))) return
  blankContextMenuRef.value?.show(e.clientX, e.clientY)
}

const handleBlankMenuClick = async (key: string) => {
  if (key === 'import-project') {
    try {
      await handleImportSingle()
      await loadAllProjects()
    } catch (err: any) {
      message.error(err?.message || '导入工程失败')
    }
  } else if (key === 'create-project') {
    createFromTemplateVisible.value = true
  } else if (key === 'create-collection') {
    handleCreateCollection()
  }
}

const handleCreateFromTemplateSuccess = async () => {
  await loadAllProjects()
}

const handleCreateCollection = (): void => openCollectionModal(null, '')

// 重命名弹窗
const renameVisible = ref(false)
const renameInput = ref('')

// ==================== 更换封面相关 ====================

// 裁剪弹窗状态
const cropperModalVisible = ref(false)
const cropperImage = ref<string>('')
const cropperRef = ref<InstanceType<typeof VueCropper> | null>(null)
const coverUploading = ref(false)

const renderCleanupPreview = (summary: string, lines: string[], moreText?: string) =>
  h('div', { style: 'display: grid; gap: 8px;' }, [
    h('div', summary),
    ...lines.map((line) =>
      h(
        'div',
        {
          style:
            'font-size: 12px; line-height: 1.5; color: var(--color-text-primary); word-break: break-all;'
        },
        line
      )
    ),
    ...(moreText
      ? [h('div', { style: 'font-size: 12px; color: var(--color-text-muted);' }, moreText)]
      : [])
  ])

const getProjectValidationTarget = (project: ProjectRecord): string =>
  String(project.originPath || project.projectPath || '').trim()

const inspectInvalidProjects = async (): Promise<ProjectRecord[]> => {
  const projectList = [...projects.value]
  const validity = await Promise.all(
    projectList.map(async (project) => {
      const targetPath = getProjectValidationTarget(project)
      if (!targetPath) return false

      try {
        const stats = await window.api.getFileStats(targetPath)
        return Boolean(stats?.isFile || stats?.isDirectory)
      } catch {
        return false
      }
    })
  )

  return projectList.filter((_, index) => !validity[index])
}

const handleRefreshProjects = async (): Promise<void> => {
  if (isRefreshingProjects.value) return

  isRefreshingProjects.value = true
  try {
    await refreshProjectSectionData()
    const invalidProjects = await inspectInvalidProjects()

    if (invalidProjects.length === 0) {
      message.success(t('page.home.project.messages.cleanupNone'))
      return
    }

    const previewLines = invalidProjects.slice(0, 5).map((project) => {
      const projectName = project.projectName || t('page.home.project.unnamedProject')
      return `${projectName}  ${getProjectValidationTarget(project) || 'N/A'}`
    })
    const moreCount = invalidProjects.length - previewLines.length

    confirmDialog({
      title: t('page.home.project.messages.cleanupConfirmTitle', {
        count: invalidProjects.length
      }),
      content: renderCleanupPreview(
        t('page.home.project.messages.cleanupConfirmContent'),
        previewLines,
        moreCount > 0
          ? t('page.home.project.messages.cleanupMore', { count: moreCount })
          : undefined
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      async onOk() {
        const results = await Promise.all(
          invalidProjects.map((project) => window.api.database.project.delete(project.projectKey))
        )
        const removedCount = results.filter((result) =>
          typeof result === 'boolean' ? result : Boolean((result as { success?: boolean })?.success)
        ).length

        await refreshProjectSectionData()

        if (removedCount > 0) {
          message.success(t('page.home.project.messages.cleanupSuccess', { count: removedCount }))
          return
        }

        message.error(t('page.home.project.messages.cleanupFailed'))
      }
    })
  } catch (error) {
    console.error('[ProjectSection] Failed to refresh projects:', error)
    message.error(t('page.home.project.messages.cleanupFailed'))
  } finally {
    isRefreshingProjects.value = false
  }
}

/**
 * 从项目里移除 UnrealAgentLink。
 *
 * 要弹确认框 —— 它会删文件、改 .uproject，而且之后不再自动装回来，
 * 这三件事用户都该先知道。
 */
const handleUalinkRemove = async (project: ProjectRecord): Promise<void> => {
  const uprojectPath = project.originPath
  if (!uprojectPath) {
    message.warning(t('page.home.project.messages.pathNotFound'))
    return
  }

  confirmDialog({
    title: t('page.home.project.ualink.removeTitle'),
    content: t('page.home.project.ualink.removeContent'),
    okText: t('common.confirm'),
    cancelText: t('common.cancel'),
    danger: true,
    async onOk() {
      try {
        const result = await window.api.database.project.ualinkRemove(uprojectPath)
        if (result?.success) {
          message.success(t('page.home.project.ualink.removeSuccess'))
        } else {
          message.error(result?.error || t('page.home.project.ualink.removeFailed'))
        }
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : t('page.home.project.ualink.removeFailed')
        message.error(errMsg)
      }
    }
  })
}

/** 把 UnrealAgentLink 装回项目（同时撤销之前的「不要装」） */
const handleUalinkInstall = async (project: ProjectRecord): Promise<void> => {
  const uprojectPath = project.originPath
  if (!uprojectPath) {
    message.warning(t('page.home.project.messages.pathNotFound'))
    return
  }

  const hide = message.loading(t('page.home.project.ualink.installing'), 0)
  try {
    const result = await window.api.database.project.ualinkInstall(uprojectPath)
    hide()
    if (result?.success) {
      message.success(t('page.home.project.ualink.installSuccess'))
    } else {
      message.error(result?.error || t('page.home.project.ualink.installFailed'))
    }
  } catch (error: unknown) {
    hide()
    const errMsg =
      error instanceof Error ? error.message : t('page.home.project.ualink.installFailed')
    message.error(errMsg)
  }
}

const handleMenuClick = async (key: string) => {
  if (!activeProject.value) return
  if (key === 'rename') {
    renameInput.value = activeProject.value.projectName || ''
    renameVisible.value = true
  } else if (key === 'open-project') {
    await handleOpenProject(activeProject.value)
  } else if (key === 'open-sln') {
    // 打开 sln 工程（C++ 项目）
    if (!activeSlnPath.value) {
      message.warning(t('page.home.project.messages.slnNotFound'))
      return
    }
    try {
      const res = await window.api.invoke('shell:openPath', activeSlnPath.value)
      const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
      if (!ok) {
        const err = (res as { error?: string })?.error || t('page.home.project.messages.openFailed')
        message.error(err)
      }
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : t('page.home.project.messages.openSlnError')
      message.error(errMsg)
    }
  } else if (key === 'ualink-remove') {
    await handleUalinkRemove(activeProject.value)
  } else if (key === 'ualink-install') {
    await handleUalinkInstall(activeProject.value)
  } else if (key === 'open-location') {
    const target = activeProject.value.originPath || activeProject.value.projectPath
    if (!target) {
      message.warning(t('page.home.project.messages.pathNotFound'))
      return
    }
    try {
      // 返回值必须看：shell:* 失败时是 return {success:false}，不抛
      const res = await window.api.invoke('shell:showItemInFolder', target)
      if (!res?.success) {
        message.error(`${t('page.home.project.messages.openLocationError')}: ${target}`, 8)
      }
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : t('page.home.project.messages.openLocationError')
      message.error(errMsg)
    }
  } else if (key === 'pin') {
    const pinned = Number(activeProject.value.isPinned || 0) === 1
    try {
      const res = await window.api.database.project.update(activeProject.value.projectKey, {
        isPinned: pinned ? 0 : 1
      })
      const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
      if (ok) {
        message.success(
          pinned
            ? t('page.home.project.messages.unpinSuccess')
            : t('page.home.project.messages.pinSuccess')
        )
        // 合集里的卡片也带置顶标记，只重读工程的话展开的那一排不会更新
        await refreshProjectSectionData()
      } else {
        message.error(t('page.home.project.messages.updatePinFailed'))
      }
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : t('page.home.project.messages.updatePinError')
      message.error(errMsg)
    }
  } else if (key === 'remove') {
    const res = await window.api.database.project.delete(activeProject.value.projectKey)
    const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
    if (ok) {
      message.success(t('page.home.project.messages.removeSuccess'))
      await refreshProjectSectionData()
    } else {
      message.error(t('page.home.project.messages.removeFailed'))
    }
  } else if (key.startsWith('remove-from-collection:')) {
    await removeProjectFromCollection(
      activeProject.value.projectKey,
      key.slice('remove-from-collection:'.length)
    )
  } else if (key === 'change-cover') {
    // 直接打开文件选择器
    handleSelectCoverFile()
  }
}

const handleRenameSuccess = async () => {
  // 改的可能是合集里的工程，两边的名字都得跟着变
  await refreshProjectSectionData()
}

/**
 * 打开文件选择器选择封面图片
 */
const handleSelectCoverFile = async (): Promise<void> => {
  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('page.home.project.messages.selectCoverTitle'),
      properties: ['openFile'],
      filters: [
        {
          name: t('page.home.project.messages.imageFile'),
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif']
        }
      ]
    })
    if (result?.canceled || !result?.filePaths?.[0]) return

    const filePath = result.filePaths[0]
    // 读取文件内容并转为 base64 供裁剪器显示
    const fileData = await (window as any).api.fs.readFile(filePath, {
      encoding: 'base64',
      maxLines: -1,
      maxBytes: -1
    })

    if (fileData?.success && fileData.content) {
      // 获取文件扩展名
      const ext = filePath.split('.').pop()?.toLowerCase() || 'jpeg'
      const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
      cropperImage.value = `data:${mimeType};base64,${fileData.content}`
      cropperModalVisible.value = true
    } else {
      message.error(t('page.home.project.messages.readImageFailed'))
    }
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error ? error.message : t('page.home.project.messages.selectFileFailed')
    message.error(errMsg)
  }
}

/**
 * 确认裁剪并保存封面到本地
 */
const handleCropConfirm = async (): Promise<void> => {
  if (!activeProject.value || !cropperRef.value) {
    cropperModalVisible.value = false
    return
  }

  try {
    coverUploading.value = true

    // 获取裁剪后的图片 blob
    const blob: Blob = await new Promise<Blob>((resolve) => {
      cropperRef.value!.getCropBlob((data: Blob) => resolve(data))
    })

    // 转换为 Uint8Array，再转为 number[] 以便 IPC 传输
    const arrayBuffer = await blob.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    const imageData = Array.from(uint8Array)

    // 保存到本地公共 thumbnails 目录
    const saveRes = await window.api.path.savePublicThumbnail(imageData, 'project_cover')
    if (!saveRes?.success || !saveRes.data) {
      message.error(t('page.home.project.messages.coverSaveFailed'))
      return
    }

    // 保存文件名到数据库
    const res = await window.api.database.project.update(activeProject.value.projectKey, {
      image: saveRes.data // 存储文件名，读取时会转换为 file:/// URL
    })
    const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
    if (ok) {
      message.success(t('page.home.project.messages.coverUpdated'))
      await loadAllProjects()
      await loadCollections()
    } else {
      message.error(t('page.home.project.messages.coverSaveFailed'))
    }
  } catch (error: unknown) {
    console.error('保存封面失败:', error)
    const errMsg =
      error instanceof Error ? error.message : t('page.home.project.messages.coverUploadFailed')
    message.error(errMsg)
  } finally {
    coverUploading.value = false
    cropperModalVisible.value = false
    cropperImage.value = ''
  }
}

/**
 * 取消裁剪
 */
const handleCropCancel = (): void => {
  cropperModalVisible.value = false
  cropperImage.value = ''
}

// 双击运行 .uproject 文件（通过 IPC 调用主进程）
const handleOpenProject = async (item: ProjectRecord) => {
  const target = item.originPath
  if (!target) {
    message.warning(t('page.home.project.messages.uprojectNotFound'))
    return
  }

  // 如果工程已连接，弹出确认框
  if (isProjectConnected(item.projectName)) {
    confirmDialog({
      title: t('actionToast.project.alreadyRunning'),
      content: `"${item.projectName}" 已启动，是否再次启动该工程？`,
      okText: t('actionToast.project.launch'),
      cancelText: t('common.cancel'),
      centered: true,
      onOk: () => doOpenProject(item.projectKey, target)
    })
    return
  }

  // 直接打开工程
  await doOpenProject(item.projectKey, target)
}

/**
 * 工程文件已经不在磁盘上：告诉用户是什么情况，顺手给一个「从列表移除」的出口，
 * 不然这条记录留在首页，每次点都只弹一句系统的 "Failed to open path"。
 */
const promptProjectMissing = (projectKey: string, target: string): void => {
  confirmDialog({
    title: t('page.home.project.messages.projectMissingTitle'),
    content: t('page.home.project.messages.projectMissingContent', { path: target }),
    okText: t('page.home.project.messages.projectMissingRemove'),
    cancelText: t('common.cancel'),
    centered: true,
    async onOk() {
      const res = await window.api.database.project.delete(projectKey)
      const ok = typeof res === 'boolean' ? res : Boolean((res as { success?: boolean })?.success)
      if (!ok) {
        message.error(t('page.home.project.messages.removeFailed'))
        return
      }
      await refreshProjectSectionData()
      message.success(t('page.home.project.messages.removeSuccess'))
    }
  })
}

/**
 * 实际执行打开工程的逻辑
 */
const doOpenProject = async (projectKey: string, target: string) => {
  // 设置加载状态
  openingProjects.value.add(projectKey)

  try {
    const res = await window.api.invoke('shell:openUproject', target)
    const ok = typeof res === 'boolean' ? res : Boolean((res as any)?.success)
    if (!ok) {
      if ((res as { pathNotFound?: boolean } | null)?.pathNotFound) {
        openingProjects.value.delete(projectKey)
        promptProjectMissing(projectKey, target)
        return
      }
      const err = (res as any)?.error || '运行失败'
      message.error(err)
      // 如果失败，立即清除加载状态
      openingProjects.value.delete(projectKey)
    } else {
      // 工程打开了，但插件没装上 —— 这是 AI 之后连不上引擎的唯一线索。
      // 带上 target（.uproject 路径）：用户选「让 AI 看看」时，AI 要去读这个文件
      notifyPluginInstallFailure({
        pluginFailure: (res as { pluginFailure?: string } | null)?.pluginFailure,
        data: { originPath: target }
      })
      // 成功打开后，2.5秒后自动清除加载状态
      setTimeout(() => {
        openingProjects.value.delete(projectKey)
      }, 2500)
    }
  } catch (error: any) {
    message.error(error?.message || '运行文件异常')
    // 发生异常时，立即清除加载状态
    openingProjects.value.delete(projectKey)
  }
}
</script>

<style lang="less" scoped>
/* 合并视图网格 */
.mixed-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-5);
}
.mixed-card.drop-target {
  outline: 2px dashed var(--color-border-focus);
  outline-offset: 2px;
}

/* 分组筛选条 */
.collection-filter {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-5);

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 220px;
    padding: 5px 12px;
    border: 1px solid var(--color-border-subtle);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    line-height: 1.4;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      border-color: var(--color-border);
      color: var(--color-text-primary);
    }

    /* 选中的那颗是这一屏唯一的高饱和色块，一眼知道自己在看哪一组 */
    &.active {
      background: var(--color-accent-solid);
      border-color: var(--color-accent-solid);
      color: var(--color-text-on-solid);

      .chip-count {
        color: var(--color-text-on-solid);
        opacity: 0.8;
      }
    }

    /* 搜索把这一组滤空了：留着但压暗，让人知道这组存在、只是没匹配上 */
    &.empty:not(.active) {
      opacity: 0.45;
    }

    &.drop-target {
      border-color: var(--color-border-focus);
      border-style: dashed;
      color: var(--color-text-primary);
    }

    .chip-label {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .chip-count {
      color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
    }
  }

  /* 新建分组：只有一个加号，别跟旁边那些带计数的分组抢注意力 */
  .filter-chip.chip-add {
    padding: 5px 10px;
    color: var(--color-text-muted);

    svg {
      display: block;
      font-size: 14px;
    }
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.6;
    transform: translate(-50%, -50%) scale(1);
  }
  50% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.1);
  }
}

.section.project-section {
  flex: 1;
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  padding: var(--section-padding, var(--space-7));
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .mixed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-5);

    .project-card {
      box-shadow: 0 16px 35px var(--shadow-color);
      border: 0;
      border-radius: var(--radius-xl);
      overflow: hidden;

      &:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 25px var(--shadow-color-strong);
      }

      .project-thumb {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) auto;
        width: 100%;
        aspect-ratio: 1;
        overflow: hidden;
        border-radius: 0;
        background: var(--color-bg-surface);
        .pin-badge {
          position: absolute;
          top: 8px;
          left: 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: var(--color-bg-surface-hover);
          color: var(--color-text-primary);
          box-shadow: var(--shadow-xs);
          z-index: 2;
        }
        img {
          display: block;
          width: 100%;
          height: 100%;
          min-height: 0;
          object-fit: cover;
          border-radius: 0;
        }
        .project-version {
          position: absolute;
          right: 8px;
          top: 8px;
          padding: 2px 8px;
          border-radius: 28px;
          background: var(--color-bg-surface-hover);
          color: var(--color-text-primary);
          font-size: 12px;
        }
      }
      .project-meta {
        position: static;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: 12px;
        border-radius: 0;
        .project-title {
          color: var(--color-text-primary);
          font-weight: var(--font-weight-semibold);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          text-align: center;
          font-size: 16px;
          line-height: 1.2;
        }
      }
      :deep(.app-card__body) {
        padding: 0;
      }

      // 打开动效遮罩层
      .project-opening-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--color-accent-bg) 80%, transparent);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border-radius: 3px;
        z-index: 10;
        animation: fadeIn 0.3s ease-out;

        .opening-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;

          .opening-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--color-accent-border);
            border-top: 3px solid var(--color-accent-border);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }

          .opening-text {
            color: var(--color-text-primary);
            font-size: 14px;
            font-weight: 500;
            text-shadow: 0 1px 2px var(--shadow-color);
            letter-spacing: 0.5px;
          }
        }
      }

      // 打开状态下的卡片样式
      &.opening {
        border-color: var(--color-accent-border);
        box-shadow:
          0 16px 35px var(--shadow-color),
          0 0 20px var(--color-accent-border);
      }
    }
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.form-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  .label {
    width: 90px;
    color: var(--color-text-muted);
  }
}
.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

/* 合集遮罩样式已迁移到子组件的 scoped 样式中 */

// 隐藏 Empty 组件的图片，只显示描述
:deep(.app-empty__icon) {
  display: none;
}

/* 已连接标识样式 - LIVE Badge */
.connected-badge {
  position: absolute;
  top: 7px;
  left: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 8px;
  background: var(--color-success-bg);
  backdrop-filter: blur(8px);
  border: 1px solid var(--color-success-border);
  border-radius: 12px;
  box-shadow:
    0 2px 8px var(--color-success-border),
    inset 0 1px 0 var(--shadow-highlight);

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-success-solid);
    box-shadow:
      0 0 6px var(--color-success-border),
      0 0 12px var(--color-success-border);
    animation: live-pulse 1.5s ease-in-out infinite;
  }

  .label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--color-success-text);
    text-shadow: 0 0 8px var(--color-success-border);
  }
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
    box-shadow:
      0 0 6px var(--color-success-border),
      0 0 12px var(--color-success-border);
  }
  50% {
    opacity: 0.6;
    transform: scale(0.85);
    box-shadow:
      0 0 3px var(--color-success-border),
      0 0 6px var(--color-success-border);
  }
}

/* 列表排序动画 */
.list-move,
.list-enter-active,
.list-leave-active {
  transition: all 0.5s cubic-bezier(0.55, 0, 0.1, 1);
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: scale(0.9) translateY(30px);
}

/* 离开时使用 absolute + 固定尺寸，防止元素脱离布局后异常放大导致残影 */
.list-leave-active {
  position: absolute;
  /* 锁定卡片尺寸，与 mixed-card 的 grid 单元格尺寸一致 */
  width: 200px !important;
  max-width: 200px !important;
  /* 高度约束，防止纵向异常扩展 */
  max-height: 280px !important;
  /* 隐藏溢出，进一步防止内容导致尺寸膨胀 */
  overflow: hidden;
  /* 确保不会被其他样式覆盖 */
  box-sizing: border-box;
  /* 禁止交互，防止离开元素干扰其他元素 */
  pointer-events: none;
}
</style>
