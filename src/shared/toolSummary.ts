/**
 * 把工具说明压成一句话，给设置页的清单用。
 *
 * 工具的 `description` 是**写给模型看的**：动辄几百字，带【功能说明】【参数说明】
 * 这类小标题、Markdown 加粗、失败处理和跨工具引用。整段铺在设置页上，用户看到的
 * 是一屏密密麻麻的说明书，而且还看不全 —— 那一页要回答的只是「这玩意儿是干嘛的」。
 *
 * 所以只取第一句。工具说明的第一句几乎总是那一句总述（「为蓝图添加成员变量」），
 * 后面才开始讲怎么用。取不到就返回空串，那一行只显示工具名 —— 编一句比不写更糟。
 */

/** 第一句结束的位置。中英文各认各的句末标记，取更靠前的那个 */
function firstSentenceEnd(text: string): number {
  const cn = text.search(/[。！？；]/)
  // 英文句点要跟空格或行尾，否则 `0.3`、`material.apply` 会被当成句末
  const en = text.search(/\.(\s|$)/)
  const stops = [cn, en].filter((index) => index >= 0)
  return stops.length ? Math.min(...stops) : -1
}

export function toolSummary(description: string, maxChars = 48): string {
  const firstLine = description.split('\n').find((line) => line.trim()) ?? ''
  let text = firstLine
    // Markdown 是给模型的排版，界面上只会显示成一串星号
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .trim()
  // 有些说明直接以【功能说明】这类小标题开头，那不是这个工具在干嘛
  text = text.replace(/^【[^】]*】[:：]?\s*/, '').trim()

  const end = firstSentenceEnd(text)
  if (end >= 0) text = text.slice(0, end)
  text = text.trim()

  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}
