/**
 * 对象存储的 `uebox` 预设：Box Plan 自带的存储。
 *
 * 对象存储服务（`services/objectStorage/objectStorageService.ts`）在预设是 `uebox` 时把活转到这里，
 * 调用方（promptMedia、streamFn、generateVideo、设置页）一概无感：上传拿键、按键要链接、
 * 问对象还在不在、列举、删除，接口都一样。
 *
 * ## 和自己的桶有什么不同
 *
 * - 不用 AK/SK：地址取缓存清单的 `api.base_url`，Key 用套餐那把（`PLAN_KEY_ID`）。不许写死域名。
 * - 键和链接都由服务端给：键是 sha256 前 32 位 + 扩展名，链接**永不改变**、没有签名参数，
 *   不需要按 6 天一格换签。所以这里把 `键 → 链接` 记在本机，发请求时不为要链接联网。
 * - 按内容哈希申请：服务端说已经有了（`exists`）就不传，直接用它给的链接。
 * - 对象在最后一次申请后保留 `retention_days` 天，到期服务端自动删。本机记着到期时间：
 *   没到期直接给链接；过了到期时间才去问一次（`GET /storage/objects/{key}`），
 *   不在了就换成说明 —— 发一个 404 的链接过去，整轮请求都会失败。
 *
 * ## 本机登记
 *
 * `userData/creator-plan-storage-index.json`：`键 → { 链接, 原文件名, 大小, 到期时间, 已删 }`。
 * 和自己的桶那份登记分开：断开套餐、换回自己的桶以后，对话里引用的套餐对象照样认得出来
 * （链接公开可读，没到期就还能用），也不会和桶里同名的键混在一起。
 *
 * 没连接时，这里没有任何代码会发请求。
 */

import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import type { ObjectStorageEntry, ObjectStorageUsage } from '../../../shared/objectStorage'
import { resolveApiKey } from '../credentials'
import { PLAN_KEY_ID } from './apply'
import { readPlanState } from './planState'
import {
  PlanStorageError,
  completeUpload,
  deleteObject,
  describePlanStorageError,
  getObject,
  getUsage,
  listObjectsPage,
  putFile,
  requestUpload,
  type PlanStorageConnection,
  type PutFile
} from './storageClient'

const INDEX_FILE = 'creator-plan-storage-index.json'
/** 列表最多翻这么多页（每页 100 个）。设置页只显示个数和总大小，再多也没意义 */
const MAX_LIST_PAGES = 50
const DAY_MS = 24 * 3600 * 1000

export interface PlanStorageDeps {
  fetch?: typeof fetch
  put?: PutFile
  now?: () => number
}

interface PlanObjectRecord {
  url: string
  fileName?: string
  size?: number
  /** 服务端给的到期时间；再申请一次会续期 */
  expiresAt: string | null
  removed?: boolean
}

interface PlanIndex {
  objects: Record<string, PlanObjectRecord>
}

// ==================== 连接 ====================

/** 已连接时：清单里的地址和套餐那把 Key。没连接回 null，不发请求 */
export async function planStorageConnection(): Promise<PlanStorageConnection | null> {
  const { manifest } = await readPlanState()
  const baseUrl = manifest?.api?.base_url
  if (!baseUrl) return null
  const apiKey = await resolveApiKey({ kind: 'literal', id: PLAN_KEY_ID }).catch(() => null)
  return apiKey ? { baseUrl, apiKey } : null
}

async function requireConnection(): Promise<PlanStorageConnection> {
  const conn = await planStorageConnection()
  if (!conn) {
    throw new PlanStorageError(
      'unauthorized',
      'Box Plan 没连接：到「设置 → 模型」连接后再用套餐的对象存储'
    )
  }
  return conn
}

/**
 * 能不能走套餐存储：连着、而且清单说套餐带存储。只看本机，不联网 ——
 * 聊天每次发送都要问一遍，离线启动门禁也不许这里发请求。
 */
export async function isPlanStorageReady(): Promise<boolean> {
  const { manifest } = await readPlanState()
  if (manifest?.storage?.enabled !== true) return false
  return (await planStorageConnection()) !== null
}

// ==================== 本机登记 ====================

let indexCache: PlanIndex | null = null
/** 读改写排成一队：两个上传同时收尾时，后写的不能拿旧快照把先写的盖掉 */
let indexChain: Promise<unknown> = Promise.resolve()

function indexPath(): string {
  return path.join(app.getPath('userData'), INDEX_FILE)
}

