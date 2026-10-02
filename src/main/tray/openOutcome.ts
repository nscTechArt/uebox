/**
 * 「点最近项目」的结果 → 弹什么系统通知、点了通知干什么。
 *
 * 抽成纯函数是为了能测：Electron 那层（Notification、sendTrayAction）
 * 留在 `trayController.ts` 里，这边只看结果给结论。
 *
 * IPC 入口里这层反馈是首页自己弹的（`usePluginInstallNotice`）；托盘点击
 * 时窗口多半藏着，所以全靠系统通知。
 */
import type { TrayAction } from '../../shared/trayActions'
import type { MainTranslator } from '../i18n'
import type { OpenUprojectResult } from '../services/project/openUproject'

export interface TrayOpenOutcome {
  title: string
  body: string
  /** 点了通知要派给界面的动作；没有就只是把窗口叫到前台 */
  action?: TrayAction
}

export function trayOpenOutcome(
  result: OpenUprojectResult,
  project: { name: string; originPath: string },
  t: MainTranslator
): TrayOpenOutcome | null {
  if (!result.success) {
    /*
     * `error` 可能是主进程写死的中文（`pathNotFound` 的「工程文件不存在」），
     * 英文用户看到会一脸懵。文件没了这种有专门文案；其余错误把原文带上 ——
     * 那多半是操作系统给的错误，是可搜的线索。
     */
    return {
      title: t('tray.openFailedTitle'),
      body: result.pathNotFound
        ? t('tray.openFailedMissing', { name: project.name })
        : t('tray.openFailedBody', { name: project.name, error: result.error ?? '' })
    }
  }

  // 工程开了但插件没装上：这是之后「AI 连不上引擎」唯一的线索。点了回界面
  // 走和首页同一张对话框（tray:action → notifyPluginInstallFailure）
  if (result.pluginFailure) {
    return {
      title: t('tray.pluginFailedTitle'),
      body: t('tray.pluginFailedBody'),
      action: {
        type: 'plugin-failure',
        pluginFailure: result.pluginFailure,
        originPath: project.originPath,
        projectName: project.name
      }
    }
  }

  return null
}
