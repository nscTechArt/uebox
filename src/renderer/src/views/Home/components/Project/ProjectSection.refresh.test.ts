import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProjectSection from './ProjectSection.vue'

type ProjectsResult = Awaited<ReturnType<typeof window.api.database.project.getAll>>
const getProjects = vi.fn<typeof window.api.database.project.getAll>()
const getCollections = vi.fn<typeof window.api.database.projectCollection.getAll>()
const unsubscribe = vi.fn()
const originalDatabase = window.api.database
let notify: () => void
let wrapper: VueWrapper

function result(image: string): ProjectsResult {
  return { success: true, data: [{ projectKey: 'one', image: `file:///${image}` }] }
}

beforeEach(() => {
  getProjects.mockReset().mockResolvedValue(result('initial.jpg'))
  getCollections.mockReset().mockResolvedValue({ success: true, data: [] })
  localStorage.removeItem('home.projectFilter')
  window.api.database = {
    ...originalDatabase,
    project: {
      ...originalDatabase.project,
      getAll: getProjects,
      onLibraryChanged: (callback) => {
        notify = callback
        return unsubscribe
      }
    },
    projectCollection: { ...originalDatabase.projectCollection, getAll: getCollections }
  }
})

afterEach(() => {
  wrapper?.unmount()
  window.api.database = originalDatabase
  localStorage.removeItem('home.projectFilter')
})

function mount(): VueWrapper {
  // Keep the real card so assertions inspect the cover rendered by ProjectSection.
  wrapper = shallowMount(ProjectSection, {
    global: { stubs: { AppCard: false, ASpace: true, ASelect: true, AInputSearch: true } }
  })
  return wrapper
}

it('replays changes received during initial load and coalesces notifications', async () => {
  const first = Promise.withResolvers<ProjectsResult>()
  getProjects.mockReturnValueOnce(first.promise).mockResolvedValue(result('new.jpg'))
  mount()
  expect(wrapper.find('app-page-skeleton-stub').exists()).toBe(true)
  notify()
  notify()
  expect(getProjects).toHaveBeenCalledTimes(1)

  first.resolve(result('old.jpg'))
  await flushPromises()
  expect(wrapper.get('.project-thumb img').attributes('src')).toBe('local-resource://new.jpg')
  expect(getProjects).toHaveBeenCalledTimes(2)
  expect(getCollections).toHaveBeenCalledTimes(2)
  expect(wrapper.find('app-page-skeleton-stub').exists()).toBe(false)
})

it('also replays changes received during the catch-up load without overlapping requests', async () => {
  const first = Promise.withResolvers<ProjectsResult>()
  const second = Promise.withResolvers<ProjectsResult>()
  getProjects.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  mount()
  notify()
  first.resolve(result('old.jpg'))
  await flushPromises()
  expect(getProjects).toHaveBeenCalledTimes(2)
  notify()
  expect(getProjects).toHaveBeenCalledTimes(2)

  second.resolve(result('stale.jpg'))
  await flushPromises()
  expect(getProjects).toHaveBeenCalledTimes(3)
  expect(wrapper.get('.project-thumb img').attributes('src')).toBe('local-resource://initial.jpg')
})

it('does not start a catch-up load after unmount', async () => {
  const first = Promise.withResolvers<ProjectsResult>()
  getProjects.mockReturnValueOnce(first.promise)
  mount()
  notify()
  wrapper.unmount()
  first.resolve(result('old.jpg'))
  await flushPromises()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(getProjects).toHaveBeenCalledTimes(1)
})

it('loads once without early notifications and still refreshes after initialization', async () => {
  mount()
  await flushPromises()
  expect(getProjects).toHaveBeenCalledOnce()
  getProjects.mockResolvedValue(result('new.jpg'))
  notify()
  await flushPromises()
  expect(getProjects).toHaveBeenCalledTimes(2)
  expect(wrapper.get('.project-thumb img').attributes('src')).toBe('local-resource://new.jpg')
})

it('discards a queued post-initialization refresh when the component unmounts', async () => {
  mount()
  await flushPromises()
  const refresh = Promise.withResolvers<ProjectsResult>()
  getProjects.mockReturnValueOnce(refresh.promise)
  notify()
  notify()
  expect(getProjects).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  refresh.resolve(result('new.jpg'))
  await flushPromises()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(getProjects).toHaveBeenCalledTimes(2)
  expect(getCollections).toHaveBeenCalledTimes(2)
})

it('replays updates received during a post-initialization refresh', async () => {
  mount()
  await flushPromises()
  const refresh = Promise.withResolvers<ProjectsResult>()
  getProjects.mockReturnValueOnce(refresh.promise).mockResolvedValue(result('latest.jpg'))
  notify()
  notify()
  expect(getProjects).toHaveBeenCalledTimes(2)
  expect(wrapper.get('.project-thumb img').attributes('src')).toBe('local-resource://initial.jpg')

  refresh.resolve(result('stale.jpg'))
  await flushPromises()
  expect(wrapper.get('.project-thumb img').attributes('src')).toBe('local-resource://latest.jpg')
  expect(getProjects).toHaveBeenCalledTimes(3)
  expect(getCollections).toHaveBeenCalledTimes(3)
})
