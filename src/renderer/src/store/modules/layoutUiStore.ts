import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Shared runtime layout signals for cross-page UI coordination.
 */
export const useLayoutUiStore = defineStore('layoutUi', () => {
  const sideMenuCollapseRequestVersion = ref(0)

  function requestSideMenuCollapse(): void {
    sideMenuCollapseRequestVersion.value += 1
  }

  return {
    sideMenuCollapseRequestVersion,
    requestSideMenuCollapse
  }
})
