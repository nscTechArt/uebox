/**
 * 共享技能的 IPC（通道全部是 share:*），以及三条安装入口共用的确认流程。
 *
 * ## 安装为什么一定要弹确认框
 *
 * 技能是给 Agent 的指令，装进来就会影响 Agent 的行为。不管是网页唤起、Agent 调工具还是
 * 命令行，都先把全文发给主窗口，用户点了「安装」才写盘。Agent 的审批档位（包括完全访问）
 * 不能跳过这一步 —— 让 Agent 自己决定装什么指令给自己，等于没有审核。
 */

import { randomUUID } from 'crypto'
import { ipcMain, shell } from 'electron'

import { findMainWindow } from '../appWindows'
import { SHARE_ORIGIN, skillPageUrl } from '../services/share/endpoint'
import { parseShareRef } from '../services/share/shareRules'
import { fetchSharedSkill, publishSharedSkill, ShareError } from '../services/share/shareClient'
import {
  accountKey,
  accountName,
  cancelConnect,
  connectAccount,
  forgetAccountKey
} from '../services/share/shareAccount'
import {
  findInstallConflict,
  installSharedSkill,
  packUserSkill,
  rememberPublished
} from '../services/share/sharedSkills'
import {
  SHARE_CONNECT_PROMPT_CHANNEL,
  SHARE_INSTALL_FAILED_CHANNEL,
  SHARE_INSTALL_REQUEST_CHANNEL,
  type SharedSkillInstallFailure,
  type SharedSkillInstallOutcome,
  type SharedSkillInstallRequest,
  type SharedSkillPack,
  type SharedSkillSubmitResult
} from '../../shared/share'

type Result<T> = { success: true; data: T } | { success: false; error: string }

async function run<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { success: true, data: await work() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 用户一直不点，确认框挂多久算放弃。Agent 和命令行那头一直等着这个结果 */
const DECISION_TIMEOUT_MS = 10 * 60 * 1000

interface Pending {
  request: SharedSkillInstallRequest
  settle: (outcome: SharedSkillInstallOutcome) => void
}
const pending = new Map<string, Pending>()

function showMainWindow(): void {
  const window = findMainWindow()
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * 三条入口共用：认出技能 → 下载 → 弹确认框 → 等用户决定。
 *
 * 地址认不出、技能不存在、连不上时直接抛错（ShareError），不弹框。
 * 主窗口还没起来（冷启动从网页唤起）时请求先挂着，界面起来后用 share:pending-installs 取。
 */
export async function requestSharedSkillInstall(
  ref: string,
  origin: SharedSkillInstallRequest['origin']
): Promise<SharedSkillInstallOutcome> {
  const id = parseShareRef(ref)
  if (!id) {
    throw new ShareError(
      `无法识别「${ref}」。请提供技能名（如 ue-level-organize）或技能页面地址（如 ${skillPageUrl('ue-level-organize')}）。`,
      'invalid'
    )
  }
  const [skill, conflict] = await Promise.all([fetchSharedSkill(id), findInstallConflict(id)])
  const request: SharedSkillInstallRequest = {
    requestId: randomUUID(),
    origin,
    skill,
    conflict,
    pageUrl: skillPageUrl(id)
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId)
      resolve({ status: 'declined', id })
    }, DECISION_TIMEOUT_MS)
    pending.set(request.requestId, {
      request,
      settle: (outcome) => {
        clearTimeout(timer)
        pending.delete(request.requestId)
        resolve(outcome)
      }
    })
    findMainWindow()?.webContents.send(SHARE_INSTALL_REQUEST_CHANNEL, request)
    showMainWindow()
  })
}

