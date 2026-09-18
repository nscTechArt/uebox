/**
 * 把一段给眼睛看的回复，收拾成能念出口的一句。
 *
 * Agent 收尾时该用 `voice_report` 自己报一句口语（见 `tools/builtin/voiceReport.ts`），
 * 但模型会漏。漏了就轮到这里：**先由模型压一句**（`condense`，Codex 那套「后台模型
 * 先产出一段适合口头说的结果」），模型没配或者调不通再退到纯规则
 * （`stripMarkdownForSpeech` + `clipToSentences`）。规则那条永远能用，模型那条更像人话。
 *
 * 真机上退到规则之前的样子：把「**当前状态** - **UALinkDev55 编辑器在跑**（PID 5256，
 * `I:\UnrealAgent\UALinkDev55`）…」逐字念出来，星号、路径全念，还在「SampleP」处硬截断。
 */

/**
 * 念出来的上限。按每秒四个字算，160 字是四十秒。
 *
 * 这条是**收尾那一句**的额度，所以比中途进度宽（`voiceReport.ts` 的两个额度同理）。
 * 从 140 提上来是因为真机上压得太狠：Agent 屏幕上写的最后一段是「…搬完了。下一步建议：
 * 打开 XX 确认插件和资产都正常，要我现在帮你打开吗？」，念出来只剩前半句。用户没看屏幕，
 * 「接下来该说什么」这件事只能从这一句里知道 —— 被压掉他就只能干等着。
 */
export const MAX_SPOKEN_CHARS = 160

/**
 * 去掉念不出口的 markdown：标题井号、列表符号、加粗斜体星号、行内代码（多半是路径和 id，
 * 念出来没人听得懂，整段去掉）、链接只留文字、代码块整块去掉。
 */
export function stripMarkdownForSpeech(text: string): string {
  return (
    text
      // 代码块和行内代码整段去掉：里面是路径、命令、id，念出来是噪音
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      // 链接和图片只留说明文字
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 标题、引用、列表符号
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      // 加粗、斜体、删除线
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      // Windows / POSIX 路径念出来没人听得懂
      .replace(/[A-Za-z]:[\\/][^\s，。；：、）)]*/g, '')
      .replace(/(?:^|\s)\/[\w./-]{2,}/g, ' ')
      // 表格线、分隔线
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/^\s*[-=*_]{3,}\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * 截到句子边界。上限内最后一个句号/问号/叹号/分号处切；一句都装不下才硬截加省略号。
 * 硬截在半个词上（「SampleP……」）是上一版的毛病。
 */
export function clipToSentences(text: string, max = MAX_SPOKEN_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const head = flat.slice(0, max)
  const boundary = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('；'),
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? ')
  )
  // 边界太靠前（不到三分之一）就等于什么都没说，宁可硬截
  if (boundary >= Math.floor(max / 3)) return head.slice(0, boundary + 1).trim()
  return `${head.trim()}……`
}

/** 纯规则的兜底：去 markdown，截到句子边界 */
export function summarizeByRules(text: string): string {
  return clipToSentences(stripMarkdownForSpeech(text))
}

/** 交给模型压一句时的系统提示词。只压缩不添加 —— 「不许编」是语音这条线的红线 */
export const CONDENSE_SYSTEM_PROMPT = [
  '你把一段助手的书面回复压成念给用户听的口语。这是一件活做完时的交代，',
  '用户没看屏幕，他对这件事知道的全部就是你这几句。',
  '规矩：',
  '- 两到三句，不超过 120 个字，像同事在旁边搭话。',
  '- 只压缩，不添加、不评价、不安慰。回复里没有的事一个字不能说。',
  '- 说清三件事里有的那几件：做成没有、结果是什么、还需要用户做什么。',
  '- **回复末尾的下一步建议、以及在问用户的那句（「要我现在帮你打开吗」）必须留着。**',
  '  只说做完了、不说接下来，用户不知道该回什么，只能干等着 —— 那等于把话说了一半。',
  '- 不用 markdown，不念路径、代码、id、工具名。',
  '- 只输出那几句话本身，不要前缀、不要引号。'
].join('\n')

/**
 * 模型压出来的一句是否可用。空的、超长的、还带 markdown 的都不要 ——
 * 退回规则那条，宁可平淡也不能念出星号。
 */
export function acceptCondensed(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat || flat.length > MAX_SPOKEN_CHARS) return null
  if (/[*`#|\\]|https?:\/\//.test(flat)) return null
  return flat
}
