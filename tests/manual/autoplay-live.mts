/**
 * 试玩机器人真机验证 —— 真引擎、真 Jev，不经过盒子。
 *
 * ## 为什么不走盒子
 *
 * 要验的是插件（射线感知、注入、寻路、pie.run）和决策循环在真引擎里能不能跑通，
 * 以及 Jev 当控制器在真实碰撞、真实导航下的表现。拉起盒子要重启用户正在用的那个，
 * 所以这个脚本自己在 17860 扮演盒子的 WebSocket 服务端：插件连上来，
 * 这里直接用 `createBotRpc` + `runAutoplay` 驱动。盒子开着时端口被占，脚本会直接退出。
 *
 * ## 游戏规则是这个脚本模拟的（必须说清楚）
 *
 * 第三人称模板里没有钥匙、门这类玩法，也没有「交互」输入。这里在关卡里放几个
 * 带名字的 TextRenderActor 当物件，由脚本按「角色走到 2 米内」触发规则：
 * 用 Python 在 PIE 世界里 `print_string`（走的就是蓝图 PrintString 那条日志），
 * 捡到的钥匙当场销毁。**移动、碰撞、射线、寻路、输入注入、日志回读全是真的；
 * 「钥匙开门」这条规则是脚本扮演的。**
 *
 * ## 用法
 *
 *   1) 盒子不要开（占着 17860）
 *   2) set TYPESAFE_API_KEY=...
 *   3) npx vite-node tests/manual/autoplay-live.mts -- --runs=2
 *   4) 用 UE 5.5 打开 H:/UnrealAgent/_autoplay-lab/TPLab55/TPLab55.uproject（插件从 zip 装进去，不是联接）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  createJudgeBrain,
  createJudgeNavigator,
  type AskJudgeRaw,
  type ControllerBrain
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/controller'
import { rulePolicy } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/policy'
import {
  BotRpcError,
  createBotRpc,
  waitForPlay,
  type BotRpc
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/rpc'
import { runAutoplay } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/runner'
import { MemoryTrace } from '../../src/main/agent-v3/tools/adapted/ue-autoplay/trace'
import type {
  Observation,
  PieRunReport,
  Vec3
} from '../../src/main/agent-v3/tools/adapted/ue-autoplay/types'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const OUT_FILE = join(APP_DIR, '.test', 'autoplay-live.json')
const KEY = process.env.TYPESAFE_API_KEY
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 2)
const ONLY = process.argv.find((a) => a.startsWith('--task='))?.split('=')[1]
const DURATION = 60

if (!KEY) {
  console.error('缺 TYPESAFE_API_KEY')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 最小 WebSocket 服务端：和 src/main/services/websocket/server.ts 同一个信封
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null
let seq = 0
const pending = new Map<string, (value: unknown) => void>()

const wss = new WebSocketServer({ host: '127.0.0.1', port: 17860 })
wss.on('error', (error) => {
  console.error('17860 起不来（盒子开着？）：', error.message)
  process.exit(1)
})
wss.on('connection', (ws) => {
  socket = ws
  console.log('插件连上了')
  ws.send(
    JSON.stringify({
      ver: '1.0',
      type: 'evt',
      method: 'system.connected',
      payload: { connectionId: 'live' },
      time: Date.now()
    })
  )
  ws.on('message', (data) => {
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(String(data))
    } catch {
      return
    }
    if (envelope.type !== 'res' || typeof envelope.id !== 'string') return
    const resolveFn = pending.get(envelope.id)
    if (!resolveFn) return
    pending.delete(envelope.id)
    const code = typeof envelope.code === 'number' ? envelope.code : undefined
    const base = (envelope.result ?? envelope.data ?? envelope.payload) as unknown
    if (base && typeof base === 'object') {
      const obj = base as Record<string, unknown>
      if (code !== undefined && code >= 400) {
        if (obj.ok === undefined) obj.ok = false
        if (obj.error === undefined && typeof obj.message === 'string') obj.error = obj.message
        if (obj.code === undefined) obj.code = code
      }
      resolveFn(obj)
    } else {
      resolveFn({ ok: code === undefined || code < 400, data: base, code })
    }
  })
  ws.on('close', () => {
    console.log('插件断开了')
    socket = null
  })
})

function call(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const ws = socket
  if (!ws) return Promise.reject(new Error('插件没连上'))
  const id = `live_${++seq}`
  return new Promise((resolveFn, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时`))
    }, timeoutMs)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolveFn(value)
    })
    ws.send(JSON.stringify({ ver: '1.0', type: 'req', id, method, params, time: Date.now() }))
  })
}

async function python(script: string): Promise<string> {
  const response = (await call('cmd.run_python', { script }, 60_000)) as {
    ok?: boolean
    error?: string
    logs?: Array<{ message?: string }>
    result?: string
  }
  if (response.ok === false) throw new Error(`python 失败：${response.error}`)
  return (response.logs ?? []).map((l) => l.message ?? '').join('\n') + (response.result ?? '')
}

// ---------------------------------------------------------------------------
// Jev（直连 HTTP，和 autoplay-jev.mts 一样）
// ---------------------------------------------------------------------------

let jevCalls = 0
let jevTokens = 0
const ask: AskJudgeRaw = async (state, questions) => {
  jevCalls++
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: AbortSignal.timeout(8_000)
    })
    const body = (await response.json().catch(() => null)) as {
      answers?: Record<string, unknown>
      usage?: { input_tokens?: number }
    } | null
    if (!response.ok || !body?.answers) return null
    jevTokens += body.usage?.input_tokens ?? 0
    return { answers: body.answers }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 场景：在玩家出生点附近放几个带名字的物件，由脚本扮演「钥匙开门」规则
// ---------------------------------------------------------------------------

interface Marker {
  label: string
  offset: { x: number; y: number }
  kind: 'key' | 'door' | 'decor' | 'exit'
  /**
   * 给了就不放文字标牌，而是在工程里真的建两个蓝图类：父类叫这个名字（有语义），
   * 子类叫 label（没语义），再放一个子类实例。用来验「名字没意义、语义在类链里」
   */
  parent?: string
}

