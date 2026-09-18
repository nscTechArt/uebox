/**
 * 统一日志服务
 * 本地日志持久化（electron-log）。社区版不含任何远程上报。
 *
 * 日志文件位置：
 * - Windows: %USERPROFILE%\AppData\Roaming\UnrealAgent\logs\unreal-agent.log
 * - macOS: ~/Library/Logs/UnrealAgent/unreal-agent.log
 * - Linux: ~/.config/UnrealAgent/logs/unreal-agent.log
 */
import log from 'electron-log/main'

// ============ electron-log 配置 ============

// 文件日志级别（info 及以上）
log.transports.file.level = 'info'

// 日志文件大小限制：10MB，超过后自动轮转
log.transports.file.maxSize = 10 * 1024 * 1024

// 控制台日志级别：一律 info。
//
// 开发环境原本是 debug，但 debug 级几乎全被用来记「注册路由 xxx」「任务执行器已注册 xxx」
// 这类逐条流水 —— 光启动就五十多行，把真正该看的信息淹掉。需要时用 UA_LOG_LEVEL=debug 打开。
// 文件日志不受影响，始终是 info 及以上。
log.transports.console.level =
  (process.env.UA_LOG_LEVEL as typeof log.transports.console.level) || 'info'

// 自定义日志文件名
log.transports.file.fileName = 'unreal-agent.log'

// 日志格式化
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {text}'

// ============ 导出 ============

/**
 * 统一日志实例
 * 用法：
 *   import { logger } from './services/logger'
 *   logger.info('消息')
 *   logger.error('错误', error)
 */
export const logger = log

/**
 * 获取日志文件路径（用于用户手动发送日志）
 * @returns 日志文件完整路径
 */
export function getLogFilePath(): string {
  return log.transports.file.getFile().path
}
