import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { expect, it } from 'vitest'
import { provideFileReview, useFileReview } from './useFileReview'

it('keeps review tabs per conversation and closing does not discard snapshots', async () => {
  const sid = ref('a')
  let state!: ReturnType<typeof provideFileReview>
  const change = { path: 'test.js', before: 'a', after: 'b', created: false }
  const Child = defineComponent({
    setup() {
      const open = useFileReview()!
      return { open, change }
    },
    template: '<button @click="open([change], change.path)">review</button>'
  })
  const wrapper = mount({
    components: { Child },
    setup() {
      state = provideFileReview(sid)
    },
    template: '<Child />'
  })
  await wrapper.find('button').trigger('click')
  expect(state.review.value?.active).toBe(true)
  state.selectBrowser()
  expect(state.review.value?.active).toBe(false)
  sid.value = 'b'
  expect(state.review.value).toBeUndefined()
  sid.value = 'a'
  expect(state.review.value?.changes[0]).toEqual(change)
  state.close()
  expect(state.review.value).toBeUndefined()
  await wrapper.find('button').trigger('click')
  expect(state.review.value?.changes[0]).toEqual(change)
  wrapper.unmount()
})
