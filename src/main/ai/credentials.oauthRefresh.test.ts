/** @vitest-environment node */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'uebox-credentials-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

let release: () => void = () => {}
const refreshOAuthTokens = vi.fn(
  () =>
    new Promise((resolve) => {
      release = () =>
        resolve({ accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })
    })
)
vi.mock('./oauth', () => ({
  isExpired: (tokens: { expiresAt?: number }) => (tokens.expiresAt ?? Infinity) < Date.now(),
  refreshOAuthTokens
}))

const { resolveApiKey, saveOAuthTokens } = await import('./credentials')

/**
 * 刷新令牌是一次性的：同一份令牌同时续两次，后到的那次拿着作废的刷新令牌，换来「请重新登录」。
 * 一次出几张图、或生图与对话共用一份登录时，过期那一刻正好是并发的。
 */
describe('登录令牌续期', () => {
  it('同一份令牌同时被要，只续一次，大家拿到同一个新令牌', async () => {
    const ref = await saveOAuthTokens('provider:chatgpt', 'chatgpt', {
      accessToken: 'stale',
      refreshToken: 'r1',
      expiresAt: Date.now() - 1000
    })

    const pending = [resolveApiKey(ref), resolveApiKey(ref), resolveApiKey(ref)]
    await vi.waitFor(() => expect(refreshOAuthTokens).toHaveBeenCalled())
    release()

    expect(await Promise.all(pending)).toEqual(['fresh', 'fresh', 'fresh'])
    expect(refreshOAuthTokens).toHaveBeenCalledTimes(1)
    // 续完写回了：下一次直接用新令牌，不再续
    expect(await resolveApiKey(ref)).toBe('fresh')
    expect(refreshOAuthTokens).toHaveBeenCalledTimes(1)
  })
})
