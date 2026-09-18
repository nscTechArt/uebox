#!/usr/bin/env node
/**
 * localStorage 用途门禁 / localStorage usage gate.
 *
 * ## 这道门禁守的是什么
 *
 * 社区版承诺「完全离线、数据在用户自己手里」。这个承诺能不能兑现，取决于一条规矩：
 *
 *   **用户自己创作的东西，唯一真相源必须是磁盘上的文件**，
 *   数据库只是可以删掉重建的索引，localStorage 只配存界面偏好。
 *
 * 违反它的代价不是抽象的：蓝图库和材质库曾经把**整个库**序列化进 localStorage，
 * 而 localStorage 只有几 MB —— 写满之后 `QuotaExceededError` 从存盘那一步窜回调用处，
 * 用户的新建/改名/导入崩在半路（见 store/modules/materialLibraryStore.ts 的注释）。
 * 更要命的是：localStorage 在用户视角里根本不存在。它不在保管库目录里，
 * 拷不走、备份不到、换台机器就没了，出问题连个能打开看看的文件都没有。
 *
 * ## 三个类别
 *
 *   ui       可丢弃的状态：界面偏好、一次性标记、能重新算出来的缓存
 *            （面板宽度、折叠状态、排序方式、「别再提醒我」、摘要缓存）。
 *            丢了不心疼，重来一遍就有 —— localStorage 正是为这个而生的。
 *   content  用户创作的内容（蓝图、材质、对话、笔记、生成产物）。**必须落到文件**。
 *   secret   凭据（API Key、访问令牌、网盘账号）。localStorage 是明文的，
 *            任何能跑 JS 的东西都读得到，必须走主进程的安全存储。
 *
 * ## 规则
 *
 *   1. 代码里出现的每一个 localStorage key 都必须在基线里登记，并写明类别和理由。
 *      没登记 = 失败。这一条逼着写代码的人先想清楚「我存的到底是什么」。
 *   2. `content` 与 `secret` 是**棘轮**：只准变少，不准新增。
 *   3. 基线里有、代码里没了 —— 说明迁走了一批，跑 --update 收紧。
 *
 * ## --update 为什么不自动登记新 key
 *
 * 因为它一自动，这道门禁就等于不存在：任何人（尤其是 AI Agent）卡在红灯上时，
 * 最省事的做法就是跑一下 --update。所以 --update **只做删除，不做新增** ——
 * 新 key 必须由人手写进基线，顺手写下它是什么、为什么放这儿。
 *
 * 用法：
 *   node scripts/check-local-storage.mjs           校验
 *   node scripts/check-local-storage.mjs --update  收紧基线（只删不增）
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const RENDERER = join(ROOT, 'src', 'renderer')
const BASELINE = join(ROOT, 'scripts', 'local-storage.baseline.json')

const SCANNED_EXTENSIONS = ['.ts', '.vue']
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|mjs)$/

/**
 * 通用存储适配器，本身不决定存什么 —— key 是调用方传进来的，
 * 调用方那边已经被扫到了。整文件排除，比在这儿硬编一个动态 key 白名单干净。
 */
const EXCLUDED_FILES = new Set(['src/renderer/src/utils/chatHistoryStorage.ts'])

/** 必须落文件的类别；这两类是棘轮，只准变少 */
const RATCHETED = new Set(['content', 'secret'])
const CATEGORIES = new Set(['ui', 'content', 'secret'])

/**
 * 两种写入 localStorage 的姿势，都要扫。
 *
 * 只扫 `localStorage.setItem` 会漏掉一大半 —— 仓库里更常见的其实是 pinia 的
 * `persist:` 选项，它把整个 store 落进 localStorage，一个字都不用自己写。
 * `chat-messages`（全部 AI 对话）、`ai-config-store`（模型 API Key）都是这么进去的。
 */
