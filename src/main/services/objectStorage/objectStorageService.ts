/**
 * 对象存储：配置、上传、链接、查看、清理。
 *
 * ## 为什么聊天里的音视频要走它
 *
 * 多模态厂商收本地文件只有 base64 一条路（MIMO 上限 50MB）。base64 塞进对话以后，
 * 之后每一轮、工具循环的每一步都要把几十 MB 重传一遍；想把它从对话里摘掉，
 * 又等于回头改前缀 —— 厂商的前缀缓存从那里断开。传到用户自己的桶里换一个链接，
 * 对话里只留几百字节，**一直留着、一字不改**，两个问题都没了。
 *
 * ## 链接为什么要「逐字稳定」
 *
 * 链接跟着对话每轮重发，字节一变缓存就断。所以：
 * - 对象键按文件内容哈希取名：同一个文件拖两次是同一个键，也不重传。
 * - 预签名的签名时刻按 6 天一格取整：同一格里签出来的链接逐字相同，
 *   有效期 7 天盖住整格还富余一天；跨格时换签一次，缓存只断这一次。
 * - 配了公开域名就直接拼，永不过期，最稳。
 *
 * ## 存在哪
 *
 * 配置是 `userData/object-storage.json`（用户可以直接看、可以备份），
 * Secret 走主进程的安全存储（和模型密钥同一个库），
 * 本机上传登记在 `userData/object-storage-index.json`，用来在列表里显示原文件名、
 * 以及记住哪些对象已经清理掉了 —— 对话里还引用着它们，得换成一句说明，
 * 不能把一个 404 的链接发给厂商、让整轮请求失败。
 *
 * ## `uebox` 预设
 *
 * 创作者 Token Plan 自带的存储，不用 AK/SK。预设是它时，上传、列举、删除、测试都转给
 * `ai/creatorPlan/storageBackend.ts`；按键要链接、问对象在不在，先看键是不是套餐存储的，
 * 是就由那边回答（换回自己的桶以后，对话里引用的套餐对象也还认得）。调用方无感。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import { deleteLiteralKey, resolveApiKey, saveLiteralKey } from '../../ai/credentials'
import * as planStorage from '../../ai/creatorPlan/storageBackend'
import { isPrivateAddress } from '../agentBrowser/urlPolicy'
import { writeSessionFile } from '../../agent-v3/core/atomicSessionFile'
import {
  DEFAULT_OBJECT_STORAGE_CONFIG,
  normalizeEndpoint,
  normalizePrefix,
  type ObjectStorageConfig,
  type ObjectStorageConfigView,
  type ObjectStorageEntry,
  type ObjectStorageSaveInput,
  type ObjectStorageUsage
} from '../../../shared/objectStorage'
import {
  deleteObject,
  headObject,
  listObjects,
  presignGetUrl,
  putObjectBytes,
  putObjectFromFile,
  type S3Target
} from './s3Client'

const CONFIG_FILE = 'object-storage.json'
const INDEX_FILE = 'object-storage-index.json'
const SECRET_ID = 'object-storage:secret-access-key'
/** 预签名换签的格子宽度。有效期 7 天 > 6 天，格子末尾签出的链接也还有一天余量 */
const SIGN_WINDOW_MS = 6 * 24 * 3600 * 1000

interface UploadRecord {
  key: string
  fileName: string
  size: number
  uploadedAt: string
}

interface UploadIndex {
  uploads: UploadRecord[]
  /** 清理掉的键。对话里还引用着它们，发请求时要换成说明 */
  removed: string[]
}

let configCache: ObjectStorageConfig | null = null
let indexCache: UploadIndex | null = null

