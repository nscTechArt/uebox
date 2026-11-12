import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = { dir: '' }
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

const { invalidateSettingsCache, readSettings, writeSettings } = await import('./store')
const { disableProvider, enableProvider, readDisabledProviders } = await import(
  './disabledProviders'
)

const provider = (id: string): Record<string, unknown> => ({
  id,
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: `https://${id}.example/v1`,
  apiKey: { kind: 'env', name: 'KEY' },
  models: [{ id: 'a' }, { id: 'b' }]
})

beforeEach(async () => {
  userData.dir = mkdtempSync(join(tmpdir(), 'disabled-providers-'))
  invalidateSettingsCache()
  await writeSettings({
    version: 3,
    providers: [provider('p'), provider('q')],
    roles: { chat: { providerId: 'p', modelId: 'b' }, summary: { providerId: 'q', modelId: 'a' } }
  } as never)
})

afterEach(() => {
  rmSync(userData.dir, { recursive: true, force: true })
})

describe('停用来源', () => {
  it('停用后 models.json 里没有它和它的角色，启用后原样回来、角色绑回去', async () => {
    await disableProvider('p')
    let settings = await readSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['q'])
    expect(settings.roles.chat).toBeUndefined()
    expect((await readDisabledProviders()).map((item) => item.id)).toEqual(['p'])

    await enableProvider('p')
    settings = await readSettings()
    expect(settings.providers.map((item) => item.id).sort()).toEqual(['p', 'q'])
    expect(settings.roles.chat).toEqual({ providerId: 'p', modelId: 'b' })
    expect(await readDisabledProviders()).toEqual([])
    expect(existsSync(join(userData.dir, 'models.disabled.json'))).toBe(false)
  })

  it('停用期间角色另绑了别人，启用时不抢回来', async () => {
    await disableProvider('p')
    const current = await readSettings()
    await writeSettings({
      ...current,
      roles: { ...current.roles, chat: { providerId: 'q', modelId: 'a' } }
    })
    await enableProvider('p')
    expect((await readSettings()).roles.chat).toEqual({ providerId: 'q', modelId: 'a' })
  })
})
