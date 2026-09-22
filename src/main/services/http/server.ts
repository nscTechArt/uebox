/**
 * HTTP服务器
 */
import express, { Express, Request, Response, NextFunction } from 'express'
import cors from 'cors'
import multer from 'multer'
import * as path from 'path'
import * as fs from 'fs/promises'
import { Server } from 'http'
import { getAppWindows } from '../../appWindows'
import { isBrowserToolName } from '../../agent-v3/tools/toolNames'
// 只要类型，编译后不留 import —— agent-v3 那一大坨仍旧走下面的动态 import
import type { UnrealAgentTool } from '../../agent-v3/tools/defineTool'
import { logger } from '../logger'
import { config } from '../config'
import { TaskManager } from '../task/taskManager'
import { ConnectionManager } from '../websocket/connectionManager'
import { TaskStatus } from '../types'
import { getDatabase, getPublicDatabase } from '../../sqliteDataBase'
import { tableExists, getTableColumns } from '../../sqliteDataBase/dbUtils'
import { getSetting, setSetting } from '../../sqliteDataBase/models/settings'
import { executeUECommand } from '../../sqliteDataBase/ipc/ueCommandBridge'
import { createProjectTool } from '../../agent-v3/tools/adapted/project/projectTool'
import { runWithTargetConnectionId } from '../../agent-v3/core/projectTargetContext'

export interface HttpServerOptions {
  port?: number
  host?: string
  uploadDir?: string
  maxFileSize?: number
  corsOrigins?: string[]
}

interface ProfileSettings {
  nickname: string
  avatarUrl: string
}

/**
 * 评测时一律拒绝的工具：动用户本机磁盘、跑命令。
 *
 * 评测在真实工程上跑，不能让一次实验把用户的文件改了。引擎内的操作不在此列 ——
 * 那正是要考的能力，而且资产可以重建。
 */
const LOCAL_DISK_TOOLS = [
  'write_local_file',
  'edit_local_file',
  'run_shell_command',
  // 接第三方 MCP 同样落在这一类：stdio 形态就是拉一个用户机器上的进程，
  // 而且它会改盒子自己的配置 —— 评测跑完之后那台 server 还留在配置里
  'connect_mcp_server'
]

const PROFILE_SETTINGS_KEY = 'profile_settings'
const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  nickname: '',
  avatarUrl: ''
}
const MAX_NICKNAME_LENGTH = 32
const MAX_AVATAR_URL_LENGTH = 2048

export class HttpServer {
  private app: Express
  private server: Server | null = null
  private taskManager: TaskManager | null = null
  private connectionManager: ConnectionManager | null = null
  private options: Required<HttpServerOptions>
  private upload: multer.Multer

  constructor(options: HttpServerOptions = {}) {
    this.options = {
      port: options.port || config.http.port,
      host: options.host || config.http.host,
      uploadDir: options.uploadDir || config.http.uploadDir,
      maxFileSize: options.maxFileSize || config.http.maxFileSize,
      corsOrigins: options.corsOrigins || config.http.corsOrigins
    }

    this.app = express()
    this.upload = this.setupMulter()
    this.setupMiddleware()
    this.setupRoutes()
  }

  /**
   * 设置任务管理器
   */
  setTaskManager(taskManager: TaskManager): void {
    this.taskManager = taskManager
  }

  /**
   * 设置连接管理器
   */
  setConnectionManager(connectionManager: ConnectionManager): void {
    this.connectionManager = connectionManager
  }

  /**
   * 启动服务器
   */
  /**
   * 端口占用时的重试次数与间隔。
   *
   * 刚退出的上一个实例会让端口停留在 TIME_WAIT / 尚未释放，此时 listen 拿到
   * EADDRINUSE。而 `ServiceManager.start()` 在 HTTP 失败时会 `stop()` **所有**
   * 服务并抛出 —— 结果是应用窗口起来了，但 WebSocket 服务也一起没了，
   * 虚幻引擎永远连不上，界面上还没有任何提示。
   *
   * 用户「关掉再马上打开」就会踩到。等几秒重试一次即可，比让整个应用瘫掉好。
   */
  private static readonly BIND_RETRIES = 5
  private static readonly BIND_RETRY_DELAY_MS = 1500

  async start(): Promise<void> {
    for (let attempt = 1; attempt <= HttpServer.BIND_RETRIES; attempt++) {
      try {
        await this.listenOnce()
        return
      } catch (error) {
        const inUse = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        const last = attempt === HttpServer.BIND_RETRIES
        if (!inUse || last) {
          logger.error('HTTP服务器启动失败:', error)
          throw error
        }
        logger.warn(
          `HTTP 端口 ${this.options.port} 被占用（可能是上一个实例尚未退出），` +
            `${HttpServer.BIND_RETRY_DELAY_MS}ms 后重试（${attempt}/${HttpServer.BIND_RETRIES}）`
        )
        await new Promise((r) => setTimeout(r, HttpServer.BIND_RETRY_DELAY_MS))
      }
    }
  }

  /** 单次监听尝试。失败时把 server 清掉，否则重试会挂在一个坏实例上 */
  private listenOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const server = this.app.listen(this.options.port, this.options.host, () => {
          this.server = server
          logger.info(`HTTP服务器启动成功: http://${this.options.host}:${this.options.port}`)
          resolve()
        })

