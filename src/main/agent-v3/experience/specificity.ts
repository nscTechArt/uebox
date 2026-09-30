/**
 * 报错片段够不够具体：太宽的片段会命中不相干的报错。
 *
 * ## 为什么要管
 *
 * 召回的判据是「归一化后的报错里原样含有这一段」。片段写成 `not found`，
 * 所有 not found 都会命中；写成 `has no attribute`，Python 里一半的报错都会命中。
 * 研究里叫负迁移：召回了不相关的经验，比不召回更糟。
 *
 * ## 上帝工具要更严
 *
 * `ue_run_python_script` 和 `ue_run_console_command` 跑的是模型现写的代码，
 * 任何事都能做，报错来自任何地方。同一个工具名下，今天是「角色没有 is_hidden」，
 * 明天是「材质没有 used_with_landscape」—— 工具名这把钥匙几乎不起区分作用，
 * 区分全压在片段上。所以对它们：
 *
 * - 只学 Python 异常（`XxxError: ...`）。「执行未确认」「没连上」这类不是知识。
 * - 不学脚本自己的 bug：NameError（变量名打错）、SyntaxError 等。那是这一次现写的
 *   代码写错了，不是引擎的规矩，下次写的是另一段代码。
 * - 片段必须带一个引号里的名字（类名、属性名、函数名、参数名），知识就在那个名字上。
 * - 片段要覆盖异常信息的大半（≥ 50%）。召回时拿**新报错**再算一次：
 *   新报错里只有一小部分和片段重合，说明是另一件事。
 *
 * 同一套判据在两个地方用：整理员写入前（`curator.ts`），召回时（`recall.ts`）——
 * 后者兜住手改过的、以及这条规则之前写下的旧经验。
 */

/** 跑任意代码的工具：工具名几乎不区分报错，片段要更严 */
export const STRICT_TOOLS: ReadonlySet<string> = new Set([
  'ue_run_python_script',
  'ue_run_console_command'
])

/** 只要 Python 异常的工具（控制台命令的报错不是 Python 格式） */
const PYTHON_TOOLS: ReadonlySet<string> = new Set(['ue_run_python_script'])

/** 脚本自己写错了，不是引擎的规矩 */
const SCRIPT_BUG =
  /^(nameerror|syntaxerror|indentationerror|taberror|unboundlocalerror|assertionerror|zerodivisionerror|keyboardinterrupt|recursionerror)$/

/** 片段最短多长。6 太短：`failed` 就满足了 */
export const MIN_PATTERN_LENGTH = 12
/** 上帝工具：片段至少覆盖异常信息的这么多 */
export const MIN_COVERAGE = 0.5

/**
 * 报错里的通用词：光靠它们拼出来的片段，什么报错都能对上。
 * 全是小写（归一化之后的样子）。
 */
const GENERIC_WORDS = new Set(
  (
    'error errors failed failure fail fails not found invalid cannot can could unable none null ' +
    'nonetype object attribute value type missing unknown exception warning the a an to for of in ' +
    'on with is was are has have no at by from and or be been did does expected got given argument ' +
    'arguments parameter parameters property function method class module name file path id line ' +
    'call calling convert when this that must should required no such exist exists does done ' +
    'traceback most recent last str int float bool list dict tuple set real number string ' +
    'attributeerror typeerror valueerror runtimeerror exception keyerror indexerror'
  ).split(' ')
)

/** 中文里的通用词。四个字以上的中文串去掉它们后还剩字，才算具体 */
const GENERIC_CJK = /失败|错误|未找到|找不到|无效|不存在|无法|不能|异常|超时|请|重试|检查/g

export interface ExceptionLine {
  type: string
  message: string
  line: string
}

/** 归一化后的报错如果是 Python 异常行，拆出类型和信息 */
export function exceptionLine(normalized: string): ExceptionLine | undefined {
  const match = normalized.match(/^([a-z][a-z0-9_]*(?:error|exception|warning)): (.+)$/)
  return match ? { type: match[1], message: match[2], line: normalized } : undefined
}

/** 片段里能起区分作用的词：引号里的名字、带下划线/点的标识符、不在通用词表里的词、中文实词 */
export function distinctiveTokens(pattern: string): string[] {
  const text = pattern.toLowerCase().replace(/<(n|id|path)>/g, ' ')
  const tokens: string[] = []
  for (const quoted of text.matchAll(/'([^']{2,})'/g)) tokens.push(quoted[1])
  for (const word of text.match(/[a-z_][a-z0-9_.]*/g) ?? []) {
    if (word.length >= 3 && !GENERIC_WORDS.has(word)) tokens.push(word)
  }
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) {
    if (run.replace(GENERIC_CJK, '').length >= 2) tokens.push(run)
  }
  return [...new Set(tokens)]
}

export type PatternProblem =
  | 'too-short'
  | 'generic'
  | 'not-in-error'
  | 'no-exception'
  | 'script-bug'
  | 'no-identifier'
  | 'too-wide'

/**
 * 这一次报错本身值不值得学（还没到片段那一步）。上帝工具才有额外要求。
 * 整理员用它提前筛掉，省得为一条注定被丢掉的经验花一次模型调用。
 */
export function errorProblem(tool: string, normalizedError: string): PatternProblem | undefined {
  if (!STRICT_TOOLS.has(tool)) return undefined
  const ex = exceptionLine(normalizedError)
  if (PYTHON_TOOLS.has(tool) && !ex) return 'no-exception'
  if (ex && SCRIPT_BUG.test(ex.type)) return 'script-bug'
  return undefined
}

/**
 * 片段对这条报错来说够不够具体。没问题回 undefined。
 *
 * `normalizedError` 在写入时是学到它的那次报错，在召回时是**这一次**的新报错。
 */
export function patternProblem(
  tool: string,
  pattern: string,
  normalizedError: string
): PatternProblem | undefined {
  const p = pattern.trim().toLowerCase()
  if (p.length < MIN_PATTERN_LENGTH) return 'too-short'
  if (!normalizedError.includes(p)) return 'not-in-error'
  if (distinctiveTokens(p).length === 0) return 'generic'

  const fromError = errorProblem(tool, normalizedError)
  if (fromError) return fromError
  if (!STRICT_TOOLS.has(tool)) return undefined

  if (!/'[^'<>]{2,}'/.test(p)) return 'no-identifier'
  const ex = exceptionLine(normalizedError)
  // 片段带着异常类型就和整行比，不带就和冒号后面的信息比
  const target = ex ? (p.startsWith(ex.type) ? ex.line : ex.message) : normalizedError
  if (p.length / target.length < MIN_COVERAGE) return 'too-wide'
  // 报错在说的那个名字必须在片段里。`'character' object has no` 带了名字、也够长，
  // 可它对角色的任何属性都成立 —— 知识在最后那个 `'is_hidden'` 上
  const subject = subjectName(ex ? ex.message : normalizedError)
  if (subject && !p.includes(`'${subject}'`)) return 'too-wide'
  return undefined
}

/**
 * 报错在说的那个名字：信息里最后一个引号名，跳过带占位符的（`'assetregistryimpl_<n>'`
 * 这种实例名每次都变，不是知识）。
 *
 * 「最后一个」是看真实报错定的：`'Character' object has no attribute 'is_hidden'`、
 * `Failed to find property 'used_with_landscape'`、`required argument 'source_or_target'` ——
 * 主语在前、缺的那个东西在后。
 */
export function subjectName(message: string): string | undefined {
  const names = [...message.matchAll(/'([^']{2,})'/g)]
    .map((m) => m[1])
    .filter((n) => !n.includes('<'))
  return names[names.length - 1]
}
