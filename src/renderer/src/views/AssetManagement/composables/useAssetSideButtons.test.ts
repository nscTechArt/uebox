import { expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { useAssetSideButtons } from './useAssetSideButtons'

it('only the active cached page receives side buttons, once per gesture', async () => {
  const current = ref('a')
  const calls = { a: vi.fn(), b: vi.fn() }
  const deactivated = vi.fn()
  const page = (name: 'a' | 'b'): ReturnType<typeof defineComponent> =>
    defineComponent({
      setup() {
        useAssetSideButtons(calls[name], vi.fn(), deactivated)
        return () => h('div', name)
      }
    })
  const pages = { a: page('a'), b: page('b') }
  const wrapper = mount({
    setup: () => () =>
      h(KeepAlive, null, {
        default: () =>
          current.value === 'other'
            ? h('div', 'other')
            : h(pages[current.value as 'a' | 'b'], { key: current.value })
      })
  })
  const gesture = (button = 3): void => {
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      window.dispatchEvent(new MouseEvent(type, { button, cancelable: true }))
    }
  }
  gesture()
  expect(calls.a).toHaveBeenCalledTimes(1)
  current.value = 'b'
  await nextTick()
  gesture(4)
  expect(calls.a).toHaveBeenCalledTimes(1)
  expect(calls.b).toHaveBeenCalledTimes(1)
  current.value = 'other'
  await nextTick()
  const ignored = new MouseEvent('mouseup', { button: 3, cancelable: true })
  window.dispatchEvent(ignored)
  expect(ignored.defaultPrevented).toBe(false)
  expect(calls.b).toHaveBeenCalledTimes(1)
  current.value = 'a'
  await nextTick()
  gesture(0)
  gesture(3)
  expect(calls.a).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  gesture()
  expect(calls.a).toHaveBeenCalledTimes(2)
  expect(deactivated).toHaveBeenCalledTimes(3)
})
