/**
 * AI 游戏工作室题库：跑题、采集、汇总。
 *
 * ## 两种模式
 *
 * - `team`（默认）：`/team 一句话`，工作室模式，见 docs/AI游戏工作室设计-2026-09-25.md。
 * - `goal`：`/goal 一句话`，单个 Agent 加复核员，当对照组。
 *
 * ## 为什么题不由脚本发
 *
 * 要量的是**产品本身**：用户在盒子里打一句命令，看它能做到哪。
 * 调试端点 `/api/debug/agent` 没有这两种模式的循环，审批也是评测专用的
 * （本机磁盘一律拒绝）—— 而做游戏要写 C++、建工程，拿它跑测的就不是产品。
 * 所以题由人在盒子里发，脚本只管前后两头：开跑前建好记录，跑完从会话记录
 * 和引擎里把数采回来。
 *
 * ## 用法
 *
 *   node tests/manual/game-studio/bench.mjs list
 *   node tests/manual/game-studio/bench.mjs new <题目id> [--arm team|goal] [--model "模型名"]
 *   node tests/manual/game-studio/bench.mjs collect <运行目录> [--session <id>] [--sessions-dir <dir>] [--no-engine]
 *   node tests/manual/game-studio/bench.mjs report
 *
 * 引擎核验要求盒子以 `pnpm dev:ue-verify` 启动（开着本机调试 HTTP），
 * 且这次的工程编辑器开着。连不上就记「没验到」，不算通过。
 *
 * 产物在 `.test/game-studio/`（已被 .gitignore 忽略）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { defaultSessionsDir } from '../../../scripts/tool-usage-report.mjs'
import { CASES, findCase } from './cases.mjs'
import {
  firstUserText,
  judgeBlueprints,
  judgeCrashes,
  judgeNewProject,
  judgeSmoke,
  parseScoreBlock,
  readTranscript,
  renderAutoSection,
  renderScoreSheet,
  replaceAutoSection,
  summarize,
  transcriptMetrics
} from './score.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..', '..', '..')
const OUT_DIR = path.join(APP_DIR, '.test', 'game-studio')
const RUNS_DIR = path.join(OUT_DIR, 'runs')
const BASE = process.env.UNREAL_BOX_HTTP || 'http://127.0.0.1:8766'

/** 引擎核验用到的工具。名字写错不会报错、只会安静地「没验到」，所以 score.test.ts 对表 */
export const ENGINE_TOOLS = { compileAll: 'blueprint_compile_all', playtest: 'ue_playtest' }

/** 冒烟试玩跑多久。够进游戏、生成几波东西，又不至于每次采集都等很久 */
const SMOKE_SECONDS = 30

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-engine') out.noEngine = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

const stamp = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// ── list / new ──────────────────────────────────────────────────────────

function list() {
  for (const c of CASES) console.log(`${c.id.padEnd(20)} ${c.genre.padEnd(12)} ${c.prompt}`)
}

const ARMS = ['team', 'goal']

async function create(caseId, model, arm = 'team') {
  const caseDef = findCase(caseId)
  if (!caseDef) {
    console.error(`没有这道题：${caseId}。可选：${CASES.map((c) => c.id).join('、')}`)
    process.exit(1)
  }
  if (!ARMS.includes(arm)) {
    console.error(`--arm 只能是 ${ARMS.join(' / ')}`)
    process.exit(1)
  }
  const startedAt = Date.now()
  const runId = `${caseId}-${arm}-${stamp(startedAt)}`
  const dir = path.join(RUNS_DIR, runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'run.json'),
    JSON.stringify(
      { runId, caseId, arm, model: model ?? null, startedAt, sessionId: null },
      null,
      2
    )
  )
  await fs.writeFile(
    path.join(dir, 'score.md'),
    renderScoreSheet({ caseDef, runId, arm, model, startedAt })
  )

  console.log(`\n已建好记录：${path.relative(APP_DIR, dir)}\n`)
  console.log('开跑前确认：')
  console.log('  1. 关掉所有 UE 编辑器 —— 让它自己新建工程，别在你的工程里干')
  console.log('  2. 设置里选好这次要测的模型；审批模式按你打算给用户的默认来')
  console.log('  3. 在盒子里新开一个会话，原样粘贴下面这一行，之后不插话\n')
  console.log(`    /${arm} ${caseDef.prompt}\n`)
  console.log(
    `跑完之后：node tests/manual/game-studio/bench.mjs collect ${path.relative(APP_DIR, dir)}`
  )
}

