<template>
  <AppModal
    :open="open"
    :title="t('catalogLibrary.import.title')"
    :width="520"
    :ok-text="t('catalogLibrary.import.start')"
    :ok-disabled="!canStart"
    :confirm-loading="busy"
    destroy-on-close
    @ok="start"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <div class="import">
      <p class="lead">{{ t('catalogLibrary.import.lead', { folder: folder.path || '/' }) }}</p>
      <div class="row">
        <AppButton size="small" @click="pickFiles">{{
          t('catalogLibrary.import.pickFiles')
        }}</AppButton>
        <span class="hint">{{ t('catalogLibrary.import.picked', { count: files.length }) }}</span>
      </div>
      <ul v-if="files.length > 0" class="names">
        <li v-for="file in files.slice(0, 6)" :key="file">{{ file }}</li>
        <li v-if="files.length > 6" class="more">
          {{ t('catalogLibrary.download.more', { count: files.length - 6 }) }}
        </li>
      </ul>

      <label class="field">
        <span>{{ t('catalogLibrary.import.repository') }}</span>
        <AppSpin v-if="resolving" size="small" />
        <a-select
          v-else
          v-model:value="repositoryId"
          :options="candidates.map((value) => ({ value, label: value }))"
          :placeholder="t('catalogLibrary.import.pickRepository')"
        />
      </label>
      <label class="field">
        <span>{{ t('catalogLibrary.import.message') }}</span>
        <a-input
          v-model:value="commitMessage"
          :placeholder="t('catalogLibrary.import.messagePlaceholder')"
        />
      </label>
      <p class="hint">{{ t('catalogLibrary.import.hint') }}</p>
      <AppAlert v-if="error" type="error" :message="error" show-icon />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 导入 = 以美术本人身份向某个成员仓库提交推送（设计 2.4）。字节只走 Lore 的 QUIC/TLS 通道，
 * 目录服务不转一个字节；推送之后目录服务从修订差异里把它们索引出来。
 * .uasset/.umap 旁边同名的 .uexp/.ubulk 由主进程一起带上。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppAlert from '@renderer/components/AppAlert.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type { CatalogFolder } from '@core/shared/catalogLibrary'
import { catalogErrorOf, catalogErrorText } from './catalogErrors'

const props = defineProps<{
  open: boolean
  libraryKey: string
  folder: CatalogFolder
  initialFiles?: string[]
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'started', jobId: string): void }>()
const { t } = useI18n()

const files = ref<string[]>([])
const repositoryId = ref<string | undefined>(undefined)
const candidates = ref<string[]>([])
const resolving = ref(false)
const commitMessage = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const canStart = computed(() => files.value.length > 0 && Boolean(repositoryId.value))

async function resolve(): Promise<void> {
  resolving.value = true
  try {
    const result = await catalogLibraryAPI.resolveRepository(props.libraryKey, {
      dirId: props.folder.dirId,
      path: props.folder.path
    })
    candidates.value = result.candidates
    repositoryId.value = result.repositoryId ?? undefined
  } catch (failure) {
    error.value = catalogErrorOf(t, failure)
  } finally {
    resolving.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    files.value = [...(props.initialFiles ?? [])]
    commitMessage.value = ''
    error.value = null
    void resolve()
  },
  { immediate: true }
)

async function pickFiles(): Promise<void> {
  const result = await catalogLibraryAPI.pickFiles()
  if (result.success && result.data) files.value = [...new Set([...files.value, ...result.data])]
}

async function start(): Promise<void> {
  if (!canStart.value || !repositoryId.value) return
  busy.value = true
  error.value = null
  try {
    const result = await catalogLibraryAPI.importFiles(props.libraryKey, {
      files: files.value,
      folderPath: props.folder.path,
      repositoryId: repositoryId.value,
      message: commitMessage.value.trim() || null
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
.import {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.lead {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.hint {
  margin: 0;
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

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  > span {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
}
</style>
