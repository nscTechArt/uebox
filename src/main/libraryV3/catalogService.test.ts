// @vitest-environment node
/**
 * CatalogService 对着一个假目录服务（fakeCatalog.testkit.ts）跑：
 *
 * - 翻页：第 0 窗不带游标，紧接着的窗用上一窗的游标，跳着要的窗用 position（结果快照）；
 * - 缓存：同一窗在代号不变时不再发请求；代号前进后作废；
 * - 离线：连不上时给看过的旧页并标 stale，没看过的照常报错；
 * - 降级：服务端没有 /changes、/annotations、预览路由时各自关掉，不影响浏览。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CatalogLibraryEvent } from '../../shared/catalogLibrary'
import { CatalogService } from './catalogService'
import { fakeCodec, startFakeCatalog, type FakeCatalog } from './fakeCatalog.testkit'
import { parsePreviewProtocolUrl } from './previews'

let dir: string
let fake: FakeCatalog
let events: CatalogLibraryEvent[]
let service: CatalogService

function makeService(): CatalogService {
  return new CatalogService({
    userDataDir: dir,
    shadowRoot: join(dir, 'shadow'),
    codec: fakeCodec(),
    emit: (event) => events.push(event),
    resolveLore: async () => ({ binary: null, problem: 'not in tests' }),
    copyPackage: async () => 0,
    sessionLabel: 'test'
  })
}

async function addDemo(options: Parameters<typeof startFakeCatalog>[0] = {}): Promise<string> {
  fake = await startFakeCatalog(options)
  service = makeService()
  const connected = await service.connect({
    address: fake.url,
    authMode: 'token',
    identityToken: 'good-token'
  })
  expect(connected.libraries.map((library) => library.id)).toEqual(['demo'])
  await service.addLibraries(connected.server.id, [{ id: 'demo', name: 'Demo' }])
  return `${connected.server.id}:demo`
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalog-service-'))
  events = []
})

afterEach(async () => {
  service?.dispose()
  await fake?.close().catch(() => undefined)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('CatalogService', () => {
  it('connects with a pasted token over loopback http and keeps the token out of the config file', async () => {
    const key = await addDemo()
    const libraries = await service.listLibraries()
    expect(libraries).toHaveLength(1)
    expect(libraries[0].key).toBe(key)
    expect(libraries[0].server.signedIn).toBe(true)
    expect(libraries[0].server.trustKind).toBe('loopback-http')
    const config = await readFile(join(dir, 'catalog-libraries.json'), 'utf8')
    expect(config).not.toContain('good-token')
    const secrets = await readFile(join(dir, 'catalog-library-secrets.bin'), 'utf8')
    expect(secrets.startsWith('enc:')).toBe(true)
  })

  it('refuses plain http to a non-loopback host', async () => {
    fake = await startFakeCatalog()
    service = makeService()
    await expect(
      service.connect({
        address: 'http://192.168.10.20:8083',
        authMode: 'token',
        identityToken: 'x'
      })
    ).rejects.toMatchObject({ code: 'insecure-http' })
  })

  it('pages with a cursor after window 0 and with position for a jump', async () => {
    const key = await addDemo()
    const query = { dir: 0, recursive: true, sort: 'name' as const }
    const first = await service.listWindow(key, query, 0, 100)
    expect(first.items).toHaveLength(100)
    expect(first.total.value).toBe(450)
    const second = await service.listWindow(key, query, 100, 100)
    expect(second.items[0].id).toBe(101)
    const jump = await service.listWindow(key, query, 400, 100)
    expect(jump.items).toHaveLength(50)
    const assetRequests = fake.requests.filter((request) => request.path.endsWith('/assets'))
    expect(assetRequests[0].query.cursor).toBeUndefined()
    expect(assetRequests[0].query.position).toBeUndefined()
    expect(assetRequests[1].query.cursor).toBe('c.100')
    expect(assetRequests[2].query.position).toBe('400')
    expect(assetRequests[2].query.cursor).toBeUndefined()
  })

  it('answers a repeated window from cache while the generation holds', async () => {
    const key = await addDemo()
    const query = { dir: 0, recursive: true }
    await service.listWindow(key, query, 0, 100)
    const before = fake.requests.length
    const again = await service.listWindow(key, query, 0, 100)
    expect(again.fromCache).toBe(true)
    expect(fake.requests.length).toBe(before)
  })

  it('drops cached pages when the server generation moves and /changes is missing', async () => {
    const key = await addDemo()
    const query = { dir: 0, recursive: true }
    await service.watch(key)
    await service.listWindow(key, query, 0, 100)
    fake.generation = 2
    // 任何一个响应带着新代号都会触发"代号前进"
    await service.folders(key, 0)
    await new Promise((done) => setTimeout(done, 50))
    const invalidations = events.filter((event) => event.kind === 'invalidate')
    expect(invalidations.at(-1)).toMatchObject({ kind: 'invalidate', scope: 'all', generation: 2 })
    const status = await service.status(key)
    expect(status.capabilities.changes).toBe(false)
    const refetched = await service.listWindow(key, query, 0, 100)
    expect(refetched.fromCache).toBe(false)
    await service.unwatch(key)
  })

  it('refetches only the affected folder when /changes names it', async () => {
    const key = await addDemo({ changes: true })
    await service.folders(key, 0)
    await service.folders(key, 1)
    await service.folders(key, 3)
    const props = { dir: 2, recursive: false }
    const rocks = { dir: 4, recursive: false }
    await service.listWindow(key, props, 0, 100)
    await service.listWindow(key, rocks, 0, 100)
    fake.generation = 2
    fake.changes.push({ gen: 2, path: 'Content/Props/SM_New.uasset', op: 'add' })
    await service.folders(key, 2)
    await new Promise((done) => setTimeout(done, 50))
    const last = events.filter((event) => event.kind === 'invalidate').at(-1)
    expect(last).toMatchObject({ scope: { paths: ['Content/Props'] }, reason: 'changes' })
    expect((await service.listWindow(key, rocks, 0, 100)).fromCache).toBe(true)
    expect((await service.listWindow(key, props, 0, 100)).fromCache).toBe(false)
  })

  it('serves viewed pages as stale when the server is gone, and fails for unviewed ones', async () => {
    const key = await addDemo()
    const query = { dir: 0, recursive: true }
    await service.listWindow(key, query, 0, 100)
    await fake.close()
    // 代号未知时强制走网络：清掉内存缓存，只剩磁盘上的旧页
    await service.clearCache(key)
    await new Promise((done) => setTimeout(done, 20))
    const offline = await service.listWindow(key, query, 0, 100)
    expect(offline.stale).toBe(true)
    expect(offline.items).toHaveLength(100)
    await expect(service.listWindow(key, query, 300, 100)).rejects.toMatchObject({
      code: 'network'
    })
    const status = await service.status(key)
    expect(status.online).toBe(false)
  })

  it('searches through /search and caps what the cursor can reach', async () => {
    const key = await addDemo()
    const result = await service.listWindow(key, { dir: 0, recursive: true, q: 'item_00' }, 0, 100)
    expect(result.total.value).toBe(100)
    expect(result.reachable).toBe(100)
    const request = fake.requests.at(-1)!
    expect(request.path).toBe('/v1/libraries/demo/search')
    expect(request.query.q).toBe('item_00')
  })

  it('rewrites signed preview URLs to uebox-preview:// and caches the image by hash', async () => {
    const key = await addDemo({ previews: true })
    const window = await service.listWindow(key, { dir: 0, recursive: true }, 0, 10)
    const url = window.items[0].previewUrl!
    expect(url.startsWith('uebox-preview://thumb/')).toBe(true)
    const ref = parsePreviewProtocolUrl(url)!
    expect(ref.libraryKey).toBe(key)
    const first = await service.previews.handle(new Request(url))
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/webp')
    const second = await service.previews.handle(new Request(url))
    expect(second.status).toBe(200)
    expect(fake.previewHits).toBe(1)
  })

  it('hides previews, annotations and changes when the server lacks the routes', async () => {
    const key = await addDemo()
    const window = await service.listWindow(key, { dir: 0, recursive: true }, 0, 10)
    expect(window.items[0].previewUrl).toBeNull()
    expect(await service.probeAnnotations(key)).toBe(false)
    const status = await service.status(key)
    expect(status.capabilities.annotations).toBe(false)
  })

  it('writes annotations when the route exists and drops the affected folder pages', async () => {
    const key = await addDemo({ annotations: true })
    expect(await service.probeAnnotations(key)).toBe(true)
    const result = await service.editAnnotations(key, [
      { path: 'Content/Props/SM_Item_0000.uasset', addTags: ['rock'] }
    ])
    expect(result).toEqual({ accepted: 1, journalSeq: 7 })
    const patch = fake.requests.filter((request) => request.method === 'PATCH').at(-1)!
    expect(patch.body).toEqual({
      ops: [{ path: 'Content/Props/SM_Item_0000.uasset', addTags: ['rock'] }]
    })
  })

  it('returns detail with one-hop dependencies and facets from the server', async () => {
    const key = await addDemo()
    const detail = await service.detail(key, 1)
    expect(detail.hash).toHaveLength(64)
    expect(detail.dependencies).toEqual([{ id: 2, path: fake.assets[1].path }])
    const facets = await service.facets(key, { dir: 0, recursive: true })
    expect(facets.facets.class?.map((value) => value.value).sort()).toEqual([
      'StaticMesh',
      'Texture2D'
    ])
  })

  it('marks the library signed out when the token is revoked, and clears it after signing in again', async () => {
    const key = await addDemo()
    fake.token = 'rotated-token'
    await expect(
      service.listWindow(key, { dir: 0, recursive: true, q: 'x' }, 0, 50)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await service.status(key)).signedOut).toBe(true)
    const serverId = key.split(':')[0]
    await service.signIn(serverId, { identityToken: 'rotated-token' })
    const statuses = events.filter((event) => event.kind === 'status' && event.key === key)
    expect(statuses.at(-1)).toMatchObject({ status: { signedOut: false } })
  })

  it('reports an invalid token as unauthorized', async () => {
    fake = await startFakeCatalog()
    service = makeService()
    await expect(
      service.connect({ address: fake.url, authMode: 'token', identityToken: 'wrong' })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await service.listServers()).toHaveLength(0)
  })

  it('picks the member repository that owns a folder for import', async () => {
    const key = await addDemo()
    await service.folders(key, 0)
    const props = await service.resolveRepository(key, { dirId: 2, path: 'Content/Props' })
    expect(props).toEqual({ repositoryId: 'repo-props', candidates: ['repo-props', 'repo-env'] })
    const content = await service.resolveRepository(key, { dirId: 1, path: 'Content' })
    expect(content.repositoryId).toBeNull()
  })
})
