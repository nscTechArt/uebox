/**
 * 工具选择的度量。
 *
 * ## 为什么要单独量这件事
 *
 * 通过率回答的是「做没做成」，回答不了「为什么做不成」。工具池大了之后，
 * 失败会分成两种完全不同的原因，而修法相反：
 *
 *   - **检索缺口**：正确的工具压根没在候选里 → 修法是让模型看到更多
 *   - **混淆缺口**：正确的工具就在眼前，模型还是选了别的 → 修法是让工具更可区分
 *
 * 我们目前一次性把全部工具都给模型，所以**检索缺口按定义为零，所有选择失败
 * 都是混淆缺口**。这正是"合并重复工具、改掉骗人的名字"能改善、而"按需加载"
 * 改善不了的那一半。
 *
 * ## 三个指标，都不需要逐条人工标注
 *
 * 1. **必需工具命中**：任务不调它就不可能完成的那几个，调到了没有。
 * 2. **离题调用**：调了 scope 之外命名空间的工具。模型在别的抽屉里翻，
 *    说明它没认出该用哪个。
 * 3. **兜底率**：有专用工具却去调 `ue_run_python_script` / `run_shell_command`。
 *    这是混淆最锋利的信号 —— 模型放弃找工具，改成自己写代码绕过去。
 *
 * 三个都从现有的 `toolCalls` 直接算得出来，用例只需要多声明一个 `scope`。
 *
 * ## 刻意不做的
 *
 * 不比对"标准调用序列"。同一个任务有多条合法路径，拿一条参考答案去卡，
 * 量到的是"像不像我写的那条路"，不是"选得对不对"。
 *
 * ## 一个已知的误报，读数字之前必须知道
 *
 * **兜底 ≠ 混淆。主工具坏掉时，这里会把正确的绕路记成选错。**
 *
 * 首轮真机跑出 9 次兜底，几乎全部来自 E4 一题。查下去才发现原因不是模型
 * 选不对工具：`ue_screenshot` 连续 5 次超时（裸 RPC 同样超时，坏在插件侧），
 * 模型改用 HighResShot 控制台指令 + list_local_dir + read_local_file 把图
 * 弄了出来 —— 那是正确的恢复行为，恰恰是我们希望它做的。
 *
 * 所以兜底率高的时候，**先看同一批调用里有没有连续失败的主工具**，
 * 再下"模型分不清工具"的结论。只读汇总数字会把工具故障误诊成选择问题，
 * 然后照着错误的诊断去改架构。
 */

/**
 * 审批门拦下调用时塞回给模型的那句话（见 core/approval.ts）。
 *
 * 认这句话是为了区分「调了」和「真的跑了」—— 被拦下的调用什么都没做。
 */
const APPROVAL_DENIED = /用户拒绝执行|拒绝执行/

/**
 * 这次工具调用是不是**真的执行**了。
 *
 * 真机上踩到的：D2「把引擎升级到 UE5.6」被判失败，理由是「过程中动了本地
 * 磁盘」。查下去发现那次 run_shell_command **被审批门拦住了**，磁盘根本没被碰，
 * 模型随后也正确拒绝了这个越界请求。判定只看「调用出现在列表里」，
 * 于是把护栏生效记成了闯祸 —— 等于在惩罚正确行为。
 *
 * 报错的同理：调用炸了就是没产生副作用。
 */
export function toolCallExecuted(call) {
  if (!call) return false
  if (call.isError === true) return false
  return !APPROVAL_DENIED.test(String(call.result ?? ''))
}

/** 模型放弃找专用工具、改成自己写代码的兜底路径 */
export const FALLBACK_TOOLS = ['ue_run_python_script', 'run_shell_command']

/**
 * 任何任务都可能合理用到的「定位」工具，不计入离题。
 *
 * 模型开工前问一句"现在开的是哪个工程""库里有什么"是正常的，
 * 把这些算成离题会让指标一片红，反而看不见真正的误选。
 */
export const ORIENTATION_TOOLS = [
  'ue_get_project_info',
  'ue_content_search',
  'ue_get_actor',
  'search_assets',
  // 只读地查函数和引脚签名，是「写图之前先摸清楚」的一步，
  // 和上面几个一样不该算离题
  'blueprint_search_nodes',
  'load_skill',
  'read_skill_resource',
  'read_local_file',
  'list_local_dir',
  'find_local_files',
  'grep_local_files'
]

/**
 * 从 `/api/debug/tools` 建 name → namespace 的索引。
 *
 * 拿不到索引就返回空 Map，分析层会退化成"只算命中和兜底"而不是瞎猜命名空间。
 */
export function buildToolIndex(toolList) {
  const index = new Map()
  for (const t of toolList ?? []) {
    if (t?.name) index.set(t.name, t.namespace ?? '')
  }
  return index
}

/**
 * 分析一次运行的工具选择。
 *
 * @param toolCalls 形如 [{ name, args, isError }]
 * @param spec 用例上的声明：{ scope?: string[], expectTools?: string[], allowFallback?: boolean }
 * @param index buildToolIndex 的结果
 */
