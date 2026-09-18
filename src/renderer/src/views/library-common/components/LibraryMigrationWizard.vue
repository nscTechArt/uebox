<script setup lang="ts">
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import LibraryFormModal from './LibraryFormModal.vue'
import {
  scanLegacyDb,
  selectLegacyDb,
  type LegacyDbCandidate,
  type LegacyImportPreview,
  type LegacyImportReport,
  type LegacyImportService
} from '../services/legacyImport'

/**
 * 蓝图库 / 材质库共用的「从旧版导入」向导。
 *
 * 没有「扫描 → 预览 → 导入」三步 —— 扫描是程序该自己干的事，不是一个要用户
 * 点「下一步」的步骤。打开就自动找库、读预览、全选，用户看到的第一屏就是
 * 「N 个可以导入，导吗」。文件夹选择、换数据库文件收在「自定义」里。
 *
 * 导什么、怎么转换由 `service` 决定，这里只管流程和界面。
 */
const props = defineProps<{
  /** 领域文案前缀，如 `blueprintMigration` */
  i18nPrefix: string
  /** 这个库自己的导入实现 */
  service: LegacyImportService
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', report: LegacyImportReport): void
}>()

const { t } = useI18n()

/** 领域文案（标题、单位词）走前缀，通用文案走 libraryMigration */
function domain(key: string, params?: Record<string, unknown>): string {
  return t(`${props.i18nPrefix}.${key}`, params ?? {})
}

function common(key: string, params?: Record<string, unknown>): string {
  return t(`libraryMigration.${key}`, params ?? {})
}

type Phase = 'loading' | 'empty' | 'confirm' | 'importing' | 'done'

const phase = ref<Phase>('loading')
const errorMessage = ref('')

const dbCandidates = ref<LegacyDbCandidate[]>([])
const selectedDbPath = ref('')
const previewData = ref<LegacyImportPreview | null>(null)
const selectedFolders = ref<Set<string>>(new Set())
const customizing = ref(false)

const progress = ref(0)
const progressTotal = ref(0)
const report = ref<LegacyImportReport | null>(null)

function reportFailure(scope: string, err: unknown): void {
  console.error(`[LibraryMigration] ${scope}:`, err)
  errorMessage.value = common('error', {
    scope,
    reason: err instanceof Error ? err.message : String(err)
  })
}

// ========== 打开即自动走完扫描与预览 ==========

onMounted(async () => {
  let found: LegacyDbCandidate[] = []
  try {
    found = (await scanLegacyDb()).dbPaths
  } catch (err) {
    reportFailure(common('scope.scan'), err)
  }

  dbCandidates.value = found
  if (found.length === 0) {
    phase.value = 'empty'
    return
  }
  // 扫到多个就先用第一个，想换的人去「自定义」里换
  await loadPreview(found[0].path)
})

async function loadPreview(dbPath: string): Promise<void> {
  phase.value = 'loading'
  errorMessage.value = ''
  selectedDbPath.value = dbPath
  try {
    previewData.value = await props.service.preview(dbPath)
    // 默认全选：绝大多数人就是想把旧库整个搬过来
    selectedFolders.value = new Set(previewData.value.folders.map((f) => f.folderKey))
    phase.value = 'confirm'
  } catch (err) {
    reportFailure(common('scope.preview'), err)
    previewData.value = null
    phase.value = 'empty'
  }
}

async function handleSelectFile(): Promise<void> {
  const path = await selectLegacyDb()
  if (!path) return

  if (!dbCandidates.value.some((d) => d.path === path)) {
    dbCandidates.value.push({ path, userId: common('manualSelect'), sizeKB: 0 })
  }
  await loadPreview(path)
}

// ========== 摘要 ==========

/** 会被导入的条目（选中的文件夹 + 不属于任何文件夹的） */
const selectedEntries = computed(() => {
  if (!previewData.value) return []
  return previewData.value.entries.filter(
    (entry) => !entry.folderKey || selectedFolders.value.has(entry.folderKey)
  )
})

/** 已经在库里的那部分会被跳过 */
const alreadyExistingCount = computed(() => selectedEntries.value.filter((e) => e.exists).length)

const newCount = computed(() => selectedEntries.value.length - alreadyExistingCount.value)

const canImport = computed(() => newCount.value > 0)

/**
 * 数字是 0 的时候必须说清楚为什么，否则用户只看到一个「0 个可以导入」，
 * 分不清是「这文件里没有」「已经导过了」还是「我自己把文件夹取消勾选了」。
 */
const blockedReason = computed(() => {
  if (canImport.value || !previewData.value) return ''
  const preview = previewData.value

  if (preview.entries.length === 0) {
    return preview.totalSkipped > 0
      ? domain('blocked.otherKindOnly', { count: preview.totalSkipped })
      : domain('blocked.emptyFile')
  }
  if (selectedEntries.value.length === 0) {
    return common('blocked.nothingSelected')
  }
  return domain('blocked.allExist', { count: alreadyExistingCount.value })
})

