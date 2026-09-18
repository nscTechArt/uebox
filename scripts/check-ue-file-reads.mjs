#!/usr/bin/env node
/**
 * 引擎文件读取门禁 / UE-authored file read gate.
 *
 * ## 这道门禁守的是什么
 *
 * **引擎写出来的文本文件不许按固定编码读。**
 *
 * UE 保存 `.uproject` / `.uplugin` 走 `FFileHelper::SaveStringToFile(Text, *FileName)`，
 * 第三个参数默认是 `EEncodingOptions::AutoDetect`。AutoDetect 的判据只有一条：
 * 内容不是纯 ASCII（`!FCString::IsPureAnsi`）就整份存成 **UTF-16LE 带 BOM**
 * （`FileHelper.cpp`，5.0–5.8 全一样）。
 *
 * 也就是说：**工程名或描述里有一个中文字，引擎下次保存就把文件翻成 UTF-16。**
 * 对中文用户这不是边角情况，是常态。
 *
 * Node 这边 `readFile(path, 'utf-8')` 读 UTF-16 得到的是 `��{\0"\0F\0…`，
 * `JSON.parse` 抛 `Unexpected token '�'`。2026-09-17 的真实事故就是这么来的：
 * 一个中文描述的工程导入后 UnrealAgentLink 装不上，右键手动安装也失败（同一段代码），
 * 用户只看到一句自己看不懂的报错，AI 从此看不见引擎里的任何东西。
 *
 * 一处修好不算完 —— 当时仓库里有 12 处同样写法，散在导入、模板建工程、
 * 插件管理、引擎发现、Epic MCP 一键里。这道门禁就是拦住第 13 处。
 *
 * ## 规则
 *
 * 读下列文件时不许出现编码参数，走 `src/main/utils/ueTextFile.ts`：
 *
 *   `.uproject` `.uplugin` `Build.version` `LauncherInstalled.dat` `*.item`
 *   引擎写的 `.ini`（TemplateDefs / EditorPerProjectUserSettings / EditorSettings / Default*.ini）
 *
 *   - 要文本 → `readUeTextFile(path)`
 *   - 要 JSON → `readUeJsonFile<T>(path)`
 *   - 已经有 Buffer → `decodeUeText(buffer)`
 *
 * 写回去继续用 UTF-8（不带 BOM）是对的：引擎读文件时没有 BOM 就按 UTF-8 解，
 * 不需要为了写回把 UTF-16 还原回去。
 *
 * 测试文件不扫 —— 测试里构造各种编码的假文件正是它该干的事。
 *
 * 用法：node scripts/check-ue-file-reads.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCAN_DIRS = [join(ROOT, 'src'), join(ROOT, 'packages')]

const TEST_FILE_PATTERN = /\.(test|spec)\.ts$/
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', '.vite'])

/** 解码器自己当然要摸原始字节 */
const EXCLUDED_FILES = new Set(['src/main/utils/ueTextFile.ts'])

/**
 * 「这个路径是引擎写的」的判据。
 *
 * 只收不会误伤的：盒子自己的 json（app-settings、window-state、ualink-config）
 * 用的是 `configPath` 这类名字，不在这份清单里，照常按 utf-8 读没问题。
 */
const UE_FILE_HINT =
  /uproject|uplugin|Build\.version|LauncherInstalled|\.item\b|TemplateDefs|EditorPerProjectUserSettings|EditorSettings|Default(?:Engine|Game|Editor|Input)\.ini|iniPath/i

/** 写死编码的写法：第二个参数是 'utf8'，或者 { encoding: 'utf8' } */
const ENCODING_ARG = /['"]utf-?8['"]|encoding:\s*['"]utf-?8['"]/i

const READ_CALL = /\breadFile(?:Sync)?\s*\(/g
/** 一次读取调用最多看这么长，够覆盖跨行写法，又不至于粘到下一个语句 */
const CALL_WINDOW = 260

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIPPED_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (!name.endsWith('.ts')) continue
    if (TEST_FILE_PATTERN.test(name)) continue
    out.push(full)
  }
  return out
}

const toRepoPath = (file) => relative(ROOT, file).split(sep).join('/')

const problems = []

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const repoPath = toRepoPath(file)
    if (EXCLUDED_FILES.has(repoPath)) continue

    const text = readFileSync(file, 'utf-8')
    for (const match of text.matchAll(READ_CALL)) {
      const call = text.slice(match.index, match.index + CALL_WINDOW)
      // 调用参数就在开头那一截；窗口尾巴上的内容可能是别的语句，别拿去判断
      const args = call.slice(0, call.indexOf(')') + 1 || CALL_WINDOW)
      if (!UE_FILE_HINT.test(args)) continue
      if (!ENCODING_ARG.test(args)) continue
      const line = text.slice(0, match.index).split('\n').length
      problems.push(`${repoPath}:${line}  ${args.split('\n')[0].trim()}`)
    }
  }
}

if (problems.length > 0) {
  console.error('✖ 引擎文件读取门禁未通过：以下位置按固定编码读引擎写的文件\n')
  for (const line of problems) console.error(`  · ${line}`)
  console.error(
    '\n引擎保存 .uproject / .uplugin 用的是 AutoDetect 编码：内容里有一个非 ASCII 字符' +
      '\n（中文工程名、中文描述）就整份存成 UTF-16LE。按 utf-8 读会得到乱码，' +
      '\nJSON.parse 当场抛 Unexpected token —— 用户那边表现为「插件装不上、AI 看不见引擎」。' +
      '\n\n改用 src/main/utils/ueTextFile.ts：' +
      '\n  · 要文本 → readUeTextFile(path)' +
      '\n  · 要 JSON → readUeJsonFile<T>(path)' +
      '\n  · 已有 Buffer → decodeUeText(buffer)' +
      '\n\n写回去仍然用 UTF-8（不带 BOM），引擎读得回来。'
  )
  process.exit(1)
}

console.log('引擎文件读取门禁通过（没有按固定编码读 .uproject / .uplugin / 引擎 ini 的地方）。')
