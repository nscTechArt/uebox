#!/usr/bin/env node
/**
 * 把固定版本的官方 lore.exe 放进 resources/lore/<平台>/，供服务端资产库的导入和下载使用
 * （src/main/libraryV3/loreCli.ts；设计：unreal-box-assets-server ADR 0008）。
 *
 * ## 为什么不进 git
 *
 * lore.exe 有 38 MB，每升一次版本就在历史里永久多一份。仓库里只提交清单
 * resources/lore/lore-cli.json（版本、来源、SHA-256），二进制由这个脚本按清单取来并逐字节核对；
 * 对不上就拒绝，绝不放一个"差不多"的 lore.exe —— 它会拿着美术的身份令牌推送。
 *
 * 用法：
 *   node scripts/fetch-lore-cli.mjs --from <lore.exe 或官方 zip>   从本机文件放入（离线、内网）
 *   node scripts/fetch-lore-cli.mjs --download                      从 GitHub Releases 下载官方 zip
 *   node scripts/fetch-lore-cli.mjs --check                         只检查：没有或哈希不对就非零退出
 *
 * 出安装包（build:win）前跑 --check：没有 lore.exe 的安装包浏览照常，但导入和下载不可用，
 * 这种包不该静默发出去。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'resources', 'lore', 'lore-cli.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const platform = `${process.platform}-${process.arch}`
const pin = manifest.platforms[platform]
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

if (!pin) {
  console.log(`[lore] 清单里没有 ${platform} 的 lore CLI，跳过（这个平台上导入和下载不可用）。`)
  process.exit(args.includes('--check') ? 1 : 0)
}

const targetDir = join(root, 'resources', 'lore', platform)
const target = join(targetDir, pin.file)

function verifyInstalled() {
  if (!existsSync(target)) return `没有 ${target}`
  const actual = sha256(target)
  return actual === pin.sha256 ? null : `${target} 的 SHA-256 是 ${actual}，清单要求 ${pin.sha256}`
}

function install(binary) {
  const actual = sha256(binary)
  if (actual !== pin.sha256) {
    console.error(
      `[lore] 拒绝：${binary} 的 SHA-256 是 ${actual}，清单要求 ${pin.sha256}（${manifest.version}）。`
    )
    process.exit(1)
  }
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(binary, target)
  console.log(`[lore] 已放入 ${target}（${manifest.version}，SHA-256 已核对）。`)
}

/** 官方 zip：先核对整包哈希，再解出 lore.exe 并核对它的哈希（Windows 10+ 自带 bsdtar 能解 zip） */
function installFromArchive(archive) {
  const actual = sha256(archive)
  if (pin.archiveSha256 && actual !== pin.archiveSha256) {
    console.error(
      `[lore] 拒绝：${archive} 的 SHA-256 是 ${actual}，清单要求 ${pin.archiveSha256}。`
    )
    process.exit(1)
  }
  const work = mkdtempSync(join(tmpdir(), 'lore-cli-'))
  try {
    const result = spawnSync('tar', ['-xf', archive, '-C', work], {
      stdio: 'inherit',
      windowsHide: true
    })
    if (result.status !== 0) {
      console.error('[lore] 解压失败（需要系统自带的 tar）。')
      process.exit(1)
    }
    const found = [join(work, pin.file), ...findFile(work, pin.file)].find((file) =>
      existsSync(file)
    )
    if (!found) {
      console.error(`[lore] 压缩包里没有 ${pin.file}。`)
      process.exit(1)
    }
    install(found)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function findFile(dir, name) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findFile(path, name))
    else if (entry.name === name) out.push(path)
  }
  return out
}

if (args.includes('--check')) {
  const problem = verifyInstalled()
  if (problem) {
    console.error(
      `[lore] ${problem}。运行 node scripts/fetch-lore-cli.mjs --from <文件> 或 --download。`
    )
    process.exit(1)
  }
  console.log(`[lore] ${target} 就绪（${manifest.version}）。`)
  process.exit(0)
}

const from = option('--from')
if (from) {
  const file = resolve(from)
  if (!existsSync(file)) {
    console.error(`[lore] 找不到 ${file}`)
    process.exit(1)
  }
  if (file.toLowerCase().endsWith('.zip')) installFromArchive(file)
  else install(file)
  process.exit(0)
}

if (args.includes('--download')) {
  if (!verifyInstalled()) {
    console.log(`[lore] ${target} 已是固定版本，不用下载。`)
    process.exit(0)
  }
  console.log(`[lore] 下载 ${pin.url}`)
  const response = await fetch(pin.url, { redirect: 'follow' })
  if (!response.ok) {
    console.error(`[lore] 下载失败：HTTP ${response.status}`)
    process.exit(1)
  }
  const work = mkdtempSync(join(tmpdir(), 'lore-zip-'))
  const archive = join(work, pin.archive)
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
  try {
    installFromArchive(archive)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  process.exit(0)
}

console.log('用法：node scripts/fetch-lore-cli.mjs --from <lore.exe|zip> | --download | --check')
process.exit(2)