interface LiveTask {
  id: string
  objective: string
  untilLog: string
  markers: Marker[]
}

const TASKS: LiveTask[] = [
  {
    // 用户搭的场景：出生点和平台之间一堵 4 米高的墙，平台（顶面 4.4 米）只能从墙另一侧的楼梯上去，
    // 每级台阶都比迈步高度高，要跳。偏移按出生点 (-454, 1110) 算到平台顶 (1600, -100)
    id: 'stairs-exit-zh',
    objective: '走到出口',
    untilLog: 'Reached BP_Exit',
    markers: [
      { label: 'BP_Exit', offset: { x: 2054, y: -1210 }, kind: 'exit' },
      { label: 'BP_Barrel', offset: { x: 644, y: 250 }, kind: 'decor' }
    ]
  },
  {
    id: 'opaque-bp-zh',
    objective: '找到钥匙，然后用它把门打开',
    untilLog: 'DoorOpened',
    markers: [
      { label: 'BP_Prop_03', offset: { x: 900, y: -700 }, kind: 'key', parent: 'BP_KeyPickup' },
      { label: 'BP_Prop_02', offset: { x: 1400, y: 600 }, kind: 'door', parent: 'BP_LockedDoor' },
      {
        label: 'BP_Prop_01',
        offset: { x: -600, y: 600 },
        kind: 'decor',
        parent: 'BP_TreasureChest'
      },
      { label: 'BP_Prop_04', offset: { x: 300, y: 1000 }, kind: 'decor', parent: 'BP_Bench' }
    ]
  },
  {
    id: 'key-door-zh',
    objective: '找到钥匙，然后用它把门打开',
    untilLog: 'DoorOpened',
    markers: [
      { label: 'BP_Key', offset: { x: 900, y: -700 }, kind: 'key' },
      { label: 'BP_Door', offset: { x: 1400, y: 600 }, kind: 'door' },
      { label: 'BP_Bench', offset: { x: -500, y: 500 }, kind: 'decor' }
    ]
  },
  {
    id: 'hidden-key-zh',
    objective: '找到钥匙，然后用它把门打开',
    untilLog: 'DoorOpened',
    markers: [
      { label: 'BP_Door', offset: { x: 800, y: 300 }, kind: 'door' },
      { label: 'BP_Key', offset: { x: -2700, y: 500 }, kind: 'key' },
      { label: 'BP_Bench', offset: { x: 200, y: -900 }, kind: 'decor' }
    ]
  },
  {
    id: 'exit-zh',
    objective: '走到出口',
    untilLog: 'Reached BP_Exit',
    markers: [
      { label: 'BP_Exit', offset: { x: -1200, y: -900 }, kind: 'exit' },
      { label: 'BP_Barrel', offset: { x: 700, y: 300 }, kind: 'decor' },
      { label: 'BP_Chest', offset: { x: 300, y: -800 }, kind: 'decor' }
    ]
  }
]

