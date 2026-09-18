<script setup lang="ts">
/**
 * 导入弹窗底栏那一行：导到哪个工程，以及版本预检有没有话要说。
 *
 * 这里不放「展开详情」：保存位置和落盘规则是导入过程的事，挑工程的时候没人读，
 * 而且展开会把底栏顶高、整个弹窗跟着变大。底栏只留一句结论，有问题才多一行警告。
 */
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'

defineProps<{
  projectKey: string
  projectName: string
  compatibilityText: string
  blocked: number
  failed: boolean
}>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="target-summary">
    <span class="target-name" :title="projectName">
      {{ t('importToProjectModal.targetProject', { name: projectName }) }}
    </span>
    <div v-if="blocked > 0 || failed" class="target-warning" role="status">
      <span>{{ compatibilityText }}</span>
      <AppButton v-if="failed" variant="text" size="small" @click="emit('retry')">
        {{ t('importToProjectModal.retry') }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.target-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
/* 这是底栏最该被读到的一句 */
.target-name {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  overflow-wrap: anywhere;
}
.target-warning {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--color-warning-text);
}
</style>
