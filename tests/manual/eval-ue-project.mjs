/**
 * 一次性 UE 测试工程的真机验收 —— 两件事，缺一不可。
 *
 *   ① **确认引擎连着的确实是那个一次性副本**，不是用户的真实工程。
 *      脚手架的写操作用例跑在真工程上，误判一次就可能毁掉不在版本控制里的工作。
 *   ② **确认下一条写操作是从相同起点开始的。**
 *      靠"我刚跑过 --restore"这种记忆不算数 —— 中间可能开过编辑器、
 *      上一条用例写过资产。这里拿**内容指纹**说话。
 *
 * 判定逻辑在 `eval-project.mjs`，那边有单测；这个文件只负责接真机。
 *
 * ## 用法（编辑器手动开关）
 *
 *   set SKILL_EVAL_UE_TEMPLATE=<仓库>\.test\eval-ue-template
 *   set SKILL_EVAL_UE_PROJECT=<仓库>\.test\eval-ue-run
 *
 *   1. 关掉 UE 编辑器
 *      node tests/manual/eval-ue-project.mjs restore
 *   2. 用 UE 5.5 打开副本里的 .uproject，等插件连上盒子
 *      node tests/manual/eval-ue-project.mjs check      ← 验收 ①②
 *   3. 想验"写完之后起点被破坏、重建后又回到起点"：
 *      node tests/manual/eval-ue-project.mjs write      ← 跑一次真写操作
 *      node tests/manual/eval-ue-project.mjs check      ← 应当报「起点已偏离」
 *      关编辑器 → restore → 开编辑器 → check            ← 应当回到「起点一致」
 *
 * 盒子要开着且 HTTP 调试口打开（`pnpm dev:ue-verify`）。
 * `write` 会真的在副本里建资产，产生 API 费用。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { EVAL_COPY_MARKER, fingerprintOf, planRestore, sameProject } from './eval-project.mjs'

const BASE = process.env.UNREAL_BOX_HTTP || 'http://127.0.0.1:8766'
const TEMPLATE = process.env.SKILL_EVAL_UE_TEMPLATE || ''
const PROJECT = process.env.SKILL_EVAL_UE_PROJECT || ''
/**
 * 「写操作的起点」指纹。放在副本外面 —— 存在副本里会把自己也算进指纹。
 *
 * **为什么起点不能按模板算**：真机上跑出来的 —— `restore` 之后的目录和模板逐字节
 * 相同，但**编辑器一打开就会写 `Config/DefaultEngine.ini`、`DefaultInput.ini`**。
 * 拿模板层的指纹去要求「起点一致」，第一次开编辑器就必然不一致，这条判据就废了。
 * 所以起点记的是**编辑器打开、还没跑任何写操作时**的状态。
 *
 * 而「重建之后还能回到同一个起点」是可证的：走两遍
 * restore → 开编辑器 → 记起点，两次的指纹应当相同（已在真机上验过）。
 */
const START_BASELINE = `${PROJECT}.start-baseline.txt`
/** 上一轮的起点。留着才比得出「重建之后是不是同一个起点」—— 删掉就没得比了 */
const PREV_START_BASELINE = `${PROJECT}.prev-start-baseline.txt`

const log = (...a) => console.log(...a)
const die = (msg, code = 1) => {
  log(`✖ ${msg}`)
  process.exit(code)
}

const pathOpts = {
  resolve: (p) => path.resolve(p),
  dirname: (p) => path.dirname(p),
  isWindows: process.platform === 'win32'
}

