#!/usr/bin/env node
/**
 * T3D 路线验证脚本 —— 验「让引擎自己做序列化」这条路走不走得通。
 *
 * ## 要验的是什么
 *
 * 现有的 `get_graph` / `create_graph` 走结构化 JSON：读侧描述节点，
 * 写侧照描述**重建**一个默认形态的节点。代价是用户改过形状的东西写不回去 ——
 * 手动加过输出引脚的 Sequence、折叠成 Composite 的一整块逻辑，
 * 重建出来都是默认形态，多出来的部分静默丢失。
 *
 * T3D 这条路不重建，让引擎自己反序列化（`blueprint.export_t3d` /
 * `blueprint.import_t3d`，底下是编辑器 Ctrl+C / Ctrl+V 调的同一对引擎函数）。
 * **这个脚本就是来验「编辑器里复制粘贴保得住的，这条路是不是也保得住」。**
 *
 * ## 和 snippet-roundtrip-probe.mjs 的区别
 *
 * 那个脚本**只读**，这个**会写**。所以分成两个文件，不把写命令混进只读那份。
 *
 * ## 走哪条线
 *
 * 和只读那份一样，走盒子的本地调试接口 `POST /api/debug/ue-command`。
 * 这个接口默认关闭，盒子必须用 `pnpm dev:ue-verify` 起。
 * **别用 `pnpm dev:smoke`** —— 它带 `WS_PORT=8765`，盒子会在 8765 上监听，
 * 而插件敲的是 17860，永远连不上。
 * 不能直连插件 —— 插件是 WebSocket 的客户端，连 17860 只会变成「第二个插件」。
 *
 * ## 用法
 *
 *   pnpm dev:ue-verify                 # 先这样起盒子；别用 dev:smoke，它会把 WS 端口改掉，UE 连不上
 *
 *   node scripts/t3d-route-probe.mjs export    --bp=/Game/Probe/BP_Probe [--graph=EventGraph] [--as=名字]
 *   node scripts/t3d-route-probe.mjs paste     --bp=/Game/Probe/BP_Paste --from=名字 [--graph=] [--compile]
 *   node scripts/t3d-route-probe.mjs roundtrip --from=/Game/Probe/BP_Probe --to=/Game/Probe/BP_Paste [--from-graph=] [--to-graph=] [--compile]
 *   node scripts/t3d-route-probe.mjs list
 *
 * `roundtrip` 是主角：导出 → 粘贴 → 两边都回读 → 逐个引脚比，告诉你什么没保住。
 *
 * ## 安全
 *
 * **写入目标默认只允许 `/Game/Probe` 下面的资产。** 这个脚本会往蓝图里塞节点，
 * 跑错工程就是在别人的工程里乱写。要写别处必须显式加 `--allow-outside-probe`，
 * 那时脚本会把目标路径打出来让你看清楚。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARCHIVE_ROOT = join(ROOT, '.probe', 't3d')

/** 盒子的本地调试接口。端口来自 config.ts 的 http.port */
const DEFAULT_API = 'http://127.0.0.1:8766'

/** 写入目标的默认白名单前缀 */
const WRITE_SAFE_PREFIX = '/Game/Probe'

function fail(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

function parseFlags(argv) {
  const flags = {}
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (match) flags[match[1]] = match[2] === undefined ? true : match[2]
  }
  return flags
}