/** 在编辑器世界里放物件；每个位置先向下打一条射线，确认下面有地 */
async function setupScene(task: LiveTask): Promise<{ start: Vec3; placed: Record<string, Vec3> }> {
  const markers = JSON.stringify(
    task.markers.map((m) => ({
      label: m.label,
      x: m.offset.x,
      y: m.offset.y,
      parent: m.parent ?? ''
    }))
  )
  const out = await python(`
import unreal, json
eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor):
    if a.get_actor_label().startswith('BP_') and (isinstance(a, unreal.TextRenderActor) or 'AutoplayLab' in a.get_class().get_path_name()):
        a.destroy_actor()
at = unreal.AssetToolsHelpers.get_asset_tools()
def ensure_bp(name, parent_cls):
    path = '/Game/AutoplayLab/' + name
    if not unreal.EditorAssetLibrary.does_asset_exist(path):
        f = unreal.BlueprintFactory()
        f.set_editor_property('parent_class', parent_cls)
        at.create_asset(name, '/Game/AutoplayLab', unreal.Blueprint, f)
    return unreal.load_class(None, path + '.' + name + '_C')
starts = [a for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.PlayerStart)]
s = starts[0].get_actor_location()
placed = {}
for m in json.loads('''${markers}'''):
    # 预设偏移处没有地（场地外、坑里）就往出生点方向收，直到脚下有地
    for f in (1.0, 0.85, 0.7, 0.55, 0.4):
        x, y = s.x + m['x'] * f, s.y + m['y'] * f
        hit = unreal.SystemLibrary.line_trace_single(world, unreal.Vector(x, y, s.z + 500), unreal.Vector(x, y, s.z - 2000), unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [], unreal.DrawDebugTrace.NONE, True)
        if hit:
            break
    z = s.z
    if hit:
        z = hit.to_tuple()[4].z + 100
    # Python 在 PIE 世界里生成不了 Actor，只算位置和类，生成交给插件的 actor.spawn（它作用于运行中的世界）
    if m['parent']:
        base = ensure_bp(m['parent'], unreal.Actor)
        cls = ensure_bp(m['label'], base).get_path_name()
    else:
        cls = '/Script/Engine.TextRenderActor'
    placed[m['label']] = [x, y, z, bool(hit), cls]
print('__PLACED__' + json.dumps({'start': [s.x, s.y, s.z], 'placed': placed}))
`)
  const line = out.split('\n').find((l) => l.includes('__PLACED__'))
  if (!line) throw new Error(`场景没放好：${out.slice(0, 400)}`)
  const data = JSON.parse(line.slice(line.indexOf('__PLACED__') + 10)) as {
    start: number[]
    placed: Record<string, [number, number, number, boolean, string]>
  }
  const placed: Record<string, Vec3> = {}
  for (const [label, [x, y, z, hasFloor, cls]] of Object.entries(data.placed)) {
    placed[label] = { x, y, z }
    if (!hasFloor) console.warn(`  ⚠️ ${label} 下面没打到地`)
    await call(
      'actor.spawn',
      { ver: '2.0', instances: [{ class: cls, name: label, location: { x, y, z } }] },
      20_000
    )
  }
  return { start: { x: data.start[0], y: data.start[1], z: data.start[2] }, placed }
}

