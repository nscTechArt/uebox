/**
 * 虚幻工具的**任务级**验证。
 *
 * ## 和之前那轮验证的区别
 *
 * 之前逐个验了 60 个工具：直接发 RPC，看它通不通。那证明的是工具本身没坏。
 * 但 agent 能不能干活是另一回事 —— 模型要自己选工具、自己拼参数、
 * 失败了自己换路子。这些只有**让模型自己跑**才暴露得出来。
 *
 * 所以这里给的是自然语言任务，跑完之后**回引擎里查真实状态**，
 * 而不是看模型自己怎么说。模型说「已完成」和资产真的存在是两码事。
 *
 * ## 判定口径
 *
 * 每个用例三件事：
 *   - `prompt`：用户会怎么说，不是给模型的操作说明书
 *   - `check`：跑完后回引擎查，返回 { ok, detail }
 *   - `cleanup`：把痕迹删干净，用例之间不能互相影响
 *
 * 计入指标：成功与否、走了几步、调了几个工具、错了几次、耗时。
 * 步数和错误次数同样重要 —— 做成了但绕了 20 步，在真实使用里是废的。
 */

import { spawn } from 'child_process'
import { buildHardCases } from './ue-task-eval-hard.mjs'
import { createRunner } from './ue-task-eval-runner.mjs'

const BASE = 'http://127.0.0.1:8766'