// ── collect ─────────────────────────────────────────────────────────────

/**
 * 找这次跑的那条会话：开跑之后创建的、第一句真人消息里带着题面的。
 * 找到不止一条就不猜 —— 让人用 --session 指定。
 */
async function findSession(sessionsDir, run, prompt) {
  const names = (await fs.readdir(sessionsDir)).filter((n) => n.endsWith('.jsonl'))
  const hits = []
  for (const name of names) {
    const file = path.join(sessionsDir, name)
    const stat = await fs.stat(file)
    if (stat.mtimeMs < run.startedAt) continue
    const { header, messages } = readTranscript(await fs.readFile(file, 'utf8'))
    if (!header || header.createdAt < run.startedAt - 60_000) continue
    if (firstUserText(messages).includes(prompt)) hits.push(header.sessionId)
  }
  return hits
}

/** 走调试端点调一个工具。拿不到就是 null，由判定函数记成「没验到」 */
async function callTool(name, args, projectPath) {
  try {
    const res = await fetch(`${BASE}/api/debug/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, args, ...(projectPath ? { projectPath } : {}) }),
      signal: AbortSignal.timeout(10 * 60_000)
    })
    const body = await res.json()
    if (!body?.success) {
      console.log(`  ${name} 没成：${String(body?.error ?? res.status).slice(0, 200)}`)
      return null
    }
    const content = body.data?.content ?? []
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { json, images: content.filter((c) => c.type === 'image') }
  } catch (error) {
    console.log(`  ${name} 调不通：${error.message}`)
    return null
  }
}

async function uprojectBirth(projectPath) {
  try {
    const entries = await fs.readdir(projectPath)
    const uproject = entries.find((n) => n.endsWith('.uproject'))
    if (!uproject) return NaN
    const stat = await fs.stat(path.join(projectPath, uproject))
    return stat.birthtimeMs || stat.ctimeMs
  } catch {
    return NaN
  }
}

async function crashesSince(projectPath, since) {
  const dir = path.join(projectPath, 'Saved', 'Crashes')
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if ((await fs.stat(path.join(dir, e.name))).mtimeMs >= since) n++
    }
    return n
  } catch (error) {
    // 从没崩过的工程没有这个目录 —— 那就是 0 次，不是「没验到」
    return error.code === 'ENOENT' ? 0 : NaN
  }
}

async function collect(runDirArg, opts) {
  const dir = path.resolve(APP_DIR, runDirArg)
  const run = await readJson(path.join(dir, 'run.json'))
  if (!run) {
    console.error(`${runDirArg} 下没有 run.json，是 bench.mjs new 建的目录吗？`)
    process.exit(1)
  }
  const caseDef = findCase(run.caseId)
  const sessionsDir = opts['sessions-dir'] ?? defaultSessionsDir()

  let sessionId = opts.session ?? run.sessionId
  if (!sessionId) {
    const hits = await findSession(sessionsDir, run, caseDef.prompt)
    if (hits.length !== 1) {
      console.error(
        hits.length
          ? `找到 ${hits.length} 条可能的会话（${hits.join('、')}），用 --session 指定`
          : `在 ${sessionsDir} 里没找到开跑后发过这道题的会话，用 --session 指定`
      )
      process.exit(1)
    }
    sessionId = hits[0]
  }
  run.sessionId = sessionId
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(run, null, 2))

  const transcript = await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), 'utf8')
  const metrics = transcriptMetrics(transcript)
  const execution = await readJson(path.join(sessionsDir, `${sessionId}.execution.json`))
  const project = execution?.project ?? metrics.project
  const goal = execution?.goal ?? null
  console.log(`会话 ${sessionId}：${metrics.minutes} 分钟，${metrics.toolCalls} 次工具调用`)

  const checks = []
  const images = []
  if (project?.projectPath) {
    checks.push({
      label: '新建的工程',
      ...judgeNewProject(await uprojectBirth(project.projectPath), run.startedAt)
    })
    checks.push({
      label: '崩溃',
      ...judgeCrashes(await crashesSince(project.projectPath, run.startedAt))
    })
  } else {
    checks.push({ label: '新建的工程', ok: null, note: '会话没记下工程，没验到' })
  }

  if (opts.noEngine) {
    console.log('跳过引擎核验（--no-engine）')
  } else {
    console.log('引擎核验：全量编译蓝图…')
    const bp = await callTool(
      ENGINE_TOOLS.compileAll,
      { scope: 'all', limit: 2000 },
      project?.projectPath
    )
    checks.push({ label: '蓝图全部编译通过', ...judgeBlueprints(bp?.json) })

    console.log(`引擎核验：冒烟试玩 ${SMOKE_SECONDS} 秒…`)
    const smoke = await callTool(
      ENGINE_TOOLS.playtest,
      { duration_seconds: SMOKE_SECONDS, frames: 9, screenshot: false },
      project?.projectPath
    )
    checks.push({ label: `冒烟试玩 ${SMOKE_SECONDS} 秒无运行时错误`, ...judgeSmoke(smoke?.json) })
    for (const [i, img] of (smoke?.images ?? []).entries()) {
      const ext = String(img.mimeType ?? 'image/png').split('/')[1] || 'png'
      const name = `smoke-${i + 1}.${ext}`
      await fs.writeFile(path.join(dir, name), Buffer.from(img.data, 'base64'))
      images.push(name)
    }
  }

  const auto = { collectedAt: Date.now(), metrics, goal, project, checks, images }
  await fs.writeFile(path.join(dir, 'auto.json'), JSON.stringify(auto, null, 2))
  const sheet = path.join(dir, 'score.md')
  await fs.writeFile(
    sheet,
    replaceAutoSection(await fs.readFile(sheet, 'utf8'), renderAutoSection(auto))
  )

  for (const c of checks)
    console.log(`  ${c.ok === true ? '✅' : c.ok === false ? '❌' : '—'} ${c.label}：${c.note}`)
  console.log(`\n写进了 ${path.relative(APP_DIR, sheet)}。接下来亲自玩一遍，填人工评分。`)
}

// ── report ──────────────────────────────────────────────────────────────

async function report() {
  let names = []
  try {
    names = await fs.readdir(RUNS_DIR)
  } catch {
    console.log('还没有任何运行记录。先 bench.mjs new <题目id>')
    return
  }
  const runs = []
  for (const name of names.sort()) {
    const dir = path.join(RUNS_DIR, name)
    const run = await readJson(path.join(dir, 'run.json'))
    if (!run) continue
    let sheet = ''
    try {
      sheet = await fs.readFile(path.join(dir, 'score.md'), 'utf8')
    } catch {
      /* 没有评分表就按全空算 */
    }
    runs.push({
      runId: run.runId,
      caseId: run.caseId,
      arm: run.arm,
      model: run.model,
      auto: await readJson(path.join(dir, 'auto.json')),
      score: parseScoreBlock(sheet)
    })
  }
  const text = summarize(runs)
  await fs.writeFile(path.join(OUT_DIR, 'report.md'), `# P0 基线汇总\n\n${text}\n`)
  console.log(text)
  console.log(`\n（同时写进了 ${path.relative(APP_DIR, path.join(OUT_DIR, 'report.md'))}）`)
}

// ── 入口 ────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  const [command, target] = args._
  if (command === 'list') list()
  else if (command === 'new' && target) await create(target, args.model, args.arm)
  else if (command === 'collect' && target) await collect(target, args)
  else if (command === 'report') await report()
  else {
    console.log(
      '用法：bench.mjs list | new <题目id> [--arm team|goal] [--model 名] | collect <运行目录> [--session id] [--no-engine] | report'
    )
    process.exit(command ? 1 : 0)
  }
}
