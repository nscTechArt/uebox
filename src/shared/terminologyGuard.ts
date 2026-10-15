/**
 * 术语守卫的共用件：禁用词表 + 扫描函数。
 *
 * 只给两个术语守卫测试用 —— 界面文案守卫（`renderer/src/i18n/terminologyGuard.test.ts`）
 * 和工具说明守卫（`main/agent-v3/tools/toolTextTerminology.test.ts`）。不是生产代码，
 * 别在别处 import。
 *
 * 放在 `src/shared/`：`tsconfig.node.json` 与 `tsconfig.web.json` 都把它收进自己的 include，
 * `scripts/typecheck-changed.mjs` 也把它当主进程与渲染层之间的共用缝，改这里两侧都会查。
 *
 * 改 `CONTEXT.md` 的 _Avoid_ 时同步这里的 `BANNED_TERMS`，两处一起改。
 */

/** 一条禁用词：`word` 是要在文案里拦下的写法，`suggestion` 告诉贡献者该换成什么 */
export interface BannedTerm {
  word: string
  suggestion: string
}

/**
 * 禁用词表。来源：`CONTEXT.md` 的 _Avoid_，是有意挑选的子集；改这张表时同步 `CONTEXT.md`。
 *
 * Thread、Fork 不入表，只靠词汇表约束 —— UE 与内核语境里有正常用法
 * （Game Thread、内核复制 session 的 fork），入表会把它们一并拦掉。
 *
 * 含汉字的词按子串匹配，有已知的跨词误报：「社会话题」含「会话」、「撤回合并」含「回合」。
 * 碰上时优先改写那句文案；改写不掉的正当用法（引擎界面名、外部协议名）
 * 加白名单，每条写清理由。
 */
export const BANNED_TERMS: BannedTerm[] = [
  // 对话主体
  { word: '聊天', suggestion: '对话' },
  { word: '回合', suggestion: '一轮' },
  { word: '一问一答', suggestion: '一轮' },
  { word: 'exchange', suggestion: 'turn' },
  // 分支
  { word: '会话分支', suggestion: '分支' },
  { word: '对话分支', suggestion: '分支' },
  // 侧边问一句
  { word: '侧边对话', suggestion: '侧边问一句' },
  { word: 'side chat', suggestion: 'side question' },
  // 语音通话
  { word: '语音对话', suggestion: '语音通话' },
  // 小窗
  { word: 'MiniChat', suggestion: 'mini window' },
  { word: 'Mini Chat', suggestion: 'mini window' },
  { word: '迷你对话', suggestion: '小窗' },
  // 不是对话的「会话」
  { word: '内核记忆', suggestion: '只说用户能理解的后果' },
  // 对话之外不再有「会话」，英文里指对话的一律 chat
  { word: '会话', suggestion: '对话（调试台写 session）' },
  {
    word: 'session',
    suggestion: '对话写 chat；登录写 sign-in / signed out；网络库导入写 import（调试台除外）'
  },
  {
    word: 'sessions',
    suggestion: '对话写 chat；登录写 sign-in / signed out；网络库导入写 import（调试台除外）'
  },
  { word: 'conversation', suggestion: 'chat' },
  { word: 'conversations', suggestion: 'chat' }
]

/** 一片叶子字符串：`path` 是文案里的完整 key（数组元素带下标），`text` 是文案本身 */
export interface Leaf {
  path: string
  text: string
}

/** 含汉字的禁用词按子串匹配，其余（拉丁字母的词）按单词边界、不区分大小写 */
const CJK_CHAR = /[一-鿿]/

/** 插值占位符是运行时才填的值，不算文案 —— 先剥掉再匹配（`{session}` 不算命中 session） */
const INTERPOLATION = /\{\w+\}/g

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 返回在这段文案里命中的禁用词条目。匹配方式按禁用词本身的写法决定，对所有来源一视同仁 */
function matchTerms(text: string, terms: BannedTerm[]): BannedTerm[] {
  const plain = text.replace(INTERPOLATION, '')
  return terms.filter((term) => {
    if (CJK_CHAR.test(term.word)) return plain.includes(term.word)
    return new RegExp(`\\b${escapeRegExp(term.word)}\\b`, 'i').test(plain)
  })
}

/**
 * 扫一批叶子，返回逐条失败信息（key 路径、命中词、替换建议；来源由调用方拼在前面）。
 * 白名单按完整 key 放行指定条目，放行之外照样报。
 */
export function scan(
  leaves: Leaf[],
  terms: BannedTerm[],
  whitelist: Map<string, string[]>
): string[] {
  const failures: string[] = []
  for (const leaf of leaves) {
    const allowed = whitelist.get(leaf.path) ?? []
    for (const term of matchTerms(leaf.text, terms)) {
      if (allowed.includes(term.word)) continue
      failures.push(`${leaf.path}：命中「${term.word}」，建议改为「${term.suggestion}」`)
    }
  }
  return failures
}
