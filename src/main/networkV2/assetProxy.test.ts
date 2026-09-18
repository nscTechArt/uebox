// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetRegisteredVaults, serveRemoteAsset } from './assetProxy'
import { forgetVaultAccessKeys, rememberVaultAccessKey } from './vaultAccessKeys'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getClient: vi.fn(),
  getAllStates: vi.fn(),
  getAllVaults: vi.fn(),
  getNetworkVaultApiKey: vi.fn()
}))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./VaultServiceManager', () => ({
  VaultServiceManager: { getInstance: () => mocks }
}))
vi.mock('../sqliteDataBase/VaultManager', () => ({
  VaultManager: { getInstance: () => mocks }
}))

const SERVER = 'https://assets.example.test/team'
const request = (serverUrl = SERVER, vaultId = 'remote-vault', file = '纹理/a b.png'): Request =>
  new Request('uebox-asset://file?' + new URLSearchParams({ serverUrl, vaultId, path: file }), {
    headers: { Range: 'bytes=1-5' }
  })

beforeEach(() => {
  vi.resetAllMocks()
  forgetVaultAccessKeys()
  forgetRegisteredVaults()
  mocks.getAllStates.mockReturnValue([{ vaultId: 'local-vault' }])
  mocks.getClient.mockReturnValue({
    remoteVaultId: 'remote-vault',
    serverUrl: SERVER
  })
  rememberVaultAccessKey(SERVER, 'remote-vault', 'test-access-key')
  mocks.getAllVaults.mockReturnValue([])
  mocks.getNetworkVaultApiKey.mockReturnValue(undefined)
  mocks.fetch.mockResolvedValue(new Response('image', { status: 206 }))
})

describe('asset proxy credentials', () => {
  it('loads registered assets with that vault access key and preserves ranges', async () => {
    expect((await serveRemoteAsset(request(SERVER + '/'))).status).toBe(206)
    expect(mocks.fetch).toHaveBeenCalledWith(
      `${SERVER}/api/vaults/remote-vault/files/${encodeURIComponent('纹理')}/a%20b.png`,
      {
        method: 'GET',
        headers: { 'X-API-Key': 'test-access-key', Range: 'bytes=1-5' },
        credentials: 'omit',
        redirect: 'error'
      }
    )
  })

  it.each([
    ['https://attacker.example.test', 'remote-vault'],
    [SERVER, 'another-vault'],
    [SERVER + '/elsewhere', 'remote-vault'],
    ['https://assets.example.test:444/team', 'remote-vault']
  ])('rejects unregistered target %s / %s before sending credentials', async (server, vault) => {
    expect((await serveRemoteAsset(request(server, vault))).status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('keeps standalone access-code authentication without borrowing a platform token', async () => {
    mocks.getClient.mockReturnValue({
      remoteVaultId: 'remote-vault',
      serverUrl: SERVER,
      platformAuthHeader: {}
    })
    rememberVaultAccessKey(SERVER, 'remote-vault', 'test-read-code')
    await serveRemoteAsset(request())
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({
      'X-API-Key': 'test-read-code',
      Range: 'bytes=1-5'
    })
  })

  it('serves a registered vault that is currently offline — 连不上不等于地址可疑', async () => {
    mocks.getClient.mockReturnValue(undefined)
    mocks.getAllVaults.mockReturnValue([
      { id: 'local-vault', vaultType: 'network', networkPath: `${SERVER}/remote-vault` }
    ])
    mocks.getNetworkVaultApiKey.mockReturnValue('stored-pairing-code')

    expect((await serveRemoteAsset(request())).status).toBe(206)
    expect(mocks.getNetworkVaultApiKey).toHaveBeenCalledWith('local-vault')
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({
      'X-API-Key': 'stored-pairing-code',
      Range: 'bytes=1-5'
    })
  })

  it('没连上又没登记就拒绝，缓存里还留着码也不行', async () => {
    rememberVaultAccessKey(SERVER, 'remote-vault', 'test-read-code')
    mocks.getClient.mockReturnValue(undefined)
    expect((await serveRemoteAsset(request())).status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('登记表也挡住别的服务器，不会因为退到登记表就放宽', async () => {
    mocks.getClient.mockReturnValue(undefined)
    mocks.getAllVaults.mockReturnValue([
      { id: 'local-vault', vaultType: 'network', networkPath: `${SERVER}/remote-vault` }
    ])

    const other = await serveRemoteAsset(request('https://attacker.example.test', 'remote-vault'))
    expect(other.status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('登记表读不出来时按不认识处理', async () => {
    mocks.getClient.mockReturnValue(undefined)
    mocks.getAllVaults.mockImplementation(() => {
      throw new Error('database not ready')
    })
    expect((await serveRemoteAsset(request())).status).toBe(403)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    'file:///C:/private',
    'https://user:password@assets.example.test/team',
    SERVER + '?x=1'
  ])('rejects invalid server addresses: %s', async (server) => {
    expect((await serveRemoteAsset(request(server))).status).toBe(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each(['../session', 'a/../../session', 'a\\..\\session', '/absolute', 'a\0.png'])(
    'rejects paths that escape the file endpoint: %s',
    async (file) => {
      expect((await serveRemoteAsset(request(SERVER, 'remote-vault', file))).status).toBe(400)
      expect(mocks.fetch).not.toHaveBeenCalled()
    }
  )

  it('does not retry a rejected redirect with credentials', async () => {
    mocks.fetch.mockRejectedValue(new Error('Redirect refused'))
    await expect(serveRemoteAsset(request())).rejects.toThrow('Redirect refused')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe('error')
  })
})
