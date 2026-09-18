/**
 * 巨型任务：派对闯关游戏 MVP。
 *
 * ## 这个和前面 13 道题不一样在哪
 *
 * 那 13 道每道考一两个能力，而且是我先看过代码再出的题 —— 通过率高有
 * 过拟合的成分。这一道是**一整件真实的活**：一句话进来，要做出能玩的东西。
 * 它的价值不在于满分，在于**告诉我们断在哪一步**。
 *
 * 四轮对话，同一个 sessionId：一句总述 + 三句真人式追加。多轮本身也是
 * 从没测过的路径（会话恢复、指代消解、在已有成果上继续改）。
 *
 * ## 判定
 *
 * 15 项逐条回引擎核验，报「完成度 N/15 + 卡在哪」，不报通过/失败。
 * 所有检查只用**已经验证过的字段名** —— 这一晚我因为猜字段名误判了六次，
 * 每个字段的出处都写在注释里。
 *
 * ## Python 单独计数
 *
 * Python 能做任何事，包括绕开我们全部工具。如果关键步骤都靠它完成，
 * 那结论不是「模型很行」而是「我们的工具不够用」—— 所以要分开统计，
 * 而不是混进总数里看不见。
 */

import { spawn } from 'child_process'

const BASE = 'http://127.0.0.1:8766'
const ROOT = '/Game/PartyMVP'

/** 五条约束里的两条：步数与时间封顶 */
const MAX_TOOL_CALLS = 200
const MAX_MINUTES = 40

