#!/usr/bin/env node
/**
 * 打包依赖闭包门禁。
 *
 * 主进程与 preload 用 electron-vite 的 externalizeDepsPlugin 把所有生产依赖
 * 外部化，运行时从 app.asar 内的 node_modules 解析。electron-builder 对 pnpm
 * 的提升布局做依赖收集时会漏掉部分传递依赖 —— 漏掉的后果是打包产物启动即
 * 抛 "Cannot find module"，而 typecheck、测试、构建全部是绿的，发现不了。
 *
 * 本脚本从 out/main 与 out/preload 实际 require 的外部包出发，遍历它们的
 * dependencies 闭包，逐个确认已经进入 app.asar。任何缺口都失败退出。
 *
 * 用法：node scripts/check-packaged-deps.mjs [--asar <path>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'
import { checkPackagedContent } from './check-packaged-content.mjs'
import { packagedAppPaths } from './packaged-app-paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS_SEP = String.fromCharCode(92)

function parseArgs(argv) {
  const asarIndex = argv.indexOf('--asar')
  return {
    asarPath:
      asarIndex !== -1 && argv[asarIndex + 1]
        ? resolve(argv[asarIndex + 1])
        : packagedAppPaths(ROOT).asar
  }
}

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exitCode = 1
}

/**
 * 列出 app.asar 内所有 node_modules 包名（任意深度）。
 *
 * pnpm/electron-builder 会把部分包放进依赖自己的 node_modules 里，例如
 * node_modules/ai/node_modules/@opentelemetry/api —— 运行时能正常解析，
 * 只认顶层会误报缺失。
 */
function readAsarPackages(asarPath) {
  const packages = new Set()
  for (const entry of listPackage(asarPath)) {
    const parts = entry.trim().split(entry.includes(WINDOWS_SEP) ? WINDOWS_SEP : '/')
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== 'node_modules') continue
      const name = parts[i + 1]
      if (name.startsWith('@')) {
        if (i + 2 < parts.length) packages.add(`${name}/${parts[i + 2]}`)
      } else {
        packages.add(name)
      }
    }
  }
  return packages
}

function collectJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectJsFiles(full, out)
    else if (/\.(js|mjs|cjs)$/.test(full)) out.push(full)
  }
  return out
}

const BUILTIN = new Set(['electron', ...builtinModules].flatMap((n) => [n, `node:${n}`]))

const toPackageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

/** out/main 与 out/preload 里实际 require 的外部包 */
function readExternalRoots() {
  const files = [
    ...collectJsFiles(join(ROOT, 'out/main')),
    ...collectJsFiles(join(ROOT, 'out/preload'))
  ]
  if (files.length === 0) {
    fail('out/main 与 out/preload 为空，请先执行构建')
    return { roots: new Set(), fileCount: 0 }
  }

  const roots = new Set()
  const pattern = /(?:require\(|(?:from|import)\s*)["']([^"'.][^"']*)["']/g
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    let match
    while ((match = pattern.exec(source))) {
      if (BUILTIN.has(match[1])) continue
      roots.add(toPackageName(match[1]))
    }
  }
  return { roots, fileCount: files.length }
}

function readManifest(packageName) {
  const manifestPath = join(ROOT, 'node_modules', packageName, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const { asarPath } = parseArgs(process.argv.slice(2))
  if (!existsSync(asarPath)) {
    fail(`找不到 app.asar：${asarPath}`)
    return
  }

  try {
    checkPackagedContent(asarPath)
  } catch (error) {
    fail(error.message)
    return
  }

  const asarPackages = readAsarPackages(asarPath)
  const { roots, fileCount } = readExternalRoots()
  if (process.exitCode === 1) return

  const visited = new Set()
  const missing = new Map()
  const queue = [...roots]

  while (queue.length > 0) {
    const packageName = queue.shift()
    if (visited.has(packageName)) continue
    visited.add(packageName)

    const manifest = readManifest(packageName)
    if (!manifest) continue

    for (const dependency of Object.keys(manifest.dependencies || {})) {
      // @types/* 只在编译期使用，electron-builder 一律不打进包，不构成运行时缺口
      if (dependency.startsWith('@types/')) continue
      // 本机未安装 = 未被解析到的可选依赖，运行时不会命中
      if (!readManifest(dependency)) continue

      const nestedPath = join(
        ROOT,
        'node_modules',
        packageName,
        'node_modules',
        dependency,
        'package.json'
      )
      if (!asarPackages.has(dependency) && !existsSync(nestedPath)) {
        if (!missing.has(dependency)) missing.set(dependency, [])
        missing.get(dependency).push(packageName)
      }
      queue.push(dependency)
    }
  }

  if (missing.size > 0) {
    for (const [dependency, dependents] of [...missing].sort()) {
      fail(`app.asar 缺少主进程运行时依赖 ${dependency}（被 ${dependents.join('、')} 依赖）`)
    }
    console.error('修复方式：在 electron-builder.yml 的 files 里显式加入 node_modules/<包名>/**')
    return
  }

  console.log(
    `打包依赖闭包检查通过（扫描 ${fileCount} 个产物文件，遍历 ${visited.size} 个包，asar 内 ${asarPackages.size} 个包）。`
  )
}

main()
