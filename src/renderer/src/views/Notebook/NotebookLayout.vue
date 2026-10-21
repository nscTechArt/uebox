<template>
  <div class="notebook-layout">
    <router-view v-slot="{ Component }" :route="viewRoute">
      <component :is="Component" v-if="Component && keepChild" :key="viewRoute.fullPath" />
    </router-view>
  </div>
</template>

<script setup lang="ts">
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import { useLibraryLayout } from '@renderer/views/library-common/composables/useLibraryLayout'

const notebookStore = useNotebookStore()

const { viewRoute, keepChild } = useLibraryLayout({
  syncActiveId: (id) => notebookStore.setActiveNotebookId(id),
  syncTabId: (tabId) => notebookStore.setTabId(tabId)
})
</script>

<style scoped lang="less">
.notebook-layout {
  height: 100%;
  position: relative;
}

/* 加载占位符样式 */
.loading-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
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
