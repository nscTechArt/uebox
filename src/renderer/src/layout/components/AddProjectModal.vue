<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref, watch } from 'vue'
import { PhCheck, PhDesktop, PhFolderOpen, PhMagnifyingGlass } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import type { SidebarProject } from '@renderer/store/modules/chatSidebarStore'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { useEngineVersionLabel } from '@renderer/hooks/useEngineVersionLabel'

interface Props {
  open: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'confirm', project: SidebarProject): void
}>()

const { t } = useI18n()

type ProjectSource = 'folder' | 'imported'

interface ImportedProject extends SidebarProject {
  selectionKey: string
  coverUrl?: string
}

const step = ref<'type' | 'imported'>('type')
const source = ref<ProjectSource>('folder')
const importedProjects = ref<ImportedProject[]>([])
const selectedImported = ref<string>('')
const importedSearchKeyword = ref('')
const loading = ref(false)
const { ensureEngineLabels, engineLabel } = useEngineVersionLabel()

watch(
  () => props.open,
  (open) => {
    if (!open) return
    step.value = 'type'
    source.value = 'folder'
    selectedImported.value = ''
    importedSearchKeyword.value = ''
  }
)

function close(): void {
  emit('update:open', false)
}

/** 取路径最后一段当工程名：D:/UE/ShooterGame → ShooterGame */
function folderName(path: string): string {
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return segments[segments.length - 1] || path
}

async function pickFolder(): Promise<void> {
  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('chatSidebar.addProject.pickFolderTitle'),
      properties: ['openDirectory']
    })

    const path = result?.filePaths?.[0]
    if (result?.canceled || !path) return

    emit('confirm', { projectName: folderName(path), projectPath: path })
    close()
  } catch (error) {
    console.warn('[AddProjectModal] 选择文件夹失败:', error)
    message.error(t('chatSidebar.addProject.pickFolderFailed'))
  }
}

async function resolveProjectCoverUrl(
  image: string | null | undefined
): Promise<string | undefined> {
  const source = String(image || '').trim()
  if (!source) return undefined

  if (
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('file:') ||
    source.startsWith('local-resource:') ||
    source.startsWith('uebox-asset:') ||
    source.startsWith('data:') ||
    source.startsWith('blob:')
  ) {
    return toLocalResourceUrl(source)
  }

  const result = await window.api.path.getPublicThumbnailUrl(source)
  return result?.success ? toLocalResourceUrl(result.data) : undefined
}

async function loadImportedProjects(): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.database.project.getAll()
    const rows = result?.success ? result.data || [] : []
    const projects = await Promise.all(
      rows.map(
        async (row, index): Promise<ImportedProject> => ({
          selectionKey:
            row.projectKey ||
            row.projectPath ||
            row.originPath ||
            `${row.projectName || 'project'}-${index}`,
          projectName: String(row.projectName || '').trim(),
          projectPath: row.projectPath || undefined,
          engineVersion: row.EngineAssociation || undefined,
          coverUrl: await resolveProjectCoverUrl(row.image)
        })
      )
    )

    importedProjects.value = projects.filter((project) => Boolean(project.projectName))
    await ensureEngineLabels(importedProjects.value.map((project) => project.engineVersion))
  } catch (error) {
    console.warn('[AddProjectModal] 读取已导入工程失败:', error)
    importedProjects.value = []
  } finally {
    loading.value = false
  }
}

async function handleNext(): Promise<void> {
  if (source.value === 'folder') {
    await pickFolder()
    return
  }

  step.value = 'imported'
  await loadImportedProjects()
}

function handleConfirmImported(): void {
  const project = importedProjects.value.find(
    (item) => item.selectionKey === selectedImported.value
  )
  if (!project) return

  emit('confirm', {
    projectName: project.projectName,
    projectPath: project.projectPath,
    engineVersion: project.engineVersion
  })
  close()
}

const canConfirmImported = computed<boolean>(() => Boolean(selectedImported.value))

const filteredImportedProjects = computed<ImportedProject[]>(() => {
  const keyword = importedSearchKeyword.value.trim().toLowerCase()
  if (!keyword) return importedProjects.value

  return importedProjects.value.filter((project) =>
    [project.projectName, project.projectPath].some((value) =>
      String(value || '')
        .toLowerCase()
        .includes(keyword)
    )
  )
})
</script>