async function sendCommand(apiBase, command, params) {
  let response
  try {
    response = await fetch(`${apiBase}/api/debug/ue-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, params }),
      signal: AbortSignal.timeout(30_000)
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
    // 插件的拒绝理由可能落在几个不同字段上，一个都别漏 ——
    // 只报 HTTP 状态码的话，「为什么被拒」这个最有用的信息就没了
    const reason =
      body?.error ??
      body?.data?.error ??
      body?.data?.message ??
      body?.message ??
      `HTTP ${response.status}`
    throw new Error(
      `命令 ${command} 失败：${reason}\n` +
        '常见原因是 UE 编辑器没连上（插件没启用，或者工程没打开），' +
        '或者插件是旧的（没有这条命令）。'
    )
  }

  return body.data ?? body
}

/** 插件回执有时多包一层 data，两种形状都认 */
function unwrap(response) {
  return response?.data && typeof response.data === 'object' ? response.data : response
}

function archivePath(name) {
  return join(ARCHIVE_ROOT, `${name}.json`)
}

function assertWritable(blueprintPath, flags) {
  if (blueprintPath.startsWith(WRITE_SAFE_PREFIX)) return
  if (flags['allow-outside-probe']) {
    console.warn(
      `⚠ 写入目标在 ${WRITE_SAFE_PREFIX} 之外：${blueprintPath}\n` +
        '  你加了 --allow-outside-probe，脚本照做。这会往这个蓝图里塞节点。'
    )
    return
  }
  fail(
    `写入目标不在 ${WRITE_SAFE_PREFIX} 下面：${blueprintPath}\n` +
      '  这个脚本会往蓝图里写节点，默认只允许写探针目录。\n' +
      `  真要写别处，加 --allow-outside-probe。`
  )
}

// ── export ──────────────────────────────────────────────────────────────

async function cmdExport(argv) {
  const flags = parseFlags(argv)
  if (!flags.bp) fail('缺少 --bp=<蓝图路径>')

  const apiBase = (flags.api || DEFAULT_API).replace(/\/$/, '')
  const graphName = flags.graph || 'EventGraph'
  const name = flags.as || `${flags.bp.split('/').pop()}-${graphName}`

  const raw = await sendCommand(apiBase, 'blueprint.export_t3d', {
    blueprint_path: flags.bp,
    graph_name: graphName
  })
  const data = unwrap(raw)

  if (data.truncated) {
    fail(
      `导出的文本被截断了（${data.text_length} 字符，超过插件上限）。\n` +
        '  截断过的 T3D 粘不回去。换一张小一点的图，或者用 node_ids 导子集。'
    )
  }

  mkdirSync(ARCHIVE_ROOT, { recursive: true })
  writeFileSync(
    archivePath(name),
    `${JSON.stringify(
      {
        name,
        capturedAt: new Date().toISOString(),
        blueprintPath: data.blueprint_path ?? flags.bp,
        graphName: data.graph_name ?? graphName,
        nodeCount: data.node_count,
        textLength: data.text_length,
        text: data.text
      },
      null,
      2
    )}\n`,
    'utf-8'
  )

  console.log(`✓ 导出 ${data.node_count} 个节点，${data.text_length} 字符`)
  console.log(`  存到 ${archivePath(name)}`)
  return { name, data }
}

// ── paste ───────────────────────────────────────────────────────────────

async function cmdPaste(argv) {
  const flags = parseFlags(argv)
  if (!flags.bp) fail('缺少 --bp=<目标蓝图路径>')
  if (!flags.from) fail('缺少 --from=<导出时用的名字>')

  assertWritable(flags.bp, flags)

  const apiBase = (flags.api || DEFAULT_API).replace(/\/$/, '')
  const file = archivePath(flags.from)
  if (!existsSync(file)) fail(`找不到导出档案：${file}（先跑 export）`)
  const archive = JSON.parse(readFileSync(file, 'utf-8'))

  const raw = await sendCommand(apiBase, 'blueprint.import_t3d', {
    blueprint_path: flags.bp,
    graph_name: flags.graph || 'EventGraph',
    text: archive.text,
    require_empty: Boolean(flags['require-empty']),
    offset_x: Number(flags['offset-x'] ?? 0),
    offset_y: Number(flags['offset-y'] ?? 0),
    compile: Boolean(flags.compile)
  })
  const data = unwrap(raw)

  console.log(`✓ 粘进 ${data.imported_count} 个节点（导出时是 ${archive.nodeCount} 个）`)
  if (data.imported_count !== archive.nodeCount) {
    console.log(`  ⚠ 数量对不上 —— 这本身就是一条结论，记下来`)
  }
  console.log(`  undoable=${data.undoable} structural=${data.structural}`)

  if (data.self_context_unresolved?.length > 0) {
    console.log(
      `  ⚠ ${data.self_context_unresolved.length} 个节点引用了源蓝图自己的成员，粘过来是断的：`
    )
    for (const item of data.self_context_unresolved) console.log(`      ${item}`)
  }
  if (data.compiled) {
    console.log(`  编译：${data.compile_error_count} 个错误 / ${data.compile_warning_count} 个警告`)
    for (const diag of data.diagnostics ?? []) {
      console.log(`      [${diag.severity}] ${diag.message}`)
    }
  }

  return data
}

// ── roundtrip ───────────────────────────────────────────────────────────

/**
 * 把一张图摊成「每个节点一行签名」，用来比对。
 *
 * **不比 GUID** —— 粘贴时引擎会重新发 GUID，比了必然全不一样。
 * 比的是 class + 每个引脚的名字/方向/类型/默认值，以及连线的**条数**。
 * 引脚数是这一轮的核心：Sequence 加过的那个第三输出，
 * 只有逐引脚比才看得见（只数节点的话完全一样）。
 */
function signatureOf(node) {
  const pins = (node.pins ?? []).map((pin) => {
    const defaults = [
      pin.default_value ? `v=${pin.default_value}` : null,
      pin.default_object ? `o=${pin.default_object}` : null,
      pin.default_text ? `t=${pin.default_text}` : null
    ].filter(Boolean)
    return [
      pin.name ?? '?',
      pin.dir ?? '-',
      pin.type ?? pin.category ?? '-',
      pin.is_array ? 'array' : '',
      `links=${(pin.linked_to ?? []).length}`,
      ...defaults
    ].join(':')
  })
  return {
    class: node.class ?? '?',
    title: node.title ?? '?',
    isGhost: node.is_ghost_node === true,
    pinCount: pins.length,
    pins: pins.sort().join(' | ')
  }
}

function graphNodes(response) {
  const data = unwrap(response)
  return Array.isArray(data?.nodes) ? data.nodes : []
}

async function cmdRoundtrip(argv) {
  const flags = parseFlags(argv)
  if (!flags.from) fail('缺少 --from=<源蓝图路径>')
  if (!flags.to) fail('缺少 --to=<目标蓝图路径>')

  assertWritable(flags.to, flags)

  const apiBase = (flags.api || DEFAULT_API).replace(/\/$/, '')
  const fromGraph = flags['from-graph'] || 'EventGraph'
  const toGraph = flags['to-graph'] || 'EventGraph'
  const name = flags.as || 'roundtrip'

  console.log(`① 从 ${flags.from} 的 ${fromGraph} 导出`)
  await cmdExport([
    `--bp=${flags.from}`,
    `--graph=${fromGraph}`,
    `--as=${name}`,
    `--api=${apiBase}`
  ])

  console.log(`\n② 粘进 ${flags.to} 的 ${toGraph}`)
  const pasteArgs = [`--bp=${flags.to}`, `--graph=${toGraph}`, `--from=${name}`, `--api=${apiBase}`]
  if (flags.compile) pasteArgs.push('--compile')
  if (flags['allow-outside-probe']) pasteArgs.push('--allow-outside-probe')
  await cmdPaste(pasteArgs)

  console.log(`\n③ 两边都回读，逐个引脚比`)
  const before = graphNodes(
    await sendCommand(apiBase, 'blueprint.get_graph', {
      blueprint_path: flags.from,
      graph_name: fromGraph
    })
  )
  const after = graphNodes(
    await sendCommand(apiBase, 'blueprint.get_graph', {
      blueprint_path: flags.to,
      graph_name: toGraph
    })
  )

  /*
   * 按 **class + title** 分组配对，不能只按 class。
   *
   * 所有事件节点的类名都是 `K2Node_Event` —— BeginPlay、Tick、ActorBeginOverlap
   * 挤在同一个桶里，配对只能靠引脚签名排序，一旦某个事件在目标图里不存在，
   * 后面全体错位，「保住了」会被报成「丢了」。带上 title 就各归各位。
   *
   * title 是按编辑器语言本地化的，但两边是同一次会话里读的同一个编辑器，
   * 所以两边一致 —— 这里只拿它当配对的键，不拿它当判据。
   *
   * 同名同类还有多个时（两个 Sequence 就是），再按引脚签名排序逐个对。
   */
  const group = (nodes) => {
    const map = new Map()
    for (const node of nodes) {
      const sig = signatureOf(node)
      const key = `${sig.class}${sig.title}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(sig)
    }
    for (const list of map.values()) list.sort((a, b) => a.pins.localeCompare(b.pins))
    return map
  }

  const beforeMap = group(before)
  const afterMap = group(after)
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()

  /** 回显用的名字。从签名本身取，**不从分组键里拆** —— 标题带空格（Event BeginPlay）会拆错 */
  const labelOf = (sig) => `${sig.class}「${sig.title}」`

  let mismatches = 0
  console.log(
    `\n  源图 ${before.length} 个节点，目标图 ${after.length} 个节点` +
      `（目标图原来就有的节点也在里面，别直接减）\n`
  )

  for (const key of keys) {
    const lhs = beforeMap.get(key) ?? []
    const rhs = afterMap.get(key) ?? []

    if (lhs.length === 0) {
      // 目标图本来就有的。全是引擎占位事件节点的话单独说一句 ——
      // 这正好顺带答了「新建蓝图自带的那几个灰事件到底是什么」（发现二）
      const ghostHint = rhs.every((s) => s.isGhost) ? '，而且都是引擎自己铺的占位事件节点' : ''
      console.log(
        `  ~ ${labelOf(rhs[0])}：目标图里有 ${rhs.length} 个，源图没有（本来就有的${ghostHint}）`
      )
      continue
    }
    if (rhs.length === 0) {
      console.log(`  ✖ ${labelOf(lhs[0])}：源图 ${lhs.length} 个，粘过去一个都没有`)
      mismatches += 1
      continue
    }

    for (let i = 0; i < lhs.length; i += 1) {
      const l = lhs[i]
      const r = rhs[i]
      if (!r) {
        console.log(`  ✖ ${labelOf(l)}：源图有，目标图少了一个`)
        mismatches += 1
        continue
      }
      if (l.pinCount !== r.pinCount) {
        console.log(`  ✖ ${labelOf(l)}：引脚数 ${l.pinCount} → ${r.pinCount}`)
        mismatches += 1
      } else if (l.pins !== r.pins) {
        console.log(`  ✖ ${labelOf(l)}：引脚数一样但内容变了`)
        console.log(`      源：${l.pins}`)
        console.log(`      新：${r.pins}`)
        mismatches += 1
      } else {
        console.log(`  ✓ ${labelOf(l)}：${l.pinCount} 个引脚，一字不差`)
      }
    }
  }

  console.log('')
  if (mismatches === 0) {
    console.log('✓ 源图里的每个节点都在目标图里找到了逐引脚相同的对应物。')
    console.log('  注意：这只说明**形状**保住了，不说明**依赖**成立 ——')
    console.log('  引用了源蓝图变量的节点会粘成红的，那要看 self_context_unresolved 和编译结果。')
  } else {
    console.log(`✖ ${mismatches} 处对不上。上面每一条都是一个具体结论，照抄进验证记录。`)
  }
}

