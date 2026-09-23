/**
 * 拦下 `unreal.Rotator(a, b, c)` 这种按位置传参的写法。
 *
 * ## 为什么要在盒子这一层拦
 *
 * UE 的 JSON / C++ / 蓝图约定都是 (pitch, yaw, roll)，本仓库所有旋转说明也这么写。
 * 但 UE Python 的 `unreal.Rotator` 构造函数走的是 `KismetMathLibrary::MakeRotator`
 * 的签名，**位置参数顺序是 (roll, pitch, yaw)**。模型把工具说明里的 (pitch, yaw, roll)
 * 顺手搬进 Python，写 `unreal.Rotator(0, 90, 0)` 想要 yaw=90，实际得到 pitch=90 ——
 * 五米长的墙横着躺，相机垂直朝天，而引擎一个字都不报。
 *
 * 真机上这一课的代价：78 个部件全摆错方向，多花约 10 次往返才从一张全是云的
 * 截图里反推出原因。关键字写法 `unreal.Rotator(roll=0, pitch=0, yaw=90)` 从不出错，
 * 所以规则很简单：位置参数一律不放行，让模型改成关键字再来。
 *
 * ## 放行的例外
 *
 * - 全是字面 0 的位置参数（`Rotator(0, 0, 0)`）：顺序无所谓，拦了是噪音。
 * - 只有一个位置参数（`Rotator(other)` 是拷贝构造；`Rotator(*vals)` 无法静态判断）。
 * - 关键字写法，以及 `unreal.Rotator()` 空构造。
 *
 * 这是静态文本扫描，不是 Python 解析器：注释和字符串里的 `Rotator(` 也会命中。
 * 宁可多拦一次让模型改一行注释，也不放一个错序进引擎。
 */

export interface PositionalRotatorCall {
  /** 1 起算的行号 */
  line: number
  /** 命中的原文，例如 `unreal.Rotator(0.0, yaw, 0.0)` */
  snippet: string
  /** 按位置传的实参原文 */
  args: string[]
}

const ROTATOR_CALL = /\bRotator\s*\(/g

/**
 * 括号感知地切实参：`Rotator(math.radians(a), b)` 要切成两个而不是三个。
 *
 * `#` 注释整段跳过：多行调用每个实参后面跟一句注释很常见，不跳的话
 * `roll=0.0,  # X` 换行 `pitch=0.0` 会被切成「注释 + 下一个实参」一整段，关键字写法被误判成按位置传
 */
function splitArgs(body: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '#') {
      const end = body.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) args.push(current.trim())
  return args
}

/** 从 `(` 之后找到配对的 `)`，返回括号内的文本；找不到返回 null */
function readParenBody(text: string, openIndex: number): string | null {
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    // 注释里的撇号（`# the pitch's value`）不能当成字符串开头，否则后面的括号全配错
    if (ch === '#') {
      const end = text.indexOf('\n', i)
      if (end === -1) return null
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }
  return null
}

/** 这个位置是不是在一行的 `#` 注释里（引号里的 `#` 不算） */
function inComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  let quote: string | null = null
  for (let i = lineStart; i < index; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return true
    }
  }
  return false
}

const isKeywordArg = (arg: string): boolean => /^[A-Za-z_]\w*\s*=(?!=)/.test(arg)
const isStarArg = (arg: string): boolean => arg.startsWith('*')
const isLiteralZero = (arg: string): boolean => /^[-+]?0+(\.0*)?$/.test(arg)

/** 找出脚本里所有该拦的 `Rotator(...)` 调用 */
export function findPositionalRotatorCalls(script: string): PositionalRotatorCall[] {
  const hits: PositionalRotatorCall[] = []
  ROTATOR_CALL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ROTATOR_CALL.exec(script)) !== null) {
    // 注释里写的示例不是会执行的代码
    if (inComment(script, match.index)) continue
    const openIndex = match.index + match[0].length - 1
    const body = readParenBody(script, openIndex)
    if (body === null) continue
    const args = splitArgs(body)
    const positional = args.filter((a) => !isKeywordArg(a))
    if (positional.length < 2) continue
    if (positional.some(isStarArg)) continue
    if (positional.every(isLiteralZero)) continue

    // 往前带上 `unreal.` 这种前缀，报错时原文更好认
    let start = match.index
    while (start > 0 && /[\w.]/.test(script[start - 1])) start--
    const snippet = script.slice(start, openIndex + body.length + 2)
    const line = script.slice(0, match.index).split('\n').length
    hits.push({ line, snippet, args: positional })
  }
  return hits
}

/**
 * 拼给模型看的拒绝理由。说清三件事：哪一行、为什么错、改成什么。
 * 改法直接按「模型多半想表达的是 (pitch, yaw, roll)」给出关键字重写，
 * 它只需照抄；真想表达别的顺序，改关键字名就行。
 */
const AXES = ['roll', 'pitch', 'yaw'] as const

/**
 * 三个实参各自点名了一个不同的轴（`rot.roll` / `r.pitch` / `rot.yaw + 90`）时，按名字给关键字写法。
 * 认不全就返回 null，退回按位置猜的那一版。
 */
function axisNamedRewrite(args: string[]): string | null {
  if (args.length !== 3) return null
  const byAxis = new Map<string, string>()
  for (const arg of args) {
    const found = AXES.filter((axis) => new RegExp(`\\b${axis}\\b`, 'i').test(arg))
    if (found.length !== 1 || byAxis.has(found[0])) return null
    byAxis.set(found[0], arg)
  }
  return `unreal.Rotator(${AXES.map((axis) => `${axis}=${byAxis.get(axis)}`).join(', ')})`
}

export function describePositionalRotatorRefusal(hits: PositionalRotatorCall[]): string {
  const lines = hits.slice(0, 5).map((h) => {
    // 实参自己带着轴名（`rot.roll, rot.pitch, rot.yaw + 90`）时按名字对，不按位置猜 ——
    // 那种写法本来就是 UE 的顺序，按 (pitch, yaw, roll) 硬映射给出的「照抄版」是转乱的
    const named = axisNamedRewrite(h.args)
    if (named) {
      return `- 第 ${h.line} 行 \`${h.snippet}\` → 改成 \`${named}\``
    }
    const [a = '0', b = '0', c = '0'] = h.args
    const rewrite =
      h.args.length === 3
        ? `unreal.Rotator(roll=${c}, pitch=${a}, yaw=${b})`
        : 'unreal.Rotator(roll=…, pitch=…, yaw=…)'
    return `- 第 ${h.line} 行 \`${h.snippet}\` → 若你想表达的是 (pitch, yaw, roll)，改成 \`${rewrite}\``
  })
  const more = hits.length > 5 ? `\n（还有 ${hits.length - 5} 处未列出）` : ''
  return (
    '脚本没有执行：unreal.Rotator 用了位置参数。' +
    'UE Python 里 unreal.Rotator 的位置参数顺序是 (roll, pitch, yaw)，' +
    '跟 JSON / 蓝图的 (pitch, yaw, roll) 相反 —— 按后者传，yaw 会被写进 pitch，' +
    '墙横着躺、镜头朝天，而引擎不报任何错。写 Python 时旋转一律用关键字：\n' +
    lines.join('\n') +
    more +
    '\n改成关键字写法后重新执行即可。'
  )
}
