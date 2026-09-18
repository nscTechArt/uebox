/**
 * 日志系统
 *
 * 重新导出 electron-log 实例，保持现有 API 兼容
 * 日志写入本地文件与控制台。社区版不做任何远程上报。
 *
 * 日志文件位置：
 * - Windows: %USERPROFILE%\AppData\Roaming\UnrealAgent\logs\unreal-agent.log
 * - macOS: ~/Library/Logs/UnrealAgent/unreal-agent.log
 * - Linux: ~/.config/UnrealAgent/logs/unreal-agent.log
 */
export { logger, getLogFilePath } from './electronLog'
