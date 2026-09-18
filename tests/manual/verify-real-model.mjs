/**
 * 真实模型下的四条关键验证。
 *
 * 集成测试（fauxProvider）证明了管道通，但模型说什么是脚本写死的。
 * 这四条只有真模型能验 —— 它们考的是模型的判断，不是代码的正确性。
 *
 * 用法：
 *   1. 先在 设置 → 模型 里配好 provider，把 agent 角色绑到一个**支持工具调用**的模型
 *      （DeepSeek 用 deepseek-chat，不要用 deepseek-reasoner）
 *   2. node tests/manual/verify-real-model.mjs
 *
 * 用一份**独立的 userData**（`.test/verify-userdata`），并把你真实配置里的
 * `models.json` + 密钥库拷进去 —— 这样既能用你配的 provider，又不会污染你的
 * 正式配置，也不会和正在运行的盒子抢端口。
 *
 * 会真的发 API 请求，产生费用。
 *
 * ## 依赖引擎的用例：必须先声明一次性测试工程
 *
 * 这个脚手架用 `approvalMode: 'yolo'`，**它真的会改连着的那个 UE 工程**。
 * 所以依赖引擎的用例默认不跑，要跑得先走一遍：
 *
 *   set SKILL_EVAL_UE_TEMPLATE=D:\eval\Template        固定模板，脚手架只读
 *   set SKILL_EVAL_UE_PROJECT=D:\eval\Run              一次性副本，会被整个丢弃重建
 *   1. 关掉 UE 编辑器
 *   2. node tests/manual/verify-real-model.mjs --restore   丢弃副本、从模板重建
 *   3. 用 UE 打开那个副本，等插件连上
 *   4. node tests/manual/verify-real-model.mjs
 *
 * 恢复是「整个副本丢掉重建」，不是增量回滚 —— 和产品里的 `assetSnapshot`
 * 要求完全不同（那边必须保留用户未保存的工作、处理编辑器里开着的资产），
 * 两者不共用实现，也不互相阻塞。
 *
 * **尚未覆盖**：脚手架不会自己开关 UE 编辑器，也确认不了操作者打开的确实是那个副本。
 * 前者要驱动编辑器生命周期，后者要一次确定性的 `ue_get_project_info` 调用。
 */
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { CASES as ALL_CASES } from './skill-routing-cases.mjs'
import { EVAL_COPY_MARKER, planRestore } from './eval-project.mjs'
import {
  BatchAborted,
  assertBatchNotStuck,
  classify,
  groupCalls,
  sampleValidity,
  summarize
} from './skill-routing-verdict.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..', '..')
const SHOT = path.join(APP_DIR, '.test', 'shots')
fs.mkdirSync(SHOT, { recursive: true })

/**
 * 从真实 userData 拷一份配置到隔离目录。
 *
 * 正式盒子可能正开着（会占住 17860 端口），所以必须用独立实例；
 * 但 provider 配置在真实 userData 里，得搬过来才能用。
 */
const REAL_USERDATA =
  process.env.UNREAL_BOX_USERDATA || path.join(process.env.APPDATA || '', 'unreal-box')
const TEST_USERDATA = path.join(APP_DIR, '.test', 'verify-userdata')

fs.rmSync(TEST_USERDATA, { recursive: true, force: true })
fs.mkdirSync(TEST_USERDATA, { recursive: true })

const copied = []
// 'Local State' 必须一起拷 —— 少了它这个脚手架就是废的。
//
// Windows 上 Electron 的 safeStorage 并不是纯 DPAPI：Chromium 的 os_crypt 会生成
// 一个随机主密钥，用 DPAPI 包好后存在 userData/Local State 里。换一个 userData
// 目录就等于换了一把主密钥，密文解不开。
//
// 而 credentials.ts 解不开时是**按空密钥库处理**（换机器/重装系统的正常路径，
// 不该让整个 AI 配置读不出来）—— 于是这里表现为：配置读到了、模型选到了、
// 请求发出去了、401、四条验证全 0 次工具调用却报 success。
// 排查了一整轮才定位到，跟 agent 本身一点关系都没有。
for (const file of ['models.json', 'ai-provider-secrets.bin', 'mcp.json', 'Local State']) {
  const src = path.join(REAL_USERDATA, file)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(TEST_USERDATA, file))
    copied.push(file)
  }
}
if (!copied.includes('models.json')) {
  console.log(`✖ 在 ${REAL_USERDATA} 里没找到 models.json`)
  console.log('  请先在 设置 → 模型 里配好 provider；若 userData 不在默认位置，')
  console.log('  用 UNREAL_BOX_USERDATA=<路径> 指定。')
  process.exit(1)
}
console.log(`已从真实配置拷贝: ${copied.join(', ')}`)
console.log(`隔离运行目录: ${TEST_USERDATA}
`)

