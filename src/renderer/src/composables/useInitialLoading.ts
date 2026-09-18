import { computed, ref, watch, type ComputedRef } from 'vue'

/** Only the first load may replace the page with a placeholder. */
export function useInitialLoading(
  loading: () => boolean,
  hasContent: () => boolean
): ComputedRef<boolean> {
  const completed = ref(hasContent())
  watch(
    [loading, hasContent],
    ([busy, populated], previous) => {
      if (populated || (previous?.[0] && !busy)) completed.value = true
    },
    { immediate: true, flush: 'sync' }
  )
  return computed(() => loading() && !completed.value)
}
