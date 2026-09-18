import { ipcMain } from 'electron'
import UnrealPathManagerUtil from '../utils/UnrealPathManager'
import { resolveEngineAssociationLabels } from './projectEngineVersion'

/**
 * Unreal 引擎路径相关的 IPC
 *
 * UnrealAgentLink 的安装不在这里 —— 它是项目级的，跟着项目导入走，
 * 入口在 `sqliteDataBase/ipc/project.ts` 的 `ensureUnrealAgentLinkPlugin`。
 */
export function registerUnrealPathIPC(): void {
  // 扫描已安装的 Unreal 引擎
  ipcMain.handle('unreal:engines:scan', async (_event) => {
    void _event
    try {
      // 用 scanEngines 而不是 findUnrealEnginePaths：后者把失败吞成一个空数组，
      // 界面于是分不清「一个都没装」和「这次没读出来」，对着装了引擎的用户报空
      const { engines, degraded } = await UnrealPathManagerUtil.scanEngines()
      return { success: true, data: engines, degraded }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Inspect persisted custom engine records whose paths are no longer valid.
  ipcMain.handle('unreal:engines:inspectInvalidCustomPaths', async (_event) => {
    void _event
    try {
      const data = await UnrealPathManagerUtil.inspectInvalidCustomEngines()
      return { success: true, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 通过自定义路径添加引擎
  ipcMain.handle('unreal:engines:addCustomPath', async (_event, customPath: string | string[]) => {
    void _event
    try {
      const data = await UnrealPathManagerUtil.addCustomPath(customPath)
      return { success: !!data, data }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 移除自定义引擎（从数据库中删除）
  ipcMain.handle('unreal:engines:removeCustomPath', async (_event, rootPath: string) => {
    void _event
    try {
      const ok = UnrealPathManagerUtil.removeCustomPath(rootPath)
      return { success: ok }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 把工程里的 EngineAssociation 翻成版本号（自编译引擎写的是 GUID，直接显示像乱码）
  ipcMain.handle(
    'unreal:engines:resolveAssociations',
    async (_event, associations: (string | null)[]) => {
      void _event
      try {
        const data = await resolveEngineAssociationLabels(
          Array.isArray(associations) ? associations : [],
          UnrealPathManagerUtil
        )
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 解析可执行文件版本
  ipcMain.handle('unreal:exe:getVersion', async (_event, filePath: string) => {
    void _event
    try {
      const v = await UnrealPathManagerUtil.getExeVersion(filePath)
      return { success: true, data: v }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 比较版本号（返回 -1/0/1）
  ipcMain.handle(
    'unreal:version:compare',
    async (_event, a: string | number, b: string | number) => {
      void _event
      try {
        const r = UnrealPathManagerUtil.compareVersions(a, b)
        return { success: true, data: r }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
