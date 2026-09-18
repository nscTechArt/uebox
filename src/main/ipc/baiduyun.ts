import { ipcMain, BrowserWindow } from 'electron'
import { createWriteStream, mkdirSync, statSync, existsSync } from 'fs'
import { dirname } from 'path'
import * as https from 'https'
import { URL } from 'url'

import { assertBaiduOk } from './baiduyunErrno'

interface DownloadByFsIdArgs {
  downloadId: string
  accessToken: string
  fsId: number
  filename?: string
  savePath: string
}

interface DownloadByDlinkArgs {
  downloadId: string
  accessToken: string
  dlink: string
  filename?: string
  savePath: string
}

type ProgressEvent = {
  downloadId: string
  loaded: number
  total?: number
  percent: number
}

function sendProgress(win: Electron.WebContents | undefined, evt: ProgressEvent): void {
  if (win) {
    win.send('baiduyun:download-progress', evt)
  }
}

function getJson<T = any>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode || 0
      const loc = res.headers.location
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        res.resume()
        getJson<T>(new URL(loc, url).toString()).then(resolve).catch(reject)
        return
      }
      if (status < 200 || status >= 300) {
        reject(new Error(`HTTP ${status}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          const json = JSON.parse(text)
          resolve(json)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
  })
}

/**
 * 百度网盘的失败不走 HTTP 状态码，走响应体里的错误码 ——
 * 判据在 `baiduyunErrno.ts`（纯函数，单独放是为了能直接测）。
 */

/**
 * 发送 POST 表单请求
 * @param urlStr - 请求URL
 * @param formData - 表单数据（URLSearchParams格式字符串）
 */
function postForm<T = any>(urlStr: string, formData: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr)
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData),
        'User-Agent': 'pan.baidu.com'
      }
    }

    const req = https.request(options, (res) => {
      const status = res.statusCode || 0
      if (status < 200 || status >= 300) {
        reject(new Error(`HTTP ${status}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          const json = JSON.parse(text)
          resolve(json)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.write(formData)
    req.end()
  })
}

function appendAccessToken(dlink: string, accessToken: string): string {
  const u = new URL(dlink)
  if (!u.searchParams.has('access_token')) {
    u.searchParams.set('access_token', accessToken)
  }
  return u.toString()
}

/**
 * 流式下载文件，支持断点续传
 * @param originalUrl 下载 URL
 * @param headers 请求头
 * @param destPath 目标文件路径
 * @param onProgress 进度回调
 * @param maxRedirects 最大重定向次数
 */
function streamDownload(
  originalUrl: string,
  headers: Record<string, string>,
  destPath: string,
  onProgress: (loaded: number, total?: number) => void,
  maxRedirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirected = 0
    const ensureDir = dirname(destPath)
    try {
      mkdirSync(ensureDir, { recursive: true })
    } catch {}

    // 检查是否存在部分下载的文件，支持断点续传
    let startByte = 0
    try {
      if (existsSync(destPath)) {
        const stats = statSync(destPath)
        startByte = stats.size
      }
    } catch {
      startByte = 0
    }

    const doRequest = (urlStr: string) => {
      // 如果有已下载的部分，添加 Range 请求头
      const requestHeaders = { ...headers }
      if (startByte > 0) {
        requestHeaders['Range'] = `bytes=${startByte}-`
      }

      const req = https.get(
        urlStr,
        {
          headers: requestHeaders
        },
        (res) => {
          const status = res.statusCode || 0
          const loc = res.headers.location
          if ([301, 302, 303, 307, 308].includes(status) && loc) {
            if (redirected >= maxRedirects) {
              res.resume()
              reject(new Error('Too many redirects'))
              return
            }
            redirected += 1
            res.resume()
            const nextUrl = new URL(loc, urlStr).toString()
            doRequest(nextUrl)
            return
          }

          // 处理断点续传响应
          // 206 表示支持 Range 请求并返回部分内容
          // 200 表示服务器不支持 Range 或返回完整内容（需要重新下载）
          if (status === 200 && startByte > 0) {
            // 服务器返回完整内容，可能不支持 Range 请求
            // 需要重新从头下载
            startByte = 0
          } else if (status !== 206 && status !== 200) {
            res.resume()
            reject(new Error(`HTTP ${status}`))
            return
          }

          // 计算总大小
          let total: number | undefined
          const contentLength = Number(res.headers['content-length']) || undefined
          const contentRange = res.headers['content-range']

          if (contentRange) {
            // Content-Range 格式: bytes 0-999/1000
            const match = contentRange.match(/bytes \d+-\d+\/(\d+)/)
            if (match) {
              total = Number(match[1])
            }
          } else if (contentLength) {
            total = status === 206 ? startByte + contentLength : contentLength
          }

          let loaded = startByte
          // 使用 append 模式（'a'），如果没有已下载部分则用写入模式（'w'）
          const file = createWriteStream(destPath, {
            flags: startByte > 0 && status === 206 ? 'a' : 'w'
          })

          res.on('data', (chunk) => {
            loaded += Buffer.byteLength(chunk)
            onProgress(loaded, total)
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          file.on('error', (err) => reject(err))
        }
      )
      req.on('error', reject)
    }

    doRequest(originalUrl)
  })
}