/** 走确定性的工具调用问引擎，不经过模型 —— 模型可能不调、可能调错 */
async function runTool(name, args = {}, connectionId) {
  const res = await fetch(`${BASE}/api/debug/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // connectionId 走请求体而不是 args：UE 工具的目标连接来自会话作用域，
    // 不是工具入参 —— 塞进 args 会被 schema 直接判非法
    body: JSON.stringify({ name, args, ...(connectionId ? { connectionId } : {}) })
  }).catch((e) => ({ ok: false, error: String(e) }))
  if (!res.ok && !res.json) return { success: false, error: res.error ?? 'fetch 失败' }
  return await res.json()
}

/** 遍历工程目录算指纹。忽略清单在 eval-project.mjs 里 */
function fingerprintProject(root) {
  const entries = []
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = fs.lstatSync(full)
      if (st.isDirectory()) {
        walk(full, relPath)
      } else if (st.isFile()) {
        entries.push({
          relPath,
          sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        })
      }
    }
  }
  walk(root, '')
  return fingerprintOf(entries)
}

/**
 * 在**所有连着的引擎**里挑出那个一次性副本，返回它的 connection_id。
 *
 * 为什么必须逐个核对而不是 `ue_get_project_info` 了事：真机上同时连着三个工程
 * （两个是别人的真实工程），`callRequest` 不指定 clientId 时会**拒绝猜测**
 * （websocket/server.ts 的 `pickDefaultConnectionId`：多于一个就报「没有可用的
 * 客户端连接」）。而更糟的情况是只连着一个、但那一个不是副本 —— 那时它会
 * 顺理成章地把写操作发到用户的真实工程上。
 *
 * 三种结果都要分开报：没有匹配、匹配到多个、正好一个。
 */
async function findDisposableConnection() {
  const health = await runTool('ue_session_health')
  const conns = health?.data?.details?.connections ?? health?.details?.connections ?? []
  if (conns.length === 0) return { ok: false, reason: '一个引擎都没连上', conns }

  const matched = conns.filter((c) => sameProject(c.project_path, PROJECT, pathOpts))
  if (matched.length === 0) {
    return { ok: false, reason: '连着的引擎里没有那个一次性副本', conns }
  }
  if (matched.length > 1) {
    return { ok: false, reason: `有 ${matched.length} 个连接都指向副本，无法确定目标`, conns }
  }
  return { ok: true, conn: matched[0], conns }
}

// ── restore：丢弃副本、从模板重建、记下基线指纹 ───────────────────────────

async function cmdRestore() {
  const plan = planRestore({
    template: TEMPLATE,
    project: PROJECT,
    resolve: (p) => path.resolve(p),
    exists: (p) => fs.existsSync(p),
    hasMarker: (p) => fs.existsSync(path.join(p, EVAL_COPY_MARKER))
  })
  if (!plan.ok) die(plan.error)

  // 编辑器还开着就重建，文件被占用不说，重建完它内存里也还是旧的。
  //
  // **先确认盒子连得上**：`runTool` 在盒子没起时同样返回 success:false，
  // 直接拿它当「引擎没连」用的话，这道守卫在盒子没起的时候就是空的 ——
  // 而那正是最容易发生的情况（先跑脚本、后起盒子）。
  const health = await fetch(`${BASE}/api/health`).catch(() => null)
  if (!health?.ok) {
    die(`连不上盒子（${BASE}）—— 先 pnpm dev:ue-verify。没有它就分不清「引擎没连」和「盒子没起」。`)
  }
  const info = await runTool('ue_get_project_info')
  if (info?.success) {
    die('引擎还连着 —— 先关掉 UE 编辑器再 restore。')
  }

  log(`${plan.willDelete ? '丢弃并重建' : '首次创建'}：${plan.project}`)
  fs.rmSync(plan.project, { recursive: true, force: true })
  fs.cpSync(plan.template, plan.project, { recursive: true })
  fs.writeFileSync(
    path.join(plan.project, EVAL_COPY_MARKER),
    `created-by tests/manual/eval-ue-project.mjs restore\n${new Date().toISOString()}\n`,
    'utf8'
  )

  // 上一轮的起点**留档**再作废：整个验收要证明的就是「重建之后回到同一个起点」，
  // 直接删掉就没有比较对象了。下一次 baseline 会拿它做对照。
  if (fs.existsSync(START_BASELINE)) {
    fs.copyFileSync(START_BASELINE, PREV_START_BASELINE)
    fs.rmSync(START_BASELINE, { force: true })
  }
  log('\n现在用 UE 5.5 打开副本里的 .uproject，等插件连上，然后：')
  log('  node tests/manual/eval-ue-project.mjs baseline   ← 记下「写操作的起点」')
}

// ── baseline：编辑器已打开、还没写任何东西时，记下真正的起点 ─────────────

async function cmdBaseline() {
  const found = await findDisposableConnection()
  if (!found.ok) {
    die(`${found.reason} —— 起点基线必须在「编辑器已打开且连的是副本」时记，否则记的不是起点。`)
  }
  const fp = fingerprintProject(PROJECT)
  const prev = fs.existsSync(PREV_START_BASELINE)
    ? fs.readFileSync(PREV_START_BASELINE, 'utf8')
    : fs.existsSync(START_BASELINE)
      ? fs.readFileSync(START_BASELINE, 'utf8')
      : null
  fs.writeFileSync(START_BASELINE, fp, 'utf8')
  log(`起点基线已记录：${START_BASELINE}（${fp.split('\n').length} 个文件）`)
  if (prev !== null) {
    log(
      prev === fp
        ? '  ✅ 和上一轮的起点**完全一致** —— 重建循环确实回到了同一个起点'
        : '  ⚠️ 和上一轮的起点不同：重建之后的起点不可复现，② 这条判据要重新设计'
    )
  }
}

// ── check：验收 ①② ───────────────────────────────────────────────────────

async function cmdCheck() {
  if (!PROJECT) die('需要设置 SKILL_EVAL_UE_PROJECT')
  let failed = false

  // ① 引擎连着的是不是那个一次性副本
  log('── ① 引擎连着的是不是那个一次性副本 ──')
  const found = await findDisposableConnection()
  log(`  当前连着 ${found.conns.length} 个工程：`)
  for (const c of found.conns) {
    const hit = sameProject(c.project_path, PROJECT, pathOpts)
    log(`    ${hit ? '→' : ' '} ${c.project_name}  ${c.project_path}  ${hit ? '← 副本' : ''}`)
  }
  log(`  声明的一次性副本：${PROJECT}`)
  if (!found.ok) {
    log(`  ✖ ${found.reason} —— 拒绝在这种状态下跑任何写操作用例。`)
    failed = true
  } else {
    log(`  ✅ 是那个副本（connection_id ${found.conn.connection_id}）`)
  }

  // ② 起点是不是和 restore 之后一致
  log('\n── ② 下一条写操作是不是从相同起点开始 ──')
  if (!fs.existsSync(START_BASELINE)) {
    log(`  ✖ 没有起点基线（${START_BASELINE}）—— 编辑器打开后先跑一次 \`baseline\``)
    failed = true
  } else {
    const baseline = fs.readFileSync(START_BASELINE, 'utf8')
    const now = fingerprintProject(PROJECT)
    if (now === baseline) {
      log(`  ✅ 起点一致（${baseline.split('\n').length} 个文件，指纹相同）`)
    } else {
      const b = new Set(baseline.split('\n'))
      const n = new Set(now.split('\n'))
      const added = [...n].filter((x) => !b.has(x))
      const removed = [...b].filter((x) => !n.has(x))
      log(`  ✖ 起点已偏离：新增/改动 ${added.length} 项，缺失 ${removed.length} 项`)
      for (const x of added.slice(0, 5)) log(`     + ${x.split(':')[0]}`)
      for (const x of removed.slice(0, 5)) log(`     - ${x.split(':')[0]}`)
      log('     关掉编辑器、跑一次 restore、重开，才能让下一条写操作从相同起点开始。')
      failed = true
    }
  }

  process.exit(failed ? 1 : 0)
}

