<template>
  <div class="blueprint-library-layout">
    <!-- 有东西没存上时常驻在页面顶部，直到真的写进去 -->
    <LibrarySaveAlert class="save-alert" :save-state="store.saveState" />
    <router-view v-slot="{ Component }">
      <component :is="Component" v-if="Component" :key="cachedRouteKey" />
    </router-view>
  </div>
</template>

<script setup lang="ts">
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import LibrarySaveAlert from '@renderer/views/library-common/components/LibrarySaveAlert.vue'
import { useLibraryLayout } from '@renderer/views/library-common/composables/useLibraryLayout'

const store = useBlueprintLibraryStore()

const { cachedRouteKey } = useLibraryLayout({
  syncActiveId: (id) => store.setActiveBlueprintId(id),
  onEditorTabIdChange: (tabId) => store.setEditorTabId(tabId)
})
</script>

<style scoped lang="less">
.blueprint-library-layout {
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.save-alert {
  margin: var(--space-3) var(--space-4) 0;
  flex-shrink: 0;
}

/* 淡入淡出过渡效果 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.12s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