async function readIndex(): Promise<PlanIndex> {
  if (indexCache) return indexCache
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(), 'utf-8')) as Partial<PlanIndex>
    indexCache = {
      objects: raw?.objects && typeof raw.objects === 'object' ? raw.objects : {}
    }
  } catch {
    indexCache = { objects: {} }
  }
  return indexCache
}

function updateIndex(change: (objects: PlanIndex['objects']) => void): Promise<void> {
  const next = indexChain.then(async () => {
    const current = await readIndex()
    const objects = { ...current.objects }
    change(objects)
    indexCache = { objects }
    const file = indexPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    // 先写临时文件再改名：半截的 JSON 读回来是空登记，「已删」的记录一丢，死链接就又发出去了
    await fs.writeFile(`${file}.tmp`, JSON.stringify(indexCache, null, 2), 'utf-8')
    await fs.rename(`${file}.tmp`, file)
  })
  indexChain = next.catch(() => undefined)
  return next
}

/** 测试用：丢掉内存里的登记，下次从盘上读 */
export function resetPlanStorageIndexCache(): void {
  indexCache = null
}

// ==================== 上传 ====================

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const sizeText = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}GB`
    : `${(bytes / 1024 / 1024).toFixed(1)}MB`

/**
 * 传进套餐存储：算指纹 → 申请 → （没有才）按预签名地址上传 → 确认。
 *
 * 和自己的桶那条路共用进度回调：`say` 是文字进度，`report` 是百分比。
 */
export async function uploadToPlan(
  filePath: string,
  contentType: string,
  say: (note: string) => void,
  report: (progress: { percent: number; note: string }) => void,
  deps: PlanStorageDeps & {
    /** 这个文件的指纹已经算过（同一次运行里复用）：不再读一遍文件 */
    sha256?: string
  } = {}
): Promise<{ key: string; reused: boolean; sha256: string }> {
  const conn = await requireConnection()
  const { manifest } = await readPlanState()
  const maxObjectBytes = manifest?.storage?.max_object_bytes
  const stat = await fs.stat(filePath)
  const fileName = path.basename(filePath)

  if (!/^(image|video|audio)\//.test(contentType)) {
    throw new PlanStorageError('invalid_request', `套餐的对象存储只收图片、音频、视频：${fileName}`)
  }
  // 清单里写着单个文件上限，超了不用去问服务端
  if (maxObjectBytes && stat.size > maxObjectBytes) {
    throw describePlanStorageError(413, 'payload_too_large', undefined, { maxObjectBytes })
  }

  let sha256 = deps.sha256
  if (!sha256) {
    const hashing = `正在计算 ${fileName} 的指纹…`
    say(hashing)
    report({ percent: 0, note: hashing })
    sha256 = await hashFile(filePath)
  }

  say(`正在确认套餐存储里有没有 ${fileName}…`)
  const ticket = await requestUpload(
    conn,
    { sha256, size: stat.size, contentType, fileName },
    { maxObjectBytes },
    deps.fetch
  )

  let expiresAt = ticket.expiresAt
  let url = ticket.url
  if (ticket.exists) {
    say(`套餐存储里已经有 ${fileName}，直接复用`)
  } else {
    try {
      if (!ticket.upload) throw new PlanStorageError('bad_response', 'Box Plan 没给上传地址')
      const note = `正在上传 ${fileName}（${sizeText(stat.size)}）到套餐存储…`
      say(note)
      let lastPercent = -1
      await (deps.put ?? putFile)(ticket.upload, filePath, stat.size, (sent, total) => {
        const percent = total > 0 ? Math.floor((sent / total) * 100) : 100
        if (percent === lastPercent) return
        lastPercent = percent
        report({ percent, note })
      })
      const done = await completeUpload(conn, ticket.key, deps.fetch)
      expiresAt = done.expiresAt ?? expiresAt
      url = done.url
    } catch (error) {
      // 服务端刚说过这个对象不在了：重传再失败，调用方不能再拿上一次的键顶上 —— 那个键已经死了
      if (error && typeof error === 'object') Object.assign(error, { planObjectGone: true })
      throw error
    }
  }
  report({ percent: 100, note: ticket.exists ? '套餐存储里已经有这个文件，直接复用' : '上传完成' })

  await updateIndex((objects) => {
    objects[ticket.key] = { url, fileName, size: stat.size, expiresAt }
  })
  return { key: ticket.key, reused: ticket.exists, sha256 }
}

// ==================== 链接与存活 ====================

/**
 * 这个键是套餐存储的：回链接（已删回 null）。不是套餐存储的键回 undefined，
 * 交给自己的桶那条路。不联网：链接永不改变，上传时就记下了。
 */
export async function planMediaUrl(key: string): Promise<string | null | undefined> {
  const record = (await readIndex()).objects[key]
  if (!record) return undefined
  return record.removed ? null : record.url
}

/**
 * 这个键是套餐存储的：回它是不是已经没了。不是套餐存储的键回 undefined。
 *
 * 没过本机记的到期时间就当还在，不联网；过了才问一次服务端（别的机器可能续过期）。
 * 已经断开、问不了的，过了到期时间就当没了。问的时候网络出错不算没了 —— 链接照发。
 */
export async function isPlanObjectRemoved(
  key: string,
  deps: PlanStorageDeps = {}
): Promise<boolean | undefined> {
  const record = (await readIndex()).objects[key]
  if (!record) return undefined
  if (record.removed) return true
  const now = (deps.now ?? Date.now)()
  const expires = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN
  if (Number.isFinite(expires) && expires > now) return false

  const conn = await planStorageConnection()
  if (!conn) return true
  try {
    const object = await getObject(conn, key, deps.fetch)
    await updateIndex((objects) => {
      const current = objects[key]
      if (!current) return
      objects[key] = object
        ? { ...current, url: object.url, expiresAt: object.expiresAt }
        : { ...current, removed: true }
    })
    return object === null
  } catch (error) {
    console.warn('[套餐存储] 查询对象是否还在时出错，按还在处理:', error)
    return false
  }
}

// ==================== 管理 ====================

/**
 * 「最后一次用到」的时间：服务端按最后一次申请续期，所以是到期时间往回推保留天数。
 * 自动清理按它算 —— 只看创建时间的话，天天在复用的文件也会被当成 N 天没碰过删掉。
 */
function lastUsedAt(
  createdAt: string | null,
  expiresAt: string | null,
  days: number | null
): string {
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (days && Number.isFinite(expires)) return new Date(expires - days * DAY_MS).toISOString()
  return createdAt ?? ''
}

export async function listPlanObjects(deps: PlanStorageDeps = {}): Promise<ObjectStorageEntry[]> {
  const conn = await requireConnection()
  const { manifest } = await readPlanState()
  const days = manifest?.storage?.retention_days ?? null
  const entries: ObjectStorageEntry[] = []
  const seen: Array<{ key: string; record: PlanObjectRecord }> = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await listObjectsPage(conn, cursor, 100, deps.fetch)
    for (const item of result.data) {
      entries.push({
        key: item.key,
        size: item.size,
        lastModified: lastUsedAt(item.createdAt, item.expiresAt, days),
        ...(item.fileName ? { fileName: item.fileName } : {})
      })
      seen.push({
        key: item.key,
        record: {
          url: item.url,
          size: item.size,
          expiresAt: item.expiresAt,
          ...(item.fileName ? { fileName: item.fileName } : {})
        }
      })
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  // 顺手记下来：别的机器传的对象，这台机器的对话里也认得出是套餐存储的
  if (seen.length > 0) {
    await updateIndex((objects) => {
      for (const { key, record } of seen)
        objects[key] = { ...objects[key], ...record, removed: false }
    })
  }
  return entries
}

export async function removePlanObjects(
  keys: string[],
  deps: PlanStorageDeps = {}
): Promise<{ removed: number; failed: Array<{ key: string; error: string }> }> {
  const conn = await requireConnection()
  const failed: Array<{ key: string; error: string }> = []
  const done: string[] = []
  for (const key of keys) {
    try {
      // 404 是本来就不在了，对用户来说一样是删掉了
      await deleteObject(conn, key, deps.fetch)
      done.push(key)
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (done.length > 0) {
    await updateIndex((objects) => {
      for (const key of done) {
        objects[key] = { ...(objects[key] ?? { url: '', expiresAt: null }), removed: true }
      }
    })
  }
  return { removed: done.length, failed }
}

export async function planStorageUsage(deps: PlanStorageDeps = {}): Promise<ObjectStorageUsage> {
  const conn = await requireConnection()
  const { manifest } = await readPlanState()
  const usage = await getUsage(conn, deps.fetch)
  return { ...usage, retentionDays: manifest?.storage?.retention_days ?? null }
}

/** 设置页的「测试」：问一次用量，能回就算通 */
export async function testPlanStorage(
  deps: PlanStorageDeps = {}
): Promise<{ ok: boolean; message: string }> {
  try {
    const usage = await planStorageUsage(deps)
    return {
      ok: true,
      message: `连接正常：套餐存储已用 ${sizeText(usage.usedBytes)} / ${sizeText(usage.quotaBytes)}`
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