async function fetchDlink(accessToken: string, fsId: number): Promise<string> {
  const base = 'https://pan.baidu.com/rest/2.0/xpan/multimedia'
  const url = `${base}?method=filemetas&access_token=${encodeURIComponent(accessToken)}&fsids=${encodeURIComponent(
    JSON.stringify([fsId])
  )}&dlink=1`
  const json = await getJson<{ list?: Array<{ dlink?: string }> }>(url)
  const dlink = json?.list && json.list[0]?.dlink
  if (!dlink) throw new Error('未获取到下载地址 dlink')
  return dlink
}

// ==================== 文件夹下载相关 ====================

/**
 * 文件夹下载参数接口
 */
interface DownloadFolderArgs {
  downloadId: string
  accessToken: string
  folderPath: string
  folderName: string
  savePath: string
}

/**
 * 文件夹下载进度事件
 */
interface FolderDownloadProgressEvent {
  downloadId: string
  phase: 'scanning' | 'downloading' | 'done' | 'error'
  totalFiles: number
  downloadedFiles: number
  failedFiles: number
  currentFile: string
  percent: number
}

/**
 * 递归文件信息（包含相对路径）
 */
interface RecursiveFileInfo {
  fsId: number
  serverFilename: string
  relativePath: string // 相对于根文件夹的路径
  size: number
}

/**
 * 清理文件名中的非法字符（Windows）
 * @param name 原始文件名
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_')
}

/**
 * 延迟函数
 * @param ms 毫秒数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发送文件夹下载进度事件
 */
function sendFolderProgress(
  win: Electron.WebContents | undefined,
  evt: FolderDownloadProgressEvent
): void {
  if (win) {
    win.send('baiduyun:folder-download-progress', evt)
  }
}

/**
 * 迭代式获取文件夹内所有文件（避免递归栈溢出）
 * @param accessToken 访问令牌
 * @param rootPath 根文件夹路径
 * @param maxDepth 最大深度限制
 * @param maxFiles 最大文件数限制
 * @param onProgress 扫描进度回调
 */
