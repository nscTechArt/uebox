import { request } from '@renderer/common/http'
import type { AxiosProgressEvent } from 'axios'

/**
 * 如果字符串包含中文字符，则对其进行 URI 编码，否则返回原字符串。
 * @param str - 需要处理的字符串
 * @returns 编码后的字符串或原字符串
 */
function encodeURIIfChinese(str: string): string {
  // // 覆盖中日韩统一表意文字、扩展A、兼容表意文字常用范围
  // const chineseRegex = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
  // if (chineseRegex.test(str)) {
  //   console.log(encodeURIComponent(str));

  //   return encodeURIComponent(str)
  // }
  return str
}

export interface BaiduUserInfoResponse {
  baidu_name: string
  netdisk_name: string
  avatar_url: string
  vip_type: number
  uk: number
}

/**
 * 获取百度网盘用户信息（NAS uinfo）
 * 使用全局统一的 HTTP 请求实例
 */
export const getBaiduNasUinfo = (params: { accessToken: string }) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/nas'
  return request.get<BaiduUserInfoResponse>(url, {
    params: {
      method: 'uinfo',
      access_token: params.accessToken,
      vip_version: 'v2'
    }
  })
}

// ======================== 文件列表接口 ========================
export interface BaiduFileListParams {
  dir?: string
  order?: 'name' | 'time' | 'size'
  desc?: 0 | 1
  start?: number
  limit?: number
  web?: 0 | 1
  folder?: 0 | 1
  showempty?: 0 | 1
}

export interface BaiduFileItem {
  fs_id: number
  path: string
  server_filename: string
  size: number
  server_mtime: number
  server_ctime: number
  local_mtime: number
  local_ctime: number
  isdir: 0 | 1
  category: number
  md5?: string
  dir_empty?: 0 | 1
  thumbs?: {
    icon?: string
    url1?: string
    url2?: string
    url3?: string
  } | null
}

export interface BaiduFileListResponse {
  list: BaiduFileItem[]
}

/**
 * 获取指定目录下的文件列表（xpan/file list）
 * 使用全局统一的 HTTP 请求实例
 */
export const getBaiduFileList = (accessToken: string, options: BaiduFileListParams = {}) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file'
  return request.get<BaiduFileListResponse>(url, {
    params: {
      method: 'list',
      access_token: accessToken,
      ...(options.dir ? { dir: encodeURIIfChinese(options.dir) } : {}),
      ...(options.order ? { order: options.order } : {}),
      ...(typeof options.desc !== 'undefined' ? { desc: options.desc } : {}),
      ...(typeof options.start !== 'undefined' ? { start: options.start } : {}),
      ...(typeof options.limit !== 'undefined' ? { limit: options.limit } : {}),
      ...(typeof options.web !== 'undefined' ? { web: options.web } : {}),
      ...(typeof options.folder !== 'undefined' ? { folder: options.folder } : {}),
      ...(typeof options.showempty !== 'undefined' ? { showempty: options.showempty } : {})
    }
  })
}

// ======================== 关键词搜索接口 ========================
export interface BaiduSearchParams {
  key: string
  dir?: string
  category?: number // 1 视频、2 音频、3 图片、4 文档、5 应用、6 其他、7 种子
  recursion?: 0 | 1
  web?: 0 | 1
  deviceId?: string
}

export interface BaiduSearchResponse {
  has_more: number
  list: BaiduFileItem[]
}

/**
 * 关键词搜索：GET /rest/2.0/xpan/file?method=search
 * 说明：服务端默认 num=500 不必传；key 最大 30 字符（UTF8）。
 */
export const searchBaiduFiles = (accessToken: string, options: BaiduSearchParams) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file'
  const key = (options.key || '').trim().slice(0, 30)
  return request.get<BaiduSearchResponse>(url, {
    params: {
      method: 'search',
      access_token: accessToken,
      key,
      ...(options.dir ? { dir: encodeURIIfChinese(options.dir) } : {}),
      ...(typeof options.category !== 'undefined' ? { category: options.category } : {}),
      ...(typeof options.recursion !== 'undefined' ? { recursion: options.recursion } : {}),
      ...(typeof options.web !== 'undefined' ? { web: options.web } : {}),
      ...(options.deviceId ? { device_id: options.deviceId } : {})
    }
  })
}

// ======================== 预上传接口 ========================
export interface BaiduPrecreateParams {
  path: string
  size: number
  isdir: 0 | 1
  blockList: string[]
  rtype?: 1 | 2 | 3
  uploadid?: string
  contentMd5?: string
  sliceMd5?: string
  localCtime?: number | string
  localMtime?: number | string
}

