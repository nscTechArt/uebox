/**
 * 蓝图片段往返摸底 —— 步骤 0 / 步骤 2 共用的记录工具。
 *
 * ## 它做什么，不做什么
 *
 * **做**：按固定协议把 `blueprint.get_graph` 的结果存成带轮次标记的档案，
 * 并把两份档案逐条比对（节点、连线、引脚默认值），把差异打出来。
 *
 * **不做**：不自己造样例、不自己写图。样例要在 UE 里手工搭，写图由盒子发起 ——
 * 这个脚本只负责「记准」和「比准」。
 *
 * 让脚本去写图是个陷阱：那样测的是脚本，不是盒子真正会走的那条路。
 *
 * ## 为什么必须存三份
 *
 * 并发类用例（探图 → 手动改 → 写入）少了中间那份就**验不出「那次修改被保留」**：
 *
 *   A  初态                    —— 探图之前
 *   B  手动改完、写入未发起      —— 缺了它，C 里的东西分不清是谁加的
 *   C  末态                    —— 写入返回之后
 *
 * 步骤 0（还没有 require_empty）的判据：C 里 B 新增的节点应该还在。
 * 步骤 2（有 require_empty）的判据：写入被拒绝，**C 与 B 逐条相等**。
 *
 * ## 失败用例没复现 ≠ 风险不存在
 *
 * 标 ⚠️ 的用例是「预期会出事」的。跑完没出事要记「本次未复现」，
 * 不能记「没问题」—— 时序类问题不复现的常见原因是窗口太短。
 *
 * ## 走哪条线
 *
 * **不直连插件。** 插件是 WebSocket 的**客户端**，它连的是盒子在 17860 上开的
 * 服务端 —— 拿个 WebSocket 客户端去连 17860，只会变成「第二个插件」，
 * 发过去的命令没人转给编辑器。
 *
 * 正确的路是盒子的本地调试接口 `POST /api/debug/ue-command`，
 * 由盒子把命令转给当前连着的那个编辑器。这个接口**默认关闭**，
 * 而且只收 127.0.0.1 的请求，所以盒子要用 `pnpm dev:ue-verify` 起
 * （它带上了 `HTTP_ENABLED=true`）。
 *
 * ## 用法
 *
 *   pnpm dev:ue-verify                  # 先这样起盒子；别用 dev:smoke，它会把 WS 端口改掉，UE 连不上
 *
 *   node scripts/snippet-roundtrip-probe.mjs capture <轮次> <用例> <存档点> --bp=/Game/BP_X [--graph=EventGraph] [--api=http://127.0.0.1:8766]
 *   node scripts/snippet-roundtrip-probe.mjs diff    <档案1> <档案2>
 *   node scripts/snippet-roundtrip-probe.mjs list    [轮次]
 *
 * `<轮次>` 是 step0 或 step2；`<存档点>` 是 A / B / C。
 * 档案落在 `.probe/snippet-roundtrip/<轮次>/<用例>-<存档点>.json`。
 *
 * ## 安全
 *
 * 这个脚本**只读**：它只发 `blueprint.get_graph`，不发任何写命令。
 * 即便如此也只在**可丢弃的测试工程**上跑，别对着真项目试。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE_ROOT = join(ROOT, '.probe', 'snippet-roundtrip')

/** 盒子的本地调试接口。端口来自 config.ts 的 http.port */
const DEFAULT_API = 'http://127.0.0.1:8766'

const ROUNDS = new Set(['step0', 'step2'])
const POINTS = new Set(['A', 'B', 'C'])

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function parseFlags(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) flags[match[1]] = match[2]
  }
  return flags
}

// ── 采集 ────────────────────────────────────────────────────────────────

/**
 * 发一条 `blueprint.get_graph` 并把原始回执原样返回。
 *
 * 存**插件原始返回**而不是工具层整理过的：档案是给人比对用的，
 * 原始返回里有 `linked_to`、三个默认值槽位这些工具层会合并掉的信息，
 * 少了它们就看不出「默认值到底丢在哪一层」。
 */