const SETITEM_PATTERN = /(?:window\.)?localStorage\.setItem\(\s*([^,]+?)\s*,/g
const PERSIST_PATTERN = /persist:/g
const PERSIST_KEY_WINDOW = 600

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (TEST_FILE_PATTERN.test(name)) continue
    if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full)
  }
  return out
}

function toRepoPath(file) {
  // 统一成正斜杠，免得基线在 Windows 与 CI 之间来回变动
  return relative(ROOT, file).split(sep).join('/')
}

/**
 * 注释里也会出现 `localStorage.setItem(...)` —— 讲的正是这道门禁要管的事
 * （throttledStorage.ts 的开头就有一句）。不抹掉的话，写一段解释为什么不要用它的注释，
 * 反而会把门禁顶红。字符串里的 `//` 会被误伤，但 key 是字面量，误伤不到。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const asLiteral = (expr) => {
  const m = /^['"](.+)['"]$/.exec(expr.trim())
  return m ? m[1] : null
}

/**
 * key 写成常量名的很多（`PERSIST_KEY`、`SIDEBAR_COLLAPSED_KEY`）。
 * 先在本文件里找它的字面量定义，找不到再去全仓找 `export const`。
 * 还找不到就当动态 key —— 动态 key 一样要登记，只是登记的是表达式。
 */
function resolveKey(expr, fileText, globalConsts) {
  const direct = asLiteral(expr)
  if (direct !== null) return direct

  const ident = expr.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return `dynamic:${ident.replace(/\s+/g, ' ')}`

  const local = new RegExp(`\\b${ident}\\s*=\\s*(['"][^'"]+['"])`).exec(fileText)
  if (local) return asLiteral(local[1])

  return globalConsts.get(ident) ?? `dynamic:${ident}`
}

/** 全仓的 `export const X = '...'`，给跨文件引用的 key 常量兜底 */
function collectGlobalConsts(files) {
  const map = new Map()
  const pattern = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"][^'"]+['"])/g
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    for (const m of text.matchAll(pattern)) map.set(m[1], asLiteral(m[2]))
  }
  return map
}