function userDataFile(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function sanitize(raw: Partial<ObjectStorageConfig>): ObjectStorageConfig {
  const merged = { ...DEFAULT_OBJECT_STORAGE_CONFIG, ...raw }
  return {
    enabled: merged.enabled === true,
    preset: merged.preset,
    endpoint: normalizeEndpoint(String(merged.endpoint ?? ''), String(merged.bucket ?? '')),
    region: String(merged.region ?? '').trim(),
    bucket: String(merged.bucket ?? '').trim(),
    accessKeyId: String(merged.accessKeyId ?? '').trim(),
    prefix: normalizePrefix(String(merged.prefix ?? '')),
    forcePathStyle: merged.forcePathStyle === true,
    publicBaseUrl: String(merged.publicBaseUrl ?? '')
      .trim()
      .replace(/\/+$/, ''),
    autoCleanDays: Math.max(0, Math.floor(Number(merged.autoCleanDays) || 0))
  }
}

export async function readObjectStorageConfig(): Promise<ObjectStorageConfig> {
  if (configCache) return configCache
  try {
    const raw = JSON.parse(await fs.readFile(userDataFile(CONFIG_FILE), 'utf-8'))
    configCache = sanitize(raw)
  } catch {
    // 没配过或文件坏了都按默认值处理，不去覆盖用户手里那份
    configCache = { ...DEFAULT_OBJECT_STORAGE_CONFIG }
  }
  return configCache
}

async function hasSecret(): Promise<boolean> {
  try {
    return Boolean(await resolveApiKey({ kind: 'literal', id: SECRET_ID }))
  } catch {
    return false
  }
}

export async function getObjectStorageView(): Promise<ObjectStorageConfigView> {
  return { ...(await readObjectStorageConfig()), hasSecret: await hasSecret() }
}

export async function saveObjectStorageConfig(
  input: ObjectStorageSaveInput
): Promise<ObjectStorageConfigView> {
  const { secretAccessKey, ...rest } = input
  const config = sanitize(rest)
  if (secretAccessKey !== undefined) {
    if (secretAccessKey.trim()) await saveLiteralKey(SECRET_ID, secretAccessKey.trim())
    else await deleteLiteralKey(SECRET_ID)
  }
  const file = userDataFile(CONFIG_FILE)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8')
  configCache = config
  // 换了桶 / 地址 / 前缀，之前记下的「传完了」对新配置不作数
  forgetSettledUploads()
  return getObjectStorageView()
}

function missingFields(config: ObjectStorageConfig): string[] {
  const missing: string[] = []
  if (!config.endpoint) missing.push('Endpoint')
  if (!config.region) missing.push('Region')
  if (!config.bucket) missing.push('Bucket')
  if (!config.accessKeyId) missing.push('AccessKey ID')
  return missing
}

/** 连接参数。缺什么就抛一句说清缺什么 */
async function targetFor(config: ObjectStorageConfig, secretOverride?: string): Promise<S3Target> {
  const missing = missingFields(config)
  const secret =
    secretOverride?.trim() ||
    (await resolveApiKey({ kind: 'literal', id: SECRET_ID }).catch(() => ''))
  if (!secret) missing.push('AccessKey Secret')
  if (missing.length > 0) throw new Error(`对象存储还没配完整：缺 ${missing.join('、')}`)
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: secret,
    forcePathStyle: config.forcePathStyle
  }
}

/** 开着、而且配完整了。聊天发送时据此决定走链接还是只带路径 */
export async function isObjectStorageReady(): Promise<boolean> {
  const config = await readObjectStorageConfig()
  if (config.preset === 'uebox') return config.enabled && planStorage.isPlanStorageReady()
  if (!config.enabled || missingFields(config).length > 0) return false
  return hasSecret()
}

// ==================== 本机上传登记 ====================

async function readIndex(): Promise<UploadIndex> {
  if (indexCache) return indexCache
  try {
    const raw = JSON.parse(await fs.readFile(userDataFile(INDEX_FILE), 'utf-8'))
    indexCache = {
      uploads: Array.isArray(raw?.uploads) ? raw.uploads : [],
      removed: Array.isArray(raw?.removed) ? raw.removed : []
    }
  } catch {
    indexCache = { uploads: [], removed: [] }
  }
  return indexCache
}

/** 登记的读改写排成一队 —— 两个上传同时收尾时，后写完的那次不能拿旧快照把先写的盖掉 */
let indexChain: Promise<unknown> = Promise.resolve()

/**
 * 改一次登记。写盘先落临时文件再替换：半截的 JSON 读回来会被当成空登记，
 * 「已清理」那张表跟着丢，对话里引用着被删对象的消息就又会发出一条死链接
 */
function updateIndex(change: (index: UploadIndex) => UploadIndex): Promise<void> {
  const next = indexChain.then(async () => {
    const index = change(await readIndex())
    indexCache = index
    await writeSessionFile(userDataFile(INDEX_FILE), JSON.stringify(index, null, 2))
  })
  indexChain = next.catch(() => undefined)
  return next
}

/** 这个键是不是已经从桶里清理掉了 */
export async function isObjectRemoved(key: string): Promise<boolean> {
  const plan = await planStorage.isPlanObjectRemoved(key)
  if (plan !== undefined) return plan
  return (await readIndex()).removed.includes(key)
}