function toggleFolder(folderKey: string): void {
  const next = new Set(selectedFolders.value)
  if (next.has(folderKey)) next.delete(folderKey)
  else next.add(folderKey)
  selectedFolders.value = next
}

function toggleAll(): void {
  if (!previewData.value) return
  const allKeys = previewData.value.folders.map((f) => f.folderKey)
  selectedFolders.value =
    selectedFolders.value.size === allKeys.length ? new Set() : new Set(allKeys)
}

const allSelected = computed(
  () => !!previewData.value && selectedFolders.value.size === previewData.value.folders.length
)

/** 没有文件夹可选时，「自定义」里只剩「换个文件」，不值得让用户点开找 */
const hasFolders = computed(() => (previewData.value?.folders.length ?? 0) > 0)

// ========== 导入 ==========

async function startImport(): Promise<void> {
  if (!selectedDbPath.value) return
  phase.value = 'importing'
  errorMessage.value = ''
  progress.value = 0

  try {
    report.value = await props.service.execute(
      selectedDbPath.value,
      // 传 Set 而不是 null —— 曾经全不选时传 null，而 null 在实现里是
      // 「不按文件夹过滤」，结果用户点完「全不选」反而把整个旧库搬了进来。
      selectedFolders.value,
      (current, total) => {
        progress.value = current
        progressTotal.value = total
      }
    )
    phase.value = 'done'
  } catch (err) {
    reportFailure(common('scope.import'), err)
    phase.value = 'confirm'
  }
}

function handleDone(): void {
  if (report.value) emit('done', report.value)
  emit('close')
}

const progressPercent = computed(() => {
  if (progressTotal.value === 0) return 0
  return Math.round((progress.value / progressTotal.value) * 100)
})
</script>

<template>
  <LibraryFormModal
    :open="true"
    icon="import"
    :title="domain('title')"
    @update:open="emit('close')"
  >
    <div v-if="errorMessage" class="wizard-error" role="alert">{{ errorMessage }}</div>

    <!-- 找库 + 读预览，用户不需要知道这是两件事 -->
    <div v-if="phase === 'loading'" class="wizard-loading">
      <div class="spinner"></div>
      <p>{{ domain('loading') }}</p>
    </div>

    <!-- 没找到：只给一个动作 -->
    <div v-else-if="phase === 'empty'" class="wizard-empty">
      <p class="empty-title">{{ common('notFound') }}</p>
      <button class="btn-pick-file" @click="handleSelectFile">
        {{ common('selectFile') }}
      </button>
    </div>

    <!-- 确认：一个数字 + 一句话，细节收在「自定义」里 -->
    <div v-else-if="phase === 'confirm' && previewData" class="wizard-confirm">
      <div class="summary">
        <span class="summary-count">{{ newCount }}</span>
        <span class="summary-unit">{{ domain('summary.unit') }}</span>
      </div>

      <p v-if="blockedReason" class="summary-sub blocked">{{ blockedReason }}</p>
      <p v-else class="summary-sub">
        {{ common('summary.from', { folders: selectedFolders.size }) }}
        <span v-if="alreadyExistingCount > 0">
          {{ common('summary.alreadyExists', { count: alreadyExistingCount }) }}
        </span>
      </p>

      <button
        type="button"
        class="customize-toggle"
        :class="{ open: customizing }"
        :aria-expanded="customizing"
        @click="customizing = !customizing"
      >
        {{ common('customize.toggle') }}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <div v-show="customizing" class="customize-body">
        <template v-if="hasFolders">
          <div class="customize-head">
            <span>{{ common('customize.folders') }}</span>
            <button class="btn-toggle-all" @click="toggleAll">
              {{ allSelected ? common('customize.selectNone') : common('customize.selectAll') }}
            </button>
          </div>
          <div class="folder-list">
            <AppCheckbox
              v-for="folder in previewData.folders"
              :key="folder.folderKey"
              class="folder-item"
              :checked="selectedFolders.has(folder.folderKey)"
              @change="toggleFolder(folder.folderKey)"
            >
              <span class="folder-name">{{ folder.title }}</span>
              <span class="folder-count">{{ folder.entryCount }}</span>
            </AppCheckbox>
          </div>
        </template>

        <button class="btn-pick-file subtle" @click="handleSelectFile">
          {{ common('customize.otherFile') }}
        </button>
      </div>
    </div>

    <!-- 导入中 -->
    <div v-else-if="phase === 'importing'" class="wizard-progress">
      <div class="progress-bar-track">
        <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <p class="progress-text">
        {{
          common('progress', {
            current: progress,
            total: progressTotal,
            percent: progressPercent
          })
        }}
      </p>
    </div>

    <!-- 完成 -->
    <div v-else-if="phase === 'done' && report" class="wizard-done">
      <svg
        class="done-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <p class="done-title">{{ domain('done.imported', { count: report.imported }) }}</p>
      <p v-if="report.collections > 0 || report.skipped > 0" class="done-sub">
        <span v-if="report.collections > 0">
          {{ common('done.collections', { count: report.collections }) }}
        </span>
        <span v-if="report.skipped > 0">
          {{ common('done.skipped', { count: report.skipped }) }}
        </span>
      </p>
    </div>

    <template #actions>
      <template v-if="phase === 'confirm'">
        <button type="button" class="btn-cancel" @click="emit('close')">
          {{ common('cancel') }}
        </button>
        <button type="button" class="btn-confirm" :disabled="!canImport" @click="startImport">
          {{ common('importCount', { count: newCount }) }}
        </button>
      </template>

      <button v-else-if="phase === 'done'" type="button" class="btn-confirm" @click="handleDone">
        {{ common('done.button') }}
      </button>

      <button v-else-if="phase === 'empty'" type="button" class="btn-cancel" @click="emit('close')">
        {{ common('cancel') }}
      </button>
    </template>
  </LibraryFormModal>
