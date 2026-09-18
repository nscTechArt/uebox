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
  const text = raw == null ? '' : String(raw)
  const runs = text.match(new RegExp(`[A-Za-z0-9]+|[${CJK_CLASS}]+`, 'g'))
  if (!runs || runs.length === 0) return null

  const terms = runs.map((run) => {
    if (CJK_TEST.test(run)) {
      // 中文串拆成逐字短语：「椅子」→ "椅 子"，只有相邻出现才算命中
      return `"${run.split('').join(' ')}"`
    }
    // 英文加前缀匹配：搜 chair 也该命中 chairs / chairman
    return `"${run.toLowerCase()}"*`
  })

  return terms.join(' OR ')
}