// ==================== 上传与链接 ====================

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.aiff': 'audio/aiff'
}

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface UploadProgress {
  /** 0–100。算指纹阶段是 0 */
  percent: number
  note: string
}

/**
 * 进行中和已完成的上传，按「路径 + 大小 + 修改时间」认。
 *
 * 拖进输入框就开传，按发送时多半还没传完 —— 发送那一路拿到的是同一个 Promise，
 * 接着等就行，不会再传第二遍；传完了的直接复用，连指纹都不用再算。
 * 失败的会被摘掉，下次重试。
 */
const uploads = new Map<string, Promise<{ key: string; reused: boolean }>>()
/** 已经传完（或确认桶里已有）的。再要就静默复用，不再报「等它传完」 */
const settled = new Set<string>()
const progressListeners = new Map<string, Set<(progress: UploadProgress) => void>>()
/** 文字进度：后来接上的调用方也要看到这次上传**此刻**在干什么，并跟着往下走 */
const noteListeners = new Map<string, Set<(note: string) => void>>()
const currentNote = new Map<string, string>()

/**
 * 忘掉已经传完的记录，下次再要就重新确认桶里还有没有。
 * 对象被清理、或者配置换了桶之后必须调：不然同一个文件再拖进来，
 * 拿到的是一个已经删掉（或根本不在新桶里）的键。
 */
function forgetSettledUploads(): void {
  for (const id of settled) uploads.delete(id)
  settled.clear()
}

async function uploadIdentity(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath)
  return `${path.resolve(filePath)}|${stat.size}|${stat.mtimeMs}`
}

/**
 * 把本地文件传进桶里，返回对象键。
 *
 * 键按内容哈希取：同一个文件第二次拖进来不再上传，对话里引用的也是同一个键。
 */
export async function uploadMediaFile(
  filePath: string,
  onProgress?: (note: string) => void,
  onPercent?: (progress: UploadProgress) => void
): Promise<{ key: string; reused: boolean }> {
  const id = await uploadIdentity(filePath)
  const running = uploads.get(id)
  if (running && settled.has(id)) {
    // 静默复用也算「用过」：自动清理按最后一次用到的时间算，不记的话
    // 一直开着的盒子里天天在用的文件，下次启动照样被当成 N 天没碰过清掉
    const { key } = await running
    await touchUpload(key)
    return running
  }
  if (onPercent) {
    const set = progressListeners.get(id) ?? new Set()
    set.add(onPercent)
    progressListeners.set(id, set)
  }
  if (onProgress) {
    const set = noteListeners.get(id) ?? new Set()
    set.add(onProgress)
    noteListeners.set(id, set)
  }
  if (running) {
    const note = currentNote.get(id)
    if (note) onProgress?.(note)
    return running.finally(() => {
      if (onPercent) progressListeners.get(id)?.delete(onPercent)
      if (onProgress) noteListeners.get(id)?.delete(onProgress)
    })
  }

  const say = (note: string): void => {
    currentNote.set(id, note)
    for (const listener of noteListeners.get(id) ?? []) listener(note)
  }
  const report = (progress: UploadProgress): void => {
    for (const listener of progressListeners.get(id) ?? []) listener(progress)
  }
  const task = doUpload(filePath, say, report)
  uploads.set(id, task)
  task
    .then(() => settled.add(id))
    .catch(() => uploads.delete(id))
    .finally(() => {
      progressListeners.delete(id)
      noteListeners.delete(id)
      currentNote.delete(id)
    })
  return task
}

