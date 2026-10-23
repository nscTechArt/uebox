<template>
  <div class="blueprint-library-layout">
    <!-- 有东西没存上时常驻在页面顶部，直到真的写进去 -->
    <LibrarySaveAlert class="save-alert" :save-state="store.saveState" />
    <router-view v-slot="{ Component }" :route="viewRoute">
      <component :is="Component" v-if="Component && keepChild" :key="viewRoute.fullPath" />
    </router-view>
  </div>
</template>

<script setup lang="ts">
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import LibrarySaveAlert from '@renderer/views/library-common/components/LibrarySaveAlert.vue'
import { useLibraryLayout } from '@renderer/views/library-common/composables/useLibraryLayout'

const store = useBlueprintLibraryStore()

const { viewRoute, keepChild } = useLibraryLayout()
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
</style>