export interface BaiduPrecreateResponse {
  errno: number
  path: string
  uploadid: string
  return_type: number
  block_list: number[] | string
}

/**
 * 预上传：通知云端新建上传任务，返回 uploadid
 * 使用 x-www-form-urlencoded 表单编码传参
 */
export const precreateBaiduFile = (accessToken: string, options: BaiduPrecreateParams) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file'
  const form = new URLSearchParams()

  form.append('path', encodeURIIfChinese(options.path))
  form.append('size', String(options.size))
  form.append('isdir', String(options.isdir))
  form.append('block_list', JSON.stringify(options.blockList))
  form.append('autoinit', '1')

  if (typeof options.rtype !== 'undefined') form.append('rtype', String(options.rtype))
  if (options.uploadid) form.append('uploadid', options.uploadid)
  if (options.contentMd5) form.append('content-md5', options.contentMd5)
  if (options.sliceMd5) form.append('slice-md5', options.sliceMd5)
  if (typeof options.localCtime !== 'undefined')
    form.append('local_ctime', String(options.localCtime))
  if (typeof options.localMtime !== 'undefined')
    form.append('local_mtime', String(options.localMtime))

  return request.post<BaiduPrecreateResponse>(url, form, {
    params: {
      method: 'precreate',
      access_token: accessToken
    }
  })
}

// ======================== 上传域名定位接口 ========================
export interface BaiduLocateUploadParams {
  path: string
  uploadid: string
  appid?: number // 默认为 250528
  uploadVersion?: '2.0'
}

export interface BaiduServerEntry {
  server: string
}
export interface BaiduLocateUploadResponse {
  bak_server: string[]
  bak_servers: BaiduServerEntry[]
  client_ip: string
  error_code: number
  error_msg: string
  expire: number
  host: string
  newno: string
  quic_server: string[]
  quic_servers: BaiduServerEntry[]
  request_id: number
  server: string[]
  server_time: number
  servers: BaiduServerEntry[]
  sl: number
}

/**
 * 获取上传域名（locateupload）
 * 使用统一 GET 请求，返回 servers/quic_servers 等域名列表
 */
export const locateUploadServer = (accessToken: string, options: BaiduLocateUploadParams) => {
  const url = 'https://d.pcs.baidu.com/rest/2.0/pcs/file'
  const appid = options.appid ?? 250528
  const uploadVersion = options.uploadVersion ?? '2.0'
  return request.get<BaiduLocateUploadResponse>(url, {
    params: {
      method: 'locateupload',
      appid,
      access_token: accessToken,
      path: encodeURIIfChinese(options.path),
      uploadid: options.uploadid,
      upload_version: uploadVersion
    }
  })
}

// ======================== 分片上传接口 ========================
export interface BaiduSuperfileUploadParams {
  host: string // 使用 locateupload 返回的域名，如 https://c.pcs.baidu.com
  accessToken: string
  path: string
  uploadid: string
  partseq: number
}

export interface BaiduSuperfileUploadResponse {
  errno: number
  md5: string
}

/**
 * 分片上传：superfile2 upload，Body 采用二进制字节流
 */
export const uploadBaiduSuperfile = (
  data: Blob | ArrayBuffer | Uint8Array,
  options: BaiduSuperfileUploadParams
) => {
  const base = options.host.replace(/\/+$/, '')
  const url = `${base}/rest/2.0/pcs/superfile2`

  // 使用 multipart/form-data，字段名为 file
  let blob: Blob
  if (data instanceof Blob) {
    blob = data
  } else if (data instanceof Uint8Array) {
    // 显式将 buffer 断言为 ArrayBuffer，避免 ArrayBufferLike 与 BlobPart 泛型不匹配
    const ab = data.buffer as ArrayBuffer
    blob = new Blob([ab], { type: 'application/octet-stream' })
  } else {
    // 兜底按 ArrayBuffer 处理
    blob = new Blob([data as ArrayBuffer], { type: 'application/octet-stream' })
  }
  const form = new FormData()
  form.append('file', blob)

  return request.post<BaiduSuperfileUploadResponse>(url, form, {
    headers: {
      // 显式覆盖默认 json 头为 multipart/form-data
      'Content-Type': 'multipart/form-data'
    },
    params: {
      method: 'upload',
      access_token: options.accessToken,
      type: 'tmpfile',
      path: encodeURIIfChinese(options.path),
      uploadid: options.uploadid,
      partseq: options.partseq
    }
  })
}

