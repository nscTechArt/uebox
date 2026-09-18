<script setup lang="ts">
/**
 * 菜单里的一组，带一个小标题。接替 `<a-menu-item-group>`（3 处）。
 *
 * 用 `role="group"` + `aria-labelledby` 把标题和这组项关联起来 ——
 * 读屏软件才会念「分组：排序方式」，否则一串菜单项听下来是平的。
 */
import { useId } from 'vue'

defineProps<{ title?: string }>()

const titleId = `app-menu-group-${useId()}`
</script>

<template>
  <li class="app-menu-item-group" role="none">
    <div v-if="title" :id="titleId" class="app-menu-item-group__title">{{ title }}</div>
    <ul
      class="app-menu-item-group__list"
      role="group"
      :aria-labelledby="title ? titleId : undefined"
    >
      <slot />
    </ul>
  </li>
</template>

<style scoped>
.app-menu-item-group {
  list-style: none;
}

.app-menu-item-group__title {
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.app-menu-item-group__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
