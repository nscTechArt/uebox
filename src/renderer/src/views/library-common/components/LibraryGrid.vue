<script setup lang="ts">
/**
 * 蓝图库 / 材质库共用的网格容器。
 *
 * 只有一件事：自适应列宽的卡片网格。拖放监听由调用方通过
 * attrs 落到根节点上（`@dragover.prevent` / `@drop.prevent`）。
 */
</script>

<template>
  <div class="library-grid">
    <slot />
  </div>
</template>

<style scoped lang="less">
.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-5);
}
</style>
