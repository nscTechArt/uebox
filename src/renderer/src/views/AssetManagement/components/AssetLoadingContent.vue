<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppPageSkeleton from '@renderer/components/AppPageSkeleton.vue'
const { t } = useI18n()
</script>

<template>
  <div class="asset-loading-content">
    <h3>{{ t('assetLib.fileList.folders') }}</h3>
    <AppPageSkeleton variant="folders" :count="8" />
    <h3>{{ t('assetLib.fileList.files') }}</h3>
    <AppPageSkeleton variant="assets" :count="16" />
  </div>
</template>

<style scoped>
h3 {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: var(--space-4) 0;
}
h3::after {
  content: '';
  height: 1px;
  background: var(--color-border-subtle);
  flex: 1;
}
</style>
