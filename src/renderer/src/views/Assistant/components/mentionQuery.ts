import type { NotebookSourceItem } from '../composables/useChatFlow'

/**
 * `@` 提及的输入解析。
 *
 * 和 `/` 技能命令（见 {@link ./skillCommands}）的区别：`@` 可以出现在句子中间，
 * 所以要从最后一个 `@` 往后看，而不是只认开头。
 */

/**
 * 从输入里解析出当前这一次 @ 提及打了什么。
 *
 * @returns `@` 后面的内容；不在一次提及里返回 null
 *
 * 中间一旦出现空白就当这次提及结束了 —— 用户在正常打字（「@我 昨天写的」），
 * 不是在挑来源。不这么判的话，一个 @ 会让弹层一直挂在那儿关不掉。
 */
export function parseMentionQuery(text: string): string | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  const after = text.slice(at + 1)
  if (/\s/.test(after)) return null
  return after
}

/**
 * 选中之后，把这一次提及连同用户打的关键词从输入里删掉。
 *
 * 不能只删一个光秃秃的 `@`：现在能边打边搜，选中时输入框里留的是「@材质」。
 */
export function stripMentionQuery(text: string): string {
  const at = text.lastIndexOf('@')
  if (at < 0) return text
  if (/\s/.test(text.slice(at + 1))) return text
  return text.slice(0, at)
}

/**
 * 把一篇笔记包成 @ 列表认得的形状。
 *
 * id 加 `note:` 前缀，避免和知识库来源的 id 撞上 —— 两种东西现在混在同一个
 * 列表、同一个已选集合里，id 撞了就会串台。
 */
export function noteToMentionSource(
  note: { id?: number; title?: string },
  fallbackTitle: string
): NotebookSourceItem {
  return {
    id: `note:${note.id}`,
    title: note.title?.trim() || fallbackTitle,
    type: 'note'
  }
}
