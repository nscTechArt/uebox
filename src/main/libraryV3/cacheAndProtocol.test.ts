// @vitest-environment node
/**
 * 本机缓存与小工具：磁盘 LRU 的上限、页缓存的"只作废受影响的页"、SSE 解析、
 * 翻页请求规划、预览协议地址、影子副本的视图文件、HTTP 错误分类。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskLru, cacheKeyOf } from './diskLru'
import { PageCache, scopeAffected, type PageScope } from './pageCache'
import { SseParser, decodeCatalogEvent } from './sse'
import { planListRequest } from './listRequest'
import { parsePreviewProtocolUrl, parseSignedPreview, previewProtocolUrl } from './previews'
import { parseView, renderView, repoRelativePath } from './shadowCopy'
import { assertTransportAllowed, classifyFailure } from './http'
import { shadowRootFor } from './shadowRoot'
import { normalizeFingerprint, normalizeListQuery, parseInvite } from '../../shared/catalogLibrary'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalog-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function totalFileBytes(root: string): Promise<number> {
  let total = 0
  for (const shard of await readdir(root)) {
    if (shard === 'state.json') continue
    for (const name of await readdir(join(root, shard)))
      total += (await stat(join(root, shard, name))).size
  }
  return total
}

describe('DiskLru', () => {
  it('stays under its byte cap and keeps the most recently written entries', async () => {
    const lru = new DiskLru({ root: dir, maxBytes: 10_000, lowWatermark: 0.8 })
    for (let index = 0; index < 40; index += 1) {
      await lru.put(cacheKeyOf(`key-${index}`), Buffer.alloc(1000, index))
      await new Promise((done) => setTimeout(done, 2))
    }
    await lru.evict()
    expect(await lru.totalBytes()).toBeLessThanOrEqual(10_000)
    expect(await totalFileBytes(dir)).toBe(await lru.totalBytes())
    expect(await lru.get(cacheKeyOf('key-39'))).not.toBeNull()
  })

  it('keeps its byte count across instances without scanning', async () => {
    const first = new DiskLru({ root: dir, maxBytes: 1_000_000 })
    await first.put('aa'.repeat(16), Buffer.alloc(500))
    await first.persistNow()
    const second = new DiskLru({ root: dir, maxBytes: 1_000_000 })
    expect(await second.totalBytes()).toBe(500)
    expect(await second.has('aa'.repeat(16))).not.toBeNull()
  })
})

describe('PageCache', () => {
  const scope = (path: string | null, recursive: boolean, dir = 1): PageScope => ({
    dir,
    path,
    recursive,
    search: false
  })

  it('decides which pages a dirty folder touches', () => {
    const dirty = { dirIds: [], paths: ['Content/Props/Chairs'] }
    expect(scopeAffected(scope('Content/Props/Chairs', false), dirty)).toBe(true)
    expect(scopeAffected(scope('Content/Props', true), dirty)).toBe(true)
    expect(scopeAffected(scope('Content/Props', false), dirty)).toBe(false)
    expect(scopeAffected(scope('Content/Env', true), dirty)).toBe(false)
    expect(scopeAffected(scope('', true), dirty)).toBe(true)
    expect(scopeAffected({ ...scope('Content/Env', false), search: true }, dirty)).toBe(true)
    expect(scopeAffected(scope(null, false), dirty)).toBe(true)
  })

  it('re-tags untouched pages to the new generation and drops the touched ones', () => {
    const cache = new PageCache({ maxMemoryBytes: 1_000_000 })
    cache.put('lib', 'props', {
      generation: 1,
      epoch: 1,
      scope: scope('Content/Props', false, 2),
      data: 'p'
    })
    cache.put('lib', 'env', {
      generation: 1,
      epoch: 1,
      scope: scope('Content/Env', false, 3),
      data: 'e'
    })
    const dropped = cache.advance('lib', { dirIds: [], paths: ['Content/Props'] }, 2, 1)
    expect(dropped).toBe(1)
    expect(cache.getFresh('lib', 'props', 2, 1)).toBeNull()
    expect(cache.getFresh('lib', 'env', 2, 1)?.data).toBe('e')
  })

  it('drops everything when the epoch changes', () => {
    const cache = new PageCache({ maxMemoryBytes: 1_000_000 })
    cache.put('lib', 'a', { generation: 3, epoch: 1, scope: scope('X', false), data: 1 })
    cache.advance('lib', { dirIds: [], paths: [] }, 3, 2)
    expect(cache.getFresh('lib', 'a', 3, 2)).toBeNull()
  })

  it('evicts the least recently used pages past its memory cap', () => {
    const cache = new PageCache({ maxMemoryBytes: 2_000 })
    for (let index = 0; index < 20; index += 1) {
      cache.put('lib', `k${index}`, {
        generation: 1,
        epoch: 1,
        scope: scope('X', false),
        data: 'x'.repeat(100)
      })
    }
    expect(cache.stats().bytes).toBeLessThanOrEqual(2_000)
    expect(cache.getFresh('lib', 'k19', 1, 1)).not.toBeNull()
    expect(cache.getFresh('lib', 'k0', 1, 1)).toBeNull()
  })

  it('falls back to the disk copy for offline reads', async () => {
    const disk = new DiskLru({ root: dir, maxBytes: 1_000_000 })
    const cache = new PageCache({ maxMemoryBytes: 1_000_000, disk })
    cache.put('lib', 'page', {
      generation: 1,
      epoch: 1,
      scope: scope('X', false),
      data: { rows: [1, 2] }
    })
    await new Promise((done) => setTimeout(done, 50))
    const fresh = new PageCache({ maxMemoryBytes: 1_000_000, disk })
    expect((await fresh.getAny<{ rows: number[] }>('lib', 'page'))?.data.rows).toEqual([1, 2])
  })
})

describe('SSE', () => {
  it('parses events split across chunks and remembers the last id', () => {
    const parser = new SseParser()
    expect(parser.push(': heartbeat\n\nevent: generation\nid: 41\nda')).toEqual([])
    const messages = parser.push('ta: {"gen":5,"dirs":["Content/Props"]}\n\n')
    expect(messages).toEqual([
      { event: 'generation', data: '{"gen":5,"dirs":["Content/Props"]}', id: '41' }
    ])
    expect(parser.lastEventId).toBe('41')
  })

  it('decodes catalog events and tolerates field-name variants', () => {
    expect(
      decodeCatalogEvent(
        {
          event: 'generation',
          data: '{"generation":7,"dirtyDirs":[12,"A/B"],"epoch":2}',
          id: null
        },
        'demo'
      )
    ).toEqual({
      type: 'generation',
      library: 'demo',
      generation: 7,
      epoch: 2,
      dirs: [12, 'A/B'],
      subtree: false
    })
    expect(
      decodeCatalogEvent(
        { event: 'generation', data: '{"gen":8,"broad":true,"library":"x"}', id: null },
        null
      )
    ).toMatchObject({
      library: 'x',
      dirs: 'broad'
    })
    expect(decodeCatalogEvent({ event: 'reset', data: '', id: null }, 'demo')).toEqual({
      type: 'reset',
      library: 'demo'
    })
    expect(decodeCatalogEvent({ event: 'nonsense', data: '{}', id: null }, 'demo')).toBeNull()
  })
})

describe('planListRequest', () => {
  const base = {
    dir: 5,
    recursive: true,
    sort: 'modified' as const,
    class: ['Texture2D', 'StaticMesh']
  }

  it('uses no cursor for the first window, the cursor next, position for a jump', () => {
    expect(planListRequest('lib', base, 0, 100, null).query).toMatchObject({
      dir: 5,
      recursive: 1,
      sort: 'modified',
      order: 'desc',
      class: 'Texture2D,StaticMesh'
    })
    expect(planListRequest('lib', base, 100, 100, 'n.1').query).toMatchObject({ cursor: 'n.1' })
    const jump = planListRequest('lib', base, 5000, 100, null).query
    expect(jump.position).toBe(5000)
    expect(jump.cursor).toBeUndefined()
  })

  it('routes a query with text to /search and caps its page at 100', () => {
    const plan = planListRequest('lib', { ...base, q: ' 椅子 ' }, 0, 200, null)
    expect(plan.path).toBe('/v1/libraries/lib/search')
    expect(plan.query).toMatchObject({ q: '椅子', limit: 100, recursive: 1 })
  })

  it('normalises equivalent queries to the same key', () => {
    expect(normalizeListQuery({ dir: 1, recursive: true, class: ['b', 'a'] })).toBe(
      normalizeListQuery({
        dir: 1,
        recursive: true,
        class: ['a', 'b', 'a'],
        sort: 'name',
        order: 'asc'
      })
    )
  })
})

describe('preview protocol', () => {
  const signed = `https://host:8083/v1/previews/${'ab'.repeat(32)}/s256?l=demo&e=20000&k=3&s=hmac`

  it('round-trips a signed URL through uebox-preview://', () => {
    const url = previewProtocolUrl('srv:demo', signed)!
    const ref = parsePreviewProtocolUrl(url)!
    expect(ref).toEqual({
      hash: 'ab'.repeat(32),
      variant: 's256',
      libraryKey: 'srv:demo',
      source: `/v1/previews/${'ab'.repeat(32)}/s256?l=demo&e=20000&k=3&s=hmac`
    })
  })

  it('refuses addresses outside /v1/previews/', () => {
    expect(parseSignedPreview('https://evil/steal?x=1')).toBeNull()
    expect(
      parsePreviewProtocolUrl(
        `uebox-preview://thumb/${'ab'.repeat(32)}/s256?l=k&u=${encodeURIComponent('/v1/assets')}`
      )
    ).toBeNull()
    expect(previewProtocolUrl('k', null)).toBeNull()
  })
})

describe('shadow copy view file', () => {
  it('writes an exclusion view with explicit re-includes', () => {
    const view = renderView(['Content/B.uasset', 'Content/A.uasset'])
    expect(view).toBe('**\n!Content/A.uasset\n!Content/B.uasset\n')
    expect([...parseView(view)]).toEqual(['Content/A.uasset', 'Content/B.uasset'])
  })

  it('rejects paths that escape the working copy', () => {
    expect(repoRelativePath('\\Content\\A.uasset')).toBe('Content/A.uasset')
    expect(() => repoRelativePath('Content/../../x')).toThrow()
    expect(() => repoRelativePath('')).toThrow()
  })

  it('puts shadow copies under LOCALAPPDATA only for the normal roaming profile', () => {
    const env = {
      APPDATA: 'C:\\Users\\a\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local'
    }
    expect(shadowRootFor('C:\\Users\\a\\AppData\\Roaming\\unreal-box', env)).toBe(
      join('C:\\Users\\a\\AppData\\Local', 'unreal-box', 'lore-shadow')
    )
    expect(shadowRootFor('H:\\dev\\profile', env)).toBe(join('H:\\dev\\profile', 'lore-shadow'))
  })
})

describe('transport and errors', () => {
  it('allows plain http only on loopback and never with embedded credentials', () => {
    expect(() =>
      assertTransportAllowed(new URL('http://127.0.0.1:8083'), { kind: 'loopback-http' })
    ).not.toThrow()
    expect(() =>
      assertTransportAllowed(new URL('http://10.0.0.5:8083'), { kind: 'loopback-http' })
    ).toThrow(/loopback/)
    expect(() => assertTransportAllowed(new URL('https://u:p@host'), { kind: 'system' })).toThrow(
      /credentials/
    )
  })

  it('tells a missing route from a missing thing', () => {
    expect(classifyFailure(404, {}, Buffer.alloc(0)).code).toBe('route-missing')
    expect(classifyFailure(404, {}, Buffer.from('{"error":"no such asset"}')).code).toBe(
      'not-found'
    )
    expect(classifyFailure(405, {}, Buffer.alloc(0)).code).toBe('route-missing')
    expect(classifyFailure(429, { 'retry-after': '3' }, Buffer.alloc(0)).retryAfterMs).toBe(3000)
    expect(classifyFailure(503, {}, Buffer.from('{"error":"library not built"}')).offline).toBe(
      true
    )
  })
})

describe('invite links and fingerprints', () => {
  const fp = 'AB:CD:'.repeat(16).slice(0, -1)

  it('normalises fingerprints written with colons, prefix or upper case', () => {
    expect(normalizeFingerprint(`SHA256:${fp}`)).toBe('abcd'.repeat(16))
    expect(normalizeFingerprint('not a fingerprint')).toBeNull()
  })

  it('reads the three parts of an invite link in its common shapes', () => {
    expect(
      parseInvite(`unrealbox://join?server=https://assets.lan:8084&ca=${'ab'.repeat(32)}&code=K7Q2`)
    ).toEqual({
      server: 'https://assets.lan:8084',
      caFingerprint: 'ab'.repeat(32),
      code: 'K7Q2'
    })
    expect(parseInvite(`https://assets.lan:8084 ${'cd'.repeat(32)} K7Q2`)).toEqual({
      server: 'https://assets.lan:8084',
      caFingerprint: 'cd'.repeat(32),
      code: 'K7Q2'
    })
    expect(parseInvite('https://assets.lan:8084')).toEqual({
      server: 'https://assets.lan:8084',
      caFingerprint: null,
      code: null
    })
  })
})
