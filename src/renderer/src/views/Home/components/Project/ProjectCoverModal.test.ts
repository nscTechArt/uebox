import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, onMounted } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProjectCoverModal from './ProjectCoverModal.vue'

// Canvas encoding is a browser boundary; retain the actual modal and save API.
vi.mock('vue-cropper/dist/vue-cropper.es.js', () => ({
  VueCropper: defineComponent({
    props: { img: String },
    emits: ['imgLoad'],
    setup(props, { expose, emit }) {
      expose({ getCropBlob: (cb: (blob: Blob) => void) => cb(new Blob(['cropped'])) })
      onMounted(() => emit('imgLoad', 'success'))
      return () => h('img', { src: props.img, alt: 'crop preview' })
    }
  })
}))

let wrapper: VueWrapper
const save = vi.fn()

beforeEach(() => {
  save.mockReset()
  Object.assign(window.api.database, { project: { saveCover: save } })
})

afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text)
  )
  if (!found) throw new Error(`Button missing: ${text}`)
  return found
}

it('keeps the crop open on save failure and allows retrying without choosing the image again', async () => {
  save
    .mockResolvedValueOnce({ success: false })
    .mockResolvedValueOnce({ success: true, data: 'new.jpg' })
  wrapper = mount(ProjectCoverModal, {
    props: { open: true, projectKey: 'one', image: 'data:image/jpeg;base64,YQ==' },
    attachTo: document.body
  })
  await flushPromises()
  button('确认').click()
  await flushPromises()
  expect(save).toHaveBeenCalledWith('one', expect.any(Uint8Array))
  expect(wrapper.emitted('update:open')).toBeUndefined()
  expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,YQ==')
  button('确认').click()
  await flushPromises()
  expect(wrapper.emitted('success')).toHaveLength(1)
  expect(wrapper.emitted('update:open')).toEqual([[false]])
})

it('prevents double submission and canceling while the cover is being saved', async () => {
  let finish: (value: { success: boolean; data: string }) => void = () => {}
  save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  wrapper = mount(ProjectCoverModal, {
    props: { open: true, projectKey: 'one', image: 'data:image/jpeg;base64,YQ==' },
    attachTo: document.body
  })
  await flushPromises()
  button('确认').click()
  button('确认').click()
  await flushPromises()
  expect(save).toHaveBeenCalledTimes(1)
  expect(button('取消').disabled).toBe(true)
  button('取消').click()
  document
    .querySelector('[role="dialog"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(wrapper.emitted('update:open')).toBeUndefined()
  finish({ success: true, data: 'new.jpg' })
  await flushPromises()
  expect(wrapper.emitted('success')).toHaveLength(1)
})

it('canceling before save does not write a cover', async () => {
  wrapper = mount(ProjectCoverModal, {
    props: { open: true, projectKey: 'one', image: 'data:image/jpeg;base64,YQ==' },
    attachTo: document.body
  })
  await flushPromises()
  button('取消').click()
  expect(save).not.toHaveBeenCalled()
  expect(wrapper.emitted('update:open')).toEqual([[false]])
})