const post = async (path, body, timeoutMs = 900_000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

const ue = async (command, params = {}) => {
  try {
    const j = await post('/api/debug/ue-command', { command, params }, 60_000)
    return j?.data ?? j
  } catch {
    return null
  }
}

const tool = async (name, args) => {
  try {
    const j = await post('/api/debug/tool', { name, args }, 120_000)
    if (!j.success) return null
    const text = (j.data?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch {
    return null
  }
}

async function boxAlive() {
  try {
    const r = await fetch(`${BASE}/api/debug/tools`, { signal: AbortSignal.timeout(5000) })
    return r.ok
  } catch {
    return false
  }
}

async function ensureBox() {
  if (await boxAlive()) return true
  console.log('  ⚠️  盒子没响应，重启中…')
  spawn('pnpm', ['dev'], { detached: true, stdio: 'ignore', shell: true }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    if (!(await boxAlive())) continue
    if ((await ue('project.info'))?.projectName) {
      console.log('  ✅ 盒子已恢复')
      return true
    }
  }
  return false
}

// ── 四轮对话 ────────────────────────────────────────────────────────────
// 第一句是用户会怎么说，不是给模型的操作说明书。
// 后三句模仿真人追加：看到结果之后提要求，而且**都带指代**
//（「平台」「通关界面」），指代能不能解析本身就是考点。

const TURNS = [
  {
    label: '总述',
    prompt:
      `帮我做一个派对闯关小游戏的雏形，东西都放在 ${ROOT} 下面：` +
      '一条通往终点的赛道，中间有会动的障碍，掉下去会重生，撞到终点显示通关。'
  },
  { label: '追加①', prompt: '平台有点窄，走上去容易掉，都加宽一点。' },
  { label: '追加②', prompt: '加个 60 秒倒计时，时间到了算失败。' },
  { label: '追加③', prompt: '通关界面上再加个「重来」按钮。' }
]

// ── 15 项验收 ───────────────────────────────────────────────────────────

/** 列出 ROOT 下的全部资产。ue_content_search 的返回形状实测确认过 */
async function listAssets() {
  const r = await tool('ue_content_search', { path: ROOT, recursive: true, limit: 100 })
  const assets = r?.assets ?? r?.results ?? []
  return Array.isArray(assets) ? assets : []
}

/** 蓝图图表里有没有连上的线。字段 pins[].is_connected / linked_to 已验证 */
function graphIsWired(graph) {
  return (graph?.nodes ?? []).some((n) =>
    (n.pins ?? []).some((p) => p.is_connected || (p.linked_to ?? []).length > 0)
  )
}

/** 在所有图里找 —— 逻辑可能放在 EventGraph 也可能放在自建函数图 */
async function anyGraphHas(blueprintPath, predicate) {
  const desc = await ue('blueprint.describe', { blueprint_path: blueprintPath })
  for (const name of desc?.graph_names ?? []) {
    const g = await ue('blueprint.get_graph', {
      blueprint_path: blueprintPath,
      graph_name: name
    })
    if (predicate(g)) return true
  }
  return false
}

async function buildChecklist() {
  const assets = await listAssets()
  const paths = assets.map((a) => String(a.path ?? a.package_path ?? a.object_path ?? ''))

  const blueprints = assets.filter((a) => /Blueprint/i.test(String(a.type ?? a.class ?? '')))
  const materials = assets.filter((a) => /Material/i.test(String(a.type ?? a.class ?? '')))
  const widgets = assets.filter((a) => /Widget/i.test(String(a.type ?? a.class ?? '')))

  // 关卡里的 Actor。空 filter = 全量扫描，limit 放大一点
  const inLevel = await tool('ue_get_actor', {
    targets: { filter: {} },
    return_transform: true,
    limit: 200
  })
  const actors = inLevel?.actors ?? []
  // 平台类：名字带 Platform/Plat/台，或类是 StaticMeshActor 且不在默认场景物里
  const platformish = actors.filter((a) =>
    /platform|plat|floor|台|块|tile/i.test(String(a.name ?? ''))
  )

  return [
    {
      id: '1 起点与终点',
      run: async () => {
        const hasStart = actors.some((a) => /start|起点|begin/i.test(String(a.name ?? '')))
        const hasGoal = actors.some((a) => /goal|finish|end|终点/i.test(String(a.name ?? '')))
        return {
          ok: hasStart && hasGoal,
          note: `起点${hasStart ? '有' : '无'} / 终点${hasGoal ? '有' : '无'}`
        }
      }
    },
    {
      id: '2 ≥6 块平台',
      run: async () => ({
        ok: platformish.length >= 6,
        note: `场景里像平台的 Actor ${platformish.length} 个`
      })
    },
    {
      id: '3 归入 Outliner 文件夹',
      run: async () => {
        // folder_path 是这一晚补进 BuildActorInfo 的字段
        const foldered = platformish.filter((a) => String(a.folder_path ?? '').length > 0)
        return {
          ok: platformish.length > 0 && foldered.length >= platformish.length * 0.8,
          note: `${foldered.length}/${platformish.length} 个已归类`
        }
      }
    },
    {
      id: '4 ≥2 个会动的障碍',
      run: async () => {
        let withTimeline = 0
        for (const bp of blueprints) {
          const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
          if (!p) continue
          const desc = await ue('blueprint.describe', { blueprint_path: p })
          const graphs = (desc?.graph_names ?? []).join(' ')
          // Timeline 在蓝图里会生成一个同名图表
          if (/timeline/i.test(graphs)) withTimeline++
        }
        return { ok: withTimeline >= 2, note: `带 Timeline 的蓝图 ${withTimeline} 个` }
      }
    },
    {
      id: '5 障碍蓝图真的连了线',
      run: async () => {
        let wired = 0
        for (const bp of blueprints) {
          const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
          if (p && (await anyGraphHas(p, graphIsWired))) wired++
        }
        return { ok: wired >= 1, note: `${wired}/${blueprints.length} 个蓝图图里有连线` }
      }
    },
    {
      id: '6 GameMode 设为默认',
      run: async () => {
        const cfg = await tool('ue_get_config', {
          config_name: 'Engine',
          section: '/Script/EngineSettings.GameMapsSettings',
          key: 'GlobalDefaultGameMode'
        })
        const v = String(cfg?.value ?? '')
        return { ok: v.includes('PartyMVP') || v.includes('BP_'), note: v || '(未设置)' }
      }
    },
    {
      id: '7 掉落重生',
      run: async () => {
        const hit = blueprints.length
          ? await Promise.all(
              blueprints.map((bp) => {
                const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
                return p
                  ? anyGraphHas(p, (g) =>
                      (g?.nodes ?? []).some((n) =>
                        /teleport|setactorlocation|respawn|restart|传送|重生/i.test(
                          `${n.title ?? ''} ${n.class ?? ''}`
                        )
                      )
                    )
                  : Promise.resolve(false)
              })
            )
          : []
        return { ok: hit.some(Boolean), note: hit.some(Boolean) ? '找到重生/传送节点' : '没找到' }
      }
    },
    {
      id: '8 终点触发通关',
      run: async () => {
        const hit = blueprints.length
          ? await Promise.all(
              blueprints.map((bp) => {
                const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
                return p
                  ? anyGraphHas(p, (g) =>
                      (g?.nodes ?? []).some((n) =>
                        /overlap|beginoverlap|hit|重叠|碰撞/i.test(
                          `${n.title ?? ''} ${n.class ?? ''}`
                        )
                      )
                    )
                  : Promise.resolve(false)
              })
            )
          : []
        return { ok: hit.some(Boolean), note: hit.some(Boolean) ? '找到重叠事件' : '没找到' }
      }
    },
    {
      id: '9 通关界面存在',
      run: async () => ({
        ok: widgets.length >= 1,
        note: widgets.length ? widgets.map((w) => w.name).join(', ') : '没有 Widget 资产'
      })
    },
    {
      id: '10 界面上有文字',
      run: async () => {
        for (const w of widgets) {
          const p = String(w.path ?? w.object_path ?? '').replace(/\.[^.]+$/, '')
          const h = await tool('widget_get_hierarchy', { path: p })
          // 形状没验证过，所以整体转字符串做宽松匹配，不猜字段名
          if (/TextBlock|Text/i.test(JSON.stringify(h ?? {}))) {
            return { ok: true, note: `${w.name} 里有文本控件` }
          }
        }
        return { ok: false, note: '没有找到文本控件' }
      }
    },
    {
      id: '11 触发时显示界面',
      run: async () => {
        const hit = blueprints.length
          ? await Promise.all(
              blueprints.map((bp) => {
                const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
                return p
                  ? anyGraphHas(p, (g) =>
                      (g?.nodes ?? []).some((n) =>
                        /createwidget|addtoviewport|创建控件|添加到视口/i.test(
                          `${n.title ?? ''} ${n.class ?? ''}`
                        )
                      )
                    )
                  : Promise.resolve(false)
              })
            )
          : []
        return { ok: hit.some(Boolean), note: hit.some(Boolean) ? '找到创建界面节点' : '没找到' }
      }
    },
    {
      id: '12 ≥2 个材质',
      run: async () => ({
        ok: materials.length >= 2,
        note: `${materials.length} 个材质：${materials.map((m) => m.name).join(', ') || '无'}`
      })
    },
    {
      id: '13 材质接到了输出',
      run: async () => {
        let connected = 0
        for (const m of materials) {
          const p = String(m.path ?? m.object_path ?? '')
          const g = await ue('material.get_graph', { path: p })
          // connections 数组是这一晚补的，字段 to_node/to_input 已验证
          if ((g?.connections ?? []).some((c) => c.to_node === 'Material')) connected++
        }
        return { ok: connected >= 2, note: `${connected}/${materials.length} 个材质接到了主节点` }
      }
    },
    {
      id: '14 资产都在 PartyMVP 下',
      run: async () => {
        const stray = paths.filter((p) => p && !p.includes('PartyMVP'))
        return {
          ok: assets.length > 0 && stray.length === 0,
          note: `${assets.length} 个资产，跑到外面的 ${stray.length} 个`
        }
      }
    },
    {
      id: '15 全部编译无错',
      run: async () => {
        let bad = []
        for (const bp of blueprints) {
          const p = String(bp.path ?? bp.object_path ?? '').replace(/\.[^.]+$/, '')
          if (!p) continue
          const desc = await ue('blueprint.describe', { blueprint_path: p })
          const st = String(desc?.compile_status ?? '')
          if (st && !/up.?to.?date|success/i.test(st)) bad.push(`${bp.name}:${st}`)
        }
        return {
          ok: blueprints.length > 0 && bad.length === 0,
          note: bad.length ? bad.join(', ') : `${blueprints.length} 个蓝图状态正常`
        }
      }
    }
  ]
}

// ── 跑 ──────────────────────────────────────────────────────────────────

console.log('\n巨型任务：派对闯关 MVP')
console.log(`封顶：${MAX_TOOL_CALLS} 次工具调用 / ${MAX_MINUTES} 分钟\n`)

if (!(await ensureBox())) {
  console.log('盒子起不来，终止')
  process.exit(1)
}

const sessionId = `party-mvp-${Date.now()}`
const startedAt = Date.now()
let usedCalls = 0
const allCalls = []
const turnLogs = []

for (const turn of TURNS) {
  const elapsedMin = (Date.now() - startedAt) / 60_000
  if (elapsedMin > MAX_MINUTES) {
    console.log(`⏱  已用 ${Math.round(elapsedMin)} 分钟，超时封顶，剩余轮次不跑\n`)
    break
  }
  if (usedCalls >= MAX_TOOL_CALLS) {
    console.log(`🔢 已用 ${usedCalls} 次工具调用，到顶，剩余轮次不跑\n`)
    break
  }

  console.log(`【${turn.label}】「${turn.prompt}」`)
  if (!(await ensureBox())) {
    console.log('  ❌ 盒子不可用，中止\n')
    break
  }

  let run
  try {
    run = await post('/api/debug/agent', {
      prompt: turn.prompt,
      sessionId,
      maxToolCalls: MAX_TOOL_CALLS - usedCalls,
      timeoutMs: Math.max(60_000, (MAX_MINUTES - elapsedMin) * 60_000)
    })
  } catch (error) {
    console.log(`  ❌ 请求中断：${error.message}\n`)
    break
  }

  const calls = run?.toolCalls ?? []
  usedCalls += calls.length
  allCalls.push(...calls)

  const python = calls.filter((c) => /python/i.test(c.name)).length
  const failed = calls.filter((c) => c.isError).length

  console.log(
    `  步数 ${run?.steps ?? '-'} · 工具 ${calls.length} 次（失败 ${failed}，Python ${python}）` +
      ` · ${Math.round((run?.elapsedMs ?? 0) / 1000)}s` +
      (run?.restoredMessages ? ` · 恢复了 ${run.restoredMessages} 条历史` : '') +
      (run?.hitToolCap ? ' · ⚠️ 撞到步数上限' : '')
  )
  if (run?.errors?.length) console.log(`  错误：${run.errors.join('; ').slice(0, 200)}`)
  if (run?.blockedApprovals?.length) {
    console.log(`  被拦下的本地磁盘操作：${run.blockedApprovals.map((b) => b.tool).join(', ')}`)
  }
  console.log(
    `  回复：${String(run?.text ?? '')
      .slice(0, 220)
      .replace(/\n+/g, ' ')}\n`
  )

  turnLogs.push({ label: turn.label, calls: calls.length, python, failed, steps: run?.steps })
}

// ── 验收 ────────────────────────────────────────────────────────────────

console.log('─'.repeat(70))
console.log('逐项核验（回引擎查真实状态）\n')

const checklist = await buildChecklist()
const verdicts = []
for (const item of checklist) {
  let v
  try {
    v = await item.run()
  } catch (error) {
    v = { ok: false, note: `核验出错：${error.message}` }
  }
  verdicts.push({ id: item.id, ...v })
  console.log(`  ${v.ok ? '✅' : '❌'} ${item.id} —— ${v.note}`)
}

const done = verdicts.filter((v) => v.ok).length
const pythonCalls = allCalls.filter((c) => /python/i.test(c.name)).length
const minutes = Math.round((Date.now() - startedAt) / 60_000)

console.log('\n' + '─'.repeat(70))
console.log(`完成度 ${done}/${verdicts.length}`)
console.log(
  `用了 ${usedCalls} 次工具调用 · ${minutes} 分钟 · ${turnLogs.length}/${TURNS.length} 轮`
)
console.log(
  `其中 Python ${pythonCalls} 次（${usedCalls ? Math.round((pythonCalls / usedCalls) * 100) : 0}%）` +
    ' —— 占比高说明对应的工具不够用，模型只能绕道'
)

// 工具使用分布：哪些工具真被用上了，是这一晚 60 个工具的实际投票
const freq = {}
for (const c of allCalls) freq[c.name] = (freq[c.name] ?? 0) + 1
const top = Object.entries(freq).sort((a, b) => b[1] - a[1])
console.log(`\n用到的工具 ${top.length} 种：`)
console.log('  ' + top.map(([n, c]) => `${n}×${c}`).join('  '))

const missed = verdicts.filter((v) => !v.ok)
if (missed.length) {
  console.log('\n没做到的：')
  for (const m of missed) console.log(`  ${m.id}：${m.note}`)
}