async function doUpload(
  filePath: string,
  say: (note: string) => void,
  report: (progress: UploadProgress) => void
): Promise<{ key: string; reused: boolean }> {
  const config = await readObjectStorageConfig()
  if (config.preset === 'uebox') {
    return planStorage.uploadToPlan(filePath, contentTypeFor(filePath), say, report)
  }
  const target = await targetFor(config)
  const stat = await fs.stat(filePath)
  const fileName = path.basename(filePath)

  const hashing = `正在计算 ${fileName} 的指纹…`
  say(hashing)
  report({ percent: 0, note: hashing })
  const digest = await hashFile(filePath)
  const key = `${config.prefix}${digest.slice(0, 32)}${path.extname(fileName).toLowerCase()}`

  say(`正在确认对象存储里有没有 ${fileName}…`)
  const exists = await headObject(target, key)
  if (exists) {
    say(`对象存储里已经有 ${fileName}，直接复用`)
  } else {
    const note = `正在上传 ${fileName}（${(stat.size / 1024 / 1024).toFixed(1)}MB）到对象存储…`
    say(note)
    let lastPercent = -1
    await putObjectFromFile(
      target,
      key,
      filePath,
      stat.size,
      contentTypeFor(fileName),
      (sent, total) => {
        const percent = total > 0 ? Math.floor((sent / total) * 100) : 100
        if (percent === lastPercent) return
        lastPercent = percent
        report({ percent, note })
      }
    )
  }
  report({ percent: 100, note: exists ? '桶里已经有这个文件，直接复用' : '上传完成' })

  await updateIndex((latest) => ({
    uploads: [
      ...latest.uploads.filter((item) => item.key !== key),
      { key, fileName, size: stat.size, uploadedAt: new Date().toISOString() }
    ],
    // 重新传上去了，就不再算「已清理」
    removed: latest.removed.filter((item) => item !== key)
  }))
  return { key, reused: exists }
}

/** 把这个键的「最后用到」挪到现在 */
async function touchUpload(key: string): Promise<void> {
  await updateIndex((latest) => ({
    ...latest,
    uploads: latest.uploads.map((item) =>
      item.key === key ? { ...item, uploadedAt: new Date().toISOString() } : item
    )
  })).catch((error) => console.warn('[对象存储] 记录复用时间失败:', error))
}

/**
 * 给厂商用的链接。**同样的输入在同一个 6 天格子里逐字相同**，见文件头。
 * @returns 配置不可用时返回 null，调用方把引用换成说明
 */
export async function mediaUrlFor(key: string, now = Date.now()): Promise<string | null> {
  const planUrl = await planStorage.planMediaUrl(key)
  if (planUrl !== undefined) return planUrl
  const config = await readObjectStorageConfig()
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
  }
  const target = await targetFor(config).catch(() => null)
  if (!target) return null
  const signedAt = new Date(Math.floor(now / SIGN_WINDOW_MS) * SIGN_WINDOW_MS)
  return presignGetUrl(target, key, signedAt)
}

// ==================== 测试、查看、清理 ====================

/**
 * 本机或内网地址。测试连接在本机跑，能通不代表厂商那边能拉到 ——
 * 自建 MinIO 最常见的坑就是这个，得在测试这一步就说出来。
 */
export function isPrivateEndpoint(address: string): boolean {
  let host: string
  try {
    host = new URL(address).hostname.toLowerCase()
  } catch {
    return false
  }
  // 和内置浏览器防 SSRF 用同一把尺子：Tailscale / CGNAT（100.64/10）、链路本地、
  // IPv6 唯一本地这些，自己手写的那份四个网段全漏了
  return isPrivateAddress(host)
}

/**
 * 连一次试试：写一个小文件、用签出的链接读回来、再删掉。
 *
 * 三步都走一遍才算通 —— 只测列举的话，「能列不能写」「能写但链接读不回来」
 * 这两种最常见的配错都会漏过去。
 */
