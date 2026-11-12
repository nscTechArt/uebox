import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import { mt } from '../../i18n'

/**
 * 网页里的右键菜单。
 *
 * Electron 的视图默认右键什么都没有 —— 复制不了链接、粘贴不了，和真浏览器差得最远的
 * 就是这一处。条目按 Chrome 的来：点在链接、图片、选中文字、输入框上各给各的，
 * 什么都没点中才给后退 / 前进 / 刷新。「检查」不给：DevTools 会把 CDP 抢走。
 */
export interface PageMenuActions {
  canGoBack: boolean
  canGoForward: boolean
  back: () => void
  forward: () => void
  reload: () => void
  openInBackground: (url: string) => void
  copyText: (text: string) => void
  copyImageAt: (x: number, y: number) => void
  editCommand: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => void
  searchFor: (text: string) => void
  openExternal: (url: string) => void
}

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

/** 菜单上引用选中文字时截短，和 Chrome 一样不让一整段字撑宽菜单 */
function clip(text: string, max = 20): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function buildPageMenu(
  params: Pick<
    ContextMenuParams,
    | 'x'
    | 'y'
    | 'linkURL'
    | 'srcURL'
    | 'mediaType'
    | 'selectionText'
    | 'isEditable'
    | 'editFlags'
    | 'pageURL'
  >,
  actions: PageMenuActions
): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const groups: MenuItemConstructorOptions[][] = []
  const link = isWebUrl(params.linkURL) ? params.linkURL : ''
  const image = params.mediaType === 'image' && isWebUrl(params.srcURL) ? params.srcURL : ''
  const selection = params.selectionText.trim()

  if (link) {
    groups.push([
      { label: mt('browser.openLinkInNewTab'), click: () => actions.openInBackground(link) },
      { label: mt('browser.openLinkInSystemBrowser'), click: () => actions.openExternal(link) },
      { label: mt('browser.copyLink'), click: () => actions.copyText(link) }
    ])
  }
  if (image) {
    groups.push([
      { label: mt('browser.openImageInNewTab'), click: () => actions.openInBackground(image) },
      { label: mt('browser.copyImage'), click: () => actions.copyImageAt(params.x, params.y) },
      { label: mt('browser.copyImageAddress'), click: () => actions.copyText(image) }
    ])
  }
  if (params.isEditable) {
    const flags = params.editFlags
    groups.push(
      [
        {
          label: mt('browser.undo'),
          enabled: flags.canUndo,
          click: () => actions.editCommand('undo')
        },
        {
          label: mt('browser.redo'),
          enabled: flags.canRedo,
          click: () => actions.editCommand('redo')
        }
      ],
      [
        {
          label: mt('browser.cut'),
          enabled: flags.canCut,
          click: () => actions.editCommand('cut')
        },
        {
          label: mt('browser.copy'),
          enabled: flags.canCopy,
          click: () => actions.editCommand('copy')
        },
        {
          label: mt('browser.paste'),
          enabled: flags.canPaste,
          click: () => actions.editCommand('paste')
        }
      ],
      [
        {
          label: mt('browser.selectAll'),
          enabled: flags.canSelectAll,
          click: () => actions.editCommand('selectAll')
        }
      ]
    )
  } else if (selection) {
    groups.push([
      { label: mt('browser.copy'), click: () => actions.editCommand('copy') },
      {
        label: mt('browser.searchFor', { text: clip(selection) }),
        click: () => actions.searchFor(selection)
      }
    ])
  }

  if (groups.length === 0) {
    groups.push(
      [
        { label: mt('browser.back'), enabled: actions.canGoBack, click: actions.back },
        { label: mt('browser.forward'), enabled: actions.canGoForward, click: actions.forward },
        { label: mt('browser.reload'), click: actions.reload }
      ],
      [
        { label: mt('browser.copyPageUrl'), click: () => actions.copyText(params.pageURL) },
        {
          label: mt('browser.openInSystemBrowser'),
          enabled: isWebUrl(params.pageURL),
          click: () => actions.openExternal(params.pageURL)
        }
      ]
    )
  }

  return groups.flatMap((group, index) => (index === 0 ? group : [separator, ...group]))
}
