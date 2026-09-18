<script setup lang="ts">
import { useI18n } from 'vue-i18n'

withDefaults(
  defineProps<{
    title?: string
    layout?: 'grid' | 'list'
    count?: number
    variant?: 'projects' | 'engines' | 'assets' | 'folders' | 'notebooks'
  }>(),
  {
    title: undefined,
    layout: 'grid',
    count: 12,
    variant: 'notebooks'
  }
)
const { t } = useI18n()
</script>

<template>
  <section
    class="page-skeleton"
    :class="variant"
    role="status"
    :aria-label="t('common.loading')"
    aria-busy="true"
  >
    <header v-if="title" class="skeleton-header">
      <h2>{{ title }}</h2>
      <span>{{ t('common.loading') }}</span>
    </header>
    <div class="skeleton-items" :class="layout" aria-hidden="true">
      <div v-for="item in count" :key="item" class="skeleton-item">
        <div class="skeleton-cover pulse"></div>
        <div class="skeleton-copy">
          <div class="skeleton-line pulse"></div>
          <div class="skeleton-line short pulse"></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-skeleton {
  width: 100%;
  box-sizing: border-box;
}
.skeleton-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  color: var(--color-text-secondary);
}
.skeleton-header h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--color-text-primary);
}
.skeleton-items {
  display: grid;
  gap: var(--space-4);
}
.grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--skeleton-card-width)), 1fr));
  gap: var(--space-5);
}
.page-skeleton.notebooks {
  --skeleton-card-width: calc(var(--space-12) * 4 + var(--space-6));
}
.page-skeleton.projects {
  --skeleton-card-width: calc(var(--space-9) * 4 + var(--space-5));
}
.page-skeleton.engines {
  --skeleton-card-width: calc(var(--space-20) * 2 + var(--space-7));
}
.page-skeleton.assets,
.page-skeleton.folders {
  --skeleton-card-width: var(--asset-loading-size, calc(var(--space-9) * 3));
}
.page-skeleton.projects .skeleton-item {
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
}
.page-skeleton.projects .skeleton-cover {
  flex: 1;
  min-height: 0;
  aspect-ratio: auto;
}
.page-skeleton.projects .skeleton-copy {
  flex: none;
  padding: var(--space-3);
}
.page-skeleton.projects .short {
  display: none;
}
.page-skeleton.notebooks .skeleton-item {
  height: calc(var(--space-9) * 5);
  display: flex;
  flex-direction: column;
}
.page-skeleton.notebooks .skeleton-cover {
  flex: 1;
  aspect-ratio: auto;
}
.page-skeleton.notebooks .skeleton-copy {
  flex: none;
}
.page-skeleton.engines .grid {
  gap: var(--space-4);
}
.page-skeleton.engines .skeleton-item {
  height: calc(var(--space-24) + var(--space-5));
  max-width: calc(var(--space-9) * 6);
}
.page-skeleton.engines .skeleton-cover {
  margin: var(--space-4);
  height: var(--space-8);
  width: 30%;
}
.page-skeleton.engines .skeleton-copy {
  border-top: 1px solid var(--color-border-subtle);
  padding: var(--space-3) var(--space-8);
}
.page-skeleton.engines .short {
  display: none;
}
.page-skeleton.assets .skeleton-item,
.page-skeleton.folders .skeleton-item {
  border: 0;
  border-radius: 0;
}
.page-skeleton.assets .skeleton-cover {
  aspect-ratio: 1;
  border-radius: var(--radius-xs);
}
.page-skeleton.assets .skeleton-copy,
.page-skeleton.folders .skeleton-copy {
  padding: var(--space-4);
}
.page-skeleton.assets .short,
.page-skeleton.folders .short {
  display: none;
}
.page-skeleton.folders .skeleton-cover {
  width: 80%;
  margin: var(--space-6) auto;
  aspect-ratio: 1.2;
  clip-path: polygon(0 0, 35% 0, 48% 15%, 100% 15%, 100% 100%, 0 100%);
}
.list .skeleton-item {
  height: var(--space-12);
  aspect-ratio: auto;
}
.list .skeleton-cover {
  flex: none;
}
.skeleton-item {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-container);
}
.skeleton-cover {
  aspect-ratio: 16 / 9;
}
.skeleton-copy {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4);
  flex: 1;
}
.skeleton-line {
  height: var(--space-3);
  border-radius: var(--radius-sm);
}
.short {
  width: 55%;
}
.list .skeleton-item {
  display: flex;
  flex-direction: row;
  align-items: center;
}
.list .skeleton-cover {
  width: var(--space-12);
  aspect-ratio: 1;
}
.pulse {
  background: var(--color-bg-surface-hover);
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}
@keyframes skeleton-pulse {
  50% {
    opacity: 0.45;
  }
}
[data-motion='reduced'] .pulse {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  html:not([data-motion='full']) .pulse {
    animation: none;
  }
}
</style>
