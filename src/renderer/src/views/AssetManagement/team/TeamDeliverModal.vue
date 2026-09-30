<template>
  <AppModal
    :open="open"
    :title="t('teamProject.outsource.deliverTitle', { name: projectName })"
    :width="520"
    :ok-text="t('teamProject.outsource.deliver')"
    :cancel-text="t('teamProject.cancel')"
    :ok-disabled="blocked || checkedFiles.length === 0 || busy"
    :confirm-loading="busy"
    destroy-on-close
    @ok="deliver"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <div class="deliver-body">
      <!-- 分组列表：按文件夹，一组一行「☑ Env/Rocks：300 个」 -->
      <label v-for="group in groups" :key="group.folder" class="group-row">
        <AppCheckbox v-model:checked="group.checked" />
        <span>{{
          t('teamProject.outsource.deliverGroup', { folder: group.label, n: group.files.length })
        }}</span>
      </label>
      <label class="field">
        <span>{{ t('teamProject.outsource.deliverMessage') }}</span>
        <a-input v-model:value="note" :maxlength="200" />
      </label>
      <!-- 检查结果用同一种提示行：红点拦住，[交付] 变灰；黄点提醒，照样能交 -->
      <div v-for="(check, index) in checks" :key="index" class="check-line">
        <i class="dot" :class="check.level === 'block' ? 'red' : 'yellow'" />
        {{ checkText(check, t) }}
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 交付给 星海（方案 4.12）：拖进「交付」以后先出这个确认窗，布局照 UE 提交窗口。
 * 上传走导入进度挂件「交付 7 · 上传中 42%」，可以关窗口，断了接着传。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import type { TeamCheck } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import { checkText, folderOf, projectRelativeOf } from './teamFormat'

const props = defineProps<{ open: boolean; files: string[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const { t } = useI18n()
const teamStore = useTeamStore()

const groups = reactive<
  Array<{ folder: string; label: string; files: string[]; checked: boolean }>
>([])
const note = ref('')
const checks = ref<TeamCheck[]>([])
const busy = ref(false)

const projectName = computed(() => teamStore.project?.name ?? teamStore.link?.projectName ?? '')
const checkedFiles = computed(() => groups.filter((g) => g.checked).flatMap((g) => g.files))
const blocked = computed(() => checks.value.some((check) => check.level === 'block'))

watch(
  () => [props.open, props.files] as const,
  async ([open]) => {
    if (!open) return
    groups.splice(0)
    const byFolder = new Map<string, string[]>()
    for (const file of props.files) {
      const folder = folderOf(projectRelativeOf(file))
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
    }
    for (const [folder, files] of byFolder)
      groups.push({
        folder,
        label: folder.replace(/^Content\//, '') || folder,
        files,
        checked: true
      })
    const first = groups[0]
    note.value = first
      ? t('teamProject.outsource.deliverDefault', { folder: first.label, n: props.files.length })
      : ''
    checks.value = []
    const key = teamStore.key
    if (!key) return
    const result = await teamAPI
      .deliveryChecks(
        key,
        props.files.map((file) => ({ path: projectRelativeOf(file) }))
      )
      .catch(() => null)
    checks.value = result?.checks ?? []
  },
  { immediate: true }
)

async function deliver(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  busy.value = true
  const result = await teamAPI.deliver(key, {
    files: checkedFiles.value,
    message: note.value.trim()
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
.deliver-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
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

.check-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);

  &.red {
    background: var(--color-danger-solid);
  }

  &.yellow {
    background: var(--color-warning-solid);
  }
}
</style>
