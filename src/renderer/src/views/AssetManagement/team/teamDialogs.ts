/**
 * 团队工程的小框（界面方案 7.1：设为里程碑、冻结、解冻、收回、打回、发给外包）。
 *
 * 一个模块级的状态 + 一个挂在资产库页上的 <TeamDialogs />：网格右键、详情、签出中、等你处理、
 * 动态卡片都从这里开同一个框，标题、字段、按钮只写一遍（2.13 确认框的规矩）。
 * 每个 open* 回一个 Promise：做成了 resolve(true)，取消 resolve(false)。
 */
import { reactive } from 'vue'

export type TeamDialog =
  | {
      kind: 'takeBack'
      holder: { id: string; name: string }
      paths?: string[]
      count: number
      askId?: string
    }
  | { kind: 'reject'; number: number }
  | { kind: 'rejectAssets'; deliveryId: string; paths: string[] }
  | { kind: 'milestone'; number: number; name?: string | null }
  | { kind: 'freeze' }
  | { kind: 'unfreeze'; waiting: number }
  | { kind: 'sendReference'; company: { id: string; name: string }; paths: string[] }
  | { kind: 'cancelCheckout'; path: string; name: string }

interface DialogState {
  current: TeamDialog | null
  resolve: ((done: boolean) => void) | null
}

export const teamDialogState = reactive<DialogState>({ current: null, resolve: null })

export function openTeamDialog(dialog: TeamDialog): Promise<boolean> {
  teamDialogState.resolve?.(false)
  return new Promise((resolve) => {
    teamDialogState.current = dialog
    teamDialogState.resolve = resolve
  })
}

export function closeTeamDialog(done: boolean): void {
  const resolve = teamDialogState.resolve
  teamDialogState.current = null
  teamDialogState.resolve = null
  resolve?.(done)
}
