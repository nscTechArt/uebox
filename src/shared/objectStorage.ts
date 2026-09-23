/**
 * 对象存储（S3 兼容）配置 —— 主进程与渲染层共用的形状。
 *
 * 用途只有一个：把聊天里带的音视频传到**用户自己的**桶里，换一个链接交给模型。
 * 多模态厂商对本地文件只收 base64（MIMO 上限 50MB），而 base64 会留在对话里、
 * 每轮重传；链接只有几百字节，能一直留在对话里而不改前缀，缓存最稳。
 *
 * 没配就不走这条路：音视频只带本地路径，由 agent 自己用 `analyze_video` 去看。
 */

/** 预设只决定默认 endpoint / region / 寻址方式，签名都是同一套 SigV4 */
export type ObjectStoragePreset = 'aws' | 'aliyun' | 'tencent' | 'r2' | 'minio' | 'custom'

export interface ObjectStorageConfig {
  enabled: boolean
  preset: ObjectStoragePreset
  /** 形如 `https://s3.oss-cn-hangzhou.aliyuncs.com`，不带桶名 */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** 对象键前缀，末尾带不带 `/` 都行。清理只动这个前缀下的东西 */
  prefix: string
  /** 路径式寻址（`endpoint/bucket/key`）。MinIO 需要，云厂商一般用虚拟主机式 */
  forcePathStyle: boolean
  /**
   * 公开访问域名（可选）。填了就直接拼 `域名/key`，链接永不过期；
   * 不填就用预签名链接（7 天有效，到期自动换签，换签那一轮缓存失效一次）
   */
  publicBaseUrl: string
  /** 自动清理多少天前上传的对象。0 = 不自动清理 */
  autoCleanDays: number
}

/** 渲染层看到的配置：密钥只告诉它「有没有」，不回传明文 */
export interface ObjectStorageConfigView extends ObjectStorageConfig {
  hasSecret: boolean
}

export interface ObjectStorageSaveInput extends ObjectStorageConfig {
  /** 不传 = 保留原来的；传空串 = 清掉 */
  secretAccessKey?: string
}

export interface ObjectStorageEntry {
  key: string
  size: number
  /** ISO 时间 */
  lastModified: string
  /** 本机登记过的原文件名。桶里有、本机没登记（别的机器传的）时为空 */
  fileName?: string
}

export const DEFAULT_OBJECT_STORAGE_CONFIG: ObjectStorageConfig = {
  enabled: false,
  preset: 'aliyun',
  // 和默认预设对上：开关一打开就是一份能用的起点，只差桶名和密钥
  endpoint: 'https://s3.oss-cn-hangzhou.aliyuncs.com',
  region: 'cn-hangzhou',
  bucket: '',
  accessKeyId: '',
  prefix: 'uebox-media/',
  forcePathStyle: false,
  publicBaseUrl: '',
  autoCleanDays: 7
}

/** 各家预设的默认值。`{region}` / `{accountId}` 由界面提示用户替换 */
export const OBJECT_STORAGE_PRESETS: Record<
  ObjectStoragePreset,
  { endpoint: string; region: string; forcePathStyle: boolean }
> = {
  aws: {
    endpoint: 'https://s3.{region}.amazonaws.com',
    region: 'us-east-1',
    forcePathStyle: false
  },
  // OSS 的 S3 兼容接口在 `s3.oss-` 这个域名下；原生的 `oss-` 域名不认 S3 签名
  aliyun: {
    endpoint: 'https://s3.oss-{region}.aliyuncs.com',
    region: 'cn-hangzhou',
    forcePathStyle: false
  },
  tencent: {
    endpoint: 'https://cos.{region}.myqcloud.com',
    region: 'ap-guangzhou',
    forcePathStyle: false
  },
  r2: {
    endpoint: 'https://{accountId}.r2.cloudflarestorage.com',
    region: 'auto',
    forcePathStyle: true
  },
  minio: { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true },
  custom: { endpoint: '', region: 'us-east-1', forcePathStyle: false }
}

/**
 * 规范化 endpoint：去掉末尾的 `/`，以及末尾多带的 `/桶名`。
 * R2 控制台给的 S3 API 地址就是 `https://<账号>.r2.cloudflarestorage.com/<桶名>`，
 * 原样粘进来桶名会拼两遍，列举变成读一个叫 `桶名/` 的对象，回 NoSuchKey。
 */
export function normalizeEndpoint(endpoint: string, bucket: string): string {
  let result = endpoint.trim().replace(/\/+$/, '')
  const tail = bucket.trim() && `/${bucket.trim()}`
  if (tail && result.endsWith(tail) && /^https?:\/\/[^/]+\//.test(result)) {
    result = result.slice(0, -tail.length)
  }
  return result
}

/** 规范化前缀：去掉开头的 `/`，保证非空时以 `/` 结尾 */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export interface ObjectStorageRemoveResult {
  success: boolean
  removed?: number
  failed?: Array<{ key: string; error: string }>
  error?: string
}
