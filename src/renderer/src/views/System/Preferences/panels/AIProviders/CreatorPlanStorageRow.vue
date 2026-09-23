<script setup lang="ts">
/**
 * 导入预览里「对象存储」那一行：勾上就把对象存储换成套餐自带的（不用填密钥），
 * 断开套餐时换回原来的。套餐不带存储（清单 storage.enabled 为假）时父组件不渲染这一行。
 *
 * 和角色那几行同一个默认：没开对象存储的勾，自己配好了桶的不勾。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import type { CreatorPlanStoragePreview } from '@core/shared/creatorPlan'

const props = defineProps<{ storage: CreatorPlanStoragePreview; checked: boolean }>()
const emit = defineEmits<{ (e: 'update:checked', value: boolean): void }>()

const { t, te } = useI18n()

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`
  return `${Number((bytes / 1024 ** 2).toFixed(0))} MB`
}

const spec = computed(() =>
  t('aiProvider.creatorPlan.storage.spec', {
    quota: formatBytes(props.storage.quotaBytes),
    days: props.storage.retentionDays
  })
)

const current = computed(() => {
  const now = props.storage.current
  if (now.kind === 'plan') return t('aiProvider.creatorPlan.previewManaged')
  if (now.kind === 'none') return t('aiProvider.creatorPlan.storage.off')
  const presetKey = `profile.objectStorage.presets.${now.preset}`
  const provider = te(presetKey) ? t(presetKey) : now.preset
  return t('aiProvider.creatorPlan.previewCurrent', { name: `${now.bucket} · ${provider}` })
})
</script>

<template>
  <div class="storage-row">
    <AppCheckbox
      :checked="checked"
      @update:checked="(value: boolean) => emit('update:checked', value)"
    >
      {{ $t('aiProvider.creatorPlan.storage.label') }}
    </AppCheckbox>
    <span class="storage-meta">
      <span>{{ spec }}</span>
      <span>{{ current }}</span>
    </span>
  </div>
</template>

<style scoped>
/* 和 CreatorPlanCard 里的 .preview-row 对齐 */
.storage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-border-subtle);
}

.storage-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
