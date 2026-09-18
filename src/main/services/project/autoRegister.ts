/**
 * 最后一道网：UE 连上盒子时，库里没有这个工程就补登记。
 *
 * ## 为什么还需要它
 *
 * 前两道是：`project_manage` 建工程时当场入库，以及挡住模型用通用工具自己拷
 * 模板。这两道管的都是**盒子自己建的工程**。但工程进用户电脑的路远不止这一条：
 *
 *   - 用户自己在 Epic 启动器里建的
 *   - 从 git clone 下来的、别人拷给他的、外接硬盘上的
 *   - 盒子装之前就存在的一堆老工程
 *
 * 这些工程盒子无从知道，直到**它们连上来**。而一旦连上来，projectPath 就在手里了。
 *
 * ## 为什么默认加进去而不是先问
 *
 * 「我的项目」这个说法在用户心里是**「我这台机器上的虚幻工程」**，不是
 * 「我手动登记过的工程」。按后者理解才需要弹窗确认，而那个理解和界面上写的名字
 * 对不上。用 UE 打开一个工程这件事本身就是「这是我的工程」最强的表态，
 * 再问一遍是多余的。
 *
 * 加错了的代价也小：从库里移除只是删一条记录，不动磁盘上的工程。
 */

import { promises as fs } from 'fs'
import * as path from 'path'

import { logger } from '../logger'

export type AutoRegisterOutcome =
  | 'registered' // 新登记进库
  | 'already' // 库里本来就有
  | 'not-found' // 路径上找不到 .uproject
  | 'failed' // 登记过程出错

/**
 * 插件报上来的 `projectPath` 可能是工程目录，也可能直接是 `.uproject` 文件。
 * 两种都得认 —— 只认一种的话，另一种会静默地什么都不做。
 */
export async function resolveUprojectPath(projectPath: string): Promise<string | undefined> {
  const target = String(projectPath || '').trim()
  if (!target) return undefined

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(target)
  } catch {
    return undefined
  }

  if (stat.isFile()) {
    return target.toLowerCase().endsWith('.uproject') ? target : undefined
  }
  if (!stat.isDirectory()) return undefined

  // 只看工程根目录这一层：.uproject 按 UE 的规矩就在这儿，往下递归只会
  // 在别人塞进 Content 里的示例工程上撞到错的那一个
  try {
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.uproject')) {
        return path.join(target, entry.name)
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * 把一个刚连上来的工程补登记进项目库。
 *
 * 静默执行：这是后台补登记，不是用户发起的操作，失败了只写日志。连上引擎
 * 是主路径，不能因为一次入库失败就影响它。
 */
export async function autoRegisterConnectedProject(
  projectPath: string
): Promise<AutoRegisterOutcome> {
  const uprojectPath = await resolveUprojectPath(projectPath)
  if (!uprojectPath) {
    logger.warn(`[AutoRegister] 连上来的工程路径里没找到 .uproject，跳过登记: ${projectPath}`)
    return 'not-found'
  }

  try {
    // 懒加载：这个模块挂在 WebSocket 消息路径上，而 ipc/project 那头连着
    // 数据库和 electron 的 ipcMain —— 静态引会把它们拖进消息处理的模块图
    const { registerProjectByUproject } = await import('../../sqliteDataBase/ipc/project')
    const result = await registerProjectByUproject(uprojectPath)

    if (result.success) {
      logger.info(`[AutoRegister] 已把连上来的工程登记进项目库: ${uprojectPath}`)
      return 'registered'
    }
    if (result.alreadyRegistered) return 'already'

    logger.warn(`[AutoRegister] 登记失败（不影响连接）: ${uprojectPath} — ${result.error}`)
    return 'failed'
  } catch (error) {
    logger.warn('[AutoRegister] 登记时异常（不影响连接）:', error)
    return 'failed'
  }
}
