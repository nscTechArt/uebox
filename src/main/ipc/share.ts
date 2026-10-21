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
import { fetchSharedSkill, submitSharedSkill, ShareError } from '../services/share/shareClient'
import {
  findInstallConflict,
  installSharedSkill,
  packUserSkill,
  readShareState,
  writeShareState
} from '../services/share/sharedSkills'
import {
  SHARE_INSTALL_FAILED_CHANNEL,
  SHARE_INSTALL_REQUEST_CHANNEL,
  type SharedSkillInstallFailure,
  type SharedSkillInstallOutcome,
  type SharedSkillInstallRequest,
  type SharedSkillPack,
  type SharedSkillSubmitInput,
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
      const [pack, state] = await Promise.all([packUserSkill(name), readShareState()])
      return {
        ...pack,
        author: state.author,
        authorLink: state.authorLink,
        isUpdate: Boolean(state.keys[name])
      }
    })
  )

  /** 文件在主进程重新打包，不用界面传上来的内容：提交的一定是盘上那一份 */
  ipcMain.handle('share:submit-skill', (_event, input: SharedSkillSubmitInput) =>
    run(async (): Promise<SharedSkillSubmitResult> => {
      const name = String(input?.name ?? '')
      const author = String(input?.author ?? '').trim().slice(0, 40)
      const authorLink = String(input?.authorLink ?? '').trim().slice(0, 200)
      const note = String(input?.note ?? '').slice(0, 500)
      if (!author) throw new Error('请填写署名。')

      const pack = await packUserSkill(name)
      const state = await readShareState()
      const editKey = state.keys[name]
      const result = await submitSharedSkill({
        author,
        authorLink,
        note,
        ...(editKey ? { editKey } : {}),
        files: pack.files
      })
      await writeShareState({
        author,
        authorLink,
        keys: { ...state.keys, [result.id]: result.editKey || editKey || '' }
      })
      return { id: result.id, isUpdate: Boolean(editKey), statusUrl: result.statusUrl }
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
