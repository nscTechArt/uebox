#!/usr/bin/env node
/**
 * 把锁定版本的官方 Blender Lab MCP 源码打成 zip，放进 resources/blender-mcp/，随安装包发。
 *
 * ## 为什么随包，而不是让用户机器上 git fetch
 *
 * 原来「一键接入 Blender」要用户先装 Git，再从 projects.blender.org 拉源码。
 * 国内直连时 Git 安装包走 GitHub Releases，握手失败、几百 KB/s 是常态；
 * 而拉的永远是同一个锁定的 commit —— 那就没有理由在用户机器上拉。
 * 源码随包之后，用户机器不再需要 Git。
 *
 * 官方站的「下载 zip」对脚本返回 403（反爬），所以这里用 git 取、`git archive` 打包。
 *
 * ## 为什么不进 git
 *
 * 27 MB、四千多个文件（大头是内置的 Blender 手册摘录），每升一次版本就在历史里永久多一份。
 * 仓库里只提交清单 blender-mcp-source.json（来源、commit）。
 *
 * ## 怎么核对
 *
 * `git archive` 打的 zip 会把 commit id 写进 zip 注释。--check 读这个注释，
 * 和清单里的 revision 对不上就拒绝 —— commit id 本身就是内容哈希，比另记一个 SHA-256 少一处要同步。
 *
 * 许可证：代码 GPL-3.0-or-later，手册摘录 CC-BY-SA-4.0。盒子以独立进程调用它，属于聚合分发；
 * 许可证全文随包在 licenses/GPL-3.0.txt，声明见 THIRD-PARTY-NOTICES.md。
 *
 * 用法：
 *   node scripts/fetch-blender-mcp.mjs --check    只检查：没有或 commit 对不上就非零退出
 *   node scripts/fetch-blender-mcp.mjs --ensure   缺了或不对就用 git 取来（出包时用这个）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'resources', 'blender-mcp')
const manifest = JSON.parse(readFileSync(join(dir, 'blender-mcp-source.json'), 'utf8'))
const target = join(dir, manifest.file)
const args = process.argv.slice(2)

/** zip 末尾「中央目录结束记录」里的注释。找不到返回 null */
export function zipComment(buffer) {
  // 记录至少 22 字节，注释最长 65535，从后往前找签名 PK\x05\x06
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) !== 0x06054b50) continue
    const length = buffer.readUInt16LE(at + 20)
    if (at + 22 + length !== buffer.length) continue
    return buffer.subarray(at + 22, at + 22 + length).toString('latin1')
  }
  return null
}

function problem() {
  if (!existsSync(target)) return `没有 ${target}`
  const comment = zipComment(readFileSync(target))
  return comment === manifest.revision
    ? null
    : `${target} 的 commit 是 ${comment ?? '（读不出）'}，清单要求 ${manifest.revision}`
}

function git(cwd, ...gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} 失败：${result.stderr || result.error?.message}`)
  }
  return result.stdout.trim()
}

function download() {
  const work = mkdtempSync(join(tmpdir(), 'blender-mcp-'))
  try {
    git(work, 'init', '--quiet')
    git(work, 'remote', 'add', 'origin', manifest.origin)
    git(work, 'fetch', '--quiet', '--depth', '1', 'origin', manifest.revision)
    const head = git(work, 'rev-parse', 'FETCH_HEAD')
    if (head !== manifest.revision)
      throw new Error(`上游给的是 ${head}，清单要求 ${manifest.revision}`)
    mkdirSync(dir, { recursive: true })
    git(work, 'archive', '--format=zip', '-o', target, manifest.revision)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const before = problem()
if (!before) {
  console.log(`[blender-mcp] ${manifest.file} 已就绪（commit ${manifest.revision.slice(0, 8)}）。`)
  process.exit(0)
}
if (!args.includes('--ensure')) {
  console.error(`[blender-mcp] ${before}。运行 node scripts/fetch-blender-mcp.mjs --ensure 取来。`)
  process.exit(1)
}

console.log(`[blender-mcp] ${before}，从 ${manifest.origin} 取…`)
try {
  download()
} catch (error) {
  console.error(`[blender-mcp] ${error.message}`)
  process.exit(1)
}
const after = problem()
if (after) {
  console.error(`[blender-mcp] 取完仍不对：${after}`)
  process.exit(1)
}
console.log(`[blender-mcp] 已放入 ${target}。`)
