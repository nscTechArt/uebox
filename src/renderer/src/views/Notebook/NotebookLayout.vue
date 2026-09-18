<template>
  <div class="notebook-layout">
    <router-view v-slot="{ Component }">
      <component :is="Component" v-if="Component" :key="cachedRouteKey" />
    </router-view>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import { getNotebookTabIdFromQuery } from '@renderer/views/Notebook/utils/notebookTabRoute'

const route = useRoute()
const notebookStore = useNotebookStore()
const isLayoutActive = ref(true)
const cachedRouteKey = ref(route.fullPath)

watch(
  () => route.fullPath,
  (nextPath) => {
    if (!isLayoutActive.value) return
    cachedRouteKey.value = nextPath
  }
)

watch(
  () => route.query._tab_id,
  () => {
    if (!isLayoutActive.value) return
    notebookStore.setTabId(getNotebookTabIdFromQuery(route.query))
  },
  { immediate: true }
)

/**
 * Track the active notebook only while the cached layout is visible.
 */
watch(
  () => route.params.id,
  (newId) => {
    if (!isLayoutActive.value) return
    notebookStore.setActiveNotebookId(newId && typeof newId === 'string' ? newId : null)
  },
  { immediate: true }
)

onActivated(() => {
  isLayoutActive.value = true
  cachedRouteKey.value = route.fullPath
  notebookStore.setTabId(getNotebookTabIdFromQuery(route.query))
})

onDeactivated(() => {
  isLayoutActive.value = false
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