/** 包一层 rpc：每次观察之后按角色位置执行「游戏规则」 */
function withRules(rpc: BotRpc, task: LiveTask, placed: Record<string, Vec3>): BotRpc {
  const fired = new Set<string>()
  let hasKey = false
  const near = (obs: Observation, label: string, radius: number): boolean => {
    const p = obs.pawn?.location
    const m = placed[label]
    // 高度也要对得上：出口在平台上时，站在平台下面、水平距离够近不算到了
    return Boolean(p && m && Math.hypot(p.x - m.x, p.y - m.y) < radius && Math.abs(p.z - m.z) < 200)
  }
  const say = (text: string, destroy?: string): Promise<string> =>
    python(`
import unreal
w = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
unreal.SystemLibrary.print_string(w, ${JSON.stringify(text)}, True, True, unreal.LinearColor(1, 1, 0, 1), 3.0)
${
  destroy
    ? `for a in unreal.GameplayStatics.get_all_actors_of_class(w, unreal.Actor):
    if a.get_actor_label() == ${JSON.stringify(destroy)}:
        a.destroy_actor()`
    : ''
}
`)
  return {
    ...rpc,
    async observe(options) {
      const obs = await rpc.observe(options)
      for (const marker of task.markers) {
        if (fired.has(marker.label) || !near(obs, marker.label, 220)) continue
        if (marker.kind === 'key') {
          fired.add(marker.label)
          hasKey = true
          await say(`Picked up ${marker.label}`, marker.label)
        } else if (marker.kind === 'door') {
          if (hasKey) {
            fired.add(marker.label)
            await say('DoorOpened')
          } else if (!fired.has(`${marker.label}:locked`)) {
            fired.add(`${marker.label}:locked`)
            await say('The door is locked')
          }
        } else if (marker.kind === 'exit') {
          fired.add(marker.label)
          await say(`Reached ${marker.label}`)
        }
      }
      // 离开门口再回来可以再提示一次「锁着」
      for (const marker of task.markers) {
        if (marker.kind === 'door' && !near(obs, marker.label, 450))
          fired.delete(`${marker.label}:locked`)
      }
      return obs
    }
  }
}