<template>
  <AppModal
    :open="props.open"
    :title="t('chatSidebar.addProject.title')"
    hide-footer
    width="640px"
    @cancel="close"
  >
    <template v-if="step === 'type'">
      <div class="add-project-label">{{ t('chatSidebar.addProject.typeLabel') }}</div>
      <div class="add-project-cards">
        <button
          type="button"
          class="add-project-card"
          :class="{ selected: source === 'folder' }"
          @click="source = 'folder'"
        >
          <span class="add-project-card-head">
            <PhDesktop class="add-project-card-icon" />
            <span class="add-project-radio" :class="{ checked: source === 'folder' }" />
          </span>
          <span class="add-project-card-name">{{ t('chatSidebar.addProject.folder') }}</span>
          <span class="add-project-card-desc">{{ t('chatSidebar.addProject.folderDesc') }}</span>
        </button>

        <button
          type="button"
          class="add-project-card"
          :class="{ selected: source === 'imported' }"
          @click="source = 'imported'"
        >
          <span class="add-project-card-head">
            <PhFolderOpen class="add-project-card-icon" />
            <span class="add-project-radio" :class="{ checked: source === 'imported' }" />
          </span>
          <span class="add-project-card-name">{{ t('chatSidebar.addProject.imported') }}</span>
          <span class="add-project-card-desc">{{ t('chatSidebar.addProject.importedDesc') }}</span>
        </button>
      </div>

      <div class="add-project-footer">
        <AppButton variant="primary" @click="handleNext">
          {{ t('chatSidebar.addProject.next') }}
        </AppButton>
      </div>
    </template>

    <template v-else>
      <div class="add-project-label">{{ t('chatSidebar.addProject.imported') }}</div>

      <label class="add-project-search">
        <PhMagnifyingGlass class="add-project-search-icon" aria-hidden="true" />
        <input
          v-model="importedSearchKeyword"
          type="search"
          class="add-project-search-input"
          :placeholder="t('chatSidebar.addProject.searchPlaceholder')"
          :aria-label="t('chatSidebar.addProject.searchPlaceholder')"
        />
      </label>

      <AppSpin :spinning="loading">
        <div class="add-project-list">
          <button
            v-for="project in filteredImportedProjects"
            :key="project.selectionKey"
            type="button"
            class="add-project-row"
            :class="{ selected: selectedImported === project.selectionKey }"
            :aria-pressed="selectedImported === project.selectionKey"
            @click="selectedImported = project.selectionKey"
          >
            <span class="add-project-cover">
              <img
                v-if="project.coverUrl"
                :src="project.coverUrl"
                alt=""
                loading="lazy"
                decoding="async"
              />
              <PhFolderOpen v-else class="add-project-cover-fallback" aria-hidden="true" />
            </span>
            <span class="add-project-row-details">
              <span class="add-project-row-head">
                <span class="add-project-row-name">{{ project.projectName }}</span>
                <span v-if="project.engineVersion" class="add-project-engine-version">
                  UE {{ engineLabel(project.engineVersion) }}
                </span>
              </span>
              <span v-if="project.projectPath" class="add-project-row-path">
                {{ project.projectPath }}
              </span>
            </span>
            <PhCheck v-if="selectedImported === project.selectionKey" class="add-project-check" />
          </button>

          <div v-if="!loading && importedProjects.length === 0" class="add-project-empty">
            {{ t('chatSidebar.addProject.importedEmpty') }}
          </div>
          <div
            v-else-if="!loading && filteredImportedProjects.length === 0"
            class="add-project-empty"
          >
            {{ t('chatSidebar.addProject.searchEmpty') }}
          </div>
        </div>
      </AppSpin>

      <div class="add-project-footer">
        <AppButton @click="step = 'type'">{{ t('chatSidebar.addProject.back') }}</AppButton>
        <AppButton variant="primary" :disabled="!canConfirmImported" @click="handleConfirmImported">
          {{ t('chatSidebar.addProject.done') }}
        </AppButton>
      </div>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.add-project-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-3);
}

.add-project-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.add-project-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  min-height: 150px;
  text-align: left;
  border: 1px solid var(--color-border-option);
  border-radius: var(--radius-xl);
  background: var(--color-bg-option);
  color: var(--color-text-primary);
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.2s ease;

  &:not(.selected):hover {
    background: var(--color-bg-option-hover);
  }

  &.selected {
    background: var(--color-bg-option-selected);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.add-project-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}

.add-project-card-icon {
  font-size: var(--font-size-lg);
  color: var(--color-text-secondary);
}

.add-project-radio {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &.checked {
    border-color: var(--color-border);
    box-shadow: inset 0 0 0 4px var(--color-border);
  }
}

.add-project-card-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
}

.add-project-card-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.add-project-list {
  height: calc(var(--space-20) * 3 + var(--space-6));
  overflow: auto;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);

  &::-webkit-scrollbar {
    width: var(--space-1);
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: var(--radius-full);
  }
}

.add-project-search {
  position: relative;
  display: block;
  margin-bottom: var(--space-3);
}

.add-project-search-icon {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  transform: translateY(-50%);
  color: var(--color-text-muted);
}

.add-project-search-input {
  width: 100%;
  min-height: calc(var(--space-10) - var(--space-1));
  padding: 0 var(--space-3) 0 var(--space-8);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font: inherit;

  &::placeholder {
    color: var(--color-text-muted);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.add-project-row {
  display: grid;
  grid-template-columns: var(--space-12) minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  min-height: calc(var(--space-12) + var(--space-1));
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  &:last-child {
    border-bottom: 0;
  }

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.selected {
    background: var(--color-bg-selected);
  }

  &.selected:hover {
    background: var(--color-bg-selected-hover);
  }

  &:focus-visible {
    position: relative;
    z-index: 1;
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.add-project-cover {
  display: inline-flex;
  width: var(--space-12);
  height: var(--space-10);
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--color-bg-surface-hover);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.add-project-cover-fallback {
  font-size: var(--font-size-lg);
  color: var(--color-text-muted);
}

.add-project-row-details {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.add-project-row-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.add-project-row-name {
  min-width: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.add-project-engine-version {
  flex: none;
  min-height: var(--space-4);
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.add-project-row-path {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.add-project-check {
  flex: none;
  color: var(--color-text-primary);
}

.add-project-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.add-project-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
