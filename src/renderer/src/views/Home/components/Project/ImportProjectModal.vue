<template>
  <AppModal
    :open="open"
    :width="900"
    hide-footer
    :closable="false"
    centered
    class="import-project-modal-wrapper"
    @update:open="(v) => emit('update:open', v)"
  >
    <div class="modal-container">
      <div class="panel">
        <button
          type="button"
          class="close-btn"
          :aria-label="t('common.close')"
          @click="handleClose"
        >
          <PhX aria-hidden="true" />
        </button>

        <header class="panel-head">
          <h2 class="panel-title">{{ t('page.home.project.importProjectModal.title') }}</h2>
          <p class="panel-subtitle">
            {{
              targetCollectionName
                ? t('page.home.project.importProjectModal.subtitleIntoCollection', {
                    name: targetCollectionName
                  })
                : t('page.home.project.importProjectModal.subtitle')
            }}
          </p>
        </header>

        <div class="filter-bar">
          <select
            v-model="versionFilter"
            class="version-select"
            :aria-label="t('page.home.project.importProjectModal.allVersions')"
          >
            <option value="all">{{ t('page.home.project.importProjectModal.allVersions') }}</option>
            <option v-for="ver in availableEngineVersions" :key="ver" :value="ver">
              UE {{ ver }}
            </option>
          </select>
          <div class="search-wrapper">
            <PhMagnifyingGlass class="search-icon" aria-hidden="true" />
            <input
              v-model="searchKeyword"
              type="text"
              :placeholder="t('page.home.project.importProjectModal.searchPlaceholder')"
              :aria-label="t('page.home.project.importProjectModal.searchPlaceholder')"
              class="search-input"
            />
          </div>
          <button
            v-if="unimportedProjectsCount > 0"
            type="button"
            class="import-all-btn"
            :disabled="importingAll"
            @click="handleImportAllProjects"
          >
            {{
              importingAll
                ? t('page.home.project.importProjectModal.importingAll')
                : t('page.home.project.importProjectModal.importAll', {
                    count: unimportedProjectsCount
                  })
            }}
          </button>
        </div>

        <div class="project-list">
          <div v-if="loading" class="state-block">
            <AppSpin size="large" />
            <div class="state-text">{{ t('page.home.project.importProjectModal.scanning') }}</div>
          </div>

          <div v-else-if="filteredProjects.length === 0" class="state-block">
            <PhSignIn class="state-icon" aria-hidden="true" />
            <div class="state-text">{{ t('page.home.project.importProjectModal.empty') }}</div>
            <div class="state-hint">{{ t('page.home.project.importProjectModal.emptyDesc') }}</div>
          </div>

          <div v-else class="project-list-inner">
            <button
              v-for="project in filteredProjects"
              :key="project.projectPath"
              type="button"
              class="project-row"
              :disabled="project.isImported && !targetCollectionName"
              :aria-label="`${project.projectName}, ${
                project.isImported && targetCollectionName
                  ? t('page.home.project.importProjectModal.clickToJoin', {
                      name: targetCollectionName
                    })
                  : t(
                      project.isImported
                        ? 'page.home.project.importProjectModal.imported'
                        : 'page.home.project.importProjectModal.clickToImport'
                    )
              }`"
              @click="handleImportProject(project)"
            >
              <div class="card-thumb">
                <img
                  v-if="project.thumbnailPath"
                  :src="toLocalResourceUrl(project.thumbnailPath)"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  class="thumb-img"
                />
                <PhFolder v-else class="thumb-fallback" aria-hidden="true" />
              </div>
              <div class="card-body">
                <div class="card-head">
                  <h3 class="card-title">{{ project.projectName }}</h3>
                  <span class="engine-badge">UE {{ project.engineVersion }}</span>
                </div>
                <p class="card-path">{{ project.projectPath }}</p>
              </div>
              <span class="last-open">{{ formatLastOpenTime(project.lastOpenTime) }}</span>
              <span v-if="project.isImported" class="imported-badge">
                <span class="badge-idle">{{
                  t('page.home.project.importProjectModal.imported')
                }}</span>
                <!-- 在分组里时已导入的工程也能点：悬停告诉用户点了会怎样 -->
                <span v-if="targetCollectionName" class="badge-hover">{{
                  t('page.home.project.importProjectModal.joinCollection')
                }}</span>
              </span>
              <span v-else class="import-action" aria-hidden="true">
                <PhFolderPlus />
              </span>
            </button>
          </div>
        </div>

        <!-- 列表只认引擎最近打开过的工程；不在里面的，得有地方自己选路径 -->
        <footer class="panel-foot">
          <span class="foot-hint">{{ t('page.home.project.importProjectModal.dropHint') }}</span>
          <button type="button" class="pick-file-btn" :disabled="picking" @click="handlePickFile">
            <PhFolderOpen aria-hidden="true" />
            {{ t('page.home.project.importProjectModal.pickFile') }}
          </button>
        </footer>
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhFolder,
  PhFolderOpen,
  PhFolderPlus,
  PhMagnifyingGlass,
  PhSignIn,
  PhX
} from '@phosphor-icons/vue'
import { message } from '@/utils/messageManager'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'

/**
 * 把本机已有的 UE 工程收进工程库。
 *
 * 这件事从「新建工程」弹窗里搬了出来：那个弹窗管的是「用模板造一个新工程」，
 * 而这里是「打开我已经有的工程」，两件事放在一个窗口里，用户找起来才乱。
 */
const { t } = useI18n()

interface Props {
  open: boolean
  /** 首页当前选中的分组名 —— 导进来的工程会直接放进去，副标题要把这件事说出来 */
  targetCollectionName?: string
}

interface Emits {
  (e: 'update:open', v: boolean): void
  /** 带上这次新进库的工程和本来就在库里的工程，首页据此把它们放进当前分组 */
  (e: 'success', projectKeys: string[], existingKeys?: string[]): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

/** Epic 启动器里记录的最近打开工程 */
interface RecentProject {
  projectPath: string
  projectName: string
  engineVersion: string
  lastOpenTime: string
  isImported: boolean
  thumbnailPath?: string
}

const projects = ref<RecentProject[]>([])
const loading = ref(false)
const importingAll = ref(false)
const picking = ref(false)
const searchKeyword = ref('')
const versionFilter = ref<string>('all')

const availableEngineVersions = computed(() => {
  const versions = new Set<string>()
  for (const proj of projects.value) versions.add(proj.engineVersion)
  return Array.from(versions).sort((a, b) => {
    const [aMajor, aMinor] = a.split('.').map(Number)
    const [bMajor, bMinor] = b.split('.').map(Number)
    return bMajor - aMajor || bMinor - aMinor
  })
})

const filteredProjects = computed(() => {
  let result = projects.value

  if (versionFilter.value !== 'all') {
    result = result.filter((p) => p.engineVersion === versionFilter.value)
  }

  const keyword = searchKeyword.value.trim().toLowerCase()
  if (keyword) {
    result = result.filter((p) => p.projectName.toLowerCase().includes(keyword))
  }

  return result
})

/** 未导入数量按当前筛选结果算 —— 「全部导入」导的就是屏幕上这些 */
const unimportedProjectsCount = computed(
  () => filteredProjects.value.filter((p) => !p.isImported).length
)

const loadProjects = async (): Promise<void> => {
  loading.value = true
  try {
    const result = await window.api.epic.getRecentProjects()
    projects.value = result?.success ? result.projects || [] : []
    if (!result?.success) console.error('加载本地工程失败:', result?.error)
  } catch (err) {
    console.error('加载本地工程异常:', err)
    projects.value = []
  } finally {
    loading.value = false
  }
}

const handleImportProject = async (project: RecentProject): Promise<void> => {
  // 已导入的工程只在分组里才可点：点它就是放进这个分组
  if (project.isImported && !props.targetCollectionName) return

  try {
    const result = await window.api.database.project.importByFilePath(project.projectPath)
    if (result?.alreadyRegistered) {
      project.isImported = true
      emit('success', [], keysOf(result.data))
    } else if (result?.success) {
      message.success(
        t('page.home.project.importProjectModal.importSuccess', { name: project.projectName })
      )
      project.isImported = true
      emit('success', keysOf(result.data))
    } else {
      message.error(result?.error || t('page.home.project.importProjectModal.importFailed'))
    }
  } catch (err) {
    console.error('导入工程失败:', err)
    message.error(t('page.home.project.importProjectModal.importError'))
  }
}

const handleImportAllProjects = async (): Promise<void> => {
  const pending = filteredProjects.value.filter((p) => !p.isImported)
  if (pending.length === 0) return

  importingAll.value = true
  let successCount = 0
  let failCount = 0
  const importedKeys: string[] = []

  try {
    for (const project of pending) {
      try {
        const result = await window.api.database.project.importByFilePath(project.projectPath)
        if (result?.success) {
          project.isImported = true
          importedKeys.push(...keysOf(result.data))
          successCount++
        } else {
          failCount++
        }
      } catch {
        failCount++
      }
    }
  } finally {
    importingAll.value = false
  }

  if (successCount > 0) emit('success', importedKeys)

  if (failCount === 0) {
    message.success(
      t('page.home.project.importProjectModal.importAllSuccess', { success: successCount })
    )
  } else {
    message.warning(
      t('page.home.project.importProjectModal.importAllPartial', {
        success: successCount,
        fail: failCount
      })
    )
  }
}

const keysOf = (record?: { projectKey?: string | null }): string[] =>
  record?.projectKey ? [record.projectKey] : []

/** 自己挑一个 .uproject。选完就算这趟办完了，关掉弹窗让用户看到卡片 */
const handlePickFile = async (): Promise<void> => {
  picking.value = true
  try {
    const ret = await window.api.dialog.showOpenDialog({
      title: t('actionToast.project.pickUproject'),
      properties: ['openFile'],
      filters: [{ name: 'Unreal Project', extensions: ['uproject'] }]
    })
    const filePath = ret?.filePaths?.[0]
    if (ret?.canceled || !filePath) return

    const result = await window.api.database.project.importByFilePath(filePath)
    if (result?.alreadyRegistered) {
      emit('success', [], keysOf(result.data))
      emit('update:open', false)
    } else if (result?.success) {
      message.success(t('actionToast.project.importOk'))
      notifyPluginInstallFailure(result)
      emit('success', keysOf(result.data))
      emit('update:open', false)
    } else {
      message.error(result?.error || t('page.home.project.importProjectModal.importFailed'))
    }
  } catch (err) {
    console.error('选择工程文件导入失败:', err)
    message.error(t('page.home.project.importProjectModal.importError'))
  } finally {
    picking.value = false
  }
}

const formatLastOpenTime = (isoTime: string): string => {
  try {
    const diffDays = Math.floor((Date.now() - new Date(isoTime).getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return t('page.home.project.importProjectModal.timeToday')
    if (diffDays === 1) return t('page.home.project.importProjectModal.timeYesterday')
    if (diffDays < 7)
      return t('page.home.project.importProjectModal.timeDaysAgo', { days: diffDays })
    if (diffDays < 30)
      return t('page.home.project.importProjectModal.timeWeeksAgo', {
        weeks: Math.floor(diffDays / 7)
      })
    if (diffDays < 365)
      return t('page.home.project.importProjectModal.timeMonthsAgo', {
        months: Math.floor(diffDays / 30)
      })
    return t('page.home.project.importProjectModal.timeYearsAgo', {
      years: Math.floor(diffDays / 365)
    })
  } catch {
    return ''
  }
}

const handleClose = (): void => {
  emit('update:open', false)
}

// 每次打开都重扫一遍：用户可能刚在引擎里开过新工程
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      searchKeyword.value = ''
      versionFilter.value = 'all'
      loadProjects()
    }
  }
)
</script>

<style lang="less">
.import-project-modal-wrapper {
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
.modal-container {
  position: relative;
  width: 100%;
  height: 620px;
  border-radius: 24px;
  overflow: hidden;
  background: var(--color-bg-raised);
  backdrop-filter: blur(40px) saturate(140%);
  -webkit-backdrop-filter: blur(40px) saturate(140%);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 40px 80px var(--shadow-color-strong);
  color: var(--color-text-primary);
  font-family: 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
}

.panel {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 28px 28px 20px;
}

.close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  z-index: 5;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.panel-head {
  flex-shrink: 0;
  padding-right: 44px;
}

.panel-title {
  font-size: 20px;
  font-weight: 500;
  margin: 0;
  color: var(--color-text-primary);
}

.panel-subtitle {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 5px 0 0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 18px 0 14px;
  flex-shrink: 0;
}

.version-select {
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 13px;
  min-height: 44px;
  padding: 0 var(--space-3);
  outline: none;
  cursor: pointer;

  &:focus-visible {
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }

  option {
    background: var(--color-bg-surface);
    color: var(--color-text-primary);
  }
}

.search-wrapper {
  position: relative;
  flex: 1;

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
    border-radius: 8px;
    min-height: 44px;
    padding: 0 var(--space-3) 0 36px;
    color: var(--color-text-primary);
    font-size: 13px;
    outline: none;

    &::placeholder {
      color: var(--color-text-disabled);
    }

    &:focus-visible {
      border-color: var(--color-border-focus);
      box-shadow: 0 0 0 2px var(--color-accent-bg);
    }
  }
}

.import-all-btn {
  flex-shrink: 0;
  min-height: 44px;
  background: var(--color-bg-inverse);
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-text-inverse);
  font-size: 13px;
  font-weight: 500;
  padding: 0 var(--space-4);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-bg-inverse-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &:disabled {
    color: var(--color-text-disabled);
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    box-shadow: none;
    cursor: not-allowed;
  }
}

.project-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);

  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }
}

.project-list-inner {
  display: flex;
  flex-direction: column;
}

.project-row {
  width: 100%;
  min-height: 68px;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) 72px 64px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:last-child {
    border-bottom: 0;
  }

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  &:disabled {
    cursor: default;
    background: var(--color-bg-surface);

    .card-title,
    .engine-badge,
    .card-path,
    .last-open,
    .imported-badge {
      color: var(--color-text-muted);
    }
  }
}

.card-thumb {
  width: 64px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;

  .thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .thumb-fallback {
    font-size: 20px;
    color: var(--color-text-muted);
  }
}

.card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-1);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.engine-badge {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
}

.card-path {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.last-open {
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: right;
}

.imported-badge {
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: center;
}

.import-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  justify-self: center;
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  font-size: 15px;
}

.imported-badge .badge-hover {
  display: none;
}

.project-row:hover:not(:disabled) .imported-badge {
  color: var(--color-text-primary);

  .badge-idle:has(+ .badge-hover) {
    display: none;
  }

  .badge-hover {
    display: inline;
  }
}

.project-row:hover:not(:disabled) .import-action {
  background: var(--color-bg-raised);
  color: var(--color-text-primary);
}

.panel-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: 14px;
}

.foot-hint {
  min-width: 0;
  font-size: 12px;
  color: var(--color-text-muted);
}

.pick-file-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-4);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: var(--color-border-focus);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
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
  gap: 10px;
  padding: 90px 20px;
  color: var(--color-text-primary);

  .state-icon {
    font-size: 36px;
    color: var(--color-text-muted);
  }

  .state-text {
    font-size: 13px;
  }

  .state-hint {
    font-size: 12px;
    color: var(--color-text-muted);
  }
}
</style>