async function runOnce(
  task: LiveTask,
  label: string,
  brain: ControllerBrain,
  eyesOnly = false
): Promise<Record<string, unknown>> {
  // 上一局（或被强停的上一个脚本）留下的 PIE 还在跑时，编辑器世界改不了 —— 先停干净
  await call('pie.stop', { reason: '开新一局' }, 5_000).catch(() => undefined)
  for (let i = 0; i < 40; i++) {
    const probe = (await call('pie.observe', { include_widgets: false }, 5_000).catch(
      () => null
    )) as { ok?: boolean } | null
    if (!probe || probe.ok === false) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const base = createBotRpc(call)
  // --no-navmesh：假装关卡没有导航网格，逼它用插件的网格规划器（验证没有 NavMesh 的项目）
  const full: BotRpc = process.argv.includes('--no-navmesh')
    ? { ...base, navPath: async () => ({ ok: true, has_navmesh: false }) }
    : base
  // 只用眼前感知：假装插件没有 pie.scene（老插件的情况），和整关场景对照
  const rpc: BotRpc = eyesOnly
    ? {
        ...full,
        scene: () => Promise.reject(new BotRpcError('Unknown method: pie.scene', 'pie.scene', 404))
      }
    : full
  let settled = false
  let report: PieRunReport | null = null
  const run = (
    call(
      'pie.run',
      { duration_seconds: DURATION, screenshot: false, fixed_fps: 60 },
      (DURATION + 120) * 1000
    ) as Promise<PieRunReport>
  )
    .then((r) => {
      report = r
    })
    .catch((error: unknown) => {
      report = { ok: false, error: String(error) }
    })
    .finally(() => {
      settled = true
    })
  const ready = await waitForPlay(rpc, () => settled, undefined, 60_000)
  if (ready !== 'ready') {
    await run
    return { task: task.id, brain: label, error: `没起来：${ready} ${JSON.stringify(report)}` }
  }
  const { placed } = await setupScene(task)
  const trace = new MemoryTrace()
  const started = Date.now()
  let result
  try {
    result = await runAutoplay(
      {
        rpc: withRules(rpc, task, placed),
        policy: rulePolicy,
        trace,
        isSessionOver: () => settled
      },
      {
        mode: 'objective',
        objective: task.objective,
        brain,
        navigator: createJudgeNavigator(ask),
        goal: { untilLog: task.untilLog },
        durationSeconds: DURATION
      }
    )
  } finally {
    if (!settled) await rpc.stop('验证结束').catch(() => undefined)
    await run
  }
  const ticks = trace.records.filter((r) => r.type === 'tick')
  const lat = [...(result.controller?.latencyMs ?? [])].sort((a, b) => a - b)
  return {
    task: task.id,
    brain: label,
    success: result.outcome === 'goal_reached',
    outcome: result.outcome,
    note: result.outcomeNote,
    wall_seconds: Math.round((Date.now() - started) / 100) / 10,
    ticks: result.controller?.ticks,
    judge_decisions: result.controller?.judgeDecisions,
    latency_p50: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
    move: result.move,
    jump: result.jump,
    findings: result.findings.map((f) => `${f.kind}: ${f.detail}`),
    path: ticks.map((t) => `${t.chosen}${t.outcome ? ` [${t.outcome}]` : ''}`),
    sample_state: ticks[0]?.state,
    report_errors: (report as PieRunReport | null)?.errors?.slice(0, 5),
    prints: (report as PieRunReport | null)?.print_strings?.slice(0, 20),
    plans: trace.records.filter((r) => r.type === 'plan')
  }
}

console.log('等插件连上 17860（打开 TPLab55 工程）……')
const waitStart = Date.now()
while (!socket && Date.now() - waitStart < 15 * 60_000)
  await new Promise((r) => setTimeout(r, 1000))
if (!socket) {
  console.error('15 分钟没等到插件')
  process.exit(1)
}
// 给编辑器一点时间把关卡加载完
await new Promise((r) => setTimeout(r, 5000))

const rows: Array<Record<string, unknown>> = []
for (const task of TASKS.filter((t) => !ONLY || t.id === ONLY)) {
  const brains: Array<{ label: string; brain: ControllerBrain; runs: number; eyesOnly?: boolean }> =
    [
      ...(process.argv.includes('--eyes')
        ? [{ label: 'jev-眼前', brain: createJudgeBrain(ask), runs: 1, eyesOnly: true }]
        : []),
      { label: 'jev', brain: createJudgeBrain(ask), runs: RUNS }
    ]
  for (const { label, brain, runs, eyesOnly } of brains) {
    for (let i = 0; i < runs; i++) {
      console.log(`\n▶ ${task.id} · ${label} #${i + 1}`)
      try {
        const row = await runOnce(task, label, brain, eyesOnly)
        rows.push(row)
        console.log(
          `  ${row.success ? '✓' : '✗'} ${row.outcome ?? row.error}  ${row.ticks ?? '-'} 步  ${row.wall_seconds ?? '-'} 秒` +
            (label !== 'rule' ? `  延迟中位 ${row.latency_p50}ms` : '')
        )
        console.log(`    ${((row.path as string[]) ?? []).slice(0, 12).join('\n    ')}`)
        if ((row.findings as string[])?.length)
          console.log(`    发现：${(row.findings as string[]).join(' | ')}`)
      } catch (error) {
        console.log('  ✗ 出错：', error instanceof Error ? error.message : String(error))
        rows.push({ task: task.id, brain: label, error: String(error) })
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

mkdirSync(join(APP_DIR, '.test'), { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify({ at: new Date().toISOString(), jevCalls, jevTokens, rows }, null, 2)
)
console.log(`\nJev 调用 ${jevCalls} 次，输入 ${jevTokens} token。结果：${OUT_FILE}`)
wss.close()
process.exit(0)
