/**
 * FTS5 全文索引的文本处理：建索引时怎么切、查询时怎么拼。
 *
 * 资产库和知识库共用同一套。两边的问题一模一样：unicode61 分词器把一整串汉字
 * 当成**一个词**，「木头椅子」是一个 token，搜「椅子」永远命中不了。
 *
 * 解法是**建索引时把汉字逐字拆开**（「木 头 椅 子」），查询时把中文串拼成短语
 * （`"椅 子"`）。不需要词典、不需要分词器插件，两个字的中文词也搜得到 ——
 * 这是 trigram 分词器做不到的（它要求查询至少 3 个字符）。
 */

/** 汉字 / 假名 / 谚文 —— 这些文字之间不写空格，unicode61 会整串当一个词 */
const CJK_CLASS = '㐀-䶿一-鿿豈-﫿぀-ヿ가-힯'
const CJK_PATTERN = new RegExp(`[${CJK_CLASS}]`, 'g')
/** 带 g 的正则 test() 会留下 lastIndex，判断用不带 g 的这一个 */
const CJK_TEST = new RegExp(`[${CJK_CLASS}]`)

/** 分词器配置。两张索引表必须一致，否则同一段查询在两边的行为会不一样 */
export const FTS_TOKENIZER = "tokenize = 'unicode61 remove_diacritics 2'"

/**
 * 建索引用的文本：把每个汉字前后加空格，让它单独成词。
 * 英文原样不动 —— unicode61 已经会按 `_` 和大小写以外的分隔符切开
 * （SM_Chair_Wood → sm / chair / wood）。
 */
export function prepareIndexText(raw: unknown): string {
  const text = raw == null ? '' : String(raw)
  if (!text) return ''
  return text.replace(CJK_PATTERN, (char) => ` ${char} `)
}

/**
 * 把用户输入变成 FTS5 的 MATCH 表达式。
 *
 * **只保留字母数字和 CJK 字符**，其余一律当分隔符扔掉。这既是分词，也是转义 ——
 * FTS5 的查询语法里 `"` `*` `-` `:` `^` `(` `)` `NEAR` `AND` `OR` 都有含义，
 * 用户随手打一个引号就能让整条查询报语法错。白名单过滤之后没有任何字符能逃出去。
 *
 * 多个词之间用 OR 而不是 AND：AND 精确但经常一条都搜不到，而 OR 配上 bm25 之后，
 * 全中的自然排在只中一个的前面 —— 既不会空手而归，排序也还是对的。
 *
 * @returns MATCH 表达式；输入里没有任何可用字符时返回 null（此时不该走 FTS）
 */
export function buildFtsMatchQuery(raw: unknown): string | null {
  const terms = buildFtsTerms(raw)
  return terms.length > 0 ? terms.map((t) => t.expr).join(' OR ') : null
}

/** 查询里的一个词：给 FTS 用的表达式，和给 JS 侧比对用的原文 */
export interface FtsTerm {
  /** `"chair"*` 或 `"椅 子"` */
  expr: string
  /** 小写后的原词：`chair` / `椅子` */
  text: string
  cjk: boolean
}

/**
 * 切词的唯一实现。OR 表达式、全中表达式、JS 侧的前缀比对都从这里取词 ——
 * 各写一份的话迟早对不上：只认字母数字的那份，查「马」会拼出一个空的 AND 表达式，
 * FTS5 当场报语法错。
 */
export function buildFtsTerms(raw: unknown): FtsTerm[] {
  const text = raw == null ? '' : String(raw)
  const runs = text.match(new RegExp(`[A-Za-z0-9]+|[${CJK_CLASS}]+`, 'g'))
  if (!runs) return []

  return runs.map((run) => {
    if (CJK_TEST.test(run)) {
      // 中文串拆成逐字短语：「椅子」→ "椅 子"，只有相邻出现才算命中
      return { expr: `"${run.split('').join(' ')}"`, text: run, cjk: true }
    }
    // 英文加前缀匹配：搜 chair 也该命中 chairs / chairman
    const lower = run.toLowerCase()
    return { expr: `"${lower}"*`, text: lower, cjk: false }
  })
}

/**
 * 「全中」表达式：每个词都要出现，而且只算 name / tags / folder / type 四列。
 *
 * 不算 note 和 path：AIGC 资产的 note 是整段生成提示词，什么词都有；
 * path 是一个目录下几百个资产共享的。真机数据上，把这两列算进来会让
 * 效果图、HDRI 因为提示词里提过「mountain」「river」而排到首页。
 */
export function buildFtsAllTermsQuery(raw: unknown): string | null {
  const terms = buildFtsTerms(raw)
  if (terms.length === 0) return null
  return `{name tags folder type} : (${terms.map((t) => t.expr).join(' AND ')})`
}

/**
 * JS 侧模拟 FTS 的命中判定，给「还没进索引」的那几行用。
 *
 * 规则和索引一致：英文按非字母数字切词、词**前缀**匹配（car 命中 cars，不命中 Scarf）；
 * 中文按连续出现匹配。直接用 LIKE '%car%' 的话，索引追平前后同一个查询的结果数会跳。
 */
export function textMatchesTerm(text: string | null | undefined, term: FtsTerm): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  if (term.cjk) return lower.includes(term.text)
  const tokens = lower.split(/[^a-z0-9]+/)
  return tokens.some((token) => token.startsWith(term.text))
}