const log = (...a) => console.log(...a)
const hr = (t) => log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`)

// ── 启动 ──────────────────────────────────────────────────────────────────

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
  // 独立 userData + 换端口，避免和正在运行的盒子冲突
  args: [APP_DIR, `--user-data-dir=${TEST_USERDATA}`],
  cwd: APP_DIR,
  env: { ...process.env, WS_PORT: '17861' },
  timeout: 60_000
})
app.process().stdout?.on('data', (d) => {
  const s = String(d)
  if (s.includes('[AgentV3]')) process.stdout.write(`  [main] ${s}`)
})

let page = null
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const m = app
    .windows()
    .filter((w) => !w.url().startsWith('devtools://'))
    .find((w) => !w.url().includes('#/spotlight'))
  if (m) {
    page = m
    break
  }
}
if (!page) {
  log('✖ 等不到窗口')
  await app.close()
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 5000))

// ── 事件收集 ──────────────────────────────────────────────────────────────

await page.evaluate(() => {
  window.__events = []
  const types = [
    'start',
    'text',
    'thinking',
    'tool-call',
    'tool-progress',
    'tool-result',
    'step',
    'done',
    'error',
    'context-usage',
    'compacting'
  ]
  for (const t of types) {
    window.api.on(`agent-v3:${t}`, (payload) => {
      window.__events.push({ type: t, ...payload })
    })
  }
})

/** 中止原因。判定和抛出在 `skill-routing-verdict.mjs`，那边有测试钉住控制流 */
let batchAborted = null

/**
 * 跑一轮对话，返回收集到的事件。
 *
 * ## 超时之后必须真的把它停住
 *
 * 原来这里是 `Promise.race([done, timed])`，超时只是**不再等**，
 * `execute` 仍在后台跑。于是上一条用例的工具调用会流进下一条用例的事件数组里 ——
 * 把超时那条从分母剔除也救不了被污染的下一条。
 *
 * `stop()` 会等它真的停下来，`drained === false` 表示等超时了还没停。
 * 这两种情况严重程度不同，所以分开回传，由 `sampleValidity` 定性。
 *
 * ## 为什么不在收集时按会话过滤
 *
 * 越界的事件正是**串样的证据**。过滤掉等于把证据一起丢了，
 * 样本会安静地变脏。这里原样收下，由 `sampleValidity` 认出来并判该样本无效。
 */
async function run(sessionId, prompt, timeoutMs = 300_000) {
  await page.evaluate(() => {
    window.__events = []
  })

  const result = await page.evaluate(
    async ({ sessionId, prompt, timeoutMs }) => {
      const started = Date.now()
      const done = window.api.agentV3.execute({
        sessionId,
        prompt,
        mode: 'agent',
        // 验证期间不弹审批，否则脚本要一直点确认
        approvalMode: 'yolo'
      })
      const TIMEOUT = Symbol('timeout')
      const timed = new Promise((r) => setTimeout(() => r(TIMEOUT), timeoutMs))
      const raced = await Promise.race([done, timed])
      if (raced !== TIMEOUT) return { out: raced, ms: Date.now() - started, timedOut: false }

      // 超时：主动停，并等它真的停下来
      const stopped = await window.api.agentV3.stop({ sessionId }).catch((e) => ({
        success: false,
        error: String(e)
      }))
      return {
        out: null,
        ms: Date.now() - started,
        timedOut: true,
        drained: stopped?.drained === true,
        stopError: stopped?.error
      }
    },
    { sessionId, prompt, timeoutMs }
  )

  const events = await page.evaluate(() => window.__events)
  if (result.timedOut) {
    log(`  ⚠️ 超时 ${Math.round(result.ms / 1000)}s，已请求停止：drained=${result.drained}`)
  }

  // **没停住就在这里终止整批**，而不是交给各条判定线自己判断。
  //
  // 上一版只在判定线 ① 的循环里 `break`：②③④ 各有各的 `run()` 调用，
  // 谁都没检查停止结果，于是「①没停住」之后 ②③④ 照跑，
  // 而 ②③④ 自己超时没停住时更是完全没人管（`--only=3,4` 复现出超时后又启动了 10 次）。
  // 旧 agent 还在后台转，新请求继续发出去：既烧钱，又让后面每一条样本都说不清归属。
  //
  // 放在 `run()` 里是因为**这是所有判定线唯一的共用入口**。抛异常而不是设标志，
  // 是为了立刻打断当前调用链；最外层统一 catch，收尾（写结果、截图、退出码）照常走。
  try {
    assertBatchNotStuck({ sessionId, timedOut: result.timedOut, drained: result.drained })
  } catch (error) {
    batchAborted = error.message
    throw error
  }

  return { ...result, sessionId, events }
}

/** 判一条样本：有效性 + 判定。两者分开 —— 无效样本要从分母里剔除，不是判失败 */
function judge(runResult, testCase) {
  const validity = sampleValidity({
    execResult: runResult.out,
    events: runResult.events,
    sessionId: runResult.sessionId,
    timedOut: runResult.timedOut === true,
    drained: runResult.drained,
    requiredCompeting: testCase.requiredCompeting ?? [],
    toolNames: runResult.out?.toolNames ?? null
  })
  const calls = groupCalls(runResult.events, runResult.sessionId)
  const result = classify(calls, testCase)
  return { validity, result, calls }
}

const toolCalls = (events) => events.filter((e) => e.type === 'tool-call')
const texts = (events) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('\n')

// ── 前置检查 ──────────────────────────────────────────────────────────────

hr('前置检查')
const smoke = await page.evaluate(() => window.api.agentV3.smoke())
log(`内核: ok=${smoke.ok}  工具=${smoke.toolCount}  技能=${smoke.skillCount}`)

const probe = await run('verify-probe', '说一句“准备好了”，不要调用任何工具。', 180_000)

// `execute` 的返回是**扁平**的 `{ success, error, toolNames, ueConnected, … }`
// （见 ipc/agentV3.ts）。这里原来写的是 `probe.out?.out?.success === false`，
// 多读了一层，恒为 undefined —— 这道前置检查从来没生效过。
//
// 它要挡的正是本文件开头描述的那个故障：密钥解不开 → 401 → 四条判定线全 0 次
// 工具调用却报 success。成因（Local State 没拷）当时修了，护栏本身是坏的。
if (probe.timedOut || probe.out?.success !== true) {
  log(
    `\n✖ 模型没跑起来：${probe.timedOut ? `超时 ${probe.ms}ms` : (probe.out?.error ?? '(无 success)')}`
  )
  log('  请先在 设置 → 模型 里配好 provider，并把 agent 角色绑到支持工具调用的模型。')
  await app.close()
  process.exit(1)
}
log(`模型可用（${probe.ms}ms）：${texts(probe.events).slice(0, 80)}`)
log(
  `本次会话工具池：${probe.out.toolCount} 个${probe.out.toolNames ? '' : ' —— ⚠️ 没拿到工具名清单'}`
)

const results = {}

// 引擎连没连决定工具池：未连接时 ue.* 整个不注册，相关用例要跳过而不是判失败。
//
// 别拿 smoke 的数去推 —— toolDiagnostics 报的是**整个注册表**（77 个），
// 不是这次会话真正拿到的工具池（未连接时只有 14 个）。我一开始用
// `smoke.toolCount > smoke.toolCountWithoutUe + 3` 判，77 > 11+3 恒成立，
// 于是两条依赖引擎的用例在引擎没连的情况下照跑，模型根本看不见那些工具，
// 被记成"选错了"。用 execute 回传的会话级实况。
const engineConnected = probe.out?.ueConnected === true
log(engineConnected ? '引擎已连接，全部用例都跑' : '引擎未连接 —— 只跑不依赖引擎的用例')

// ── 工程隔离 ──────────────────────────────────────────────────────────────
//
// 这个脚手架用 `approvalMode: 'yolo'`，**它真的会改连着的那个 UE 工程**。
// 所以依赖引擎的用例默认**不跑**：必须先声明一个一次性的测试工程，
// 由脚手架自己从模板重建 —— 重建过的副本才谈得上"可丢弃"。
//
// 恢复是「整个副本丢掉重建」，不是增量回滚。这和产品里的 assetSnapshot
// 要求完全不同（那边必须保留用户未保存的工作、处理编辑器里开着的资产），
// 两者不共用实现，也不互相阻塞。
const TEMPLATE = process.env.SKILL_EVAL_UE_TEMPLATE || ''
const TEST_PROJECT = process.env.SKILL_EVAL_UE_PROJECT || ''
const testProjectDeclared = Boolean(TEMPLATE && TEST_PROJECT)

if (process.argv.includes('--restore')) {
  hr('恢复测试工程')

  // 这底下是一条 rm -rf，作用在环境变量给的路径上。判定抽在
  // eval-project.mjs 里，好让「模板和副本填成同一路径」这类反例
  // 能在不碰真实磁盘的情况下被测住 —— 评审就是这么复现出先删模板的。
  const plan = planRestore({
    template: TEMPLATE,
    project: TEST_PROJECT,
    resolve: (x) => path.resolve(x),
    exists: (x) => fs.existsSync(x),
    hasMarker: (x) => fs.existsSync(path.join(x, EVAL_COPY_MARKER))
  })
  if (!plan.ok) {
    log(`✖ ${plan.error}`)
    await app.close()
    process.exit(1)
  }
  // 编辑器开着就不能重建 —— 文件被占用，而且重建完它内存里还是旧的
  if (engineConnected) {
    log('✖ 编辑器还连着。先关掉 UE 编辑器再跑 --restore。')
    await app.close()
    process.exit(1)
  }

  log(`${plan.willDelete ? '丢弃并重建' : '首次创建'}：${plan.project}`)
  fs.rmSync(plan.project, { recursive: true, force: true })
  fs.cpSync(plan.template, plan.project, { recursive: true })
  // 标记文件是「这个目录是脚本造的」唯一可核实的凭据。下次 --restore
  // 靠它区分一次性副本和用户的真实工程，所以必须在复制之后立刻写下
  fs.writeFileSync(
    path.join(plan.project, EVAL_COPY_MARKER),
    `created-by tests/manual/verify-real-model.mjs --restore