function collect() {
  const files = walk(RENDERER)
  const globalConsts = collectGlobalConsts(files)
  /** key -> Set<文件> */
  const found = new Map()

  const record = (key, repoPath) => {
    if (!found.has(key)) found.set(key, new Set())
    found.get(key).add(repoPath)
  }

  for (const file of files) {
    const repoPath = toRepoPath(file)
    if (EXCLUDED_FILES.has(repoPath)) continue
    const text = stripComments(readFileSync(file, 'utf-8'))

    for (const m of text.matchAll(SETITEM_PATTERN)) {
      record(resolveKey(m[1], text, globalConsts), repoPath)
    }

    for (const m of text.matchAll(PERSIST_PATTERN)) {
      const window = text.slice(m.index, m.index + PERSIST_KEY_WINDOW)
      // storage 没写就是 localStorage（pinia-plugin-persistedstate 的默认值）
      if (/storage:\s*['"]?sessionStorage/.test(window)) continue
      // 对话历史已经落磁盘文件了（utils/chatHistoryStorage.ts），不占 localStorage
      if (/storage:\s*chatHistoryStorage/.test(window)) continue
      const keyMatch = /\bkey:\s*([^,\n}]+)/.exec(window)
      if (keyMatch) record(resolveKey(keyMatch[1], text, globalConsts), repoPath)
    }
  }

  return found
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 上一次提交里的基线，用来做棘轮比对。
 *
 * 棘轮不能只靠「基线是手写的」这条社会规范 —— 手写一样能写成 content。
 * 所以拿 HEAD 里的那份比：**新增的 key 不许是 content / secret**，
 * 已有 key 也不许从 ui 改判成 content / secret。真要新增，得维护者手动改基线并说明理由。
 *
 * 拿不到（首次引入这个文件、浅克隆、不在 git 里）就跳过棘轮，只做「必须登记」那一关。
 */
function readCommittedBaseline() {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:scripts/local-storage.baseline.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeBaseline(entries) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8')
}

const found = collect()
const baseline = readBaseline()

if (baseline === null) {
  console.error(
    `读不到基线文件 ${relative(ROOT, BASELINE)}。\n` +
      '这份基线要手写 —— 每个 key 标上 category（ui / content / secret）和 why。'
  )
  process.exit(1)
}

const gone = Object.keys(baseline).filter((key) => !found.has(key))

if (process.argv.includes('--update')) {
  const unregistered = [...found.keys()].filter((key) => !(key in baseline))
  if (unregistered.length > 0) {
    console.error('✖ 拒绝写入基线：--update 只删不增。\n')
    for (const key of unregistered) console.error(`  · ${key}`)
    console.error(
      '\n新的 localStorage key 必须由人手写进基线，并说明它是什么。' +
        '\n自动登记等于这道门禁不存在 —— 卡红灯的人跑一下 --update 就绿了。'
    )
    process.exit(1)
  }

  if (gone.length === 0) {
    console.log('基线已是最新，无需收紧。')
    process.exit(0)
  }

  const next = { ...baseline }
  for (const key of gone) delete next[key]
  writeBaseline(next)
  console.log(`基线已收紧：移除 ${gone.length} 个不再使用的 key。`)
  for (const key of gone) console.log(`  · ${key}（原 ${baseline[key].category}）`)
  process.exit(0)
}

const problems = []

for (const [key, files] of found) {
  const entry = baseline[key]
  if (!entry) {
    problems.push(`未登记的 key：${key}\n      出现于 ${[...files].join(', ')}`)
    continue
  }
  if (!CATEGORIES.has(entry.category)) {
    problems.push(`${key} 的 category 非法：${entry.category}`)
  }
}

const committed = readCommittedBaseline()
if (committed !== null) {
  for (const [key, entry] of Object.entries(baseline)) {
    if (!RATCHETED.has(entry.category)) continue
    const before = committed[key]
    if (!before) {
      problems.push(
        `棘轮：新增了 category 为 ${entry.category} 的 key「${key}」——` +
          `\n      用户内容要落成保管库里的文件，凭据要走主进程安全存储，都不该进 localStorage。`
      )
    } else if (!RATCHETED.has(before.category)) {
      problems.push(`棘轮：${key} 的 category 从 ${before.category} 改成了 ${entry.category}`)
    }
  }
}

if (problems.length > 0) {
  console.error('✖ localStorage 门禁未通过：\n')
  for (const line of problems) console.error(`  · ${line}`)
  console.error(
    '\n每个 localStorage key 都要在 scripts/local-storage.baseline.json 里登记，' +
      '\n写明 category 和 why。先想清楚你存的是什么：' +
      '\n  · 界面偏好 / 一次性标记 → category: "ui"，登记即可；' +
      '\n  · 用户创作的内容（蓝图、材质、对话、笔记、生成产物）→ 不许放 localStorage。' +
      '\n    它必须落到保管库里的文件，数据库只做索引。' +
      '\n  · 凭据（API Key、令牌、网盘账号）→ 不许放 localStorage，那是明文的。' +
      '\n    走主进程的安全存储。' +
      '\n\ncontent / secret 两类是棘轮，只准变少 —— 基线里现有的是待迁移的历史欠账，' +
      '\n不是可以照抄的先例。'
  )
  process.exit(1)
}

if (gone.length > 0) {
  console.error(`✖ 有 ${gone.length} 个 key 已不再使用，请跑 --update 收紧基线：\n`)
  for (const key of gone) console.error(`  · ${key}`)
  process.exit(1)
}

const tally = { ui: 0, content: 0, secret: 0 }
for (const key of found.keys()) tally[baseline[key].category] += 1

console.log(
  `localStorage 门禁通过（${found.size} 个 key：${tally.ui} 个界面偏好，` +
    `${tally.content} 个待迁移内容，${tally.secret} 个待迁移凭据）。`
)
