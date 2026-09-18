/**
 * 采样前把虚幻编辑器窗口拉到前台。
 *
 * ## 为什么需要这一步
 *
 * 编辑器窗口在后台或失去焦点时会主动降帧（真机量到过 4.8 FPS），渲染线程和
 * GPU 耗时会双双掉到 0——不是「GPU 很快」，是**根本没在渲染那一帧**。
 * 用户在盒子的聊天窗口里问性能问题时，UE 编辑器窗口大概率正被聊天窗口挡在
 * 后面：不主动拉一次前台，几乎每次首采样都会撞上这个空转样本。
 *
 * `ue_get_performance_stats` 一直有这一步；`ue_capture_perf_trace` /
 * `ue_insights_trace(action=capture)` 采样时间更长，撞上空转样本的代价更大
 * （用户要等完 duration_seconds 才知道白采了），更需要这一步。
 *
 * ## 不保证成功
 *
 * `AppActivate` 能不能抢到焦点取决于 Windows 的前台锁定策略、多显示器配置等，
 * 不是每次都灵。调用方失败了也不该中断采样——这只是「提高命中率」，
 * 不是必要条件。真采到空转样本时，各工具自己的 `idle_sample` 判定兜底。
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * 尝试把 UnrealEditor.exe 的窗口带到前台，并等待引擎从后台降帧模式恢复。
 *
 * 失败（找不到进程、PowerShell 不可用等）只记日志，不抛出——调用方应当
 * 无论成功与否都继续往下采样。
 */
export async function foregroundUnrealEditorWindow(logPrefix: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      const { activateMacEditor } = await import('../../../../utils/macEditorActivation')
      const { getTargetProjectPath } = await import('../../../core/projectTargetContext')
      console.log(`${logPrefix} 正在尝试唤醒虚幻引擎窗口...`)
      if (await activateMacEditor(getTargetProjectPath())) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      } else {
        // 认不出该激活哪个（没匹配上，或者开着好几个编辑器分不清）。
        // 不说一声的话，后面那张截图拍到的是当时恰好在前台的窗口，
        // 而调用方会当成编辑器的画面用。
        console.warn(`${logPrefix} 没能确定要唤醒哪个编辑器窗口，后续采样可能不是编辑器画面`)
      }
      return
    }
    const psCommand =
      'powershell -Command "$wshell = New-Object -ComObject WScript.Shell; ' +
      '$proc = Get-Process UnrealEditor -ErrorAction SilentlyContinue | ' +
      'Sort-Object StartTime -Descending | Select-Object -First 1; ' +
      'if ($proc) { $wshell.AppActivate($proc.Id) }"'

    console.log(`${logPrefix} 正在尝试唤醒虚幻引擎窗口...`)
    await execAsync(psCommand, { timeout: 2000 })

    // 等待一秒，让引擎从后台降帧模式恢复
    await new Promise((resolve) => setTimeout(resolve, 1000))
  } catch (error) {
    console.warn(`${logPrefix} 唤醒窗口失败 (非致命错误):`, error)
  }
}
