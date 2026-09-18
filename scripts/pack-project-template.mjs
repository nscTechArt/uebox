#!/usr/bin/env node
/**
 * 把一个 UE 工程目录打包成内置工程模板（`resources/project/*.zip`）。
 *
 * 为什么要有这个脚本，而不是右键「压缩」：
 *
 *   1. **条目名必须是 UTF-8。** Windows 的资源管理器压出来的 zip，中文条目名走的是
 *      本地代码页（GBK），没有设 UTF-8 标志位。这种包在中文系统上看着正常，
 *      到别人机器上就是一串乱码路径。仓库里原来的两个模板正是这么来的。
 *
 *   2. **必须剔掉 `Content/Developers/**`。** 这是 UE 给每个开发者建的私人目录，
 *      名字就是本机用户名 —— 打包者的真名会跟着模板分发出去，而且目录本身是空的。
 *
 *   3. 顺手排掉 Binaries / Intermediate / Saved 这些不该进模板的产物目录。
 *
 *   4. **输出必须可复现。** 压缩库默认把「打包那一刻」写进每个条目的时间戳，于是
 *      同样的内容每打一次就是一份不同的二进制。模板包是要进 git 的，不可复现意味着
 *      没人能回答「这个 zip 和上次比到底变了什么」—— 只能看到哈希变了。
 *      所以这里固定条目时间并按路径排序，同样的输入永远得到同样的字节。
 *
 * 用法：
 *   node scripts/pack-project-template.mjs <工程目录> <输出 zip 路径>
 */

import { readdirSync, statSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname, relative, sep, basename } from 'node:path'
import AdmZip from 'adm-zip'

/** 不进模板的目录 */
const EXCLUDED_DIRS = new Set([
  '.git',
  '.vs',
  '.idea',
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  'Build'
])

/** 不进模板的文件后缀 */
const EXCLUDED_EXTENSIONS = new Set(['.suo', '.sdf', '.opensdf', '.db', '.tmp', '.sln'])

/**
 * `Content/Developers/<用户名>/` 是 UE 的按人隔离的沙盒目录。
 * 它出现在分发包里没有任何用处，只会泄露打包者的用户名。
 */
function isDeveloperFolder(relativePath) {
  return relativePath.split('/').includes('Developers') && relativePath.includes('Content/')
}

function collectFiles(root, current = root, out = []) {
  for (const name of readdirSync(current)) {
    const full = join(current, name)
    if (statSync(full).isDirectory()) {
      if (EXCLUDED_DIRS.has(name)) continue
      collectFiles(root, full, out)
      continue
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (EXCLUDED_EXTENSIONS.has(ext)) continue
    out.push(full)
  }
  return out
}

const [, , projectDir, outputPath] = process.argv

if (!projectDir || !outputPath) {
  console.error('用法：node scripts/pack-project-template.mjs <工程目录> <输出 zip 路径>')
  process.exit(1)
}

/**
 * 固定的条目时间戳。
 *
 * 取值本身没有含义，只要求「每次打包都一样」。zip 的时间字段精度是 2 秒，
 * 选一个偶数秒的整点，免得不同实现在取整方向上产生分歧。
 */
const FIXED_ENTRY_TIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0))

const projectName = basename(projectDir)
// 排序：目录遍历顺序在不同文件系统上不保证一致，不排序就谈不上可复现
const files = collectFiles(projectDir).sort()
const zip = new AdmZip()

let skipped = 0
for (const file of files) {
  // zip 规范里分隔符是 `/`，Windows 上要转一下
  const relativePath = relative(projectDir, file).split(sep).join('/')
  if (isDeveloperFolder(relativePath)) {
    skipped += 1
    continue
  }
  zip.addFile(`${projectName}/${relativePath}`, readFileSync(file))
}

// addFile 会把「此刻」写进条目头，必须逐条覆盖成固定值
for (const entry of zip.getEntries()) {
  entry.header.time = FIXED_ENTRY_TIME
}

mkdirSync(dirname(outputPath), { recursive: true })
zip.writeZip(outputPath)

const written = readFileSync(outputPath)
console.log(`已打包 ${zip.getEntries().length} 个文件 → ${outputPath}（${written.length} 字节）`)
if (skipped > 0) {
  console.log(`已剔除 ${skipped} 个 Content/Developers 下的条目`)
}

// 立刻回读一遍：条目名解码不出 UTF-8 就是打包环节出了问题，不能等分发之后才发现
const verify = new AdmZip(outputPath)
const broken = verify
  .getEntries()
  .filter((entry) => entry.entryName !== entry.rawEntryName.toString('utf8'))
if (broken.length > 0) {
  console.error('✖ 有条目名不是合法 UTF-8：')
  for (const entry of broken) console.error(`  · ${entry.entryName}`)
  process.exit(1)
}
console.log('✓ 条目名均为 UTF-8')
