import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { installPageLoading, pendingPage } from './pageLoading'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(): { router: Router; slow: Deferred; newer: Deferred } {
  const slow = deferred()
  const newer = deferred()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      {
        path: '/blueprint-library',
        component: { template: '<div />' },
        beforeEnter: () => slow.promise
      },
      {
        path: '/material-library',
        component: { template: '<div />' },
        beforeEnter: () => newer.promise
      },
      { path: '/notebooks', component: () => slow.promise.then(() => ({ template: '<div />' })) }
    ]
  })
  installPageLoading(router)
  return { router, slow, newer }
}

describe('page loading feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pendingPage.value = null
  })
  afterEach(() => {
    vi.useRealTimers()
    pendingPage.value = null
  })

  it('does not flash on an immediately available page', async () => {
    const { router } = setup()
    await router.push('/')
    await vi.advanceTimersByTimeAsync(150)
    expect(pendingPage.value).toBeNull()
  })

  it('shows the destination while a data guard waits and clears on success', async () => {
    const { router, slow } = setup()
    const navigation = router.push('/blueprint-library')
    await vi.advanceTimersByTimeAsync(150)
    expect(pendingPage.value?.path).toBe('/blueprint-library')
    slow.resolve()
    await navigation
    expect(pendingPage.value).toBeNull()
  })

  it('keeps the page visible during slow query and hash updates', async () => {
    const { router } = setup()
    await router.push('/')
    const wait = deferred()
    router.beforeEach(() => wait.promise)
    const navigation = router.push('/?filter=recent#results')
    await vi.advanceTimersByTimeAsync(150)
    expect(pendingPage.value).toBeNull()
    wait.resolve()
    await navigation
  })

  it('also covers lazy component loading', async () => {
    const { router, slow } = setup()
    const navigation = router.push('/notebooks')
    await vi.advanceTimersByTimeAsync(150)
    expect(pendingPage.value?.path).toBe('/notebooks')
    slow.resolve()
    await navigation
    expect(pendingPage.value).toBeNull()
  })

  it('an older cancelled navigation cannot clear newer feedback', async () => {
    const { router, slow, newer } = setup()
    const first = router.push('/blueprint-library')
    await vi.advanceTimersByTimeAsync(150)
    const second = router.push('/material-library')
    await vi.advanceTimersByTimeAsync(150)
    slow.resolve()
    await first
    expect(pendingPage.value?.path).toBe('/material-library')
    newer.resolve()
    await second
    expect(pendingPage.value).toBeNull()
  })

  it('clears feedback after a failed load', async () => {
    const { router, slow } = setup()
    const navigation = router.push('/notebooks').catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(150)
    slow.reject(new Error('load failed'))
    expect(await navigation).toBeInstanceOf(Error)
    expect(pendingPage.value).toBeNull()
  })

  it('immediately restores the current page when it is clicked during loading', async () => {
    const { router, slow } = setup()
    await router.push('/')
    const navigation = router.push('/blueprint-library')
    await vi.advanceTimersByTimeAsync(150)
    expect(pendingPage.value?.path).toBe('/blueprint-library')
    await router.push('/')
    expect(pendingPage.value).toBeNull()
    slow.resolve()
    await navigation
    expect(router.currentRoute.value.path).toBe('/')
  })
})