// ======================== 创建文件接口 ========================
export interface BaiduCreateFileParams {
  path: string
  size: number | string
  isdir: 0 | 1
  blockList: string[]
  uploadid?: string
  rtype?: 0 | 1 | 2 | 3
  localCtime?: number
  localMtime?: number
  zipQuality?: 50 | 70 | 100
  zipSign?: string
  isRevision?: 0 | 1
  mode?: 1 | 2 | 3 | 4 | 5
  exifInfo?: string | Record<string, any>
}

export interface BaiduCreateFileResponse {
  errno: number
  fs_id: number
  md5?: string
  server_filename: string
  category: number
  path: string
  size: number
  ctime: number
  mtime: number
  isdir: 0 | 1
}

/**
 * 创建文件/目录（create）：合并分片并生成文件信息
 * 使用 x-www-form-urlencoded 表单编码
 */
export const createBaiduFile = (accessToken: string, options: BaiduCreateFileParams) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file'
  const form = new URLSearchParams()

  form.append('path', encodeURIIfChinese(options.path))
  form.append('size', String(options.size))
  form.append('isdir', String(options.isdir))
  form.append('block_list', JSON.stringify(options.blockList))
  if (options.uploadid) form.append('uploadid', options.uploadid)
  if (typeof options.rtype !== 'undefined') form.append('rtype', String(options.rtype))
  if (typeof options.localCtime !== 'undefined')
    form.append('local_ctime', String(options.localCtime))
  if (typeof options.localMtime !== 'undefined')
    form.append('local_mtime', String(options.localMtime))
  if (typeof options.zipQuality !== 'undefined')
    form.append('zip_quality', String(options.zipQuality))
  if (options.zipSign) form.append('zip_sign', options.zipSign)
  if (typeof options.isRevision !== 'undefined')
    form.append('is_revision', String(options.isRevision))
  if (typeof options.mode !== 'undefined') form.append('mode', String(options.mode))
  if (typeof options.exifInfo !== 'undefined') {
    const exif =
      typeof options.exifInfo === 'string' ? options.exifInfo : JSON.stringify(options.exifInfo)
    form.append('exif_info', exif)
  }

  return request.post<BaiduCreateFileResponse>(url, form, {
    params: {
      method: 'create',
      access_token: accessToken
    }
  })
}

/**
 * 在百度网盘创建文件夹
 * @param accessToken - 访问令牌
 * @param path - 文件夹在百度网盘中的完整路径，如 /apps/unreal-agent/我的文件夹
 * @param rtype - 重名策略，默认 1（覆盖）
 */
export const createBaiduFolder = (accessToken: string, path: string, rtype: 0 | 1 | 2 | 3 = 1) => {
  return createBaiduFile(accessToken, {
    path,
    size: 0,
    isdir: 1,
    blockList: [],
    rtype
  })
}

// ======================== 查询文件信息接口 ========================
export interface BaiduFileMetasParams {
  fsids: Array<number | string>
  dlink?: 0 | 1
  path?: string
  thumb?: 0 | 1
  extra?: 0 | 1
  needmedia?: 0 | 1
  detail?: 0 | 1
  deviceId?: string
  fromApaas?: 0 | 1
}

export interface BaiduFileMetaItem {
  fs_id?: number
  path?: string
  md5?: string
  category: number
  dlink?: string
  filename: string
  isdir: 0 | 1
  server_ctime: number
  server_mtime: number
  size: number
  thumbs?: Record<string, string>
  height?: number
  width?: number
  date_taken?: number
  orientation?: string
  media_info?: Record<string, any>
}

export interface BaiduFileMetasResponse {
  list: BaiduFileMetaItem[]
  names?: Record<string, any>
}

/**
 * 查询文件信息（filemetas）：按 fsids 返回文件的 meta 信息
 * GET https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas
 */
export const getBaiduFileMetas = (accessToken: string, options: BaiduFileMetasParams) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
  const fsids = (options.fsids || []).map((v) => (typeof v === 'string' ? Number(v) : v))

  return request.get<BaiduFileMetasResponse>(url, {
    params: {
      method: 'filemetas',
      access_token: accessToken,
      fsids: JSON.stringify(fsids),
      ...(typeof options.dlink !== 'undefined' ? { dlink: options.dlink } : {}),
      ...(options.path ? { path: encodeURIIfChinese(options.path) } : {}),
      ...(typeof options.thumb !== 'undefined' ? { thumb: options.thumb } : {}),
      ...(typeof options.extra !== 'undefined' ? { extra: options.extra } : {}),
      ...(typeof options.needmedia !== 'undefined' ? { needmedia: options.needmedia } : {}),
      ...(typeof options.detail !== 'undefined' ? { detail: options.detail } : {}),
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
      ...(typeof options.fromApaas !== 'undefined' ? { from_apaas: options.fromApaas } : {})
    }
  })
}

