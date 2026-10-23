<template>
  <div class="notebook-layout">
    <router-view v-slot="{ Component }" :route="viewRoute">
      <component :is="Component" v-if="Component && keepChild" :key="viewRoute.fullPath" />
    </router-view>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { getTabIdFromQuery } from '@renderer/common/tabRoute'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import { useLibraryLayout } from '@renderer/views/library-common/composables/useLibraryLayout'

const notebookStore = useNotebookStore()

const { viewRoute, keepChild } = useLibraryLayout()

// 记录本 tab 打开的笔记本：从侧栏回到笔记本列表时，路由守卫据此按 tab 跳回详情页
watch(
  viewRoute,
  (route) => {
    const id = route.params.id
    notebookStore.setActiveNotebookId(
      typeof id === 'string' && id ? id : null,
      getTabIdFromQuery(route.query)
    )
  },
  { immediate: true }
)
</script>

<style scoped lang="less">
.notebook-layout {
  height: 100%;
  position: relative;
}
</style>