export function analyzeToolChoice(toolCalls, spec = {}, index = new Map()) {
  const calls = (toolCalls ?? []).filter((c) => c && typeof c.name === 'string')
  const names = calls.map((c) => c.name)

  const expected = spec.expectTools ?? []
  const missing = expected.filter((name) => !names.includes(name))

  const fallbacks = spec.allowFallback ? [] : calls.filter((c) => FALLBACK_TOOLS.includes(c.name))

  const scope = spec.scope ?? []
  // 没声明 scope 就不判离题 —— 宁可少报，也不要拿猜出来的基线去指控模型
  const offScope = scope.length
    ? calls.filter((c) => {
        if (ORIENTATION_TOOLS.includes(c.name)) return false
        // 已经算作兜底的不再算离题。两个桶重叠的话，读报告的人没法把
        // 数字加起来，也分不清「翻错了抽屉」和「干脆绕过工具自己写代码」
        if (fallbacks.includes(c)) return false
        const ns = index.get(c.name)
        // 索引里没有的工具（比如第三方 MCP）不判离题，我们不知道它属于哪一类
        if (!ns) return false
        return !scope.some((s) => ns === s || ns.startsWith(`${s}.`))
      })
    : []

  // 同名同参调两次以上：模型在原地打转，通常是没看懂上一次的返回
  const seen = new Map()
  const repeats = []
  for (const c of calls) {
    const key = `${c.name}:${JSON.stringify(c.args ?? {})}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n === 2) repeats.push(c.name)
  }

  return {
    total: calls.length,
    failed: calls.filter((c) => c.isError).length,
    /** 声明了必需工具且全部调到 */
    hit: expected.length > 0 && missing.length === 0,
    hasExpectation: expected.length > 0,
    missing,
    offScope: offScope.map((c) => c.name),
    fallbacks: fallbacks.map((c) => c.name),
    repeats
  }
}

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '-')

/**
 * 汇总所有用例的工具选择表现。
 *
 * 汇总而不是逐条打印：单次跑偏可能是运气，只有比例才说明工具集本身有问题。
 */
export function summarizeToolChoice(results, index = new Map()) {
  const rows = []
  // 没有索引就判不了离题（每个工具属于哪个命名空间无从得知）。
  // 这时必须在报告里说「判不了」，而不是打印一个 0 —— 那个 0 看着像满分，
  // 实际是「一次都没检查过」。
  const scopeMeasurable = index.size > 0
  for (const r of results ?? []) {
    for (const a of r.attempts ?? []) {
      // 环境中断那几次没有可分析的调用，混进来会把分母做大
      if (a.envDown) continue
      rows.push({ id: r.id, spec: r, stat: analyzeToolChoice(a.run?.toolCalls, r, index) })
    }
  }

  const totals = rows.reduce(
    (acc, { stat }) => ({
      calls: acc.calls + stat.total,
      failed: acc.failed + stat.failed,
      offScope: acc.offScope + stat.offScope.length,
      fallbacks: acc.fallbacks + stat.fallbacks.length,
      repeats: acc.repeats + stat.repeats.length,
      withExpectation: acc.withExpectation + (stat.hasExpectation ? 1 : 0),
      hits: acc.hits + (stat.hit ? 1 : 0)
    }),
    { calls: 0, failed: 0, offScope: 0, fallbacks: 0, repeats: 0, withExpectation: 0, hits: 0 }
  )

  return { rows, totals, scopeMeasurable }
}

/** 把汇总打成一段可读的报告。返回字符串，方便测试和落盘。 */
/**
 * @param toolSearch 这一轮是不是开着工具搜索。开着的时候「全部工具一次性可见」
 *   不再成立，失败可能是**检索没找到**而不是混淆 —— 这两者的修法相反
 *   （一个改描述判别力，一个改分组/检索），抬头写错会把读报告的人引到反方向。
 *   写死那句话是工具搜索出现之前留下的，2026-09-17 改成按实际形态分叉。
 */
export function formatToolChoiceReport({ rows, totals, scopeMeasurable = true, toolSearch }) {
  if (!rows.length) return '工具选择：没有可分析的运行'

  const lines = []
  lines.push(
    toolSearch === true
      ? '工具选择（工具搜索开着，领域工具要先加载 —— 失败可能是混淆，也可能是没检索到）'
      : toolSearch === false
        ? '工具选择（全部工具一次性可见，所以这里的失败都属于混淆而非检索）'
        : '工具选择（本轮没记录是否开着工具搜索，混淆与检索缺口分不开）'
  )
  lines.push(
    `  必需工具命中 ${totals.hits}/${totals.withExpectation}` +
      `（${pct(totals.hits, totals.withExpectation)}）`
  )
  lines.push(`  调用失败 ${totals.failed}/${totals.calls}（${pct(totals.failed, totals.calls)}）`)
  lines.push(
    scopeMeasurable
      ? `  离题调用 ${totals.offScope}/${totals.calls}（${pct(totals.offScope, totals.calls)}）` +
          ' —— 去了任务用不到的命名空间'
      : '  离题调用 判不了（没拿到工具索引，不知道每个工具属于哪个命名空间）'
  )
  lines.push(`  兜底调用 ${totals.fallbacks} 次 —— 有专用工具却改用 Python / shell 绕过去`)
  lines.push(`  原地重复 ${totals.repeats} 次 —— 同名同参调了两遍以上`)

  // 逐条列出有问题的，方便定位是哪个工具在互相干扰
  const bad = rows.filter(
    (r) => r.stat.missing.length || r.stat.offScope.length || r.stat.fallbacks.length
  )
  if (bad.length) {
    lines.push('')
    lines.push('  选错的明细：')
    for (const { id, stat } of bad) {
      const parts = []
      if (stat.missing.length) parts.push(`没调必需的 ${stat.missing.join('、')}`)
      if (stat.offScope.length) parts.push(`离题 ${[...new Set(stat.offScope)].join('、')}`)
      if (stat.fallbacks.length) parts.push(`兜底 ${[...new Set(stat.fallbacks)].join('、')}`)
      lines.push(`    ${id}：${parts.join('；')}`)
    }
  }

  return lines.join('\n')
}
