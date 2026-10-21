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
</style>
