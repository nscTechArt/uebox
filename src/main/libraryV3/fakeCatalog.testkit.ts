/**
 * 单测用的假目录服务（只在 *.test.ts 里用）：形状照 asset-catalog-api.md 第一切片，
 * 外加可开关的预览、注释、变更路由，方便测"服务端还没有这条路由"的降级。
 *
 * 缺的路由回空体 404 —— 和真服务端（axum 默认）一致；找不到东西回 `{"error": …}` 的 404。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeAsset {
  id: number
  path: string
  name: string
  dirId: number
  repository: string
  ext: string
  class: string
  engine: string
  size: number
  modifiedMs: number
  tags: string[]
  hidden: boolean
  preview?: { s128?: string; s256?: string } | null
}

export interface FakeRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  authorization: string | null
}

export interface FakeCatalogOptions {
  token?: string
  assets?: number
  previews?: boolean
  annotations?: boolean
  changes?: boolean
}

export interface FakeCatalog {
  url: string
  port: number
  requests: FakeRequest[]
  generation: number
  epoch: number
  assets: FakeAsset[]
  changes: Array<{ gen: number; path: string; op: string }>
  previewHits: number
  /** 当前认的令牌；测试里换掉它就等于服务端把旧令牌作废了 */
  token: string
  close(): Promise<void>
  reopen(): Promise<void>
}

const PREVIEW_BYTES = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 fake', 'binary')

