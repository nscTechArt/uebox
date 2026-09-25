/**
 * 给带图的工具结果补一句「这是本批第几张图」。
 *
 * ## 为什么要补
 *
 * pi 的 OpenAI 兼容序列化（`openai-completions.js`）把一串连续工具结果里的图
 * 全部摘出来，堆进工具消息**之后**的一条 user 消息，前面只有一句
 * 「Attached image(s) from tool result:」—— 图和调用之间没有任何标签。
 * 并行读 8 张帧时，模型看到 8 条一模一样的「Read image file [image/jpeg]」，
 * 再看到 8 张没署名的图，只能按顺序猜。猜错就是「同一镜出现 3 次、另外 3 镜缺失」
 * 「整图和它的裁切是两个画面」（见 AgentFeedback 2026-09-25 视觉回读不可信）。
 *
 * 这里在每条带图的工具结果文字前写明「本结果的图是本批附图里的第几张」，
 * 让对应关系写在明面上，不靠模型猜。序号按 pi 的收集顺序算：一串连续
 * toolResult 里按消息顺序、消息内按块顺序累加 —— 与序列化完全一致。
 * 图留在原位的协议（Anthropic、Responses）上这句话同样成立，只是多余，无害。
 *
 * 确定性改写：同样的消息列表永远得到同样的结果，缓存前缀不受影响。
 */
export function labelToolResultImages<T>(messages: T[]): T[] {
  let changed = false
  let ordinal = 0
  const out = messages.map((message) => {
    const record = message as {
      role?: string
      content?: { type?: string; text?: string }[]
    }
    if (record.role !== 'toolResult') {
      ordinal = 0
      return message
    }
    if (!Array.isArray(record.content)) return message
    const count = record.content.filter((block) => block?.type === 'image').length
    if (count === 0) return message

    const first = ordinal + 1
    ordinal += count
    const range = count === 1 ? `第 ${first} 张` : `第 ${first}–${ordinal} 张`
    changed = true
    const label = {
      type: 'text',
      text: `[本结果附 ${count} 张图，是这批工具结果附图里的${range}。只按这个序号对应，别按内容猜]`
    }
    return { ...record, content: [label, ...record.content] } as unknown as T
  })
  return changed ? out : messages
}
