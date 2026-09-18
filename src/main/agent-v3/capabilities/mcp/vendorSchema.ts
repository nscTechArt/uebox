/**
 * 把第三方 MCP server 的 JSON Schema 压成**厂商收得下**的子集。
 *
 * ## 为什么必须做
 *
 * MCP 的 `inputSchema` 就是 JSON Schema，理论上原样交给厂商即可 ——
 * 我们一开始也是这么做的。问题是「合法的 JSON Schema」远大于
 * 「厂商 function calling 接口收的 JSON Schema」：
 *
 *   - `$defs` + `$ref`：标准写法，OpenAI / DeepSeek 等的工具定义不解引用
 *   - `oneOf` / `anyOf` / `allOf`：同上
 *
 * 而厂商拒的**不是那一个工具，是整个请求**。也就是说，用户接进来一个
 * 用了 `$ref` 的第三方 server，会导致这次对话里**所有工具全部失效**，
 * 包括盒子自己的 77 个。故障范围和原因完全对不上，极难排查。
 *
 * 这不是假想 —— `tests/fixtures/mcp/quirky-server.mjs` 就是照着真实
 * 第三方 server 的写法造的，接进来时确实原样透传了。
 *
 * ## 取舍
 *
 * 压缩是**有损**的：`oneOf` 表达的约束没法在子集里等价表示。
 * 这里选择**放宽而不是猜**——把表达不了的位置降级成"任意值"，
 * 让模型能填、由对方 server 自己去校验。反过来（猜一个具体类型）
 * 会让模型填不出对方要的形状，那是更糟的失败。
 */

/** 递归深度上限。防 `$ref` 成环，也防恶意 server 用超深嵌套撑爆内存 */
const MAX_DEPTH = 12

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 顺着 `#/$defs/foo` 这类指针取出被引用的 schema */
function resolveRef(ref: string, root: Schema): Schema | undefined {
  if (!ref.startsWith('#/')) return undefined // 外部引用取不到，也不该去取

  let current: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    // JSON Pointer 的转义：~1 是 /，~0 是 ~
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isSchema(current)) return undefined
    current = current[segment]
  }
  return isSchema(current) ? current : undefined
}

/**
 * 合并 `allOf` 的各分支。
 *
 * 只做浅合并：`properties` 取并集，`required` 取并集。
 * 深合并需要处理冲突语义，收益不抵复杂度 —— 而且真实 server 里
 * `allOf` 基本都是"加几个字段"的用法。
 */
function mergeAllOf(branches: Schema[], root: Schema, depth: number): Schema {
  const properties: Schema = {}
  const required: string[] = []

  for (const branch of branches) {
    const flat = flatten(branch, root, depth)
    if (isSchema(flat.properties)) Object.assign(properties, flat.properties)
    if (Array.isArray(flat.required)) {
      for (const key of flat.required) if (typeof key === 'string') required.push(key)
    }
  }

  const out: Schema = { type: 'object', properties }
  if (required.length) out.required = [...new Set(required)]
  return out
}

/**
 * 合并 `oneOf` / `anyOf` 的各分支。
 *
 * 各分支同类型时保留该类型（信息没丢，只是丢了"必须是其中之一"）；
 * 类型不一致就整个降级成任意值 —— 见文件头关于取舍的说明。
 */
function mergeUnion(branches: Schema[], root: Schema, depth: number, base: Schema): Schema {
  const flattened = branches.map((branch) => flatten(branch, root, depth))
  const types = new Set(flattened.map((s) => s.type).filter((t) => typeof t === 'string'))

  const description = base.description ?? flattened.find((s) => s.description)?.description
  const carry = description ? { description } : {}

  if (types.size !== 1) return carry

  const [type] = [...types]
  if (type !== 'object') return { ...carry, type }

  // 都是 object：属性取并集，required 取交集（各分支都要求才算真的必填）
  const properties: Schema = {}
  let required: string[] | null = null
  for (const branch of flattened) {
    if (isSchema(branch.properties)) Object.assign(properties, branch.properties)
    const branchRequired = Array.isArray(branch.required)
      ? branch.required.filter((k): k is string => typeof k === 'string')
      : []
    required =
      required === null ? branchRequired : required.filter((k) => branchRequired.includes(k))
  }

  const out: Schema = { ...carry, type: 'object', properties }
  if (required?.length) out.required = required
  return out
}

/** 递归展平一个 schema 节点 */
function flatten(node: unknown, root: Schema, depth: number): Schema {
  if (!isSchema(node)) return {}
  if (depth > MAX_DEPTH) return {} // 成环或过深：降级成任意值，别抛异常

  // $ref 先解引用，解不开就当任意值 —— 保留一个解不开的 $ref 会让整个请求被拒
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root)
    return target ? flatten(target, root, depth + 1) : {}
  }

  if (Array.isArray(node.allOf)) {
    return mergeAllOf(node.allOf.filter(isSchema), root, depth + 1)
  }

  const union = node.oneOf ?? node.anyOf
  if (Array.isArray(union)) {
    return mergeUnion(union.filter(isSchema), root, depth + 1, node)
  }

  const out: Schema = {}
  for (const [key, value] of Object.entries(node)) {
    // $defs / definitions 是给 $ref 用的仓库，引用都内联之后它就是死重量，
    // 而且厂商看到不认识的顶层关键字同样可能拒
    if (key === '$defs' || key === 'definitions' || key === '$schema' || key === '$id') continue

    if (key === 'properties' || key === 'patternProperties') {
      if (!isSchema(value)) continue
      const mapped: Schema = {}
      for (const [name, sub] of Object.entries(value)) {
        mapped[name] = flatten(sub, root, depth + 1)
      }
      out[key] = mapped
      continue
    }

    if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      // items 可以是数组（元组形式）
      out[key] = Array.isArray(value)
        ? value.map((item) => flatten(item, root, depth + 1))
        : isSchema(value)
          ? flatten(value, root, depth + 1)
          : value
      continue
    }

    out[key] = value
  }
  return out
}

/**
 * 入口：把第三方工具的 `inputSchema` 压成厂商安全的形态。
 *
 * 顶层强制是 `{ type: 'object' }` —— 厂商的工具参数只接受对象。
 * 对方给了别的（或者没给 type），补成空对象比让厂商拒掉整个请求好。
 */
export function toVendorSafeSchema(inputSchema: unknown): Record<string, unknown> {
  const flattened = flatten(inputSchema, isSchema(inputSchema) ? inputSchema : {}, 0)

  if (flattened.type !== 'object') {
    return {
      type: 'object',
      properties: isSchema(flattened.properties) ? flattened.properties : {}
    }
  }
  if (!isSchema(flattened.properties)) {
    flattened.properties = {}
  }
  return flattened
}
