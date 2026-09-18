/**
 * 输入框里按回车到底算什么。
 *
 * ## 为什么要能选
 *
 * 「回车发送」对聊天是对的，对写多行提示词是灾难 —— 尤其中文输入法用户：
 * 一句话里按几次回车挑候选词，稍不留神就把半句话发出去了。反过来，
 * 「Ctrl+回车才发送」对只写一行的人是每次都多按一个键。
 *
 * 两种人都真实存在，所以这是设置，不是我们替他选。
 *
 * ## 为什么是纯函数
 *
 * 组合有八种（两档 × 有没有 Shift × 有没有 Ctrl），而错一种的表现是
 * 「我的话发不出去」或者「我还没写完就发出去了」—— 两种都不会抛异常，
 * 只会在真机上被用户撞见。
 */

/**
 * 哪个键算「发出去」。
 *
 * - `enter`：**默认**。回车发送，Shift+回车换行。
 * - `ctrl-enter`：回车换行，Ctrl+回车（mac 上 ⌘+回车）发送。
 */
export type SendShortcut = 'enter' | 'ctrl-enter'

/** 这次按键要干什么。`null` 表示不是我们管的键，交给输入框自己处理 */
export type ComposerKeyAction =
  /** 按设置发出去（跑着的时候可能是排队或插话，见 `resolveFollowUpAction`） */
  | 'submit'
  /** 发出去，但对**这一条**反着来 —— 排队档下改成插话，插话档下改成排队 */
  | 'submit-opposite'
  /** 换行。交给输入框默认行为即可，不用我们插手 */
  | 'newline'

export interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * 判定。
 *
 * ## Shift+回车永远是换行
 *
 * 两档下都一样。这是所有聊天软件的共识，抢过来做别的用途只会让人怀疑键盘坏了。
 *
 * ## 「反着来」那个键在两档下不一样
 *
 * `enter` 档：发送是回车，那么 **Ctrl+回车**空着，用它。
 * `ctrl-enter` 档：Ctrl+回车已经是发送了，只好再叠一个 Shift。
 * 这一档下的组合键确实难记 —— 但输入框上那颗按钮一直摆着，
 * 键盘党之外的人根本用不到它。
 */
export function resolveComposerKeyAction(
  event: ComposerKeyEvent,
  mode: SendShortcut
): ComposerKeyAction | null {
  if (event.key !== 'Enter') return null

  const modifier = event.ctrlKey || event.metaKey

  if (mode === 'ctrl-enter') {
    if (!modifier) return 'newline'
    return event.shiftKey ? 'submit-opposite' : 'submit'
  }

  // enter 档
  if (event.shiftKey) return 'newline'
  return modifier ? 'submit-opposite' : 'submit'
}