async function listFolderFilesIterative(
  accessToken: string,
  rootPath: string,
  maxDepth = 10,
  maxFiles = 5000,
  onProgress?: (scannedDirs: number, foundFiles: number) => void
): Promise<{ files: RecursiveFileInfo[]; truncated: boolean }> {
  const files: RecursiveFileInfo[] = []
  // 队列项: [目录路径, 当前深度, 相对于 rootPath 的前缀]
  const queue: Array<{ dir: string; depth: number; prefix: string }> = [
    { dir: rootPath, depth: 0, prefix: '' }
  ]
  let scannedDirs = 0
  let truncated = false

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift()!
    const { dir, depth, prefix } = current

    if (depth > maxDepth) {
      continue // 超过深度限制则跳过
    }

    scannedDirs++
    onProgress?.(scannedDirs, files.length)

    // 分页获取当前目录下的文件
    let start = 0
    const limit = 100
    let hasMore = true

    while (hasMore && files.length < maxFiles) {
      const params = new URLSearchParams()
      params.set('method', 'list')
      params.set('access_token', accessToken)
      params.set('dir', dir)
      params.set('order', 'name')
      params.set('start', String(start))
      params.set('limit', String(limit))
      params.set('web', '1')

      const url = `https://pan.baidu.com/rest/2.0/xpan/file?${params.toString()}`

      try {
        const json = await getJson<{
          errno?: number
          list?: Array<{
            fs_id: number
            server_filename: string
            path: string
            isdir: number
            size: number
          }>
        }>(url)

        // 检查 Token 过期
        if (json.errno === 111 || json.errno === -6) {
          throw new Error('TOKEN_EXPIRED')
        }

        const list = json.list || []
        if (list.length === 0) {
          hasMore = false
          break
        }

        for (const item of list) {
          if (files.length >= maxFiles) {
            truncated = true
            break
          }

          const itemRelativePath = prefix
            ? `${prefix}/${sanitizeFilename(item.server_filename)}`
            : sanitizeFilename(item.server_filename)

          if (item.isdir === 1) {
            // 是目录，加入队列
            queue.push({
              dir: item.path,
              depth: depth + 1,
              prefix: itemRelativePath
            })
          } else {
            // 是文件，加入结果
            files.push({
              fsId: item.fs_id,
              serverFilename: item.server_filename,
              relativePath: itemRelativePath,
              size: item.size
            })
          }
        }

        start += list.length
        if (list.length < limit) {
          hasMore = false
        }

        // API 限流保护：每次请求后延迟 100ms
        await delay(100)
      } catch (e) {
        // 遇到 Token 过期错误直接抛出
        if ((e as Error).message === 'TOKEN_EXPIRED') {
          throw e
        }
        // 其他错误记录日志并继续
        console.warn(`获取目录 ${dir} 失败:`, e)
        hasMore = false
      }
    }
  }

  if (queue.length > 0 && files.length >= maxFiles) {
    truncated = true
  }

  return { files, truncated }
}

