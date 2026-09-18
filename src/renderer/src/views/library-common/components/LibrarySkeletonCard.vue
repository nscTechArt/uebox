<script setup lang="ts">
/**
 * 加载中的骨架卡片。放进 LibraryGrid 里，数量由调用方决定。
 *
 * 形状刻意跟 LibraryCard 对齐（130px 封面 + 四行信息），
 * 这样从骨架切到真卡片时布局不跳。
 */
</script>

<template>
  <div class="skeleton-card">
    <div class="skeleton-cover"></div>
    <div class="skeleton-info">
      <div class="skeleton-line title"></div>
      <div class="skeleton-line path"></div>
      <div class="skeleton-line meta"></div>
      <div class="skeleton-line stats"></div>
    </div>
  </div>
</template>

<style scoped lang="less">
.skeleton-card {
  min-height: 230px;
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface-hover);
  overflow: hidden;
  pointer-events: none;
}

.skeleton-cover {
  height: 130px;
  background: var(--color-bg-surface);
}

.skeleton-info {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton-line {
  background: var(--color-border-subtle);
  border-radius: 3px;
}

.skeleton-line.title {
  height: 16px;
  width: 60%;
}

.skeleton-line.path {
  height: 12px;
  width: 80%;
}

.skeleton-line.meta {
  height: 18px;
  width: 100%;
}

.skeleton-line.stats {
  height: 12px;
  width: 50%;
}

.skeleton-cover,
.skeleton-line {
  animation: skeleton-pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes skeleton-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

@media (prefers-reduced-motion: reduce) {
  html:not([data-motion='full']) .skeleton-cover,
  html:not([data-motion='full']) .skeleton-line {
    animation: none;
  }
}

[data-motion='reduced'] .skeleton-cover,
[data-motion='reduced'] .skeleton-line {
  animation: none;
}
</style>
