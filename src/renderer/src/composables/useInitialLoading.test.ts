import { effectScope, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useInitialLoading } from './useInitialLoading'

describe('initial page loading', () => {
  it('does not restore placeholders after an empty first result or a filter refresh', () => {
    const scope = effectScope()
    scope.run(() => {
      const loading = ref(false)
      const populated = ref(false)
      const initial = useInitialLoading(
        () => loading.value,
        () => populated.value
      )
      loading.value = true
      expect(initial.value).toBe(true)
      loading.value = false
      loading.value = true
      expect(initial.value).toBe(false)
    })
    scope.stop()
  })
  it('keeps cached content visible even when later filters are empty', () => {
    const scope = effectScope()
    scope.run(() => {
      const loading = ref(true)
      const populated = ref(true)
      const initial = useInitialLoading(
        () => loading.value,
        () => populated.value
      )
      expect(initial.value).toBe(false)
      populated.value = false
      expect(initial.value).toBe(false)
    })
    scope.stop()
  })
})