export function registerBaiduyunIPC(): void {
  ipcMain.handle('baiduyun:downloadByFsId', async (event, args: DownloadByFsIdArgs) => {
    const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
    const { downloadId, accessToken, fsId, savePath } = args
    try {
      const dlink = await fetchDlink(accessToken, fsId)
      const finalUrl = appendAccessToken(dlink, accessToken)
      const headers: Record<string, string> = {
        'User-Agent': 'pan.baidu.com',
        'Accept-Encoding': 'identity'
      }

      await streamDownload(finalUrl, headers, savePath, (loaded, total) => {
        const percent = total ? Math.max(1, Math.min(99, Math.round((loaded / total) * 100))) : 0
        sendProgress(web, { downloadId, loaded, total, percent })
      })

      sendProgress(web, { downloadId, loaded: 1, total: 1, percent: 100 })
      return { success: true, data: { savePath } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('baiduyun:downloadByDlink', async (event, args: DownloadByDlinkArgs) => {
    const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
    const { downloadId, accessToken, dlink, savePath } = args
    try {
      const finalUrl = appendAccessToken(dlink, accessToken)
      const headers: Record<string, string> = {
        'User-Agent': 'pan.baidu.com',
        'Accept-Encoding': 'identity'
      }

      await streamDownload(finalUrl, headers, savePath, (loaded, total) => {
        const percent = total ? Math.max(1, Math.min(99, Math.round((loaded / total) * 100))) : 0
        sendProgress(web, { downloadId, loaded, total, percent })
      })

      sendProgress(web, { downloadId, loaded: 1, total: 1, percent: 100 })
      return { success: true, data: { savePath } }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 下载整个文件夹（递归）
   * @param args.downloadId - 下载任务ID
   * @param args.accessToken - 访问令牌
   * @param args.folderPath - 百度网盘文件夹路径
   * @param args.folderName - 文件夹名称
   * @param args.savePath - 本地保存根路径
   */
  ipcMain.handle('baiduyun:downloadFolder', async (event, args: DownloadFolderArgs) => {
    const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
    const { downloadId, accessToken, folderPath, folderName, savePath } = args

    const failedFiles: Array<{ relativePath: string; error: string }> = []
    let downloadedCount = 0
    let totalFiles = 0

    /**
     * 发送进度更新的辅助函数
     */
    const emitProgress = (phase: FolderDownloadProgressEvent['phase'], currentFile = ''): void => {
      const percent =
        phase === 'scanning'
          ? 0
          : phase === 'done' || phase === 'error'
            ? 100
            : totalFiles > 0
              ? Math.round((downloadedCount / totalFiles) * 100)
              : 0
      sendFolderProgress(web, {
        downloadId,
        phase,
        totalFiles,
        downloadedFiles: downloadedCount,
        failedFiles: failedFiles.length,
        currentFile,
        percent
      })
    }

    try {
      // 阶段1：扫描文件夹
      emitProgress('scanning')

      const { files, truncated } = await listFolderFilesIterative(
        accessToken,
        folderPath,
        10, // maxDepth
        5000, // maxFiles
        (_scannedDirs, foundFiles) => {
          totalFiles = foundFiles
          emitProgress('scanning')
        }
      )

      totalFiles = files.length

      // 空文件夹直接返回成功
      if (files.length === 0) {
        emitProgress('done')
        return {
          success: true,
          data: {
            downloadedCount: 0,
            failedFiles: [],
            truncated: false,
            message: '文件夹为空'
          }
        }
      }

      // 阶段2：下载文件
      const rootSavePath = `${savePath}/${sanitizeFilename(folderName)}`.replace(/\/{2,}/g, '/')

      // 确保根目录存在
      mkdirSync(rootSavePath, { recursive: true })

      for (const file of files) {
        emitProgress('downloading', file.serverFilename)

        const fileSavePath = `${rootSavePath}/${file.relativePath}`.replace(/\/{2,}/g, '/')

        // 确保目标目录存在
        const fileDir = dirname(fileSavePath)
        mkdirSync(fileDir, { recursive: true })

        // 检查文件是否已存在
        if (existsSync(fileSavePath)) {
          // 文件已存在，跳过
          downloadedCount++
          continue
        }

        // 下载文件，带重试逻辑
        let success = false
        let lastError = ''
        const maxRetries = 3

        for (let attempt = 0; attempt < maxRetries && !success; attempt++) {
          try {
            // 获取下载链接
            const dlink = await fetchDlink(accessToken, file.fsId)
            const finalUrl = appendAccessToken(dlink, accessToken)
            const headers: Record<string, string> = {
              'User-Agent': 'pan.baidu.com',
              'Accept-Encoding': 'identity'
            }

            // 下载文件
            await streamDownload(finalUrl, headers, fileSavePath, () => {
              // 单文件进度暂不发送，只发送整体进度
            })

            success = true
          } catch (e) {
            lastError = (e as Error).message

            // Token 过期直接返回
            if (lastError === 'TOKEN_EXPIRED') {
              emitProgress('error')
              return {
                success: false,
                error: 'TOKEN_EXPIRED',
                data: { downloadedCount, failedFiles }
              }
            }

            // 指数退避重试
            if (attempt < maxRetries - 1) {
              await delay(Math.pow(2, attempt) * 500)
            }
          }
        }

        if (success) {
          downloadedCount++
        } else {
          failedFiles.push({ relativePath: file.relativePath, error: lastError })
        }

        // API 限流保护
        await delay(200)
      }

      emitProgress('done')

      return {
        success: failedFiles.length === 0,
        data: {
          downloadedCount,
          failedFiles,
          truncated,
          savePath: rootSavePath
        }
      }
    } catch (error) {
      emitProgress('error')
      const errMsg = (error as Error).message
      if (errMsg === 'TOKEN_EXPIRED') {
        return { success: false, error: 'TOKEN_EXPIRED', data: { downloadedCount, failedFiles } }
      }
      return { success: false, error: errMsg, data: { downloadedCount, failedFiles } }
    }
  })

  /**
   * 获取百度网盘用户信息
   * @param args.accessToken - 访问令牌
   */
  ipcMain.handle('baiduyun:getUserInfo', async (_event, args: { accessToken: string }) => {
    try {
      const url = `https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${encodeURIComponent(args.accessToken)}&vip_version=v2`
      const data = assertBaiduOk(await getJson(url))
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 获取指定目录下的文件列表
   * @param args.accessToken - 访问令牌
   * @param args.dir - 目录路径，默认 '/'
   * @param args.order - 排序字段: name/time/size
   * @param args.desc - 是否降序: 0/1
   * @param args.limit - 返回数量限制
   */
  ipcMain.handle(
    'baiduyun:getFileList',
    async (
      _event,
      args: {
        accessToken: string
        dir?: string
        order?: string
        desc?: number
        start?: number
        limit?: number
        web?: number
        folder?: number
        showempty?: number
      }
    ) => {
      try {
        const params = new URLSearchParams()
        params.set('method', 'list')
        params.set('access_token', args.accessToken)
        if (args.dir) params.set('dir', args.dir)
        if (args.order) params.set('order', args.order)
        if (typeof args.desc !== 'undefined') params.set('desc', String(args.desc))
        if (typeof args.start !== 'undefined') params.set('start', String(args.start))
        if (typeof args.limit !== 'undefined') params.set('limit', String(args.limit))
        if (typeof args.web !== 'undefined') params.set('web', String(args.web))
        if (typeof args.folder !== 'undefined') params.set('folder', String(args.folder))
        if (typeof args.showempty !== 'undefined') params.set('showempty', String(args.showempty))

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?${params.toString()}`
        const data = assertBaiduOk(await getJson(url))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 搜索百度网盘文件
   * @param args.accessToken - 访问令牌
   * @param args.key - 搜索关键词（最多30字符）
   * @param args.dir - 搜索目录
   * @param args.recursion - 是否递归搜索: 0/1
   */
  ipcMain.handle(
    'baiduyun:searchFiles',
    async (
      _event,
      args: {
        accessToken: string
        key: string
        dir?: string
        category?: number
        recursion?: number
        web?: number
      }
    ) => {
      try {
        const params = new URLSearchParams()
        params.set('method', 'search')
        params.set('access_token', args.accessToken)
        params.set('key', (args.key || '').trim().slice(0, 30))
        if (args.dir) params.set('dir', args.dir)
        if (typeof args.category !== 'undefined') params.set('category', String(args.category))
        if (typeof args.recursion !== 'undefined') params.set('recursion', String(args.recursion))
        if (typeof args.web !== 'undefined') params.set('web', String(args.web))

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?${params.toString()}`
        const data = assertBaiduOk(await getJson(url))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 百度网盘文件管理：重命名、删除、复制、移动
   * @param args.accessToken - 访问令牌
   * @param args.opera - 操作类型: copy/move/rename/delete
   * @param args.filelist - 文件列表JSON
   * @param args.async - 异步模式: 0同步/1自适应/2异步
   * @param args.ondup - 重名处理: fail/newcopy/overwrite/skip
   */
  ipcMain.handle(
    'baiduyun:fileManager',
    async (
      _event,
      args: {
        accessToken: string
        opera: 'copy' | 'move' | 'rename' | 'delete'
        filelist: Array<{ path: string; newname?: string; dest?: string }>
        async?: number
        ondup?: string
      }
    ) => {
      try {
        const queryParams = new URLSearchParams()
        queryParams.set('method', 'filemanager')
        queryParams.set('access_token', args.accessToken)
        queryParams.set('opera', args.opera)

        const formParams = new URLSearchParams()
        formParams.set('async', String(args.async ?? 0))

        if (args.opera === 'delete') {
          // delete 操作只需要路径数组
          const paths = args.filelist.map((item) => item.path)
          formParams.set('filelist', JSON.stringify(paths))
        } else {
          formParams.set('filelist', JSON.stringify(args.filelist))
          if (args.ondup) formParams.set('ondup', args.ondup)
        }

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?${queryParams.toString()}`
        // filemanager 是服务端异步任务：errno 111 是「上一批还在跑」，等一会重试就行。
        // 当成鉴权失效的话，用户连着删两批就被引去重新授权，授权完还是 111
        const data = assertBaiduOk(await postForm(url, formParams.toString()), { asyncTask: true })
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // ==================== 上传相关 API ====================

  /**
   * 预上传：通知云端新建上传任务
   * @param args.accessToken - 访问令牌
   * @param args.path - 云端路径
   * @param args.size - 文件大小
   * @param args.blockList - 分片MD5列表
   * @param args.rtype - 重名策略
   */
  ipcMain.handle(
    'baiduyun:precreate',
    async (
      _event,
      args: {
        accessToken: string
        path: string
        size: number
        isdir?: 0 | 1
        blockList: string[]
        rtype?: 0 | 1 | 2 | 3
      }
    ) => {
      try {
        const formParams = new URLSearchParams()
        formParams.set('path', args.path)
        formParams.set('size', String(args.size))
        formParams.set('isdir', String(args.isdir ?? 0))
        formParams.set('block_list', JSON.stringify(args.blockList))
        formParams.set('autoinit', '1')
        if (typeof args.rtype !== 'undefined') {
          formParams.set('rtype', String(args.rtype))
        }

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${encodeURIComponent(args.accessToken)}`
        const data = assertBaiduOk(await postForm(url, formParams.toString()))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 获取上传域名
   * @param args.accessToken - 访问令牌
   * @param args.path - 云端路径
   * @param args.uploadid - 上传ID
   */
  ipcMain.handle(
    'baiduyun:locateUpload',
    async (
      _event,
      args: {
        accessToken: string
        path: string
        uploadid: string
      }
    ) => {
      try {
        const params = new URLSearchParams()
        params.set('method', 'locateupload')
        params.set('appid', '250528')
        params.set('access_token', args.accessToken)
        params.set('path', args.path)
        params.set('uploadid', args.uploadid)
        params.set('upload_version', '2.0')

        const url = `https://d.pcs.baidu.com/rest/2.0/pcs/file?${params.toString()}`
        const data = assertBaiduOk(await getJson(url))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 分片上传文件（主进程读取文件，支持进度回调）
   * @param args.accessToken - 访问令牌
   * @param args.localPath - 本地文件路径
   * @param args.remotePath - 云端路径
   * @param args.uploadid - 上传ID
   * @param args.host - 上传域名
   * @param args.uploadId - 进度事件标识
   * @param args.blockSize - 分片大小(字节)，默认4MB
   */
  ipcMain.handle(
    'baiduyun:uploadFile',
    async (
      event,
      args: {
        accessToken: string
        localPath: string
        remotePath: string
        uploadid: string
        host: string
        uploadId: string
        blockSize?: number
      }
    ) => {
      const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
      const { accessToken, localPath, remotePath, uploadid, host, uploadId } = args
      const blockSize = args.blockSize ?? 4 * 1024 * 1024 // 默认4MB

      try {
        const { readFileSync, statSync } = await import('fs')
        const stats = statSync(localPath)
        const fileSize = stats.size
        const fileData = readFileSync(localPath)

        const blockCount = Math.ceil(fileSize / blockSize)
        const blockMd5List: string[] = []
        let uploadedBytes = 0

        // 分片上传
        for (let i = 0; i < blockCount; i++) {
          const start = i * blockSize
          const end = Math.min(start + blockSize, fileSize)
          const chunk = fileData.slice(start, end)

          // 构建 multipart/form-data 边界
          const boundary = `----BaiduPcsUploadBoundary${Date.now()}`
          const header = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`
          )
          const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
          const body = Buffer.concat([header, chunk, footer])

          const baseUrl = host.replace(/\/+$/, '')
          const params = new URLSearchParams()
          params.set('method', 'upload')
          params.set('access_token', accessToken)
          params.set('type', 'tmpfile')
          params.set('path', remotePath)
          params.set('uploadid', uploadid)
          params.set('partseq', String(i))

          const uploadUrl = `${baseUrl}/rest/2.0/pcs/superfile2?${params.toString()}`

          // 发送分片
          const result = await new Promise<{ errno?: number; md5?: string }>((resolve, reject) => {
            const parsedUrl = new URL(uploadUrl)
            const req = https.request(
              {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                  'Content-Type': `multipart/form-data; boundary=${boundary}`,
                  'Content-Length': body.length,
                  'User-Agent': 'pan.baidu.com'
                }
              },
              (res) => {
                const chunks: Buffer[] = []
                res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
                res.on('end', () => {
                  try {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve(JSON.parse(text))
                  } catch (e) {
                    reject(e)
                  }
                })
              }
            )
            req.on('error', reject)
            req.write(body)
            req.end()
          })

          if (result.errno && result.errno !== 0) {
            throw new Error(`分片 ${i} 上传失败: errno=${result.errno}`)
          }

          blockMd5List.push(result.md5 || '')
          uploadedBytes += chunk.length

          // 广播进度
          const percent = Math.round((uploadedBytes / fileSize) * 100)
          web.send('baiduyun:upload-progress', {
            uploadId,
            loaded: uploadedBytes,
            total: fileSize,
            percent,
            partIndex: i,
            partCount: blockCount
          })
        }

        return { success: true, data: { blockMd5List } }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 创建文件（合并分片）
   * @param args.accessToken - 访问令牌
   * @param args.path - 云端路径
   * @param args.size - 文件大小
   * @param args.blockList - 分片MD5列表
   * @param args.uploadid - 上传ID
   * @param args.rtype - 重名策略
   */
  ipcMain.handle(
    'baiduyun:create',
    async (
      _event,
      args: {
        accessToken: string
        path: string
        size: number
        isdir?: 0 | 1
        blockList: string[]
        uploadid?: string
        rtype?: 0 | 1 | 2 | 3
      }
    ) => {
      try {
        const formParams = new URLSearchParams()
        formParams.set('path', args.path)
        formParams.set('size', String(args.size))
        formParams.set('isdir', String(args.isdir ?? 0))
        formParams.set('block_list', JSON.stringify(args.blockList))
        if (args.uploadid) formParams.set('uploadid', args.uploadid)
        if (typeof args.rtype !== 'undefined') formParams.set('rtype', String(args.rtype))

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${encodeURIComponent(args.accessToken)}`
        const data = assertBaiduOk(await postForm(url, formParams.toString()))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 创建文件夹
   * @param args.accessToken - 访问令牌
   * @param args.path - 云端路径
   * @param args.rtype - 重名策略
   */
  ipcMain.handle(
    'baiduyun:createFolder',
    async (
      _event,
      args: {
        accessToken: string
        path: string
        rtype?: 0 | 1 | 2 | 3
      }
    ) => {
      try {
        const formParams = new URLSearchParams()
        formParams.set('path', args.path)
        formParams.set('size', '0')
        formParams.set('isdir', '1')
        formParams.set('block_list', '[]')
        if (typeof args.rtype !== 'undefined') formParams.set('rtype', String(args.rtype))

        const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${encodeURIComponent(args.accessToken)}`
        const data = assertBaiduOk(await postForm(url, formParams.toString()))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 查询文件信息
   * @param args.accessToken - 访问令牌
   * @param args.fsids - 文件ID列表
   * @param args.dlink - 是否返回下载链接
   * @param args.thumb - 是否返回缩略图
   */
  ipcMain.handle(
    'baiduyun:filemetas',
    async (
      _event,
      args: {
        accessToken: string
        fsids: Array<number | string>
        dlink?: 0 | 1
        thumb?: 0 | 1
      }
    ) => {
      try {
        const fsids = args.fsids.map((v) => (typeof v === 'string' ? Number(v) : v))
        const params = new URLSearchParams()
        params.set('method', 'filemetas')
        params.set('access_token', args.accessToken)
        params.set('fsids', JSON.stringify(fsids))
        if (typeof args.dlink !== 'undefined') params.set('dlink', String(args.dlink))
        if (typeof args.thumb !== 'undefined') params.set('thumb', String(args.thumb))

        const url = `https://pan.baidu.com/rest/2.0/xpan/multimedia?${params.toString()}`
        const data = assertBaiduOk(await getJson(url))
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
