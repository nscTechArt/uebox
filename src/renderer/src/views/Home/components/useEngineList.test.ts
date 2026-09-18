import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

async function setup(): Promise<{
  scan: Mock<Window['api']['unrealPath']['scanEngines']>
  useEngineList: typeof import('./useEngineList').useEngineList
}> {
  const scan = vi.fn<Window['api']['unrealPath']['scanEngines']>()
  vi.stubGlobal('api', { ...window.api, unrealPath: { scanEngines: scan } })
  const { useEngineList } = await import('./useEngineList')
  return { scan, useEngineList }
}

describe('engine list session cache', () => {
  it('shows a skeleton only before the first result, then reuses content during a background scan', async () => {
    const { scan, useEngineList } = await setup()
    scan.mockResolvedValueOnce({ success: true, data: [{ version: '5.5' }] } as never)
    const first = useEngineList()
    expect(first.initLoading.value).toBe(true)
    await first.refresh()
    const reopened = useEngineList()
    expect(reopened.engines.value[0].version).toBe('5.5')
    expect(reopened.initLoading.value).toBe(false)
    let finish!: (value: never) => void
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const refreshing = reopened.refresh()
    expect(reopened.initLoading.value).toBe(false)
    expect(reopened.engines.value[0].version).toBe('5.5')
    expect(first.refresh()).toBe(refreshing)
    finish({ success: true, data: [{ version: '5.6' }] } as never)
    await refreshing
    expect(reopened.engines.value[0].version).toBe('5.6')
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('keeps cached content on a failed scan without allowing selection cleanup', async () => {
    const { scan, useEngineList } = await setup()
    scan.mockResolvedValueOnce({ success: true, data: [{ version: '5.5' }] } as never)
    await useEngineList().refresh()
    scan.mockResolvedValueOnce({ success: false } as never)
    const state = useEngineList()
    expect((await state.refresh()).syncSelections).toBe(false)
    expect(state.scanFailed.value).toBe(true)
    expect(state.engines.value[0].version).toBe('5.5')
    expect(state.initLoading.value).toBe(false)
  })

  it('caches a successful empty result and shares user edits across remounts', async () => {
    const { scan, useEngineList } = await setup()
    scan.mockResolvedValueOnce({ success: true, data: [] } as never)
    await useEngineList().refresh()
    const state = useEngineList()
    expect(state.initLoading.value).toBe(false)
    expect(state.engines.value).toEqual([])
    const { mapEngineInfoToItem } = await import('./useEngineList')
    state.engines.value.push(mapEngineInfoToItem({ version: '5.7' }))
    expect(useEngineList().engines.value[0].version).toBe('5.7')
    state.engines.value.splice(0, 1)
    expect(useEngineList().engines.value).toEqual([])
  })
})
