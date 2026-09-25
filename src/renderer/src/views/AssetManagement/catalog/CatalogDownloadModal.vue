<template>
  <AppModal
    :open="open"
    :title="t('catalogLibrary.download.title', { count: items.length })"
    :width="520"
    :ok-text="t('catalogLibrary.download.start')"
    :ok-disabled="!targetRoot"
    :confirm-loading="busy"
    destroy-on-close
    @ok="start"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <div class="download">
      <p class="lead">{{ t('catalogLibrary.download.lead') }}</p>
      <ul class="names">
        <li v-for="item in items.slice(0, 5)" :key="item.id">{{ item.path }}</li>
        <li v-if="items.length > 5" class="more">
          {{ t('catalogLibrary.download.more', { count: items.length - 5 }) }}
        </li>
      </ul>

      <AppSegmented
        v-model="target"
        :options="targets"
        :aria-label="t('catalogLibrary.download.target')"
      >
        <template #default="{ option }">{{
          t(`catalogLibrary.download.targets.${option}`)
        }}</template>
      </AppSegmented>

      <template v-if="target === 'project'">
        <AppSpin v-if="projectsLoading" size="small" />
        <AppEmpty
          v-else-if="projectOptions.length === 0"
          :description="t('catalogLibrary.download.noProjects')"
        />
        <a-select
          v-else
          v-model:value="projectPath"
          :options="projectOptions"
          show-search
          option-filter-prop="label"
          :placeholder="t('catalogLibrary.download.pickProject')"
        />
      </template>
      <div v-else class="folder-row">
        <AppButton size="small" @click="pickFolder">{{
          t('catalogLibrary.download.pickFolder')
        }}</AppButton>
        <span class="path">{{ folderPath || t('catalogLibrary.download.noFolder') }}</span>
      </div>

      <AppCheckbox
        :checked="withDependencies"
        @update:checked="(value: boolean) => (withDependencies = value)"
      >
        {{ t('catalogLibrary.download.withDependencies') }}
      </AppCheckbox>
      <p class="hint">{{ t('catalogLibrary.download.hint') }}</p>
      <AppAlert v-if="error" type="error" :message="error" show-icon />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 下载 / 放进 UE 工程：选目标（工程或文件夹）→ 主进程算依赖闭包、在影子副本里物化、
 * 再**复制**进目标（Content/… 对应 /Game/…）。进度在资产库视图底部显示。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppAlert from '@renderer/components/AppAlert.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppSegmented from '@renderer/components/AppSegmented.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type { CatalogAssetSummary } from '@core/shared/catalogLibrary'
import { catalogErrorText } from './catalogErrors'

const props = defineProps<{ open: boolean; libraryKey: string; items: CatalogAssetSummary[] }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'started', jobId: string): void }>()
const { t } = useI18n()

const targets = ['project', 'folder'] as const
const target = ref<(typeof targets)[number]>('project')
const projectPath = ref<string | undefined>(undefined)
const folderPath = ref<string | null>(null)
const withDependencies = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)
const projects = ref<Array<{ name: string; path: string }>>([])
const projectsLoading = ref(false)

const projectOptions = computed(() =>
  projects.value.map((project) => ({
    value: project.path,
    label: `${project.name} — ${project.path}`
  }))
)
const targetRoot = computed(
  () => (target.value === 'project' ? projectPath.value : folderPath.value) ?? null
)

async function loadProjects(): Promise<void> {
  projectsLoading.value = true
  try {
    const result = await window.api.database.project.getAll()
    const rows = (result?.success ? result.data : []) as Array<{
      projectName?: string | null
      projectPath?: string | null
      projectKey: string
    }>
    projects.value = rows
      .filter((row) => typeof row.projectPath === 'string' && row.projectPath.length > 0)
      .map((row) => ({ name: row.projectName || row.projectKey, path: row.projectPath as string }))
  } catch {
    projects.value = []
  } finally {
    projectsLoading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    error.value = null
    void loadProjects()
  },
  { immediate: true }
)

async function pickFolder(): Promise<void> {
  const result = await catalogLibraryAPI.pickFolder()
  if (result.success && result.data) folderPath.value = result.data
}

async function start(): Promise<void> {
  if (!targetRoot.value) return
  busy.value = true
  error.value = null
  try {
    const result = await catalogLibraryAPI.download(props.libraryKey, {
      ids: props.items.map((item) => item.id),
      targetRoot: targetRoot.value,
      withDependencies: withDependencies.value
    })
    if (!result.success || !result.data) {
      error.value = catalogErrorText(t, result.errorCode, result.error)
      return
    }
    emit('started', result.data)
    emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped lang="less">
.download {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lead,
.hint {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.names {
  margin: 0;
  padding-left: var(--space-4);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);

  .more {
    color: var(--color-text-muted);
    font-family: inherit;
  }
}

.folder-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
}
</style>
