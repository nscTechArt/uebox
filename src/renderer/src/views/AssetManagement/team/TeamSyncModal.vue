<template>
  <AppModal
    :open="open"
    :title="t('teamProject.sync.title', { name: projectName })"
    :width="460"
    :ok-text="t('teamProject.sync.start')"
    :cancel-text="t('teamProject.cancel')"
    :ok-disabled="!canStart"
    :confirm-loading="busy"
    destroy-on-close
    @ok="start"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <div class="sync-body">
      <!-- 默认可见：一行「放在 [D:\UEProjects\星海 ▾]」；一行灰字「约 120 GB · D 盘还剩 400 GB」 -->
      <div class="place-row">
        <span class="muted">{{ t('teamProject.sync.placeAt') }}</span>
        <button class="place-btn" data-testid="team-sync-place" @click="pickPlace">
          {{ target || t('teamProject.sync.choose') }} <PhCaretDown />
        </button>
      </div>
      <div class="muted">
        <template v-if="existing">{{ t('teamProject.sync.existing') }}</template>
        <template v-else-if="free !== null">
          {{
            size !== null
              ? t(drive ? 'teamProject.sync.size' : 'teamProject.sync.sizeHere', {
                  size: formatSize(size),
                  drive,
                  free: formatSize(free)
                })
              : t(drive ? 'teamProject.sync.free' : 'teamProject.sync.freeHere', {
                  drive,
                  free: formatSize(free)
                })
          }}
        </template>
      </div>
      <!-- 按需：盘不够 -->
      <div v-if="shortBy > 0" class="warn-line">
        <i class="dot red" />{{
          t(drive ? 'teamProject.sync.notEnough' : 'teamProject.sync.notEnoughHere', {
            drive,
            need: formatSize(shortBy)
          })
        }}
      </div>
      <div v-if="!existing" class="muted">
        {{ t('teamProject.sync.haveIt') }}
        <button class="link-btn" @click="pickExisting">{{ t('teamProject.sync.pickIt') }}</button>
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 同步 星海 到本机（方案 4.3）：默认同步全部文件夹，Content 以外放源文件的文件夹默认不同步；
 * 弹窗里不选文件夹。进度走导入进度挂件，可以关窗口。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown } from '@phosphor-icons/vue'
import AppModal from '@renderer/components/AppModal.vue'
import { teamAPI } from '@renderer/api/team'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import { message } from '@renderer/utils/messageManager'
import { formatSize } from './teamFormat'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const { t } = useI18n()
const teamStore = useTeamStore()
const libraryStore = useAssetLibraryStore()

const target = ref('')
const existing = ref(false)
const free = ref<number | null>(null)
const size = ref<number | null>(null)
const busy = ref(false)

const projectName = computed(() => teamStore.project?.name ?? teamStore.link?.projectName ?? '')
/** Windows 默认放 D:\UEProjects（没有 D 盘放 C:）；macOS / Linux 放 ~/UEProjects，主进程展开 ~ */
const onWindows = window.api?.platform === 'win32'
const sep = onWindows ? '\\' : '/'
const drive = computed(() => (/^([A-Za-z]):/.exec(target.value)?.[1] ?? '').toUpperCase())
const shortBy = computed(() =>
  !existing.value && free.value !== null && size.value !== null ? size.value - free.value : 0
)
const canStart = computed(() => Boolean(target.value) && shortBy.value <= 0 && !busy.value)

async function refreshFree(): Promise<void> {
  free.value = target.value ? await teamAPI.freeSpace(target.value).catch(() => null) : null
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    existing.value = false
    const name = projectName.value || 'Project'
    if (onWindows) {
      const dFree = await teamAPI.freeSpace('D:\\').catch(() => null)
      target.value = `${dFree !== null ? 'D:' : 'C:'}\\UEProjects\\${name}`
    } else {
      target.value = `~/UEProjects/${name}`
    }
    await refreshFree()
    // 工程多大：目录服务的库计数
    const library = libraryStore.activeServer
    if (library) {
      const remote = await catalogLibraryAPI.remoteLibraries(library.serverId).catch(() => null)
      const row = (remote?.data ?? []).find((item) => item.id === library.libraryId)
      const bytes = (row as { counts?: { bytes?: number } } | undefined)?.counts?.bytes
      size.value = typeof bytes === 'number' ? bytes : null
    }
  },
  { immediate: true }
)

async function pickPlace(): Promise<void> {
  const result = await catalogLibraryAPI.pickFolder()
  if (!result.success || !result.data) return
  const name = projectName.value || 'Project'
  const inspected = await teamAPI.inspectFolder(result.data).catch(() => null)
  target.value = inspected?.empty
    ? result.data
    : `${result.data.replace(/[\\/]+$/, '')}${sep}${name}`
  existing.value = false
  await refreshFree()
}

/** 「电脑上已经有这个工程？[选它]」：只下载不一样的文件 */
async function pickExisting(): Promise<void> {
  const result = await catalogLibraryAPI.pickFolder()
  if (!result.success || !result.data) return
  target.value = result.data
  existing.value = true
  await refreshFree()
}

async function start(): Promise<void> {
  const key = teamStore.key
  if (!key || !canStart.value) return
  busy.value = true
  const result = await teamAPI.syncToLocal(key, {
    targetDir: target.value,
    existing: existing.value
  })
  busy.value = false
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  emit('close')
}
</script>

<style scoped lang="less">
.sync-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.place-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.place-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.warn-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);

  &.red {
    background: var(--color-danger-solid);
  }
}

.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent-text);
  cursor: pointer;
}
</style>