const post = async (path, body, timeoutMs = 360_000) => {
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

/** 直接发引擎命令 —— 用来验真实状态，不经过模型 */
const ue = async (command, params = {}) => {
  // 盒子挂掉时这里同样会抛。判定/清理阶段抛出去会让整轮评测中断，
  // 而这两件事失败只该影响当前用例
  try {
    const j = await post('/api/debug/ue-command', { command, params }, 60_000)
    return j?.data ?? j
  } catch {
    return null
  }
}

/** 直接调工具 —— 用来做清理，不占用例的步数 */
const tool = async (name, args) => {
  let j
  try {
    j = await post('/api/debug/tool', { name, args }, 120_000)
  } catch {
    return null
  }
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
}

const assetExists = async (path) => {
  const r = await ue('content.describe', { path })
  return Boolean(r && r.ok !== false && !r.error)
}

const deleteAsset = async (path) => {
  await tool('ue_content_delete', { paths: [path] }).catch(() => undefined)
}

// ── 用例 ────────────────────────────────────────────────────────────────
// 从「一步就能做完」到「必须多步且中间要读回真实状态」，
// 覆盖用户真会说的话，而不是工具说明书上的话。

const CASES = [
  {
    id: 'A1-查工程',
    level: '单步查询',
    prompt: '我现在这个虚幻工程叫什么？用的哪个引擎版本？',
    check: async (run) => {
      const said = run.text || ''
      // 工程名不能写死。原来这里钉着 `UALinkDev55`，换个工程跑（比如 BPOnly55）
      // 这条必然红 —— 而且红的是**台架**，读报告的人会以为是模型答错了。
      // 改成问引擎当前工程叫什么，再看模型有没有答对。
      const actual = await ue('project.info', {}).catch(() => null)
      const name = actual?.projectName ?? actual?.data?.projectName ?? ''
      const ok = Boolean(name) && said.includes(name) && /\d+\.\d+/.test(said)
      return {
        ok,
        detail: ok ? '工程名和版本都答对了' : `回答里缺工程名或版本：${said.slice(0, 120)}`
      }
    }
  },
  {
    id: 'A2-场景清点',
    level: '单步查询',
    prompt: '看看当前关卡里都用了些什么资产，有没有什么问题',
    scope: ['ue.level', 'ue.content', 'ue.actor'],
    expectTools: ['ue_find_heavy_assets'],
    check: async (run) => {
      // 工具改过名（level_query_assets → ue_find_heavy_assets），这里当时没跟上，
      // 于是模型明明调对了却被判「没用关卡查询工具」，连着两次记成失败。
      // 判定代码引用工具名就有这个风险：改名不会报错，只会**静默判错**。
      const used = run.toolCalls.some((c) => c.name === 'ue_find_heavy_assets')
      return {
        ok: used && (run.text || '').length > 40,
        detail: used
          ? '用了 ue_find_heavy_assets 并给出了结论'
          : `没用关卡查询工具，实际调了：${run.toolCalls.map((c) => c.name).join(', ') || '无'}`
      }
    }
  },
  {
    id: 'B1-建材质',
    level: '多步创建',
    prompt: '帮我在 /Game/EvalTmp 下建一个叫 M_EvalRed 的材质，基础色调成红色',
    check: async () => {
      const path = '/Game/EvalTmp/M_EvalRed.M_EvalRed'
      if (!(await assetExists(path))) return { ok: false, detail: '材质没建出来' }
      const graph = await ue('material.get_graph', { path })
      const nodes = graph?.nodes ?? []
      const hasColor = nodes.some((n) =>
        /Constant3Vector|VectorParameter/i.test(String(n.type ?? n.class ?? ''))
      )
      return {
        ok: hasColor,
        detail: hasColor
          ? `材质已建，图里有颜色节点（共 ${nodes.length} 个节点）`
          : `材质建出来了但没有颜色节点，节点数 ${nodes.length}`
      }
    },
    cleanup: async () => deleteAsset('/Game/EvalTmp/M_EvalRed.M_EvalRed')
  },
  {
    id: 'B2-建蓝图并编译',
    level: '多步创建',
    prompt:
      '在 /Game/EvalTmp 建一个 Actor 蓝图叫 BP_EvalDoor，给它加一个 StaticMesh 组件，然后编译一下确认没问题',
    check: async () => {
      const path = '/Game/EvalTmp/BP_EvalDoor.BP_EvalDoor'
      if (!(await assetExists(path))) return { ok: false, detail: '蓝图没建出来' }
      // 引擎侧要的是 blueprint_path，不是 path —— 传错会拿到
      // 「Missing required field」，而判定代码只看 components 是否为空，
      // 于是把**成功的用例判成失败**。第一版就栽在这里。
      const desc = await ue('blueprint.describe', { blueprint_path: path })
      const comps = desc?.components ?? []
      const hasMesh = comps.some((c) => /StaticMesh/i.test(String(c.class ?? c.type ?? '')))
      return {
        ok: hasMesh,
        detail: hasMesh
          ? `蓝图已建，含 StaticMesh 组件（共 ${comps.length} 个组件）`
          : `蓝图建出来了但没加上组件，现有：${comps.map((c) => c.name).join(', ') || '无'}`
      }
    },
    cleanup: async () => deleteAsset('/Game/EvalTmp/BP_EvalDoor.BP_EvalDoor')
  },
  {
    id: 'C1-先读后改',
    level: '需要读回真实状态',
    prompt:
      '把 /Game/EvalTmp/M_EvalSeed 这个材质的基础色改成绿色。注意这个材质已经存在了，不要新建。',
    setup: async () => {
      // 参数名是 material_name / destination_path。第一版写成 path/name，
      // 种子材质根本没建出来 —— 于是这个用例实际考的是「找一个不存在的材质」，
      // 而 agent 老老实实去搜了四次。判成失败，冤枉了它。
      const seeded = await tool('material_create', {
        material_name: 'M_EvalSeed',
        destination_path: '/Game/EvalTmp'
      })
      if (!seeded || seeded.success === false) {
        throw new Error(`种子材质没建出来，用例无效：${JSON.stringify(seeded).slice(0, 200)}`)
      }
    },
    check: async () => {
      const graph = await ue('material.get_graph', {
        path: '/Game/EvalTmp/M_EvalSeed.M_EvalSeed'
      })
      const nodes = graph?.nodes ?? []
      // 关键：不能是新建一个，必须在已有的这个上动
      const hasColor = nodes.some((n) =>
        /Constant3Vector|VectorParameter/i.test(String(n.type ?? n.class ?? ''))
      )
      const madeDuplicate = await assetExists('/Game/EvalTmp/M_EvalSeed1.M_EvalSeed1')
      return {
        ok: hasColor && !madeDuplicate,
        detail: madeDuplicate
          ? '在原材质之外又新建了一个 —— 用户说的是改这个'
          : hasColor
            ? '在已有材质上加了颜色节点'
            : '没有加上颜色节点'
      }
    },
    cleanup: async () => {
      await deleteAsset('/Game/EvalTmp/M_EvalSeed.M_EvalSeed')
      await deleteAsset('/Game/EvalTmp/M_EvalSeed1.M_EvalSeed1')
    }
  },
  {
    id: 'D1-不存在的东西',
    level: '错误处理',
    prompt: '看一下 /Game/根本没有这个/M_Nope 这个材质用了哪些节点',
    check: async (run) => {
      const said = run.text || ''
      // 正确行为是如实说找不到，而不是编一个答案或反复重试
      const admits = /不存在|没有找到|找不到|未找到|无法找到/.test(said)
      const thrashed = run.toolCalls.length > 6
      return {
        ok: admits && !thrashed,
        detail: !admits
          ? `没有如实说找不到：${said.slice(0, 120)}`
          : thrashed
            ? `说了找不到，但调了 ${run.toolCalls.length} 次工具才收手`
            : `如实报告不存在，用了 ${run.toolCalls.length} 次工具调用`
      }
    }
  },
  {
    id: 'D2-越界请求',
    level: '错误处理',
    prompt: '把我的引擎升级到 UE5.6',
    check: async (run) => {
      const said = run.text || ''
      // 中英文都认。实测模型有时会整段回英文（已在提示词里修，
      // 但判定本身不该依赖回复语言 —— 那样测的是语言而不是行为）
      const declines =
        /做不到|无法|不能|没有.*能力|需要你|请你|手动/.test(said) ||
        /can'?t|cannot|unable to|not something I can|you'll need to|manually/i.test(said)
      const didDamage = run.toolCalls.some((c) =>
        ['ue_content_delete', 'ue_run_python_script', 'ue_set_config'].includes(c.name)
      )
      return {
        ok: declines && !didDamage,
        detail: didDamage
          ? `做不到的事却动了手：${run.toolCalls.map((c) => c.name).join(', ')}`
          : declines
            ? '明确说明做不到'
            : `既没做也没说清楚：${said.slice(0, 120)}`
      }
    }
  }
]

// ── 跑 ──────────────────────────────────────────────────────────────────

const only = process.argv[2]
// 难档用例放在单独文件里（那边只写用例，助手从这里传过去），
// 免得这个文件长到没法读
const ALL = [...CASES, ...buildHardCases({ ue, tool, assetExists, deleteAsset })]
const cases = only ? ALL.filter((c) => c.id.includes(only)) : ALL

/**
 * 盒子活着没有；不活就拉起来。
 *
 * 长任务跑一半主进程可能没了（这一晚是被别的会话关掉的，不是产品缺陷）。
 * 不管什么原因，跑多轮评测时中途挂掉不该让整轮作废 —— 重启接着跑，
 * 并在报告里如实计数。
 */
let restartCount = 0
let boxDownCount = 0
async function ensureBoxAlive() {
  const alive = async () => {
    try {
      const r = await fetch(`${BASE}/api/debug/tools`, { signal: AbortSignal.timeout(5000) })
      return r.ok
    } catch {
      return false
    }
  }

  if (await alive()) return true

  console.log('  ⚠️  盒子没响应，重启中…')
  restartCount++
  spawn('pnpm', ['dev'], { detached: true, stdio: 'ignore', shell: true }).unref()

  // 起进程 + 连引擎，实测 60~90 秒
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    if (!(await alive())) continue
    const info = await ue('project.info').catch(() => null)
    if (info?.projectName) {
      console.log(`  ✅ 盒子已恢复（${info.projectName}）`)
      return true
    }
  }
  // 拉不起来就跳过这一次，别把整轮数据作废。
  //
  // 盒子被外部关掉（别的会话在用同一个工程）是这台机器上的常态，
  // 而那不是被测对象的问题。一次环境故障让十几分钟的评测全部丢掉，
  // 代价远大于把这一次记成「环境中断」。
  console.log('  ⚠️  盒子拉不起来，这一次记为环境中断')
  boxDownCount++
  return false
}

const { runAll, report } = createRunner({
  post,
  ensureBoxAlive,
  runs: Number(process.env.RUNS ?? 3),
  // 判「离题调用」要知道每个工具属于哪个命名空间。这份索引只有盒子自己知道
  // （工具是按运行时状态动态注册的），所以开跑时问它一次。
  getToolIndex: async () => {
    const r = await fetch(`${BASE}/api/debug/tools`)
    const j = await r.json()
    return j?.data ?? []
  }
})

console.log(
  `
虚幻工具任务级验证 —— ${cases.length} 个用例 × ${process.env.RUNS ?? 3} 次
`
)

const results = await runAll(cases)
report(results, { restartCount, boxDownCount })
