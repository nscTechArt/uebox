import { ipcMain, dialog } from 'electron'
import { createWriteStream, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { WebDAVClient, FileStat } from 'webdav'
import { mt } from '../i18n'

/**
 * WebDAV 连接配置
 */
interface WebdavConnectionConfig {
  serverUrl: string
  username: string
  password: string
}

/**
 * 测试 WebDAV 连接参数
 */
interface TestConnectionArgs extends WebdavConnectionConfig {}

/**
 * 获取目录内容参数
 */
interface GetDirectoryContentsArgs extends WebdavConnectionConfig {
  path: string
}

/**
 * 上传文件参数
 */
interface UploadFileArgs extends WebdavConnectionConfig {
  remotePath: string
  fileBuffer: Buffer
}

/**
 * 下载文件参数
 */
interface DownloadFileArgs extends WebdavConnectionConfig {
  remotePath: string
  savePath?: string
}

/**
 * 删除文件参数
 */
interface DeleteFileArgs extends WebdavConnectionConfig {
  path: string
}

/**
 * 创建目录参数
 */
interface CreateDirectoryArgs extends WebdavConnectionConfig {
  path: string
}

/**
 * 创建 WebDAV 客户端
 *
 * webdav 包近 2MB，且只有配置过 WebDAV 同步的用户才会触发；
 * 顶层 import 会把它钉进启动路径，所以延到第一次真正建连接时再加载。
 * 它是纯 ESM 包，必须用 `await import` 而不是 `require`。
 */
async function createWebdavClient(config: WebdavConnectionConfig): Promise<WebDAVClient> {
  const { createClient } = await import('webdav')
  return createClient(config.serverUrl, {
    username: config.username,
    password: config.password
  })
}

/**
 * 注册 WebDAV 相关的 IPC 处理函数
 */
export function registerWebdavIPC(): void {
  /**
   * 测试 WebDAV 连接
   */
  ipcMain.handle('webdav:testConnection', async (_, args: TestConnectionArgs) => {
    try {
      const client = await createWebdavClient(args)

      // 尝试获取根目录内容以验证连接
      await client.getDirectoryContents('/')

      return { success: true, data: { message: '连接成功' } }
    } catch (error) {
      console.error('WebDAV 连接测试失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '连接失败'
      }
    }
  })

  /**
   * 获取目录内容
   */
  ipcMain.handle('webdav:getDirectoryContents', async (_, args: GetDirectoryContentsArgs) => {
    try {
      const client = await createWebdavClient(args)
      const contents = (await client.getDirectoryContents(args.path)) as FileStat[]

      return {
        success: true,
        data: contents.map((item) => ({
          filename: item.filename,
          basename: item.basename,
          type: item.type,
          size: item.size,
          lastmod: item.lastmod
        }))
      }
    } catch (error) {
      console.error('获取 WebDAV 目录内容失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取目录内容失败'
      }
    }
  })

  /**
   * 上传文件
   */
  ipcMain.handle(
    'webdav:uploadFile',
    async (_, { serverUrl, username, password, remotePath, fileBuffer }: UploadFileArgs) => {
      try {
        const client = await createWebdavClient({ serverUrl, username, password })
        // 确保 fileBuffer 是 Buffer 类型
        const buffer = Buffer.from(fileBuffer)
        await client.putFileContents(remotePath, buffer)
        return { success: true }
      } catch (error: any) {
        console.error('WebDAV uploadFile error:', error)
        return { success: false, error: error.message }
      }
    }
  )

  /**
   * 下载文件
   */
  ipcMain.handle('webdav:downloadFile', async (_, args: DownloadFileArgs) => {
    try {
      const client = await createWebdavClient(args)
      const { remotePath } = args

      // 允许调用方直接指定保存路径；否则回退到保存对话框
      let localPath = args.savePath
      if (!localPath) {
        const result = await dialog.showSaveDialog({
          defaultPath: remotePath.split('/').pop() || 'download',
          title: mt('dialog.save')
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: '用户取消下载' }
        }
        localPath = result.filePath
      }

      // 确保目录存在
      mkdirSync(dirname(localPath), { recursive: true })

      // 下载文件
      const buffer = (await client.getFileContents(remotePath)) as Buffer
      const writeStream = createWriteStream(localPath)

      await new Promise<void>((resolve, reject) => {
        writeStream.write(buffer, (err) => {
          if (err) reject(err)
          else {
            writeStream.end()
            resolve()
          }
        })
      })

      return {
        success: true,
        data: { localPath }
      }
    } catch (error) {
      console.error('WebDAV 下载文件失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '下载文件失败'
      }
    }
  })

  /**
   * 删除文件或目录
   */
  ipcMain.handle('webdav:deleteFile', async (_, args: DeleteFileArgs) => {
    try {
      const client = await createWebdavClient(args)

      await client.deleteFile(args.path)

      return { success: true, data: { path: args.path } }
    } catch (error) {
      console.error('WebDAV 删除文件失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除文件失败'
      }
    }
  })

  /**
   * 创建目录
   */
  ipcMain.handle('webdav:createDirectory', async (_, args: CreateDirectoryArgs) => {
    try {
      const client = await createWebdavClient(args)
      await client.createDirectory(args.path)
      return { success: true, data: { path: args.path } }
    } catch (error) {
      console.error('WebDAV 创建目录失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '创建目录失败'
      }
    }
  })

  /**
   * 移动或重命名文件/目录
   */
  ipcMain.handle(
    'webdav:moveFile',
    async (_, args: WebdavConnectionConfig & { fromPath: string; toPath: string }) => {
      try {
        const client = await createWebdavClient(args)
        await client.moveFile(args.fromPath, args.toPath)
        return { success: true }
      } catch (error) {
        console.error('WebDAV 移动文件失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : '操作失败'
        }
      }
    }
  )
}
