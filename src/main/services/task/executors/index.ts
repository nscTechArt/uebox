/**
 * 任务执行器入口
 */
export { PluginTaskExecutor } from './pluginTaskExecutor'
export { FileTaskExecutor } from './fileTaskExecutor'
export { SystemTaskExecutor } from './systemTaskExecutor'

import { TaskManager } from '../taskManager'
import { PluginTaskExecutor } from './pluginTaskExecutor'
import { FileTaskExecutor } from './fileTaskExecutor'
import { SystemTaskExecutor } from './systemTaskExecutor'
import { logger } from '../../logger'

/**
 * 注册所有任务执行器
 */
export function registerExecutors(taskManager: TaskManager): void {
  logger.info('开始注册任务执行器')

  // 插件任务执行器
  const pluginExecutor = new PluginTaskExecutor()
  pluginExecutor.registerExecutors(taskManager)

  // 文件任务执行器
  const fileExecutor = new FileTaskExecutor()
  fileExecutor.registerExecutors(taskManager)

  // 系统任务执行器
  const systemExecutor = new SystemTaskExecutor()
  systemExecutor.registerExecutors(taskManager)

  // AI3D 任务执行器
  logger.info('任务执行器注册完成')
}