async function requestGraph(apiBase, blueprintPath, graphName) {
  let response
  try {
    response = await fetch(`${apiBase}/api/debug/ue-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'blueprint.get_graph',
        params: { blueprint_path: blueprintPath, graph_name: graphName }
      }),
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    throw new Error(
      `连不上盒子的调试接口（${apiBase}）：${error.message}\n` +
        '盒子要用 `pnpm dev:ue-verify` 起 —— 普通 `pnpm dev` 不开这个接口，\n' +
        '而 `pnpm dev:smoke` 会把 WS 端口改成 8765，UE 插件反而连不上。'
    )
  }

  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    throw new Error(
      `盒子回了失败：${body?.error ?? `HTTP ${response.status}`}\n` +
        '常见原因是 UE 编辑器没连上（插件没启用，或者工程没打开）。'
    )
  }

  return body.data ?? body
}

async function capture(argv) {
  const [round, sample, point] = argv
  const flags = parseFlags(argv)

  if (!ROUNDS.has(round)) fail(`轮次要么 step0 要么 step2，收到「${round}」`)
  if (!sample) fail('缺少用例名，比如 06-return-constant')
  if (!POINTS.has(point)) fail(`存档点要 A / B / C，收到「${point}」`)
  if (!flags.bp) fail('缺少 --bp=<蓝图路径>')

  const apiBase = (flags.api || DEFAULT_API).replace(/\/$/, '')
  const graphName = flags.graph || 'EventGraph'

  const response = await requestGraph(apiBase, flags.bp, graphName)

  const archive = {
    round,
    sample,
    point,
    capturedAt: new Date().toISOString(),
    blueprintPath: flags.bp,
    graphName,
    // 原样存，不做任何归一化 —— 归一化会把「哪一层丢了东西」这个信息抹掉
    raw: response
  }

  const dir = join(ARCHIVE_ROOT, round)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sample}-${point}.json`)
  writeFileSync(file, `${JSON.stringify(archive, null, 2)}\n`, 'utf-8')

  const nodes = Array.isArray(response?.data?.nodes)
    ? response.data.nodes
    : Array.isArray(response?.nodes)
      ? response.nodes
      : []
  console.log(`✓ 存档 ${round}/${sample}-${point}.json（${nodes.length} 个节点）`)
}

// ── 比对 ────────────────────────────────────────────────────────────────

function nodesOf(archive) {
  const raw = archive.raw?.data ?? archive.raw ?? {}
  return Array.isArray(raw.nodes) ? raw.nodes : []
}

/**
 * 一个节点摊平成可比较的行。
 *
 * **节点身份不能只看 class。** 上一版只摊了 `class` 和 `write_as`，
 * 于是把同一个节点从 `Add` 改成 `Subtract`（两者 class 都是
 * `K2Node_CommutativeAssociativeBinaryOperator`，差别在 `member_name`）
 * 之后，脚本照样输出「逐条相等 —— 图没有任何变化」。
 *
 * 这条脚本是「用户原有内容没被动过」的**验收凭据**，漏字段等于凭据是假的。
 * 所以：凡是能区分两个节点的字段，一个都不能少。
 */
function flatten(node) {
  const id = node.node_id ?? node.id ?? '?'

  // 顺序固定，缺席的写成 `-`，这样两边行数一致、diff 看得出是哪个字段变了
  const identity = [
    `class=${node.class ?? '-'}`,
    `write_as=${node.write_as ?? '-'}`,
    `member=${node.member_name ?? '-'}`,
    `target_class=${node.target_class ?? '-'}`,
    `struct_type=${node.struct_type ?? '-'}`,
    `title=${node.title ?? '-'}`
  ].join(' ')

  const rows = [`node ${id} ${identity}`]

  // 坐标单独一行：挪位置不是逻辑变化，但要看得见 ——
  // 混进 identity 会让「只是排了个版」也报成改动
  if (node.pos_x !== undefined || node.pos_y !== undefined) {
    rows.push(`  pos ${id} x=${node.pos_x ?? '-'} y=${node.pos_y ?? '-'}`)
  }

  /*
   * **每个引脚都出一行**，不管它有没有值、有没有连线。
   *
   * 上一版只记「带默认值或带连线」的引脚，于是给 Sequence 加一个未连接的
   * 输出（引脚从 3 个变成 4 个）之后，比对照样判「相同」——
   * 而那正是决定 5 的核心假设要盯的那类改动。
   *
   * 引脚的名字、方向、类型都参与比较：改类型、改方向、加删引脚都得看得出来。
   */
  for (const pin of node.pins ?? []) {
    const name = pin.name ?? '?'
    // 三个默认值槽位分开写，不合并 —— 合并了就看不出「值挪了个槽位」
    const defaults = [
      pin.default_value !== undefined && pin.default_value !== ''
        ? `value=${pin.default_value}`
        : null,
      pin.default_object ? `object=${pin.default_object}` : null,
      pin.default_text !== undefined && pin.default_text !== '' ? `text=${pin.default_text}` : null
    ].filter(Boolean)

    const shape = [
      `dir=${pin.dir ?? '-'}`,
      // 插件原始返回用 category/sub_category，工具层归一成 type —— 两边都认
      `type=${pin.type ?? pin.category ?? '-'}`,
      `sub=${pin.sub_category_object ?? pin.sub_category ?? '-'}`,
      pin.is_array ? 'array' : null,
      pin.is_reference ? 'ref' : null
    ]
      .filter(Boolean)
      .join(' ')

    rows.push(`  pin ${id}.${name} ${shape}${defaults.length > 0 ? ` ${defaults.join(' ')}` : ''}`)

    for (const link of pin.linked_to ?? []) {
      rows.push(`  link ${id}.${name} -> ${link.node_id ?? '?'}.${link.pin_name ?? '?'}`)
    }
  }

  return rows
}

function readArchive(path) {
  const full = resolve(path)
  if (!existsSync(full)) fail(`档案不存在：${full}`)
  return JSON.parse(readFileSync(full, 'utf-8'))
}

function diff(argv) {
  const [leftPath, rightPath] = argv
  if (!leftPath || !rightPath) fail('用法：diff <档案1> <档案2>')

  const left = readArchive(leftPath)
  const right = readArchive(rightPath)

  const leftRows = nodesOf(left).flatMap(flatten).sort()
  const rightRows = nodesOf(right).flatMap(flatten).sort()

  const leftSet = new Set(leftRows)
  const rightSet = new Set(rightRows)

  const removed = leftRows.filter((row) => !rightSet.has(row))
  const added = rightRows.filter((row) => !leftSet.has(row))

  console.log(`左：${left.round}/${left.sample}-${left.point}（${leftRows.length} 行）`)
  console.log(`右：${right.round}/${right.sample}-${right.point}（${rightRows.length} 行）`)
  console.log('')

  if (removed.length === 0 && added.length === 0) {
    console.log('✓ 逐条相等 —— 图没有任何变化')
    return
  }

  if (removed.length > 0) {
    console.log(`− 左边有、右边没了（${removed.length} 条）：`)
    for (const row of removed) console.log(`  ${row}`)
    console.log('')
  }
  if (added.length > 0) {
    console.log(`+ 右边新增（${added.length} 条）：`)
    for (const row of added) console.log(`  ${row}`)
  }

  console.log('')
  console.log('注意：连线和引脚默认值都在上面这些行里 ——')
  console.log('「节点数没变」不代表图没变，前几轮踩的三种失效都是节点数没变的。')
}

// ── 列档案 ──────────────────────────────────────────────────────────────

function list(argv) {
  const [round] = argv
  const rounds = round ? [round] : ['step0', 'step2']

  for (const item of rounds) {
    const dir = join(ARCHIVE_ROOT, item)
    if (!existsSync(dir)) {
      console.log(`${item}: （还没有档案）`)
      continue
    }
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
    console.log(`${item}: ${files.length} 份`)
    for (const name of files) console.log(`  ${name}`)
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────

/**
 * `flatten` 是这份脚本里唯一有对错可言的逻辑 —— 它决定「图变没变」这个判断
 * 准不准，而那是真机验收的凭据。所以导出来让单测盯住：
 * 上一版漏了 `member_name`，于是把 Add 改成 Subtract 也报「没有变化」。
 */
export { flatten, nodesOf }

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'capture':
      await capture(rest)
      break
    case 'diff':
      diff(rest)
      break
    case 'list':
      list(rest)
      break
    default:
      console.log(
        readFileSync(fileURLToPath(import.meta.url), 'utf-8')
          .split('*/')[0]
          .slice(3)
      )
      process.exit(command ? 1 : 0)
  }
}

// 被 import 时（单测）不跑 CLI —— 否则 process.exit 会把测试进程带走
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
