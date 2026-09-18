/*
 * 这个文件必须是 CommonJS：它要被 vitest 当作 `better-sqlite3` 的替身解析，
 * 而 better-sqlite3 本身是 CJS，垫片得能原样 require 它的内部模块。
 * .cjs 里写不了 TS 的返回类型标注，所以这两条规则在本文件关掉 ——
 * 这是文件格式的限制，不是图省事。
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
/**
 * 测试专用的 better-sqlite3 入口。
 *
 * vitest 把 `better-sqlite3` 别名到这里（见 vitest.config.ts）。它做的事只有一件：
 * **不加载 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`**，
 * 改用缓存里那份按 Node ABI 编好的副本。
 *
 * 为什么要绕开：那个文件同时被跑着的 Electron 应用加载着。原先的做法是每次跑测试
 * 前把它重编成 Node ABI、跑应用前再编回 Electron ABI —— 于是「应用开着就跑不了
 * 测试」（Windows 上被占用的 .node 连删都删不掉，报 EPERM）。
 *
 * 绕开之后两边各用各的：`node_modules` 里那份永远保持 Electron ABI 供 `pnpm dev`
 * 使用，测试只读缓存里的 Node ABI 副本。互不写入，也就不存在抢文件。
 *
 * 产物由 `scripts/better-sqlite3-abi.mjs` 维护，缓存键带 ABI 号与依赖版本，
 * 升级 better-sqlite3 或 Electron 后会自然失效重建。
 */
const path = require('node:path')
const fs = require('node:fs')

const Database = require('better-sqlite3/lib/database.js')
const SqliteError = require('better-sqlite3/lib/sqlite-error.js')

const CACHE_ROOT = path.join(__dirname, '..', '..', 'node_modules', '.cache', 'better-sqlite3-abi')

/**
 * 找出缓存里属于当前 Node ABI 的那份产物。
 *
 * 按前缀找而不是拼出完整目录名：完整名字里还有 better-sqlite3 的版本号，
 * 在这里再拼一次就等于把同一份规则写两遍，升级依赖时必然漏掉一处。
 */
function resolveNativeBinding() {
  const prefix = `node-abi${process.versions.modules}-${process.platform}-${process.arch}-`

  let entries = []
  try {
    entries = fs.readdirSync(CACHE_ROOT)
  } catch {
    entries = []
  }

  const matched = entries.find((name) => name.startsWith(prefix))
  if (matched) {
    const file = path.join(CACHE_ROOT, matched, 'better_sqlite3.node')
    if (fs.existsSync(file)) return file
  }

  throw new Error(
    '测试用的 better-sqlite3 原生产物还没准备好。\n' +
      '关掉虚幻盒子与 pnpm dev，然后跑一次：\n' +
      '  node scripts/better-sqlite3-abi.mjs ensure node\n' +
      '这一步只需要做一次，之后应用开着也能跑测试。'
  )
}

let cachedBinding = null

/**
 * 包一层，把 nativeBinding 预置进去。
 *
 * 用 Reflect.construct 而不是 `new Database(...)`：调用方可能写
 * `new Database(...)`，也可能直接 `Database(...)`（better-sqlite3 两种都支持），
 * 而且 `instanceof` 要照常成立 —— 有测试在断言这个。
 */
function TestDatabase(filename, options) {
  if (cachedBinding === null) cachedBinding = resolveNativeBinding()
  const merged = { nativeBinding: cachedBinding, ...(options || {}) }
  return Reflect.construct(Database, [filename, merged], new.target || TestDatabase)
}

TestDatabase.prototype = Database.prototype
TestDatabase.SqliteError = SqliteError

module.exports = TestDatabase
module.exports.SqliteError = SqliteError
module.exports.default = TestDatabase
