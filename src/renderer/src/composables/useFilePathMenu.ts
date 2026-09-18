import { computed, ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'

import type { MenuItem } from '@renderer/components/ContextMenu/types'
import { message } from '@renderer/utils/messageManager'
import { describeShellOpenFailure, type ShellOpenResult } from '@renderer/utils/shellOpen'

/**
 * 「对一条本地/网络路径能做什么」的共用菜单。
 *
 * 两个地方要用同一套动作：聊天正文里右键一条路径（MarkdownRenderer），
 * 以及「本轮改动」里每个文件行的「打开 ▾」（AIBubble）。写两份必然会漂移，
 * 所以菜单项和动作分发都放这里。
 */

/** 支持的编辑器；label 是产品名，不进 i18n */
const EDITORS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'trae', label: 'Trae' },
  { id: 'webstorm', label: 'WebStorm' }
] as const

/**
 * 左键直接打开会有风险的扩展名：这些一律降级成「在资源管理器里定位」。
 * 路径是模型给出来的，不该让一次左键就能起一个可执行文件。
 */
const RISKY_EXTENSION = /\.(?:exe|bat|cmd|com|scr|ps1|psm1|vbs|vbe|wsf|js|jar|msi|reg|lnk)$/i

/** 装了哪些编辑器整个进程只问一次 */
let installedEditorsPromise: Promise<string[]> | null = null

function loadInstalledEditors(): Promise<string[]> {
  if (!installedEditorsPromise) {
    installedEditorsPromise = Promise.resolve(window.api?.shell?.listEditors?.())
      .then((result) => (result?.success ? (result.editors ?? []) : []))
      .catch(() => [])
  }
  return installedEditorsPromise
}

/** 取路径的最后一段作为文件名 */
export function basenameOf(path: string): string {
  const parts = String(path)
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}

/** 取路径里除文件名以外的部分，末尾带分隔符（`prototype/`），根目录下则为空串 */
export function dirnameOf(path: string): string {
  const normalized = String(path).replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  return cut > 0 ? `${normalized.slice(0, cut)}/` : ''
}

/**
 * 目录的短形式：只留最后一两层，前面用 `…/` 代替。
 *
 * 绝对路径太长，一行里放不下；而 CSS 的省略号只能砍尾巴，砍掉的恰好是
 * 「文件在哪个文件夹」这个最有用的信息，所以在这里从前面砍。
 *
 * @param path 完整路径
 * @param keep 保留几层目录
 */
export function shortDirOf(path: string, keep = 2): string {
  const segments = dirnameOf(path).split('/').filter(Boolean)
  if (segments.length === 0) return ''
  if (segments.length <= keep) return `${segments.join('/')}/`
  return `…/${segments.slice(-keep).join('/')}/`
}

/**
 * 打不开就说一声。
 *
 * 这批 `shell:*` 失败时是 `return { success: false }`，不抛异常 —— 只写 console.warn
 * 等于对用户静默，他看到的就是「点了没反应」。
 */
function reportOpenFailure(result: ShellOpenResult | undefined, target: string): void {
  const failure = describeShellOpenFailure(result, target)
  if (!failure) return
  console.warn('[useFilePathMenu] 打开失败:', target, failure.error)
  message[failure.level](
    failure.pathNotFound ? `这个路径不存在：${target}` : `打不开：${target}（${failure.error}）`,
    8
  )
}

/** 用系统默认程序打开路径；可执行文件退回到「资源管理器里定位」 */
export async function openFilePath(path: string): Promise<void> {
  if (!path) return
  const result = RISKY_EXTENSION.test(path)
    ? await window.api.shell.showItemInFolder(path)
    : await window.api.shell.openPath(path)
  reportOpenFailure(result, path)
}

export interface FilePathMenuOptions {
  /** 菜单第一项是不是「打开」。右键正文里的路径要，「打开 ▾」按钮自己就是打开，不要 */
  includeOpen?: boolean
}

export interface FilePathMenu {
  menuItems: ComputedRef<MenuItem[]>
  runFilePathAction: (key: string, path: string) => Promise<void>
}

/**
 * 路径操作菜单
 * @param options 菜单组成选项
 */
export function useFilePathMenu(options: FilePathMenuOptions = {}): FilePathMenu {
  const { t } = useI18n()
  const installedEditors = ref<string[]>([])
  void loadInstalledEditors().then((ids) => {
    installedEditors.value = ids
  })

  const menuItems = computed<MenuItem[]>(() => {
    const items: MenuItem[] = []
    if (options.includeOpen !== false) {
      items.push({ key: 'open', label: t('filePathMenu.open') })
    }
    items.push({ key: 'reveal', label: t('filePathMenu.reveal') })

    for (const editor of EDITORS) {
      if (installedEditors.value.includes(editor.id)) {
        items.push({ key: editor.id, label: editor.label })
      }
    }

    items.push({ type: 'divider' })
    items.push({ key: 'copyPath', label: t('filePathMenu.copyPath') })
    items.push({ key: 'copyName', label: t('filePathMenu.copyName') })
    return items
  })

  /**
   * 执行一个菜单动作
   * @param key 菜单项 key
   * @param path 目标路径
   */
  async function runFilePathAction(key: string, path: string): Promise<void> {
    if (!path) return

    if (EDITORS.some((editor) => editor.id === key)) {
      reportOpenFailure(await window.api.shell.openInEditor(path, key), path)
      return
    }

    switch (key) {
      case 'open':
        await openFilePath(path)
        break
      case 'reveal':
        reportOpenFailure(await window.api.shell.showItemInFolder(path), path)
        break
      case 'copyPath':
        await navigator.clipboard?.writeText(path)
        break
      case 'copyName':
        await navigator.clipboard?.writeText(basenameOf(path))
        break
    }
  }

  return { menuItems, runFilePathAction }
}