        server.on('error', (error) => {
          server.close()
          reject(error)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('HTTP服务器已停止')
          this.server = null
          resolve()
        })
      })
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus(): any {
    return {
      running: this.server !== null,
      port: this.options.port,
      host: this.options.host,
      uptime: this.server ? process.uptime() : 0
    }
  }

  /**
   * 设置Multer文件上传
   */
  private setupMulter(): multer.Multer {
    const storage = multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await fs.mkdir(this.options.uploadDir, { recursive: true })
          cb(null, this.options.uploadDir)
        } catch (error) {
          cb(error as Error, '')
        }
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9)
        const ext = path.extname(file.originalname)
        const name = path.basename(file.originalname, ext)
        cb(null, `${name}-${uniqueSuffix}${ext}`)
      }
    })

    return multer({
      storage,
      limits: {
        fileSize: this.options.maxFileSize
      },
      fileFilter: (_req, file, cb) => {
        // 基本的文件类型检查
        const allowedTypes = /\.(jpg|jpeg|png|gif|pdf|txt|doc|docx|zip|rar)$/i
        const isAllowed = allowedTypes.test(file.originalname)

        if (isAllowed) {
          cb(null, true)
        } else {
          cb(new Error('不支持的文件类型'))
        }
      }
    })
  }

  /**
   * 设置中间件
   */
  private setupMiddleware(): void {
    // CORS
    const origins = Array.isArray(this.options.corsOrigins)
      ? this.options.corsOrigins
      : [this.options.corsOrigins].filter(Boolean)
    const allowedOrigins = new Set(origins)
    this.app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || allowedOrigins.has(origin)) {
            callback(null, true)
            return
          }
          callback(new Error('Not allowed by CORS'))
        },
        credentials: true
      })
    )

    // JSON解析
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }))

    // 请求日志
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now()

      res.on('finish', () => {
        const duration = Date.now() - start
        logger.debug(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`)
      })

      next()
    })

    // 错误处理
    this.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error('HTTP服务器错误:', error)
      res.status(500).json({
        success: false,
        error: '服务器内部错误'
      })
    })
  }

  /**
   * 设置路由
   */
  private setupRoutes(): void {
    // 健康检查 - 同时支持两种路径
    this.app.get('/health', this.handleHealth.bind(this))
    this.app.get('/api/health', this.handleHealth.bind(this))

    // 系统信息
    this.app.get('/api/system/info', this.handleSystemInfo.bind(this))
    this.app.get('/api/system/stats', this.handleSystemStats.bind(this))

    // Personal settings
    this.app.get('/api/profile/settings', this.handleGetProfileSettings.bind(this))
    this.app.put('/api/profile/settings', this.handleUpdateProfileSettings.bind(this))

    // 任务管理
    this.app.get('/api/tasks', this.handleGetTasks.bind(this))
    this.app.get('/api/tasks/:id', this.handleGetTask.bind(this))
    this.app.post('/api/tasks', this.handleCreateTask.bind(this))
    this.app.put('/api/tasks/:id', this.handleUpdateTask.bind(this))
    this.app.delete('/api/tasks/:id', this.handleCancelTask.bind(this))

    // 文件上传 - 同时支持两种路径
    this.app.post('/api/upload', this.upload.single('file'), this.handleFileUpload.bind(this))
    this.app.post('/api/files/upload', this.upload.single('file'), this.handleFileUpload.bind(this))
    this.app.post(
      '/api/upload/multiple',
      this.upload.array('files', 10),
      this.handleMultipleFileUpload.bind(this)
    )
    this.app.post(
      '/api/files/upload/multiple',
      this.upload.array('files', 10),
      this.handleMultipleFileUpload.bind(this)
    )

    // 文件下载
    this.app.get('/api/download/:filename', this.handleFileDownload.bind(this))

    // WebSocket连接信息
    this.app.get('/api/websocket/connections', this.handleWebSocketConnections.bind(this))
    this.app.post('/api/debug/ue-command', this.handleDebugUeCommand.bind(this))
    this.app.post('/api/debug/project-manage', this.handleDebugProjectManage.bind(this))
    this.app.get('/api/debug/tools', this.handleDebugListTools.bind(this))
    this.app.post('/api/debug/tool', this.handleDebugRunTool.bind(this))
    this.app.post('/api/debug/agent', this.handleDebugRunAgent.bind(this))
    this.app.post('/api/debug/embed', this.handleDebugEmbed.bind(this))

    // 调试：数据库表存在性检查
    this.app.get('/api/debug/db', this.handleDbDebug.bind(this))

    // 404处理
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: '接口不存在'
      })
    })
  }

  /**
   * 健康检查
   */
  private async handleHealth(_req: Request, res: Response): Promise<void> {
    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: Date.now(),
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0'
      }
    })
  }

  /**
   * 系统信息
   */
  private async handleSystemInfo(_req: Request, res: Response): Promise<void> {
    try {
      const info = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        pid: process.pid
      }

      res.json({
        success: true,
        data: info
      })
    } catch (error) {
      logger.error('获取系统信息失败:', error)
      res.status(500).json({
        success: false,
        error: '获取系统信息失败'
      })
    }
  }

  /**
   * 系统统计
   */
  private async handleSystemStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = {
        tasks: this.taskManager
          ? {
              total: this.taskManager.getStats().total,
              running: this.taskManager.getStats().running,
              completed: this.taskManager.getStats().completed,
              failed: this.taskManager.getStats().failed
            }
          : null,
        websocket: this.connectionManager
          ? {
              connections: this.connectionManager.getConnectionCount(),
              activeConnections: this.connectionManager.getAllConnections().length
            }
          : null,
        http: {
          port: this.options.port,
          uptime: process.uptime()
        }
      }

      res.json({
        success: true,
        data: stats
      })
    } catch (error) {
      logger.error('获取系统统计失败:', error)
      res.status(500).json({
        success: false,
        error: '获取系统统计失败'
      })
    }
  }

  /**
   * 获取任务列表
   */
  private async handleGetTasks(req: Request, res: Response): Promise<void> {
    try {
      if (!this.taskManager) {
        res.status(503).json({
          success: false,
          error: '任务管理器未初始化'
        })
        return
      }

      const { status, type, limit = 50, offset = 0 } = req.query
      const tasks = this.taskManager.listTasks({
        status: status as TaskStatus,
        type: type as string,
        limit: Number(limit),
        offset: Number(offset)
      })

      res.json({
        success: true,
        data: {
          tasks,
          total: this.taskManager.getStats().total
        }
      })
    } catch (error) {
      logger.error('获取任务列表失败:', error)
      res.status(500).json({
        success: false,
        error: '获取任务列表失败'
      })
    }
  }

  /**
   * 获取单个任务
   */
  private async handleGetTask(req: Request, res: Response): Promise<void> {
    try {
      if (!this.taskManager) {
        res.status(503).json({
          success: false,
          error: '任务管理器未初始化'
        })
        return
      }

      const { id } = req.params
      const task = await this.taskManager.getTask(id)

      if (!task) {
        res.status(404).json({
          success: false,
          error: '任务不存在'
        })
        return
      }

      res.json({
        success: true,
        data: task
      })
    } catch (error) {
      logger.error('获取任务失败:', error)
      res.status(500).json({
        success: false,
        error: '获取任务失败'
      })
    }
  }

  /**
   * 创建任务
   */
  private async handleCreateTask(req: Request, res: Response): Promise<void> {
    try {
      if (!this.taskManager) {
        res.status(503).json({
          success: false,
          error: '任务管理器未初始化'
        })
        return
      }

      const { type, payload, priority } = req.body
      if (!type) {
        res.status(400).json({
          success: false,
          error: '缺少任务类型'
        })
        return
      }

      const taskId = await this.taskManager.createTask({
        type,
        payload,
        priority
      })

      res.status(201).json({
        success: true,
        data: { taskId }
      })
    } catch (error) {
      logger.error('创建任务失败:', error)
      res.status(500).json({
        success: false,
        error: '创建任务失败'
      })
    }
  }

  /**
   * 更新任务
   */
  private async handleUpdateTask(req: Request, res: Response): Promise<void> {
    try {
      if (!this.taskManager) {
        res.status(503).json({
          success: false,
          error: '任务管理器未初始化'
        })
        return
      }

      const { id } = req.params
      const updates = req.body

      const success = await this.taskManager.updateTask(id, updates)

      if (!success) {
        res.status(404).json({
          success: false,
          error: '任务不存在'
        })
        return
      }

      // 获取更新后的任务
      const task = this.taskManager.getTask(id)

      res.json({
        success: true,
        data: task
      })
    } catch (error) {
      logger.error('更新任务失败:', error)
      res.status(500).json({
        success: false,
        error: '更新任务失败'
      })
    }
  }

  /**
   * 取消任务
   */
  private async handleCancelTask(req: Request, res: Response): Promise<void> {
    try {
      if (!this.taskManager) {
        res.status(503).json({
          success: false,
          error: '任务管理器未初始化'
        })
        return
      }

      const { id } = req.params
      const success = await this.taskManager.cancelTask(id)

      if (!success) {
        res.status(404).json({
          success: false,
          error: '任务不存在或无法取消'
        })
        return
      }

      res.json({
        success: true,
        message: '任务已取消'
      })
    } catch (error) {
      logger.error('取消任务失败:', error)
      res.status(500).json({
        success: false,
        error: '取消任务失败'
      })
    }
  }

  /**
   * 文件上传
   */
  private async handleFileUpload(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: '没有上传文件'
        })
        return
      }

      const fileInfo = {
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        uploadTime: Date.now()
      }

      logger.info('文件上传成功:', fileInfo)

      res.json({
        success: true,
        data: fileInfo
      })
    } catch (error) {
      logger.error('文件上传失败:', error)
      res.status(500).json({
        success: false,
        error: '文件上传失败'
      })
    }
  }

  /**
   * 多文件上传
   */
  private async handleMultipleFileUpload(req: Request, res: Response): Promise<void> {
    try {
      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({
          success: false,
          error: '没有上传文件'
        })
        return
      }

      const files = req.files as Express.Multer.File[]

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: '没有上传文件'
        })
        return
      }

      const fileInfos = files.map((file) => ({
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        path: file.path,
        uploadTime: Date.now()
      }))

      logger.info(`批量文件上传成功: ${files.length} 个文件`)

      res.json({
        success: true,
        data: {
          files: fileInfos,
          count: files.length
        }
      })
    } catch (error) {
      logger.error('批量文件上传失败:', error)
      res.status(500).json({
        success: false,
        error: '批量文件上传失败'
      })
    }
  }

  /**
   * 文件下载
   */
  private async handleFileDownload(req: Request, res: Response): Promise<void> {
    try {
      const { filename } = req.params
      const filePath = path.join(this.options.uploadDir, filename)

      try {
        await fs.access(filePath)
      } catch {
        res.status(404).json({
          success: false,
          error: '文件不存在'
        })
        return
      }

      res.download(filePath, (error) => {
        if (error) {
          logger.error('文件下载失败:', error)
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: '文件下载失败'
            })
          }
        }
      })
    } catch (error) {
      logger.error('文件下载处理失败:', error)
      res.status(500).json({
        success: false,
        error: '文件下载处理失败'
      })
    }
  }

  /**
   * WebSocket连接信息
   */
  private async handleWebSocketConnections(_req: Request, res: Response): Promise<void> {
    try {
      if (!this.connectionManager) {
        res.status(503).json({
          success: false,
          error: '连接管理器未初始化'
        })
        return
      }

      const connections = this.connectionManager.getAllConnections().map((conn) => ({
        id: conn.id,
        connectedAt: conn.connectedAt,
        lastHeartbeat: conn.lastHeartbeat
      }))

      res.json({
        success: true,
        data: {
          connections,
          total: connections.length
        }
      })
    } catch (error) {
      logger.error('获取WebSocket连接信息失败:', error)
      res.status(500).json({
        success: false,
        error: '获取连接信息失败'
      })
    }
  }

  /**
   * 列出 agent-v3 注册表里的全部工具。
   *
   * 和 `/api/debug/ue-command` 的区别是**层次**：那个直连插件发裸 RPC，
   * 验的是引擎侧；这个走工具层，验的是模型真正会调的那一层 ——
   * 参数拼装、默认值、响应解析、错误措辞全在这一层，
   * 「能跑但效果不对」基本都藏在这里。
   */
  /**
   * 调试端点用的 sender。
   *
   * 有些工具（笔记增删改）要给渲染层发变更通知，拿不到 `sender` 就
   * **整个不注册** —— 于是这个端点里它们根本不存在，5 个笔记工具只看得见 2 个，
   * 剩下 3 个无从验证。把主窗口的 webContents 传进去，验证覆盖面才和
   * 真实会话一致。
   *
   * 没有窗口时返回 undefined，行为退回原样（少几个工具，但不报错）。
   */
  private debugSender(): Electron.WebContents | undefined {
    // 走 getAppWindows()：Agent 浏览器窗口也在 getAllWindows() 里，
    // 而给一个远程网页发盒子的 IPC 没有任何意义
    const win = getAppWindows()[0]
    return win?.webContents
  }

  private async handleDebugListTools(req: Request, res: Response): Promise<void> {
    if (!this.isLoopbackRequest(req)) {
      res.status(403).json({ success: false, error: 'Debug endpoint is local-only' })
      return
    }

    try {
      const { buildAllTools } = await import('../../agent-v3/tools/registry')
      res.json({
        success: true,
        data: buildAllTools({ ...(this.debugSender() ? { sender: this.debugSender()! } : {}) }).map(
          (tool) => ({
            name: tool.name,
            namespace: tool.unrealBox.namespace,
            risk: tool.unrealBox.risk,
            // 描述是**模型唯一用来选工具的东西**，不给它这个接口就只能回答
            // 「参数长什么样」，回答不了「模型会不会选错」。
            //
            // 而描述又不能靠读源码扒：一半的工具在 registry.ts 里只登记名字，
            // 描述写在各自的工厂函数里，正则抓不全 —— 抓不全的清单拿去做审计，
            // 会把「我没抓到」误判成「它没有」。
            description: tool.description,
            parameters: tool.parameters
          })
        )
      })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  /** 按名字执行一个 agent-v3 工具。只走回环，供真机验证脚手架使用 */
  private async handleDebugRunTool(req: Request, res: Response): Promise<void> {
    if (!this.isLoopbackRequest(req)) {
      res.status(403).json({ success: false, error: 'Debug endpoint is local-only' })
      return
    }

    const name = typeof req.body?.name === 'string' ? req.body.name : ''
    /*
     * 默认不等长任务 —— 但**只对真有这个参数的工具**加，见下面 `wantsWaitSeconds`。
     *
     * `project_manage` 的 `open_project` 会一直等到新编辑器真的能接命令
     * （默认 180 秒），那对 agent 是对的 —— 用户能按停止，模型也在等结果。
     * 这个端点两样都没有：一个 HTTP 请求挂三分钟、还掐不断。
     * 所以这里替它把默认改成「不等」，调用方要等就自己在 args 里写 waitSeconds。
     *
     * 2026-09-17 修：原来是无条件塞进**每个**工具的 args。而绝大多数工具的
     * schema 是 strict 的，于是它们一律被 `unrecognized_keys: ["waitSeconds"]` 拒掉 ——
     * 这个端点对除 `project_manage` 以外的工具**一直是坏的**，而且坏得很安静：
     * 调用方拿到的是 `success: false`，`ue-task-eval` 的 `tool()` 把它转成 `null`，
     * 判定里 `got?.actors ?? []` 于是变成空数组，报「实际 0 个」。
     * E3 那条用例因此稳定判失败，而模型每次都把八个灯摆对了。
     */
    const args: Record<string, unknown> =
      req.body?.args && typeof req.body.args === 'object'
        ? { ...(req.body.args as Record<string, unknown>) }
        : {}
    if (!name) {
      res.status(400).json({ success: false, error: 'Missing required field: name' })
      return
    }

    try {
      // 浏览器工具永远走不到这条路。
      //
      // 它们本来就不在 `buildAllTools()` 里（构造点收在 resolveTools），这里
      // 是第二道闸：这个端点直接 execute，不经审批门 —— 而浏览器带着用户真实的
      // 登录态，评测脚手架不该能打开网站或点页面。
      if (isBrowserToolName(name)) {
        res.status(403).json({
          success: false,
          error: `${name} 需要用户逐次审批，不能从调试接口执行`
        })
        return
      }

      const { buildAllTools } = await import('../../agent-v3/tools/registry')
      const tool = buildAllTools({
        ...(this.debugSender() ? { sender: this.debugSender()! } : {})
      }).find((t) => t.name === name)
      if (!tool) {
        res.status(404).json({ success: false, error: `Unknown tool: ${name}` })
        return
      }

      // 只有声明了 waitSeconds 的工具才给默认值。照着工具自己的 schema 判，
      // 而不是维护一份会过期的工具名单。
      const schema = tool.parameters as { properties?: Record<string, unknown> } | undefined
      if (
        schema?.properties &&
        Object.prototype.hasOwnProperty.call(schema.properties, 'waitSeconds') &&
        !Object.prototype.hasOwnProperty.call(args, 'waitSeconds')
      ) {
        args.waitSeconds = 0
      }

      const started = Date.now()

      // 目标工程要能从外面指定。
      //
      // UE 工具的目标连接来自 AsyncLocalStorage（`projectTargetContext`），
      // 由会话的工程作用域设进去，**不是工具参数**。这个端点原来没有设过，
      // 于是同时连着多个工程时 `pickDefaultConnectionId` 拒绝猜测，一律报
      // 「没有可用的客户端连接」。开发机上同时开着两三个编辑器是常态，
      // 那时这个端点对所有 UE 工具都是废的。
      //
      // 更要紧的是**不指定就没法保证写到哪个工程**。评测要在一次性副本上跑
      // 写操作，用户的真实工程往往就在旁边连着 —— 猜错一次就是不可还原的损失。
      const target =
        typeof req.body?.connectionId === 'string' || typeof req.body?.projectPath === 'string'
          ? {
              ...(typeof req.body.connectionId === 'string'
                ? { connectionId: req.body.connectionId }
                : {}),
              ...(typeof req.body.projectPath === 'string'
                ? { projectPath: req.body.projectPath }
                : {})
            }
          : undefined
      const result = await runWithTargetConnectionId(target, () =>
        tool.execute(`debug-${started}`, args)
      )
      res.json({ success: true, data: result, elapsedMs: Date.now() - started })
    } catch (error) {
      // 工具用抛异常表达失败（见 defineTool），所以这里 400 才是「工具报错」，
      // 不是脚手架坏了 —— 验证脚本要能区分这两者
      res.status(400).json({
        success: false,
        error: (error as Error).message,
        name: (error as Error).name
      })
    }
  }

  /**
   * 用用户配的向量化模型给一批文本取向量。只走回环，供工具预检索台架
   * （`tests/manual/tool-rag-retriever.mjs`）建索引 —— 台架在主进程外面，
   * 拿不到密钥，只能借这条路。`task` 是 `query` / `document`，非对称检索模型上
   * 传错了不报错只是搜不准，所以由调用方明说。
   */
  private async handleDebugEmbed(req: Request, res: Response): Promise<void> {
    if (!this.isLoopbackRequest(req)) {
      res.status(403).json({ success: false, error: 'Debug endpoint is local-only' })
      return
    }
    const inputs: string[] = Array.isArray(req.body?.inputs)
      ? req.body.inputs.filter((n: unknown) => typeof n === 'string')
      : []
    const task = req.body?.task === 'query' ? 'query' : 'document'
    try {
      const { embedTexts } = await import('../../ai/embedding')
      const vectors = await embedTexts(inputs, task)
      res.json({ success: true, data: vectors })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  /**
   * 让**模型自己**跑一整个任务，返回完整事件轨迹。
   *
   * 与 `/api/debug/tool` 的区别是根本性的：那个直接调工具，模型不在回路里。
   * 逐个工具调通不等于 agent 能干活 —— 模型选错工具、参数拼错、
   * 失败后不会换路子，这些都只有让它自己跑才暴露得出来。
   *
   * 任务级验证需要的正是这条路径：给一句自然语言，看它做成没有、
   * 走了几步、错在哪。
   */
  private async handleDebugRunAgent(req: Request, res: Response): Promise<void> {
    if (!this.isLoopbackRequest(req)) {
      res.status(403).json({ success: false, error: 'Debug endpoint is local-only' })
      return
    }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : ''
    if (!prompt) {
      res.status(400).json({ success: false, error: 'Missing required field: prompt' })
      return
    }

    const sessionId =
      typeof req.body?.sessionId === 'string' ? req.body.sessionId : `eval-${Date.now()}`
    const timeoutMs = typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : 300_000
    // 工具调用上限。跑飞的 agent 会一直转，而「跑了多远才卡住」比
    // 「转了一小时」有信息量得多 —— 到顶就停，把进度如实记下来
    const maxToolCalls =
      typeof req.body?.maxToolCalls === 'number' ? req.body.maxToolCalls : Infinity

    /*
     * 下面这一组全是**工具选择台架**的开关（`tests/manual/tool-rag-bench.mjs`），
     * 产品路径一个都不传。它们存在的理由见
     *
     * `stubTools`：引擎工具和写操作不真跑（见下面的 `wrapTools`）。
     * `facts`：桩的返回里回显的题面事实。
     * `hideTools`：按名字藏掉一批工具 —— harness 侧预检索那一臂用它把
     *   「这道题没检索到的」藏起来。
     * `haltOnFirstDomainCall` + `neutralTools`：第一个「领域动作」出手就收工。
     *   桩返回什么模型根本看不到，所以「伸向哪个工具」这个判据不受桩影响。
     *   中立工具（开工前问一句「现在是什么工程」）既不算答案也不收工。
     * `model`：钉死 provider/model，否则界面上换个模型两臂就不可比。
     */
    const stubTools = req.body?.stubTools === true
    const facts: string[] = Array.isArray(req.body?.facts)
      ? req.body.facts.filter((n: unknown) => typeof n === 'string')
      : []
    const hideTools: string[] = Array.isArray(req.body?.hideTools)
      ? req.body.hideTools.filter((n: unknown) => typeof n === 'string')
      : []
    const haltOnFirstDomainCall = req.body?.haltOnFirstDomainCall === true
    const neutralTools: string[] = Array.isArray(req.body?.neutralTools)
      ? req.body.neutralTools.filter((n: unknown) => typeof n === 'string')
      : []
    const isNeutral = (name: string): boolean => neutralTools.includes(name)
    const pin =
      typeof req.body?.model?.providerId === 'string' &&
      typeof req.body?.model?.modelId === 'string'
        ? { providerId: req.body.model.providerId, modelId: req.body.model.modelId }
        : undefined

    try {
      const { createUnrealAgent } = await import('../../agent-v3/core/createAgent')
      const { serviceManager } = await import('../../services')
      const { isShellAvailable } = await import('../../agent-v3/tools/builtin/localShell')
      const { TranscriptStore, loadTranscript } = await import(
        '../../agent-v3/core/transcriptStore'
      )
      const { ensureConnected } = await import('../../agent-v3/capabilities/mcp')
      const { currentMainLanguage } = await import('../../i18n')

      /*
       * 台架要量的是「155 个工具摆在面前挑不挑得准」，那就得**先有那 155 个**——
       * 而 `ue.*` 那一百来个只在引擎连着时才注册。
       *
       * 所以允许假装连着，但**只在空跑时**：`stubTools` 关着的话，
       * 假装连上等于让一串工具对着不存在的引擎发 RPC，模型还会照着环境块
       * 一口咬定工程开着 —— 那不是台架，那是造一个假现场。
       */
      const ueConnected =
        stubTools && req.body?.assumeUeConnected === true
          ? true
          : serviceManager.getWebSocketService().getConnectionCount() > 0
      // 和 IPC 那条路保持一致：评测里的 agent 也要拿到用户配的 MCP server
      // 及其连接状态。少了它，任何和 MCP 有关的回归在评测里都看不见。
      const mcp = await ensureConnected()
      const blockedApprovals: Array<{ tool: string; args: unknown }> = []
      let hitToolCap = false
      /** 因为「第一个领域动作出手了」而收工时，收在哪个工具上 */
      let haltedAt: string | undefined
      /**
       * 收工那一刻已经记下几条模型错误。
       *
       * 收工之后 pi 还会因为 abort 再落一条，那条是预期的、不算数；
       * 收工**之前**就有的才是真的厂商故障。分不开的话，一次 500 撞上收工
       * 会被当成一条干净样本统计进去，而 A/B 的结论正是逐样本算出来的。
       */
      let errorsAtHalt = 0
      const sender = getAppWindows()[0]?.webContents

      /*
       * 台架对工具池的两手：藏一批、把会动东西的换成空跑的桩。
       *
       * 都写在这里而不是 `SessionContext` 上 —— 这两件事只有本机调试端点会做，
       * 塞进会话上下文的话，以后每一个改工具装配的人都要先读懂三个产品路径
       * 永远不传的字段。`wrapTools` 是那边留的通用接缝，判据归调用方。
       *
       * 用黑名单而不是白名单：会话现造的那些（`ask_user`、`task`、`load_skill`……）
       * 名字台架事先不知道，白名单会把它们一起滤掉，两臂就不再只差「被藏的那批」。
       *
       * 只桩一半是有教训的：全桩掉的话模型读到桩会识破（「that's not a real
       * result」）然后转去 shell 自己找，量到的是墙不是它的选择。
       */
      const hidden = new Set(hideTools)
      const wrapTools =
        hideTools.length || stubTools
          ? (list: UnrealAgentTool<never>[]): UnrealAgentTool<never>[] =>
              list
                .filter((tool) => !hidden.has(tool.name))
                .map((tool) => {
                  const stub =
                    stubTools &&
                    (tool.unrealBox.namespace.startsWith('ue.') || tool.unrealBox.risk !== 'safe')
                  if (!stub) return tool
                  return {
                    ...tool,
                    execute: async () => ({
                      content: [
                        {
                          type: 'text' as const,
                          // 明说是台架，别让模型以为是工具坏了 —— 那会把它推去兜底
                          // （改用 Python / shell 绕过去），而兜底率正是实验的护栏指标之一。
                          // 回显题面里的事实：模型要的是「列出来」，不是一句「都在」。
                          text:
                            `(台架空跑) ${tool.name} 已记录，本次不执行。假定它成功了，继续下一步。` +
                            (facts.length ? ` 已确认存在：${facts.join('、')}。` : '')
                        }
                      ],
                      details: undefined as never
                    })
                  }
                })
          : undefined

      const { agent, selection, tools, toolSearchEnabled } = await createUnrealAgent({
        sessionId,
        ...(typeof req.body.toolSearchEnabled === 'boolean'
          ? { toolSearchEnabled: req.body.toolSearchEnabled }
          : {}),
        // 推理档位。调试端点原先不透传它，于是台架只能跑模型的默认档，
        // 而「换个推理档还会不会错」正是判断问题出在模型还是工具上的第一问。
        // 端点比 agent 窄，测出来的就不是 agent 的能力。
        ...(typeof req.body.thinkingLevel === 'string'
          ? { thinkingLevel: req.body.thinkingLevel as never }
          : {}),
        ueConnected,
        shellAvailable: await isShellAvailable(),
        // 台架也要拿到界面语言：语言准则那条按它分叉，端点少传一个字段，
        // 台架上跑出来的提示词就不是用户那份（同 `thinkingLevel` 的道理）
        uiLanguage: currentMainLanguage(),
        modelRequest: { role: 'agent', agentType: 'agent-v3', ...(pin ? { pin } : {}) },
        ...(wrapTools ? { wrapTools } : {}),
        // 评测跑在真实工程上，所以**不能**用 yolo。
        //
        // 第一版没传 requestApproval（等同全放行），结果「把引擎升级到 5.6」
        // 这个本该被拒绝的请求，让模型改掉了用户的 .uproject 和两个
        // Target.cs —— 而那个工程不在 git 下，没有任何东西能自动还原。
        // 复现了两次，不是偶然。
        //
        // 现在：引擎内的操作照常放行（那是评测要考的东西，且资产可以重建），
        // **动本机磁盘和跑命令一律拒绝**并记录。拒绝的理由写给模型看，
        // 让它据此换路子，这样既跑得下去，又不会把测试代价转嫁到用户工程上。
        approvalMode: 'ask',
        requestApproval: async (request) => {
          // 浏览器工具在这条路上根本不该出现（`resolveTools` 认的是「有没有
          // 真实审批 UI」，而这里只是个自动点头的函数），但闸门要按最坏情况写：
          // 一旦出现就拒绝并记账，绝不 auto-approve —— 它带着用户真实的登录态。
          if (LOCAL_DISK_TOOLS.includes(request.toolName) || isBrowserToolName(request.toolName)) {
            blockedApprovals.push({ tool: request.toolName, args: request.args })
            return 'reject'
          }
          return 'approve'
        },
        mcp,
        ...(sender ? { sender } : {})
      })

      // `response` 是这次调用出自**第几次模型响应**（`steps` 就是已完成的 turn 数，
      // 而 pi 的一个 turn 就是一次模型响应加它的工具执行）。
      //
      // 少了它，「先读技能再动手」判不准：模型可以在**同一次回答**里同时派出
      // `load_skill` 和业务调用，运行时依次执行，调用顺序完全正确 ——
      // 但业务调用的参数在那一刻已经生成完了，它根本没读到技能正文。
      // 只看顺序会把这种情况判成通过。`load_skill` 默认 `concurrency: 'parallel'`，
      // 这条路径是被允许的。
      const toolCalls: Array<{
        toolCallId: string
        name: string
        args: unknown
        response: number
        isError?: boolean
        result?: string
      }> = []
      // 按 toolCallId 索引，**不能按工具名找**。
      //
      // pi 的工具执行默认是 parallel，`tool_execution_end` 按**完成顺序**发
      // （见 pi-agent-core 的 types.d.ts）。原来这里 `[...toolCalls].reverse()
      // .find(c => c.name === event.toolName)` 总是命中最后一条同名调用：
      // 三次并发 web_search 的结果会全写进同一条，另外两条留下"没有结果"，
      // 而评测那边把"没有结果"当成样本不完整 —— 一条干净的样本就这样被判废了。
      // 真实会话记录里那三次搜索其实都有结果。
      const callsById = new Map<string, (typeof toolCalls)[number]>()
      const texts: string[] = []
      const errors: string[] = []
      let steps = 0
      /*
       * 逐次模型响应的 token 用量，**分缓存读/写记**。台架顺带记成本，
       * 汇总放 `usage`，逐轮放 `usageByTurn`（汇总看不见「第几轮重写了一次前缀」）。
       */
      const usageByTurn: Array<{
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
      }> = []
      agent.subscribe((event) => {
        switch (event.type) {
          case 'tool_execution_start':
            {
              const entry = {
                toolCallId: event.toolCallId,
                name: event.toolName,
                args: event.args,
                response: steps
              }
              toolCalls.push(entry)
              callsById.set(event.toolCallId, entry)
            }
            if (toolCalls.length > maxToolCalls) {
              hitToolCap = true
              agent.abort()
            } else if (haltOnFirstDomainCall && !isNeutral(event.toolName)) {
              // 第一手已经记下了，这一轮问完了。这里 abort **不会**漏掉这次调用：
              // 它已经进了 `toolCalls`，而工具本身是桩，跑不跑都没有副作用。
              haltedAt = event.toolName
              errorsAtHalt = errors.length
              agent.abort()
            }
            break
          case 'tool_execution_end': {
            const entry = callsById.get(event.toolCallId)
            if (entry) {
              entry.isError = event.isError
              const content = (event.result as { content?: Array<{ type: string; text?: string }> })
                ?.content
              entry.result = (content ?? [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join('\n')
                .slice(0, 400)
            }
            break
          }
          case 'turn_end':
            steps++
            break
          case 'message_end': {
            const message = event.message as {
              role?: string
              stopReason?: string
              errorMessage?: string
              usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
            }
            if (message?.role !== 'assistant') break
            if (message.usage) {
              usageByTurn.push({
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                cacheWrite: message.usage.cacheWrite
              })
            }
            if (message.stopReason === 'error') {
              errors.push(message.errorMessage || '模型调用失败，未返回原因')
              break
            }
            const content = (event.message as { content?: unknown }).content
            if (typeof content === 'string') texts.push(content)
            else if (Array.isArray(content)) {
              texts.push(
                content
                  .filter((b) => (b as { type?: string }).type === 'text')
                  .map((b) => (b as { text?: string }).text ?? '')
                  .join('')
              )
            }
            break
          }
        }
      })

      // 恢复同一 sessionId 之前的对话，并在每轮结束后落盘 ——
      // 和 `agent-v3:execute` 走同一套。
      //
      // 不做这件事的话，同一个 sessionId 连发两句得到的是**两段互不相干的
      // 对话**，多轮用例（「做个门」→「不对，往外开」）等于什么都没测，
      // 还会显得通过了。评测路径必须和真实路径一致，否则测的不是产品。
      const store = new TranscriptStore(sessionId)
      const previous = await loadTranscript(sessionId)
      if (previous.length > 0) {
        agent.state.messages = previous
        store.markPersisted(previous.length)
      }
      agent.subscribe(async (event) => {
        if (event.type === 'turn_end' || event.type === 'agent_end') {
          await store.append(agent.state.messages)
        }
      })

      const started = Date.now()
      // 超时必须能真的把它停下来。跑飞的 agent 会一直占着引擎连接，
      // 后面每个用例都跟着废掉
      const timer = setTimeout(() => agent.abort(), timeoutMs)
      const { runWithLockOwner, releaseAll } = await import('../../agent-v3/core/assetLock')
      try {
        // 和 IPC 那条路一致：评测里的 agent 也要带锁主，否则它跟真实会话
        // 抢同一个资产时不会被拦，而评测正是最容易跟人撞车的场景
        await runWithLockOwner(sessionId, () => agent.prompt(prompt))
      } finally {
        clearTimeout(timer)
        releaseAll(sessionId)
      }

      res.json({
        /*
         * 主动收工不算失败。
         *
         * `haltOnFirstDomainCall` 走的是 `agent.abort()`，于是 pi 把这一轮标成
         * 中断、`errorMessage` 有值 —— 而那正是**预期的正常结束**。不在这里
         * 分开的话，每一条成功记下第一手的样本都会被判成 `model-error` 扔掉。
         *
         * 但「收工」不等于「这一轮没出过错」：收工**之前**就落下的模型错误是真的
         * （厂商 500 撞上收工），照样得判失败，否则 `tool-choice-verdict.mjs` 那条
         * `success === false && errors.length > 0` 认不出来，一条被厂商故障污染的
         * 样本会当成干净的第一手统计进 A/B。
         */
        success: haltedAt ? errorsAtHalt === 0 : !agent.state.errorMessage,
        sessionId,
        model: `${selection.providerId}/${selection.modelId}`,
        toolCount: tools.length,
        toolSearchEnabled,
        // 数量答不了「那个工具在不在池里」—— 两份同样大小的工具池内容可以完全不同。
        // 评测要判「模型本来有没有直接动手的选项」，只能逐个名字核对。
        toolNames: tools.map((tool) => tool.name),
        stubTools,
        hiddenCount: hideTools.length,
        usage: usageByTurn.reduce(
          (acc, u) => ({
            input: acc.input + u.input,
            output: acc.output + u.output,
            cacheRead: acc.cacheRead + u.cacheRead,
            cacheWrite: acc.cacheWrite + u.cacheWrite
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        ),
        usageByTurn,
        ueConnected,
        steps,
        restoredMessages: previous.length,
        hitToolCap,
        // 收工是因为第一手已经出了（正常结束），还是因为模型自己讲完了（没出手）
        haltedAt: haltedAt ?? null,
        elapsedMs: Date.now() - started,
        text: texts.filter(Boolean).join('\n').slice(0, 4000),
        toolCalls,
        // 被拦下的写盘 / 跑命令。空数组才是干净的一轮 ——
        // 非空说明模型试图动用户本机文件，即便任务本身做成了也要当回事
        blockedApprovals,
        errors:
          agent.state.errorMessage && !haltedAt ? [...errors, agent.state.errorMessage] : errors
      })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private isLoopbackRequest(req: Request): boolean {
    const remoteAddress = req.socket.remoteAddress || ''
    const requestIp = req.ip || ''
    return (
      remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1' ||
      requestIp === '127.0.0.1' ||
      requestIp === '::1' ||
      requestIp === '::ffff:127.0.0.1'
    )
  }

  private async handleDebugUeCommand(req: Request, res: Response): Promise<void> {
    try {
      if (!this.isLoopbackRequest(req)) {
        res.status(403).json({
          success: false,
          error: 'Debug UE command endpoint is restricted to local requests'
        })
        return
      }

      const command = typeof req.body?.command === 'string' ? req.body.command.trim() : ''
      const params =
        req.body?.params && typeof req.body.params === 'object' && !Array.isArray(req.body.params)
          ? req.body.params
          : {}

      if (!command) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: command'
        })
        return
      }

      const result = await executeUECommand({
        command,
        params: params as Record<string, unknown>,
        projectPath: typeof req.body?.projectPath === 'string' ? req.body.projectPath : undefined
      })

      res.status(result.success ? 200 : 400).json(result)
    } catch (error) {
      logger.error('Debug UE command failed:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async handleDebugProjectManage(req: Request, res: Response): Promise<void> {
    try {
      if (!this.isLoopbackRequest(req)) {
        res.status(403).json({
          success: false,
          error: 'Debug project manage endpoint is restricted to local requests'
        })
        return
      }

      const input =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : null

      if (!input?.action || typeof input.action !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Missing required field: action'
        })
        return
      }

      const projectTool = createProjectTool() as {
        execute?: (args: Record<string, unknown>) => Promise<unknown>
      }

      if (!projectTool.execute) {
        res.status(500).json({
          success: false,
          error: 'Project management tool is not executable'
        })
        return
      }

      // 同 `/api/debug/tool`：默认不等 `open_project` 那 180 秒，
      // 一个掐不断的 HTTP 请求不该挂三分钟。要等就自己传 waitSeconds
      const result = await projectTool.execute({ waitSeconds: 0, ...input })
      const success = !(
        result &&
        typeof result === 'object' &&
        'success' in result &&
        result.success === false
      )
      res.status(success ? 200 : 400).json(result)
    } catch (error) {
      logger.error('Debug project manage failed:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private normalizeProfileSettings(settings?: Partial<ProfileSettings> | null): ProfileSettings {
    return {
      nickname: typeof settings?.nickname === 'string' ? settings.nickname : '',
      avatarUrl: typeof settings?.avatarUrl === 'string' ? settings.avatarUrl : ''
    }
  }

  private async handleGetProfileSettings(_req: Request, res: Response): Promise<void> {
    try {
      const db = getPublicDatabase()
      const stored = getSetting<ProfileSettings>(db, PROFILE_SETTINGS_KEY, DEFAULT_PROFILE_SETTINGS)
      res.json({
        success: true,
        data: this.normalizeProfileSettings(stored)
      })
    } catch (error) {
      logger.error('Failed to load profile settings:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to load profile settings'
      })
    }
  }

  private async handleUpdateProfileSettings(req: Request, res: Response): Promise<void> {
    try {
      const db = getPublicDatabase()
      const stored = getSetting<ProfileSettings>(db, PROFILE_SETTINGS_KEY, DEFAULT_PROFILE_SETTINGS)
      const current = this.normalizeProfileSettings(stored)
      const payload = (req.body || {}) as Partial<ProfileSettings>
      const next: ProfileSettings = { ...current }

      if (typeof payload.nickname === 'string') {
        const nickname = payload.nickname.trim()
        if (nickname.length > MAX_NICKNAME_LENGTH) {
          res.status(400).json({
            success: false,
            error: `Nickname must be ${MAX_NICKNAME_LENGTH} characters or less`
          })
          return
        }
        next.nickname = nickname
      }

      if (typeof payload.avatarUrl === 'string') {
        const avatarUrl = payload.avatarUrl.trim()
        if (avatarUrl.length > MAX_AVATAR_URL_LENGTH) {
          res.status(400).json({
            success: false,
            error: `Avatar URL must be ${MAX_AVATAR_URL_LENGTH} characters or less`
          })
          return
        }
        next.avatarUrl = avatarUrl
      }

      setSetting(db, PROFILE_SETTINGS_KEY, next)

      res.json({
        success: true,
        data: next
      })
    } catch (error) {
      logger.error('Failed to update profile settings:', error)
      res.status(500).json({
        success: false,
        error: 'Failed to update profile settings'
      })
    }
  }

  private handleDbDebug(_req: Request, res: Response): void {
    try {
      const db = getDatabase()
      // 调试端点只报「表在不在、有哪些列」。3D 生成那两张表随生成能力一起移出了
      // 公开核心，这里改看资产库自己的表。
      const tables: Record<string, { exists: boolean; columns: string[] }> = {}
      for (const name of ['assets', 'tags', 'vaults']) {
        const exists = tableExists(db, name)
        tables[name] = { exists, columns: exists ? getTableColumns(db, name) : [] }
      }

      res.json({ success: true, tables })
    } catch (error) {
      logger.error('DB调试端点错误:', error)
      res.status(500).json({ success: false, error: 'DB debug failed' })
    }
  }
}