export async function startFakeCatalog(options: FakeCatalogOptions = {}): Promise<FakeCatalog> {
  const count = options.assets ?? 450
  const assets: FakeAsset[] = []
  for (let index = 0; index < count; index += 1) {
    const folder = index % 3 === 0 ? 'Content/Props' : 'Content/Env/Rocks'
    const name = `SM_Item_${String(index).padStart(4, '0')}.uasset`
    assets.push({
      id: index + 1,
      path: `${folder}/${name}`,
      name,
      dirId: index % 3 === 0 ? 2 : 4,
      repository: index % 3 === 0 ? 'repo-props' : 'repo-env',
      ext: '.uasset',
      class: index % 2 === 0 ? 'StaticMesh' : 'Texture2D',
      engine: '5.4',
      size: 1000 + index,
      modifiedMs: 1_700_000_000_000 + index,
      tags: [],
      hidden: false,
      preview: options.previews
        ? { s256: `/v1/previews/${index.toString(16).padStart(64, 'a')}/s256?l=demo&e=1&k=1&s=sig` }
        : undefined
    })
  }
  const folders = [
    { dirId: 1, path: 'Content', name: 'Content', parent: 0 },
    { dirId: 2, path: 'Content/Props', name: 'Props', parent: 1 },
    { dirId: 3, path: 'Content/Env', name: 'Env', parent: 1 },
    { dirId: 4, path: 'Content/Env/Rocks', name: 'Rocks', parent: 3 }
  ]
  const state: FakeCatalog = {
    url: '',
    port: 0,
    requests: [],
    generation: 1,
    epoch: 1,
    assets,
    changes: [],
    previewHits: 0,
    token: options.token ?? 'good-token',
    close: async () => undefined,
    reopen: async () => undefined
  }

  const meta = (): Record<string, unknown> => ({
    library: 'demo',
    generation: state.generation,
    epoch: state.epoch,
    revision: null
  })

  const subtree = (dirId: number): number[] => {
    const out = [dirId]
    for (const folder of folders) if (folder.parent === dirId) out.push(...subtree(folder.dirId))
    return out
  }

  const folderItem = (folder: (typeof folders)[number]): Record<string, unknown> => {
    const ids = subtree(folder.dirId)
    const inside = assets.filter((asset) => ids.includes(asset.dirId))
    return {
      dirId: folder.dirId,
      path: folder.path,
      name: folder.name,
      nDirect: assets.filter((asset) => asset.dirId === folder.dirId).length,
      nSubtree: inside.length,
      bytes: inside.reduce((sum, asset) => sum + asset.size, 0),
      nDirs: ids.length - 1
    }
  }

  const handler = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fake')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let body: unknown = null
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
    }
    const query = Object.fromEntries(url.searchParams.entries())
    state.requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query,
      body,
      authorization: request.headers.authorization ?? null
    })
    const json = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    const missing = (): void => {
      response.writeHead(404, { 'content-length': '0' })
      response.end()
    }

    if (url.pathname === '/health')
      return json(200, { status: 'ok', libraries: [{ id: 'demo', state: 'ready' }] })
    if (url.pathname.startsWith('/v1/previews/')) {
      if (!options.previews) return missing()
      state.previewHits += 1
      response.writeHead(200, { 'content-type': 'image/webp' })
      response.end(PREVIEW_BYTES)
      return
    }
    if (!url.pathname.startsWith('/v1/')) return missing()
    if (request.headers.authorization !== `Bearer ${state.token}`)
      return json(401, { error: 'unknown token' })

    if (url.pathname === '/v1/libraries') {
      return json(200, {
        items: [
          {
            id: 'demo',
            name: 'Demo',
            state: 'ready',
            epoch: state.epoch,
            generation: state.generation,
            counts: { assets: assets.length, bytes: 1, dirs: folders.length },
            members: [
              { memberId: 0, repositoryId: 'repo-props', branch: 'main' },
              { memberId: 1, repositoryId: 'repo-env', branch: 'main' }
            ],
            complete: true
          }
        ]
      })
    }
    const base = '/v1/libraries/demo'
    if (!url.pathname.startsWith(base)) return json(404, { error: 'no such library' })
    const rest = url.pathname.slice(base.length)

    if (rest === '/folders') {
      const parent = Number(query.parent ?? 0)
      const root = { dirId: 0, path: '', name: '', parent: -1 }
      const folder = parent === 0 ? root : folders.find((candidate) => candidate.dirId === parent)
      if (!folder) return json(404, { error: 'no such folder' })
      const items = folders.filter((candidate) => candidate.parent === parent).map(folderItem)
      return json(200, {
        ...meta(),
        folder: folderItem(folder as (typeof folders)[number]),
        items,
        nextCursor: null
      })
    }

    if (rest === '/assets' || rest === '/search') {
      const dir = Number(query.dir ?? 0)
      const recursive = rest === '/search' ? query.recursive !== '0' : query.recursive === '1'
      const scope = recursive ? subtree(dir) : [dir]
      let rows = assets.filter((asset) =>
        dir === 0 && recursive ? true : scope.includes(asset.dirId)
      )
      if (query.class) rows = rows.filter((asset) => query.class.split(',').includes(asset.class))
      if (rest === '/search') {
        if (!query.q) return json(400, { error: 'q is required' })
        rows = rows.filter((asset) => asset.name.toLowerCase().includes(query.q.toLowerCase()))
      }
      const limit = Math.min(Number(query.limit ?? 100), rest === '/search' ? 100 : 200)
      let offset = 0
      let route = rest === '/search' ? 'tantivy' : 'sqlite-keyset'
      if (query.cursor) offset = Number(query.cursor.replace(/^c\./, ''))
      if (query.position) {
        offset = Number(query.position)
        route = 'snapshot'
      }
      const page = rows.slice(offset, offset + limit)
      const next =
        offset + page.length < rows.length && !query.position ? `c.${offset + page.length}` : null
      return json(200, {
        ...meta(),
        total: { value: rows.length, exact: true },
        items: page,
        nextCursor: next,
        route
      })
    }

    if (rest === '/facets' && request.method === 'POST') {
      const counts = new Map<string, number>()
      for (const asset of assets) counts.set(asset.class, (counts.get(asset.class) ?? 0) + 1)
      return json(200, {
        ...meta(),
        total: { value: assets.length, exact: true },
        facets: { class: [...counts].map(([value, n]) => ({ value, n })) },
        route: 'dir_facet'
      })
    }

    const detail = /^\/assets\/(\d+)$/.exec(rest)
    if (detail) {
      const asset = assets.find((candidate) => candidate.id === Number(detail[1]))
      if (!asset) return json(404, { error: 'no such asset' })
      const dependency = assets.find((candidate) => candidate.id === asset.id + 1)
      return json(200, {
        ...meta(),
        ...asset,
        hash: 'ab'.repeat(32),
        branch: 'main',
        dependencies: dependency ? [{ id: dependency.id, path: dependency.path }] : [],
        dependenciesTruncated: false,
        dependentsCount: 2
      })
    }

    if (rest === '/annotations/status') {
      if (!options.annotations) return missing()
      return json(200, { ...meta(), appliedSeq: 0, flushedSeq: 0, unflushed: 0, alert: false })
    }

    if (rest === '/annotations' && request.method === 'PATCH') {
      if (!options.annotations) return missing()
      const ops = (body as { ops?: unknown[] } | null)?.ops ?? []
      return json(200, { ...meta(), accepted: ops.length, journalSeq: 7 })
    }

    if (rest === '/changes') {
      if (!options.changes) return missing()
      const since = Number(query.since ?? 0)
      return json(200, {
        ...meta(),
        from: since,
        to: state.generation,
        items: state.changes
          .filter((change) => change.gen > since)
          .map(({ path, op }) => ({ path, op })),
        more: false
      })
    }

    return missing()
  }

  let server = http.createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = (server.address() as AddressInfo).port
  state.url = `http://127.0.0.1:${state.port}`
  state.close = async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  state.reopen = async () => {
    server = http.createServer((request, response) => {
      void handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(state.port, '127.0.0.1', resolve))
  }
  return state
}

/** 测试用的"加密"：可逆、可控是否可用 */
export function fakeCodec(available = true): {
  available: () => boolean
  encrypt: (text: string) => Buffer
  decrypt: (data: Buffer) => string
} {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (data) => data.toString('utf8').replace(/^enc:/, '')
  }
}
