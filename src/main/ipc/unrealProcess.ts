/**
 * 虚幻引擎进程检测相关 IPC 处理器
 *
 * 提供获取当前运行的虚幻引擎项目信息的 IPC 接口
 */

import { ipcMain } from 'electron'
import UnrealProcessDetector, { RunningUnrealProject } from '../utils/UnrealProcessDetector'

/**
 * IPC 响应结构
 */
interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * 注册虚幻引擎进程检测相关 IPC 处理器
 */
export function registerUnrealProcessIPC(): void {
  /**
   * 获取所有正在运行的虚幻引擎项目
   * @channel unreal:process:getRunningProjects
   * @returns {IPCResponse<RunningUnrealProject[]>}
   */
  ipcMain.handle(
    'unreal:process:getRunningProjects',
    async (_event): Promise<IPCResponse<RunningUnrealProject[]>> => {
      void _event
      try {
        const projects = await UnrealProcessDetector.getRunningProjects()
        return { success: true, data: projects }
      } catch (error) {
        console.error('[IPC] unreal:process:getRunningProjects 错误:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 检查虚幻编辑器是否正在运行
   * @channel unreal:process:isRunning
   * @returns {IPCResponse<boolean>}
   */
  ipcMain.handle('unreal:process:isRunning', async (_event): Promise<IPCResponse<boolean>> => {
    void _event
    try {
      const isRunning = await UnrealProcessDetector.isUnrealEditorRunning()
      return { success: true, data: isRunning }
    } catch (error) {
      console.error('[IPC] unreal:process:isRunning 错误:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 获取主要运行的项目（第一个）
   * @channel unreal:process:getPrimaryProject
   * @returns {IPCResponse<RunningUnrealProject | null>}
   */
  ipcMain.handle(
    'unreal:process:getPrimaryProject',
    async (_event): Promise<IPCResponse<RunningUnrealProject | null>> => {
      void _event
      try {
        const project = await UnrealProcessDetector.getPrimaryRunningProject()
        return { success: true, data: project }
      } catch (error) {
        console.error('[IPC] unreal:process:getPrimaryProject 错误:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 根据项目名称查找运行中的项目
   * @channel unreal:process:findByName
   * @param projectName 项目名称
   * @returns {IPCResponse<RunningUnrealProject | null>}
   */
  ipcMain.handle(
    'unreal:process:findByName',
    async (_event, projectName: string): Promise<IPCResponse<RunningUnrealProject | null>> => {
      void _event
      try {
        if (!projectName) {
          return { success: false, error: '项目名称不能为空' }
        }
        const project = await UnrealProcessDetector.findRunningProjectByName(projectName)
        return { success: true, data: project }
      } catch (error) {
        console.error('[IPC] unreal:process:findByName 错误:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * 根据项目路径查找运行中的项目
   * @channel unreal:process:findByPath
   * @param projectPath 项目文件路径
   * @returns {IPCResponse<RunningUnrealProject | null>}
   */
  ipcMain.handle(
    'unreal:process:findByPath',
    async (_event, projectPath: string): Promise<IPCResponse<RunningUnrealProject | null>> => {
      void _event
      try {
        if (!projectPath) {
          return { success: false, error: '项目路径不能为空' }
        }
        const project = await UnrealProcessDetector.findRunningProjectByPath(projectPath)
        return { success: true, data: project }
      } catch (error) {
        console.error('[IPC] unreal:process:findByPath 错误:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  console.log('[IPC] 虚幻引擎进程检测 IPC 已注册')
}
