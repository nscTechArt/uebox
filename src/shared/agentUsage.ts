/**
 * 一轮对话花掉的 token。
 *
 * 与 `agent-v3:context-usage` **不是一回事**：那个是「模型此刻看得见多大的上下文」，
 * 是个瞬时快照，压缩一次就会掉回去；这个是「这一轮往厂商发出去多少、收回来多少」，
 * 只增不减，也是账单上真正计费的那个数。
 *
 * 字段沿用 pi 的 `Usage`，跨轮相加：一轮里模型往返很多次（每次工具调用之后
 * 都是一次新请求），每次的输入都带着到那一刻为止的完整上下文，所以 `input`
 * 会比「上下文有多大」大出好几倍 —— 这是对的，厂商就是这么收钱的。
 */
export interface AgentTurnUsage {
  /** 输入 token，不含命中缓存的部分 */
  input: number
  /** 输出 token，含推理 token */
  output: number
  /** 命中缓存读掉的 token，单价通常比 input 低一个数量级 */
  cacheRead: number
  /** 写进缓存的 token */
  cacheWrite: number
  /** 上面四项之和。厂商各自的 totalTokens 口径不一，这里自己加，保证前后一致 */
  total: number
  /** 美元。厂商没给价的模型算出来就是 0 */
  cost: number
}

/**
 * pi 的 `Usage` 里我们要的那几个字段。
 *
 * 写成结构类型而不是 `import type { Usage }`：共享层被渲染进程也编译，
 * 不该为了一个数字形状把 pi 的类型拖进去。
 */
export interface PiUsageLike {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

export const EMPTY_TURN_USAGE: AgentTurnUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0
})

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 把 pi 报的用量收敛成本仓的形状。字段缺失一律按 0，不让 NaN 漏到界面上 */
export function toTurnUsage(usage: PiUsageLike | undefined | null): AgentTurnUsage {
  const input = num(usage?.input)
  const output = num(usage?.output)
  const cacheRead = num(usage?.cacheRead)
  const cacheWrite = num(usage?.cacheWrite)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost: num(usage?.cost?.total)
  }
}

/** 累加两笔用量。返回新对象 —— 调用方多半在往响应式状态里塞，就地改容易漏触发 */
export function mergeTurnUsage(a: AgentTurnUsage, b: AgentTurnUsage): AgentTurnUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    cost: a.cost + b.cost
  }
}

/**
 * 值不值得显示。
 *
 * 全 0 说明这一轮压根没走到厂商那边（本地失败、用户秒停），
 * 显示一个「0 tokens」只会让人以为统计坏了。
 */
export function hasTurnUsage(usage: AgentTurnUsage | undefined | null): boolean {
  if (!usage) return false
  return usage.total > 0 || usage.cost > 0
}