// ── list ────────────────────────────────────────────────────────────────

function cmdList() {
  if (!existsSync(ARCHIVE_ROOT)) {
    console.log('还没有任何导出档案。')
    return
  }
  const files = readdirSync(ARCHIVE_ROOT).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('还没有任何导出档案。')
    return
  }
  for (const file of files) {
    const archive = JSON.parse(readFileSync(join(ARCHIVE_ROOT, file), 'utf-8'))
    console.log(
      `${archive.name}\t${archive.nodeCount} 节点\t${archive.textLength} 字符\t` +
        `${archive.blueprintPath}:${archive.graphName}`
    )
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'export':
      await cmdExport(rest)
      break
    case 'paste':
      await cmdPaste(rest)
      break
    case 'roundtrip':
      await cmdRoundtrip(rest)
      break
    case 'list':
      cmdList()
      break
    default:
      console.error('用法：')
      console.error(
        '  node scripts/t3d-route-probe.mjs export    --bp=/Game/Probe/BP_X [--graph=] [--as=名字]'
      )
      console.error(
        '  node scripts/t3d-route-probe.mjs paste     --bp=/Game/Probe/BP_Y --from=名字 [--graph=] [--compile] [--require-empty]'
      )
      console.error(
        '  node scripts/t3d-route-probe.mjs roundtrip --from=/Game/Probe/BP_X --to=/Game/Probe/BP_Y [--compile]'
      )
      console.error('  node scripts/t3d-route-probe.mjs list')
      process.exit(command ? 1 : 0)
  }
}

// 被 import 时（单测）不跑 CLI —— 否则 process.exit 会把测试进程带走
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.message))
}

export { signatureOf, parseFlags }