${new Date().toISOString()}
`,
    'utf8'
  )
  log('完成。现在用 UE 打开这个副本，等插件连上，再不带 --restore 跑一次。')
  await app.close()
  process.exit(0)
}

if (engineConnected && !testProjectDeclared) {
  log('⚠️ 引擎连着，但没有声明一次性测试工程 —— 依赖引擎的用例一律跳过。')
  log('   要跑它们：设好 SKILL_EVAL_UE_TEMPLATE / SKILL_EVAL_UE_PROJECT，先跑一次 --restore。')
}
/** 依赖引擎的用例要同时满足：引擎连着 + 工程是我们自己重建出来的一次性副本 */
const engineCasesAllowed = engineConnected && testProjectDeclared

/**
 * 只跑指定的判定线，例如 `--only=1` 或 `--only=1,4`。
 *
 * 判定线 ③ 要灌 8 轮 x 2.4 万 token 的填充文本才逼得出压缩，
 * 只想验判定线 ① 的时候跑全量纯属烧钱。缺省仍是四条全跑。
 */
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : null
const wants = (line) => !ONLY || ONLY.has(String(line))
if (ONLY)
  log(`
只跑判定线：${[...ONLY].join(', ')}`)

// 四条判定线包在同一个 try 里：`run()` 在「超时没停住」时抛
// `BatchAborted`，无论它出自哪一条都立刻打断整批；下面的汇总、写结果、
// 截图、退出码照常走 —— “停下来”不该顺带把已经跑出来的数据丢掉。
try {
  // ── ① 模型能否自己想到先 load_skill ───────────────────────────────────────

  if (wants(1)) {
    hr('① 模型能否先读对技能，再动手')
    log('判据不是"调用顺序"，是六态判定 —— 见 skill-routing-verdict.mjs 里的三个漏判。')

    /**
     * 少量真机样本。**这不是评测用例集**，只是让新判定在真机上走一遍。
     *
     * `requiredCompeting` 是这道题"直接动手"需要的工具：它不在池里的时候，
     * 跳过技能这件事在物理上就发生不了，样本对"会不会跳过"这个结论无效。
     * 未连引擎时 ue.* 整个不注册，这一条会真的触发。
     */
    // 用例集在 `skill-routing-cases.mjs`，那边有测试守住「不许逐字抄触发词」
    // 这条规矩。原来这里内联着三条自己写的用例，两处各写一份必然漂移。
    //
    // 依赖引擎的用例要同时满足两个条件才跑（见 §工程隔离）：引擎连着，
    // 而且连的是我们自己重建出来的一次性副本。
    const skillCases = ALL_CASES.filter((c) => engineCasesAllowed || !c.needsEngine)

    results.skill = { samples: [] }
    for (const [i, c] of skillCases.entries()) {
      // 每条样本一个独立会话 —— 复用会话会让上一条的调用留在上下文里
      const r = await run(`verify-skill-${i}-${c.tag}`, c.say)
      const { validity, result, calls } = judge(r, c)

      log(`  「${c.say.slice(0, 20)}…」  期望 ${c.expect ?? '(不该加载技能)'}`)
      log(
        `    调用: ${calls.map((x) => `${x.toolName}@r${x.response}`).join(' → ') || '(一个都没调)'}`
      )
      log(
        validity.ok
          ? `    判定: ${result.verdict} ${result.pass ? '✅' : '✖'}` +
              (validity.usableFor.skip ? '' : `  （缺竞争工具 ${validity.detail}，不计入跳过结论）`)
          : `    样本无效: ${validity.reason} ${validity.detail ?? ''}`
      )
      results.skill.samples.push({ case: c.tag, validity, result })
      // 「超时没停住」不在这里处理：`run()` 已经抛 BatchAborted 打断整批了。
      // 留两套机制只会让人以为其中一套在生效，而实际上先触发的永远是另一套。
    }
    results.skill.summary = summarize(results.skill.samples)
    log(`小结: ${JSON.stringify(results.skill.summary.byVerdict)}`)
    log(
      `有效 ${results.skill.summary.valid}/${results.skill.summary.total}` +
        `，通过率 ${results.skill.summary.passRate ?? '—'}` +
        `，可用于跳过结论 ${results.skill.summary.skipUsable}`
    )
  } // ← 判定线 1 结束

  // ── ② 77 个工具描述够不够让它选对 ─────────────────────────────────────────

  if (wants(2)) {
    hr('② 工具描述是否足以让模型选对')
    log('给一个只有特定工具能做的任务，看它选谁。')

    /**
     * 用例分两类：
     *   - 不依赖引擎的（本地能力）：任何时候都能验
     *   - 依赖引擎的：只有连上引擎才注册，没连时跳过而不是判失败
     */
    const cases = [
      {
        prompt: '把资产库里所有名字带 tree 的资产找出来。',
        expect: ['search_assets'],
        needsEngine: false
      },
      { prompt: '给我列一下都有哪些虚幻项目。', expect: ['project_manage'], needsEngine: false },
      {
        prompt: '看看当前虚幻项目里都有哪些材质。',
        // material_list 这个工具不存在（插件侧的 material.list 也在 2026-09-16 删了）：
        // 「有哪些材质」走 ue_content_search 带 filter_class
        expect: ['ue_content_search', 'material_describe'],
        needsEngine: true
      },
      {
        prompt: '虚幻引擎刚才崩溃了，帮我看看崩溃日志。',
        expect: ['ue_get_crash_logs'],
        needsEngine: true
      }
    ].filter((c) => engineCasesAllowed || !c.needsEngine)
    results.toolChoice = []
    for (const [i, c] of cases.entries()) {
      const r = await run(`verify-tool-${i}`, c.prompt)
      const picked = toolCalls(r.events).map((e) => e.toolName)
      const hit = picked.some((n) => c.expect.includes(n))
      log(`  「${c.prompt.slice(0, 24)}…」`)
      log(`    期望其一: ${c.expect.join(' / ')}`)
      log(`    实际选了: ${picked.join(' → ') || '(无)'}  ${hit ? '✅' : '✖'}`)
      results.toolChoice.push({ prompt: c.prompt, expect: c.expect, picked, hit })
    }
  } // ← 判定线 2 结束

  // ── ③ compaction 后还记不记得早期结论 ─────────────────────────────────────

  if (wants(3)) {
    hr('③ compaction 触发后模型是否还记得早期结论')
    log('先塞一个事实，再灌长对话逼出压缩，最后回头问那个事实。')

    const FACT = 'ZY-9F72-KRT'
    await run('verify-compact', `记住这个工单号：${FACT}。之后我会问你。先回一句“记住了”。`)

    /**
     * 靠"让模型多写点"是撑不满上下文的。
     *
     * 窗口是 128k（piModel.ts 的缺省值），压缩阈值是「已用 + 保留额度(24k) > 窗口」，
     * 也就是要用掉 104k 才触发。模型每轮回 500 字 ≈ 800 token，12 轮才 1 万 ——
     * 上一轮跑完 triggered=false，这条等于没验到，却差点被当成通过。
     *
     * 改成**我们自己灌**：每轮塞一大段确定性文本进 prompt。历史每轮都会重发，
     * prompt_tokens 累加得很快，几轮就到阈值。
     */
    const FILLER_UNIT =
      '虚幻引擎的材质表达式节点在编译期会被展开成 HLSL 片段，采样器槽位上限与平台相关。'
    const FILLER = FILLER_UNIT.repeat(900) // ≈ 2.4 万 token/轮

    let compacted = false
    for (let i = 0; i < 8 && !compacted; i++) {
      const r = await run(
        'verify-compact',
        `这是第 ${i + 1} 批参考资料，读完只回「收到」两个字，不要复述：
  ${FILLER}`,
        300_000
      )
      const usage = r.events.filter((e) => e.type === 'context-usage').pop()
      compacted = r.events.some((e) => e.type === 'compacting')
      log(
        `  第 ${i + 1} 轮：上下文 ${usage?.tokens ?? '?'} / ${usage?.contextWindow ?? '?'}` +
          (compacted ? '  ← 触发压缩' : '')
      )
    }

    const recall = await run('verify-compact', '我一开始给你的那个工单号是什么？只回答工单号本身。')
    const recalled = texts(recall.events).includes(FACT)
    results.compaction = {
      triggered: compacted,
      recalled,
      answer: texts(recall.events).slice(0, 120)
    }
    log(`压缩触发: ${compacted ? '是' : '否（上下文没撑满，这条没验到）'}`)
    log(`回忆结果: ${recalled ? '✅ 记得' : '✖ 忘了'} —— 回答「${results.compaction.answer}」`)
  } // ← 判定线 3 结束

  // ── ④ 失败工具会不会被反复重试 ────────────────────────────────────────────

  if (wants(4)) {
    hr('④ 失败的工具会不会被反复重试（V2 的老毛病）')

    /**
     * 场景选择很关键。
     *
     * 一开始想用「引擎未连接时发引擎指令」，但那验不到 —— `resolveTools` 在未连接时
     * 会把 ue.* 工具**整个过滤掉**，模型压根看不到，自然无从重试，这条会假通过。
     *
     * 改用一个**已注册且必定失败**的调用：给一个不存在的资产打标签。
     * add_asset_tags 一直在工具池里（不依赖引擎），但资产不存在，必然报错。
     */
    log('依次试几个必定失败的调用，取第一个真失败的，数它撞几次墙。')

    /**
     * 制造一次**真实的工具失败**比想象中难 —— 这本身是个好消息。
     *
     * 试过两版都没验到：
     *   v1「请给资产 X 打标签」→ 模型先 search_assets，没搜到就收手，零失败。
     *   v2 加了「不要先搜索，直接调」→ 它照样先搜，还明确回复
     *      「按我的操作原则，不能凭空用一个未验证的 assetKey 去打标签」。
     *
     * 那份谨慎正是 V2 缺的，但它让这条判定线悬空。所以改成一组**递进的强制探针**，
     * 取第一个真产生 isError 结果的来数重试次数；一个都没失败就记「未验到」，
     * 绝不按通过算。
     */
    const retryProbes = [
      {
        label: 'load_skill 不存在的技能',
        prompt: '直接调用 load_skill 加载技能 ue-nonexistent-skill-9999，不要先调 list_skills。'
      },
      {
        label: 'read_skill_resource 不存在的文件',
        prompt:
          '直接调用 read_skill_resource 读取技能资源 ue-nonexistent-skill-9999/reference/zzz.md。'
      },
      {
        label: 'update_note 不存在的笔记',
        prompt: '直接调用 update_note 把笔记 note-zzz-does-not-exist-9999 的内容改成「测试」。'
      }
    ]

    let r4 = null
    for (const probeCase of retryProbes) {
      const attempt = await run('verify-retry', probeCase.prompt, 240_000)
      const errored = attempt.events.filter((e) => e.type === 'tool-result' && e.isError).length
      log(`  探针「${probeCase.label}」：失败 ${errored} 次`)
      r4 = attempt
      if (errored > 0) break
    }
    const calls4 = toolCalls(r4.events).map((e) => e.toolName)
    const failed = r4.events.filter((e) => e.type === 'tool-result' && e.isError)
    const perTool = {}
    for (const n of calls4) perTool[n] = (perTool[n] ?? 0) + 1
    const maxRepeat = Math.max(0, ...Object.values(perTool))

    log(`工具调用: ${calls4.join(' → ') || '(无)'}`)
    log(`失败次数: ${failed.length}，同一工具最多重复 ${maxRepeat} 次`)
    log(`最终回复: ${texts(r4.events).slice(0, 200)}`)
    results.retry = { calls: calls4, failures: failed.length, maxRepeat, perTool }
    log(
      failed.length === 0
        ? '— 一次失败都没制造出来，这条未验到（不按通过算）'
        : maxRepeat <= 2
          ? '✅ 没有陷入重试循环'
          : `⚠️ 同一工具撞了 ${maxRepeat} 次 —— 需要在 system prompt 里加强约束`
    )
  } // ← 判定线 4 结束
} catch (error) {
  if (!(error instanceof BatchAborted)) throw error
  log(`
