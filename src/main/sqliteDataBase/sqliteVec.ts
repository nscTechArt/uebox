import type Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

const loadedDbs = new WeakSet<Database.Database>()

/** 加载失败过的连接。记着是为了不在每次状态轮询时重试一遍并刷一屏错误日志 */
const failedDbs = new WeakSet<Database.Database>()

/**
 * 获取 sqlite-vec 原生模块的正确路径
 * 打包后需要从 app.asar.unpacked 目录加载
 */
function getSqliteVecPath(): string | null {
  const platform = process.platform
  const arch = process.arch

  // 平台特定的包名和扩展名
  // 注意：process.platform 返回 'win32'，但 npm 包名使用 'windows'
  const platformName = platform === 'win32' ? 'windows' : platform
  const platformPkg = `sqlite-vec-${platformName}-${arch}`
  const extName =
    platform === 'win32' ? 'vec0.dll' : platform === 'darwin' ? 'vec0.dylib' : 'vec0.so'

  // 尝试多个可能的路径
  const possiblePaths: string[] = []

  if (app.isPackaged) {
    // 打包后 - 使用 process.resourcesPath 指向 resources 目录
    // 优先尝试顶层 node_modules 中的平台特定包（pnpm 常见结构）
    const unpackedBase = join(process.resourcesPath, 'app.asar.unpacked')
    possiblePaths.push(
      // 顶层 node_modules 中的平台特定包（优先尝试）
      join(unpackedBase, 'node_modules', platformPkg, extName),
      // sqlite-vec 嵌套的 node_modules 中的平台特定包
      join(unpackedBase, 'node_modules', 'sqlite-vec', 'node_modules', platformPkg, extName),
      // 直接在 sqlite-vec 包内
      join(unpackedBase, 'node_modules', 'sqlite-vec', extName)
    )
  } else {
    // 开发环境
    possiblePaths.push(
      join(process.cwd(), 'node_modules', platformPkg, extName),
      join(process.cwd(), 'node_modules', 'sqlite-vec', 'node_modules', platformPkg, extName),
      join(__dirname, '..', '..', '..', 'node_modules', platformPkg, extName)
    )
  }

  console.log(`[sqlite-vec] Platform: ${platform}, Arch: ${arch}, isPackaged: ${app.isPackaged}`)
  console.log(`[sqlite-vec] App path: ${app.getAppPath()}`)

  for (const p of possiblePaths) {
    console.log(`[sqlite-vec] Checking path: ${p}`)
    if (existsSync(p)) {
      console.log(`[sqlite-vec] Found at: ${p}`)
      return p
    }
  }

  console.warn('[sqlite-vec] Native module not found in any known path')
  return null
}

/**
 * 加载 sqlite-vec 扩展
 * 优先使用手动路径加载，回退到 sqlite-vec 包的自动加载
 */
export const loadSqliteVec = (db: Database.Database): boolean => {
  if (loadedDbs.has(db)) {
    return true
  }

  // 方法 1：手动加载原生模块
  const vecPath = getSqliteVecPath()
  if (vecPath) {
    try {
      console.log(`[sqlite-vec] Loading extension from: ${vecPath}`)
      // 使用 better-sqlite3 的 loadExtension API
      // Windows 上需要完整路径（包括 .dll 扩展名）
      db.loadExtension(vecPath)
      loadedDbs.add(db)
      console.log('[sqlite-vec] Extension loaded successfully via manual path')
      return true
    } catch (error) {
      console.error('[sqlite-vec] Manual load failed:', error)
    }
  }

  // 方法 2：回退到 sqlite-vec 包的自动加载
  try {
    console.log('[sqlite-vec] Trying sqlite-vec package auto-load...')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec')
    sqliteVec.load(db)
    loadedDbs.add(db)
    console.log('[sqlite-vec] Extension loaded successfully via package')
    return true
  } catch (error) {
    console.error('[sqlite-vec] Package auto-load failed:', error)
  }

  console.error('[sqlite-vec] All loading methods failed')
  failedDbs.add(db)
  return false
}

export const isSqliteVecLoaded = (db: Database.Database): boolean => loadedDbs.has(db)

/**
 * 这条连接上到底能不能用 sqlite-vec —— **没加载过就现加载一次**。
 *
 * 和 `isSqliteVecLoaded` 的区别是「试过没有」和「能不能」。前者只查一个
 * WeakSet，对**从没被加载过**的连接一律回 false —— 而 loadSqliteVec 此前只在
 * 公共库那条连接上调过，保管库是另一条连接，于是资产库的语义搜索永远显示
 * 「扩展没能加载」，开关还因此被禁用，用户连打开都打不开。
 *
 * 失败结果也记下来：设置页每 2 秒轮询一次状态，真加载不上的机器不该每次都
 * 重跑一遍找路径 + 打一屏错误日志。
 */
export const ensureSqliteVecLoaded = (db: Database.Database): boolean => {
  if (loadedDbs.has(db)) return true
  if (failedDbs.has(db)) return false
  return loadSqliteVec(db)
}