/** 网页上的「装到盒子」：`unrealbox://install-skill?id=xxx` */
export function handleShareDeepLink(raw: string): boolean {
  if (!/^unrealbox:\/\/install-skill/i.test(raw)) return false
  requestSharedSkillInstall(raw, 'link').catch((error: unknown) => {
    const failure: SharedSkillInstallFailure = {
      ref: raw,
      error: error instanceof Error ? error.message : String(error)
    }
    findMainWindow()?.webContents.send(SHARE_INSTALL_FAILED_CHANNEL, failure)
    showMainWindow()
  })
  return true
}

export function registerShareIPC(): void {
  ipcMain.handle('share:pending-installs', () =>
    run(async () => [...pending.values()].map((p) => p.request))
  )

  /** 确认框的结果。同意就在这里装，装的结果同时回给确认框和发起方 */
  ipcMain.handle('share:install-reply', (_event, requestId: unknown, approve: unknown) =>
    run(async (): Promise<SharedSkillInstallOutcome> => {
      const entry = typeof requestId === 'string' ? pending.get(requestId) : undefined
      if (!entry) throw new Error('这个安装请求已经失效，请重新发起。')
      const { skill } = entry.request
      if (approve !== true) {
        const outcome: SharedSkillInstallOutcome = { status: 'declined', id: skill.id }
        entry.settle(outcome)
        return outcome
      }
      try {
        await installSharedSkill(skill)
        const outcome: SharedSkillInstallOutcome = {
          status: 'installed',
          id: skill.id,
          version: skill.version
        }
        entry.settle(outcome)
        return outcome
      } catch (error) {
        const outcome: SharedSkillInstallOutcome = {
          status: 'failed',
          id: skill.id,
          error: (error as Error).message
        }
        entry.settle(outcome)
        return outcome
      }
    })
  )

  ipcMain.handle('share:pack-skill', (_event, name: unknown) =>
    run(async (): Promise<SharedSkillPack> => {
      if (typeof name !== 'string') throw new Error('缺少技能名。')
      const [pack, key] = await Promise.all([packUserSkill(name), accountKey()])
      return { ...pack, account: key ? await accountName(key) : null }
    })
  )

  /** 连接 UEBox 账户：浏览器打开 uebox.ai/connect，校验码推给界面，等用户点「允许」 */
  ipcMain.handle('share:connect', (event) =>
    run(async () => {
      await connectAccount((prompt) => {
        if (!event.sender.isDestroyed()) event.sender.send(SHARE_CONNECT_PROMPT_CHANNEL, prompt)
        if (/^https?:\/\//.test(prompt.verificationUri))
          void shell.openExternal(prompt.verificationUri)
      })
      const key = await accountKey()
      return { account: key ? await accountName(key) : null }
    })
  )
  ipcMain.handle('share:cancel-connect', () => cancelConnect())

  /**
   * 以连接的账户发布。文件在主进程重新打包，不用界面传上来的内容：提交的一定是盘上那一份。
   * 同名技能由同一个账户再发就是更新；名字被别的账户占了，服务端会拒。
   */
  ipcMain.handle('share:submit-skill', (_event, name: unknown) =>
    run(async (): Promise<SharedSkillSubmitResult> => {
      if (typeof name !== 'string') throw new Error('缺少技能名。')
      const key = await accountKey()
      if (!key) throw new ShareError('请先连接 UEBox 账户。', 'not-connected')
      const pack = await packUserSkill(name)
      try {
        const result = await publishSharedSkill(key, pack.files)
        await rememberPublished(result.id)
        return result
      } catch (error) {
        if (error instanceof ShareError && error.code === 'not-connected') await forgetAccountKey()
        throw error
      }
    })
  )

  /** 只打开共享网站自己的页面，别的地址一律不认。`list` 是共享技能列表页 */
  ipcMain.handle('share:open-page', (_event, url: unknown) =>
    run(async () => {
      const target = url === 'list' ? `${SHARE_ORIGIN}/share/` : url
      if (typeof target !== 'string' || !target.startsWith(`${SHARE_ORIGIN}/`)) {
        throw new Error('不是共享技能页面的地址。')
      }
      await shell.openExternal(target)
    })
  )
}
