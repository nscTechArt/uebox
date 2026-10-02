/**
 * 点了「最近项目」之后的那一段：防双击 → 挂「启动中」 → 真去开 → 按结果决定反馈。
 *
 * Electron 的 Notification、窗口回调都留在 `trayController.ts`；这里是纯逻辑，
 * 依赖全注入，可以进 vitest。
 *
 * 三条不能破的线：
 * - 点第二下绝不再开一个编辑器：「启动中」由 `tracker.isLaunching` 拦 ——
 *   它覆盖「openFile 还没回来」和「回来成功在等引擎连上」两段；
 *   「运行中」点下去这一刻现查 `isRunning` —— 菜单是弹出时刻的快照，
 *   挂着期间工程可能被别处（首页、直接双击 .uproject）拉起来
 * - 打开失败必须把标记摘掉 —— 进行中的标记不吃 TTL，不摘就永远灰着；
 *   `openFile` 真抛出来也按失败处理，口头契约不该是唯一防线
 */
import type { OpenUprojectResult } from '../services/project/openUproject'

import type { LaunchTracker } from './launchTracker'
import type { TrayRecentProject } from './trayMenu'

export interface TrayProjectOpenerDeps {
  tracker: LaunchTracker
  /**
   * 此刻它是不是已经在跑（`runningProjectKeys`）。实现方自己兜底：
   * 查不出来按 false 放行 —— 真开不起来后面还有 `openFile` 的失败通知，
   * 拦死才是「点了没反应还不知为啥」
   */
  isRunning: (projectKey: string) => boolean
  /** 真正打开 .uproject（`openUprojectFile`）；契约上不抛，抛了按打开失败处理 */
  openFile: (path: string) => Promise<OpenUprojectResult>
  /**
   * 把打开结果交出去反馈（controller 里经 `trayOpenOutcome` 翻成系统通知）。
   * 成功、失败都会调 —— 要不要弹、弹什么由实现方定
   */
  report: (result: OpenUprojectResult, project: TrayRecentProject) => void
  /** 启动标记变了：重建菜单 + 重排到期定时器 */
  onStateChanged: () => void
}

export function createTrayProjectOpener(
  deps: TrayProjectOpenerDeps
): (project: TrayRecentProject) => Promise<void> {
  return async (project) => {
    // 菜单项灰掉之前弹出的旧菜单里这条可能还能点 —— 拦一道，别把编辑器开双份。
    // 「启动中」看 tracker；「运行中」拿点击时刻的实况，不是快照里的那份
    if (deps.tracker.isLaunching(project.projectKey) || deps.isRunning(project.projectKey)) {
      return
    }

    deps.tracker.begin(project.projectKey)
    deps.onStateChanged()

    let result: OpenUprojectResult
    try {
      result = await deps.openFile(project.originPath)
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }

    // openFile 落定才翻页：成功转入「等引擎连上」的计时（TTL 从这里才开始算），
    // 失败摘掉标记 —— 不然这条要灰到永远
    deps.tracker.complete(project.projectKey, result.success)
    deps.onStateChanged()

    deps.report(result, project)
  }
}
