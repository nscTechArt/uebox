/**
 * 共享技能（官网共享库）。
 *
 * 读类调用走 `unwrapResult()`，失败直接抛；安装确认框和分享弹窗按抛出的消息原样提示 ——
 * 主进程给的错误文案已经是给用户看的句子（见 src/main/ipc/share.ts）。
 */
import type {
  SharedSkillInstallFailure,
  SharedSkillInstallOutcome,
  SharedSkillInstallRequest,
  SharedSkillPack,
  SharedSkillSubmitInput,
  SharedSkillSubmitResult
} from '@core/shared/share'
import { unwrapResult } from '@renderer/common/utils'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const unwrap = <T>(res: Res<T>): T => unwrapResult(res as { success: boolean; data: T; error?: string })

export const shareAPI = {
  async pendingInstalls(): Promise<SharedSkillInstallRequest[]> {
    return unwrap(await window.api.share.pendingInstalls())
  },
  async installReply(requestId: string, approve: boolean): Promise<SharedSkillInstallOutcome> {
    return unwrap(await window.api.share.installReply(requestId, approve))
  },
  async packSkill(name: string): Promise<SharedSkillPack> {
    return unwrap(await window.api.share.packSkill(name))
  },
  async submitSkill(input: SharedSkillSubmitInput): Promise<SharedSkillSubmitResult> {
    return unwrap(await window.api.share.submitSkill(input))
  },
  async openPage(url: string): Promise<void> {
    unwrap(await window.api.share.openPage(url))
  },
  onInstallRequest(listener: (request: SharedSkillInstallRequest) => void): () => void {
    return window.api.share.onInstallRequest(listener)
  },
  onInstallFailed(listener: (failure: SharedSkillInstallFailure) => void): () => void {
    return window.api.share.onInstallFailed(listener)
  }
}
