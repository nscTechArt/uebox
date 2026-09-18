import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import { probeScreenCapture } from './screenCaptureProbe'
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const mockStream = (): { stop: ReturnType<typeof vi.fn>; stream: MediaStream } => {
  const stop = vi.fn()
  return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream }
}
it('stops a successful probe immediately', async () => {
  const { stop, stream } = mockStream()
  expect(await probeScreenCapture(async () => stream)).toBe(true)
  expect(stop).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('stops a stream that arrives after the permission prompt outlives the timeout', async () => {
  const { stop, stream } = mockStream()
  let consent!: (stream: MediaStream) => void
  const pending = probeScreenCapture(
    () =>
      new Promise((resolve) => {
        consent = resolve
      })
  )
  await vi.advanceTimersByTimeAsync(1500)
  expect(await pending).toBe(false)
  consent(stream)
  await Promise.resolve()
  expect(stop).toHaveBeenCalledOnce()
})
it('returns false on permission denial without leaking a timer', async () => {
  expect(
    await probeScreenCapture(async () => {
      throw new Error('denied')
    })
  ).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
