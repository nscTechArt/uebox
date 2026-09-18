/**
 * 检索结果的回读校验。
 *
 * ## 为什么需要这一层
 *
 * 搜索后端失手的时候，**不会告诉你它失手了**。实测过的每一条免密钥路线都一样：
 * HTTP 200、结构完整、`<channel><title>` 还回显你的查询词，但 `<item>` 里装的
 * 是和查询毫无关系的东西 —— 查 UE 的 C++ API 回来一批银行官网，查「世界最高的
 * 山」回来一个桌宠项目。同一条查询连跑四次，四批不同的垃圾。
 *
 * 这比「搜不到」坏得多：模型看到的是一批**格式正确的结果**，会拿它当事实往下走。
 *
 * 所以这一层做的事只有一件 —— **没有回读校验就不许报 success**。宁可说
 * 「搜到的东西和你问的没关系」，也不把噪声当答案递出去。
 *
 * ## 判据为什么只用字面重合
 *
 * 只用便宜、确定、可复现的信号：查询词切碎之后，有没有出现在结果的标题、摘要
 * 或网址里。不引模型打分 —— 那会让「检索是否可信」这件事本身又依赖一次可能
 * 出错的推理，而且每次搜索都要多花一次调用。
 *
 * ## 已知的取舍
 *
 * 会有**假阴性**：语义相关但字面不重合的好结果会被标成存疑（查「最高的山」
 * 返回「珠穆朗玛峰」就是）。这个取舍是**故意选的** —— 在「偶尔多标一句存疑」
 * 和「把某银行官网当成 UE C++ 文档喂给模型」之间，选前者。
 *
 * 所以判据只在一个方向上是硬的：**全部零命中才判失败**。单条零命中只标注，
 * 不丢弃。
 */

/** 判定结果里带上这个，调用方决定怎么呈现 */
export type Relevance = 'ok' | 'unclear'

/**
 * 太常见的词，出现在哪里都不说明相关。
 *
 * 故意保持很短：这个表越长，越容易把真正有信息量的词误删。像 `world`、`engine`
 * 这种看起来普通但能定位内容的词一律不收。
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'not',
  'what',
  'which',
  'who',
  'how',
  'why',
  'when',
  'where',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'here',
  'there',
  'nothing',
  'something',
  'anything',
  'random',
  'should',
  'would',
  'could',
  'can',
  'will',
  'do',
  'does',
  'did',
  'with',
  'from',
  'about'
])

/** 连续的中日韩字符。中文不按空格分词，得单独抓出来再切 */
const CJK_RUN = /[㐀-䶿一-鿿぀-ヿ가-힯]+/g

/** 拉丁字母、数字、以及技术标识里常见的下划线连字符和点 */
const LATIN_TOKEN = /[a-z0-9][a-z0-9._-]*/g

/**
 * 把查询切成用于比对的词。
 *
 * `site:` 这类限定语法要**保留域名丢掉前缀** —— 用户写 `site:dev.epicgames.com
 * nanite` 时，`dev.epicgames.com` 恰恰是最该出现在结果网址里的东西，把整段扔掉
 * 反而丢了最强的一个信号。
 */
export function tokenizeQuery(query: string): string[] {
  // site:example.com / filetype:pdf —— 前者留值，后者整个丢（文件类型不出现在标题里）
  const normalized = query
    .toLowerCase()
    .replace(/\b(?:site|inurl|intitle):/g, ' ')
    .replace(/\b(?:filetype|ext):\S+/g, ' ')
    // 减号排除项：用户明说不要的东西，出现与否都不算命中
    .replace(/(^|\s)-\S+/g, ' ')

  const tokens = new Set<string>()

  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    // 中文按 2-gram 切。单字太容易撞上无关内容，整串又太容易一个字都对不上
    for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2))
  }

  for (const token of normalized.match(LATIN_TOKEN) ?? []) {
    // 单字符和纯标点残留没有区分度
    if (token.length < 2) continue
    if (STOPWORDS.has(token)) continue
    tokens.add(token)
  }

  return [...tokens]
}

/** 一条结果里可供比对的全部文本 */
function haystack(item: { title: string; url: string; snippet?: string }): string {
  return `${item.title} ${item.snippet ?? ''} ${item.url}`.toLowerCase()
}

export interface RelevanceReport<T> {
  /** 原样带回，每条多一个 relevance 字段 */
  items: (T & { relevance: Relevance })[]
  /** 有几条对得上 */
  matched: number
  /**
   * 是不是**整批**都对不上。
   *
   * 这是唯一会导致「报失败」的信号。单条对不上只标注 —— 语义相关但字面不重合
   * 的好结果不该因为一个便宜判据就被丢掉。
   */
  allUnclear: boolean
}

/** 给一批结果逐条打标，并给出「整批是否都对不上」 */
export function judgeResults<T extends { title: string; url: string; snippet?: string }>(
  query: string,
  items: T[]
): RelevanceReport<T> {
  const tokens = tokenizeQuery(query)
  const judged = items.map((item) => ({
    ...item,
    relevance:
      tokens.length === 0
        ? ('ok' as const)
        : tokens.some((token) => haystack(item).includes(token))
          ? ('ok' as const)
          : ('unclear' as const)
  }))
  const matched = judged.filter((item) => item.relevance === 'ok').length

  return {
    items: judged,
    matched,
    // 空结果不算「整批对不上」—— 那是「没有结果」，是另一回事，由调用方各自处理
    allUnclear: judged.length > 0 && matched === 0
  }
}