// ======================== 下载文件接口（通过 dlink） ========================
export interface BaiduDlinkDownloadParams {
  dlink: string
  accessToken: string
  range?: string | { start?: number; end?: number }
  responseType?: 'blob' | 'arraybuffer'
  onDownloadProgress?: (e: AxiosProgressEvent) => void
}

/**
 * 使用 filemetas 返回的 dlink 进行下载。
 * 需要在 dlink 上拼接 access_token，并在 Header 设置 User-Agent 为 pan.baidu.com。
 * 支持 Range 断点续传。
 */
export const downloadBaiduFileByDlink = (options: BaiduDlinkDownloadParams) => {
  const { dlink, accessToken } = options
  const sep = dlink.includes('?') ? '&' : '?'
  const finalUrl = dlink.includes('access_token=')
    ? dlink
    : `${dlink}${sep}access_token=${accessToken}`

  const headers: Record<string, string> = {
    'User-Agent': 'pan.baidu.com'
  }
  if (options.range) {
    headers['Range'] =
      typeof options.range === 'string'
        ? options.range
        : `bytes=${typeof options.range.start === 'number' ? options.range.start : ''}-${typeof options.range.end === 'number' ? options.range.end : ''}`
  }

  return request.get<Blob | ArrayBuffer>(finalUrl, {
    headers,
    responseType: options.responseType || 'blob',
    onDownloadProgress: options.onDownloadProgress
  })
}

// ======================== 文件管理接口（复制/移动/重命名/删除） ========================
export type BaiduFileManagerOpera = 'copy' | 'move' | 'rename' | 'delete'
export type BaiduFileOndup = 'fail' | 'newcopy' | 'overwrite' | 'skip'

export interface BaiduCopyMoveItem {
  path: string
  dest: string
  newname?: string
  ondup?: BaiduFileOndup
}

export interface BaiduRenameItem {
  path: string
  newname: string
  ondup?: BaiduFileOndup
}

export type BaiduDeleteItem = string | { path: string }

export interface BaiduFileManagerOptionsBase {
  async: 0 | 1 | 2
}

export interface BaiduFileManagerOptionsCopyMove extends BaiduFileManagerOptionsBase {
  opera: 'copy' | 'move'
  filelist: BaiduCopyMoveItem[]
  ondup?: BaiduFileOndup
}

export interface BaiduFileManagerOptionsRename extends BaiduFileManagerOptionsBase {
  opera: 'rename'
  filelist: BaiduRenameItem[]
  ondup?: BaiduFileOndup
}

export interface BaiduFileManagerOptionsDelete extends BaiduFileManagerOptionsBase {
  opera: 'delete'
  filelist: BaiduDeleteItem[]
}

export type BaiduFileManagerOptions =
  | BaiduFileManagerOptionsCopyMove
  | BaiduFileManagerOptionsRename
  | BaiduFileManagerOptionsDelete

export interface BaiduFileManagerResponse {
  info?: Array<Record<string, any>>
  taskid?: number
}

/**
 * 文件管理：复制/移动/重命名/删除（filemanager）
 * Body 参数采用 x-www-form-urlencoded：async、filelist、ondup（全局，可选）
 * 说明：delete 操作不支持 ondup；当 async=2 时服务端返回 taskid 进行异步处理
 */
export const fileManagerBaidu = (accessToken: string, options: BaiduFileManagerOptions) => {
  const url = 'https://pan.baidu.com/rest/2.0/xpan/file'
  const form = new URLSearchParams()

  form.append('async', String(options.async))

  if (options.opera === 'delete') {
    const list = options.filelist.map((item) => (typeof item === 'string' ? item : item.path))
    form.append('filelist', JSON.stringify(list))
  } else {
    form.append('filelist', JSON.stringify(options.filelist))
    form.append('ondup', options.ondup ?? 'fail')
  }

  return request.post<BaiduFileManagerResponse>(url, form, {
    params: {
      method: 'filemanager',
      access_token: accessToken,
      opera: options.opera
    }
  })
}