// ── write：真的写一次，用来验证 ② 认得出偏离 ──────────────────────────────

async function cmdWrite() {
  // 写之前先过 ① —— 这正是这道守卫存在的意义。真机上同时连着三个工程，
  // 其中两个是别人的真实工程；不核对就可能把资产建到它们里面去
  const found = await findDisposableConnection()
  if (!found.ok) {
    die(`${found.reason}；连着的是：${found.conns.map((c) => c.project_path).join(', ')}`)
  }
  log(`通过副本核对（${found.conn.project_name} / ${found.conn.connection_id}），开始写…`)
  const r = await runTool(
    'material_create',
    { material_name: 'M_EvalProbe', save_path: '/Game/EvalWrite' },
    found.conn.connection_id
  )
  log(`material_create → success=${r?.success ?? r?.data?.details?.success} ${r?.error ?? ''}`)

  // 不 save 就只改了内存，磁盘上什么都没有 —— 指纹是看磁盘的，那样这一步等于没写。
  // 系统提示词里那条「引擎里改的东西不保存就只在内存里」在这儿同样成立。
  const s = await runTool('ue_save', {}, found.conn.connection_id)
  log(`ue_save → success=${s?.success ?? s?.data?.details?.success} ${s?.error ?? ''}`)
  log('写完了。现在跑 `check`，② 应当报「起点已偏离」。')
}

const cmd = process.argv[2]
if (cmd === 'restore') await cmdRestore()
else if (cmd === 'baseline') await cmdBaseline()
else if (cmd === 'check') await cmdCheck()
else if (cmd === 'write') await cmdWrite()
else {
  log('用法: node tests/manual/eval-ue-project.mjs <restore|baseline|check|write>')
  log('  restore  关掉编辑器后跑：丢弃副本、从模板重建、记下模板层基线')
  log('  baseline 编辑器打开后跑：记下「写操作的起点」，并和上一轮的起点比对')
  log('  check    开着编辑器跑：验收 ① 连的是副本 ② 起点一致')
  log('  write    真写一次，用来验证 ② 认得出偏离')
  process.exit(2)
}