export async function testObjectStorage(input: ObjectStorageSaveInput): Promise<{
  ok: boolean
  message: string
}> {
  const { secretAccessKey, ...rest } = input
  const config = sanitize(rest)
  if (config.preset === 'uebox') return planStorage.testPlanStorage()
  try {
    const target = await targetFor(config, secretAccessKey)
    const key = `${config.prefix}.uebox-connection-test-${Date.now()}.txt`
    const body = Buffer.from('uebox object storage connection test')
    await putObjectBytes(target, key, body, 'text/plain')
    try {
      const url = config.publicBaseUrl
        ? `${config.publicBaseUrl}/${key}`
        : presignGetUrl(target, key, new Date(), 300)
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) {
        return {
          ok: false,
          message: config.publicBaseUrl
            ? `写入成功，但公开域名读不到（HTTP ${response.status}）：检查域名是否绑定到这个桶、桶是否允许公共读`
            : `写入成功，但签名链接读不回来（HTTP ${response.status}）：检查 region 是否与桶所在地域一致`
        }
      }
    } finally {
      await deleteObject(target, key).catch(() => {})
    }
    if (isPrivateEndpoint(config.publicBaseUrl || config.endpoint)) {
      return {
        ok: false,
        message:
          '本机读写都通过了，但这是本机或内网地址，模型厂商从公网访问不到，视频发过去它看不了'
      }
    }
    return { ok: true, message: '连接正常：写入、链接读取、删除都通过了' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 盒子自己传的对象键：内容哈希的前 32 位 + 扩展名，见 doUpload */
const OWN_KEY_NAME = /^[0-9a-f]{32}(\.[^/]*)?$/

/**
 * 这个键归不归盒子管。前缀留空时，列举和清理面对的是整个桶 ——
 * 只认盒子按哈希起名的那些，用户放在同一个桶里的别的数据一概不碰。
 */
function ownsKey(config: ObjectStorageConfig, key: string): boolean {
  if (config.prefix) return key.startsWith(config.prefix)
  return OWN_KEY_NAME.test(key)
}

export async function listStoredObjects(): Promise<ObjectStorageEntry[]> {
  const config = await readObjectStorageConfig()
  if (config.preset === 'uebox') return planStorage.listPlanObjects()
  const target = await targetFor(config)
  const index = await readIndex()
  const names = new Map(index.uploads.map((item) => [item.key, item.fileName]))
  const objects = await listObjects(target, config.prefix)
  return objects
    .filter((item) => ownsKey(config, item.key))
    .map((item) => ({
      ...item,
      ...(names.has(item.key) ? { fileName: names.get(item.key) } : {})
    }))
    .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
}

/** 删掉这些对象，并记下来 —— 对话里还引用着的，发请求时换成说明 */
export async function removeStoredObjects(keys: string[]): Promise<{
  removed: number
  failed: Array<{ key: string; error: string }>
}> {
  const config = await readObjectStorageConfig()
  if (config.preset === 'uebox') {
    const result = await planStorage.removePlanObjects(keys)
    if (result.removed > 0) forgetSettledUploads()
    return result
  }
  const target = await targetFor(config)
  const failed: Array<{ key: string; error: string }> = []
  const done: string[] = []
  for (const key of keys) {
    // 只动盒子自己传的东西：桶里别的数据不归盒子管
    if (!ownsKey(config, key)) {
      failed.push({ key, error: '不是盒子传的对象，不动' })
      continue
    }
    try {
      await deleteObject(target, key)
      done.push(key)
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await updateIndex((index) => ({
    uploads: index.uploads.filter((item) => !done.includes(item.key)),
    removed: [...new Set([...index.removed, ...done])]
  }))
  if (done.length > 0) forgetSettledUploads()
  return { removed: done.length, failed }
}

/**
 * 清理多少天没用过的对象。
 *
 * 「用过」取桶里的上传时间和本机最后一次复用的时间里较晚的那个：同一个文件去重后
 * 不会再传，桶里的时间停在第一次 —— 只看它，6 天前传、今天刚在新对话里复用的文件，
 * 明天就会被清掉，今天那段对话的链接跟着失效。
 */
export async function cleanOlderThan(days: number): Promise<{
  removed: number
  failed: Array<{ key: string; error: string }>
}> {
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const objects = await listStoredObjects()
  const lastUsed = new Map((await readIndex()).uploads.map((item) => [item.key, item.uploadedAt]))
  const stale = objects.filter((item) => {
    const used = Date.parse(lastUsed.get(item.key) ?? '')
    const time = Math.max(Date.parse(item.lastModified) || 0, Number.isNaN(used) ? 0 : used)
    return time < cutoff
  })
  if (stale.length === 0) return { removed: 0, failed: [] }
  return removeStoredObjects(stale.map((item) => item.key))
}

/** 套餐存储的用量；自己的桶没有这一项，回 null */
export async function objectStorageUsage(): Promise<ObjectStorageUsage | null> {
  const config = await readObjectStorageConfig()
  return config.preset === 'uebox' ? planStorage.planStorageUsage() : null
}

/** 启动时按设置自动清一次。没开、没配好、没网都安静跳过 —— 这不值得打扰用户 */
export async function runAutoClean(): Promise<void> {
  const config = await readObjectStorageConfig()
  if (config.autoCleanDays <= 0 || !(await isObjectStorageReady())) return
  if (!existsSync(userDataFile(CONFIG_FILE))) return
  try {
    const result = await cleanOlderThan(config.autoCleanDays)
    if (result.removed > 0) {
      console.log(`[对象存储] 自动清理了 ${result.removed} 个 ${config.autoCleanDays} 天前的对象`)
    }
  } catch (error) {
    console.warn('[对象存储] 自动清理跳过:', error)
  }
}