✖ ${error.message} —— 整批中止，后面的判定线一律不跑。`)
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

hr('汇总')
// 没跑到的判定线一律记 null（—）。`--only` 跳过的和「跑了但没验到」的处置相同：
// 都不是通过。规矩来自 README —— 「验不到的判定线记 — 而不是 ✅」。
const verdicts = [
  [
    '① 先读对技能再动手',
    !results.skill || results.skill.summary.valid === 0
      ? null
      : results.skill.summary.passRate === 1
  ],
  [
    '② 工具描述够选对',
    results.toolChoice
      ? results.toolChoice.filter((c) => c.hit).length === results.toolChoice.length
      : null
  ],
  ['③ 压缩后还记得', results.compaction?.triggered ? results.compaction.recalled : null],
  ['④ 不陷入重试循环', results.retry?.failures > 0 ? results.retry.maxRepeat <= 2 : null]
]
for (const [name, ok] of verdicts) {
  log(`  ${ok === null ? '—' : ok ? '✅' : '✖'}  ${name}`)
}
if (results.toolChoice) {
  log(
    `\n② 细分: ${results.toolChoice.filter((c) => c.hit).length}/${results.toolChoice.length} 选对`
  )
}

fs.writeFileSync(
  path.join(APP_DIR, '.test', 'real-model-verdict.json'),
  JSON.stringify(results, null, 2),
  'utf8'
)
log('\n完整结果: .test/real-model-verdict.json')

// 分数低是正常结束；**批次没跑完**是失败，必须让调用方看得见
if (batchAborted) {
  log(`
✖ 评测没有跑完：${batchAborted}`)
  await page.screenshot({ path: path.join(SHOT, '20-real-model.png') })
  await app.close()
  process.exit(2)
}

await page.screenshot({ path: path.join(SHOT, '20-real-model.png') })
await app.close()
