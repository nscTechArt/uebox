import { useI18n } from 'vue-i18n'

import { confirmDialog } from '@renderer/utils/dialog'
import { message } from '@renderer/utils/messageManager'
import { useUpdateStore, formatUpdateVersion } from '@renderer/store/modules/updateStore'

/**
 * 「重启安装」这件事，全应用一份。
 *
 * ## 为什么要收拢
 *
 * 标题栏角标和「设置 → 关于」各写了一遍同样的确认框，于是有了两套文案键
 * （`update.installTitle/installContent/installNow/later` 和
 * `profile.about.updateReady/installNow/later`，两种语言共八个字符串），
 * 而且**已经跑偏了**：关于页那份会把失败 `message.error` 出来，角标那份是
 * `void updateStore.install()`，装不上就一声不吭。
 *
 * 同一个动作按入口不同给两种反馈，对用户来说就是「有时候能用有时候不能用」。
 *
 * ## 失败为什么必须在这里报
 *
 * `install()` 返回 `{ success: false }` 而不是抛异常，所以 `void` 掉就等于丢掉。
 * 而且 `quitAndInstall` 的失败**不走** `update-error` 事件 —— App.vue 那条
 * 「错误统一报一次」的路子覆盖的是下载，不覆盖安装。不在这儿报就没人报：
 * 用户点「立即重启」，弹窗关掉，应用不重启，什么提示都没有，再点一次还是这样。
 */
export function useUpdateInstall(): { confirmInstall: () => void } {
  const { t } = useI18n()
  const updateStore = useUpdateStore()

  function confirmInstall(): void {
    confirmDialog({
      title: t('update.installTitle'),
      content: t('update.installContent', {
        version: formatUpdateVersion(updateStore.latestVersion)
      }),
      okText: t('update.installNow'),
      cancelText: t('update.later'),
      // 不返回 Promise：返回了弹窗会顶着 loading 等，而成功那一路进程直接就没了
      onOk: () => {
        void runInstall()
      }
    })
  }

  async function runInstall(): Promise<void> {
    const result = await updateStore.install()
    if (!result.success) {
      message.error(result.error || t('update.installFailed'))
    }
  }

  return { confirmInstall }
}