</template>

<style scoped lang="less">
// 遮罩、面板、标题栏、底部按钮都归 LibraryFormModal，这里只有导入自己的东西。

.wizard-error {
  margin-bottom: var(--space-4);
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-danger-border);
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
  font-size: 13px;
}

// ===== 加载中 =====
.wizard-loading {
  padding: 48px 0;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}

.spinner {
  width: 28px;
  height: 28px;
  margin: 0 auto var(--space-3);
  border: 3px solid var(--color-accent-border);
  border-top-color: var(--color-accent-border);
  border-radius: 50%;
  animation: wizard-spin 0.8s linear infinite;
}

@keyframes wizard-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

// ===== 没找到 =====
.wizard-empty {
  padding: 40px 0;
  text-align: center;
}

.empty-title {
  margin: 0 0 var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
}

.btn-pick-file {
  padding: 8px 18px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-strong);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
  }

  // 抽屉里那个「换个文件」是次要动作，不该和上面的复选框抢
  &.subtle {
    width: 100%;
    margin-top: var(--space-3);
    border-style: dashed;
    color: var(--color-text-muted);
  }
}

// ===== 确认 =====
.wizard-confirm {
  padding: var(--space-5) 0 0;
}

.summary {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--space-2);
}

.summary-count {
  font-size: 44px;
  font-weight: var(--font-weight-bold);
  line-height: 1;
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

.summary-unit {
  font-size: var(--font-size-base);
  color: var(--color-text-muted);
}

.summary-sub {
  margin: var(--space-3) auto 0;
  max-width: 340px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: var(--line-height-normal);

  span {
    margin-left: 6px;
  }

  // 「为什么是 0」比普通说明重要一点，但也不是错误
  &.blocked {
    color: var(--color-text-muted);
  }
}

.customize-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: var(--space-6);
  padding: var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.2s;

  &:hover {
    color: var(--color-text-primary);
  }

  svg {
    transition: transform 0.25s;
  }

  &.open svg {
    transform: rotate(180deg);
  }
}

.customize-body {
  margin-top: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.customize-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.btn-toggle-all {
  border: none;
  background: none;
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.folder-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}

.folder-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text-secondary);
  transition: background 0.15s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  // 行内容在 ant 复选框的标签插槽里，那是个普通 span —— 不撑成 flex 的话
  // .folder-name 的 flex: 1 没有生效对象，右侧计数就贴不到行尾
  :deep(> span:last-child) {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
  }

  .folder-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-count {
    flex-shrink: 0;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }
}

// ===== 导入中 =====
.wizard-progress {
  padding: 48px 0;
  text-align: center;
}

.progress-bar-track {
  height: 6px;
  margin-bottom: var(--space-3);
  border-radius: var(--radius-xs);
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: var(--radius-xs);
  background: var(--color-accent-solid);
  transition: width 0.3s;
}

.progress-text {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
}

// ===== 完成 =====
.wizard-done {
  padding: 40px 0;
  text-align: center;
}

.done-icon {
  width: 40px;
  height: 40px;
  margin-bottom: var(--space-4);
  color: var(--color-success-text);
}

.done-title {
  margin: 0;
  font-size: var(--font-size-md);
  color: var(--color-text-primary);
}

.done-sub {
  margin: var(--space-2) 0 0;
  font-size: 13px;
  color: var(--color-text-muted);

  span + span::before {
    content: '·';
    margin: 0 6px;
  }
}
</style>
