import dotenv from 'dotenv'
import { app } from 'electron'
import { join } from 'path'

/**
 * 获取环境变量文件的正确路径
 * 开发环境：从项目根目录加载
 * 生产环境：从打包后的应用目录加载
 */
function getEnvFilePath(filename: string): string {
  // app.isPackaged 可以判断是否为打包后的应用
  if (app.isPackaged) {
    // 打包后，文件在 app.asar 的根目录
    return join(app.getAppPath(), filename)
  }
  // 开发环境，使用当前工作目录（项目根目录）
  return filename
}

// 优先加载 .env（基础），再加载 .env.<NODE_ENV>（覆盖），保证环境专用配置覆盖基础配置
// 生产环境强制加载 .env.production
const envFile =
  app.isPackaged || process.env.NODE_ENV === 'production'
    ? '.env.production'
    : `.env.${process.env.NODE_ENV || 'development'}`

dotenv.config({ path: getEnvFilePath('.env') })
dotenv.config({ path: getEnvFilePath(envFile), override: true })

// 调试日志：确认环境变量加载情况
console.log(`[Config] 环境变量文件: ${getEnvFilePath(envFile)}`)
console.log(`[Config] app.isPackaged: ${app.isPackaged}`)
/**
 * 服务配置管理
 */
import { ServiceConfig } from './types'

// 默认配置
const DEFAULT_CONFIG: ServiceConfig = {
  http: {
    port: 8766,
    host: '127.0.0.1',
    uploadDir: './uploads',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
    // 默认关闭：这个本地服务器现在只剩一组 debug 路由（跑工具、跑 Agent、导数据库），
    // 而它们没有任何鉴权。UE 插件用的是 WebSocket(17860)，渲染进程也不访问 8766。
    // 需要时用 HTTP_ENABLED=true 打开（pnpm dev:smoke 已经这么做了）。
    enabled: false,
    cors: {
      origin: ['http://localhost:3000', 'http://localhost:5173'],
      credentials: true
    },
    authToken: undefined
  },
  websocket: {
    port: 17860,
    heartbeatInterval: 15000, // 15秒
    heartbeatTimeout: 45000 // 45秒
  },
  ws: {
    port: 17860,
    heartbeatInterval: 15000, // 15秒
    heartbeatTimeout: 45000 // 45秒
  },
  queue: {
    inboundCapacity: 4096,
    outboundCapacity: 4096
  },
  task: {
    defaultTimeoutSec: 180, // 3分钟
    maxConcurrent: 5
  },
  logging: {
    level: 'info'
  },
  message: {
    maxBytes: 524288 // 512KB
  }
}

// 从环境变量获取配置值
function getEnvValue(key: string, defaultValue: any): any {
  const value = process.env[key]
  if (value === undefined) {
    return defaultValue
  }

  // 尝试解析为数字
  const numValue = Number(value)
  if (!isNaN(numValue)) {
    return numValue
  }

  // 尝试解析为布尔值
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false

  return value
}

// 加载配置
function loadConfig(): ServiceConfig {
  return {
    ws: {
      port: getEnvValue('WS_PORT', DEFAULT_CONFIG.ws.port),
      heartbeatInterval: getEnvValue('WS_HEARTBEAT_INTERVAL', DEFAULT_CONFIG.ws.heartbeatInterval),
      heartbeatTimeout: getEnvValue('WS_HEARTBEAT_TIMEOUT', DEFAULT_CONFIG.ws.heartbeatTimeout)
    },
    websocket: {
      port: getEnvValue('WEBSOCKET_PORT', DEFAULT_CONFIG.websocket.port),
      heartbeatInterval: getEnvValue(
        'WEBSOCKET_HEARTBEAT_INTERVAL',
        DEFAULT_CONFIG.websocket.heartbeatInterval
      ),
      heartbeatTimeout: getEnvValue(
        'WEBSOCKET_HEARTBEAT_TIMEOUT',
        DEFAULT_CONFIG.websocket.heartbeatTimeout
      )
    },
    http: {
      port: getEnvValue('HTTP_PORT', DEFAULT_CONFIG.http.port),
      enabled: getEnvValue('HTTP_ENABLED', DEFAULT_CONFIG.http.enabled),
      host: getEnvValue('HTTP_HOST', DEFAULT_CONFIG.http.host),
      uploadDir: getEnvValue('HTTP_UPLOAD_DIR', DEFAULT_CONFIG.http.uploadDir),
      maxFileSize: getEnvValue('HTTP_MAX_FILE_SIZE', DEFAULT_CONFIG.http.maxFileSize),
      corsOrigins: getEnvValue('HTTP_CORS_ORIGINS', DEFAULT_CONFIG.http.corsOrigins),
      cors: getEnvValue('HTTP_CORS', DEFAULT_CONFIG.http.cors),
      authToken: getEnvValue('HTTP_AUTH_TOKEN', DEFAULT_CONFIG.http.authToken)
    },
    queue: {
      inboundCapacity: getEnvValue('QUEUE_INBOUND_CAPACITY', DEFAULT_CONFIG.queue.inboundCapacity),
      outboundCapacity: getEnvValue(
        'QUEUE_OUTBOUND_CAPACITY',
        DEFAULT_CONFIG.queue.outboundCapacity
      )
    },
    message: {
      maxBytes: getEnvValue('MESSAGE_MAX_BYTES', DEFAULT_CONFIG.message.maxBytes)
    },
    task: {
      defaultTimeoutSec: getEnvValue(
        'TASK_DEFAULT_TIMEOUT_SEC',
        DEFAULT_CONFIG.task.defaultTimeoutSec
      ),
      maxConcurrent: getEnvValue('TASK_MAX_CONCURRENT', DEFAULT_CONFIG.task.maxConcurrent)
    },
    logging: {
      level: getEnvValue('LOGGING_LEVEL', DEFAULT_CONFIG.logging.level)
    }
  }
}

// 导出配置实例
export const config = loadConfig()

// 导出配置加载函数
export { loadConfig }
