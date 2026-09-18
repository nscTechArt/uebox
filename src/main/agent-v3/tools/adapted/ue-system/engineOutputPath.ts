/**
 * 把引擎报上来的产物路径落到盒子能打开的绝对路径上。
 *
 * ## 为什么需要这一步
 *
 * 引擎内部到处用**相对路径**：`FPaths::ProjectDir()` 会被
 * `DefaultConvertToRelativePath` 相对化成 `../../../<工程>/`（工程和引擎在同一个盘
 * 时必然如此，UE 5.7 GenericPlatformMisc.cpp:1311）。CSV Profiler 的输出名就是这么
 * 拼出来的。引擎自己读得到 —— 它按自己的 BaseDir 解；盒子读不到 —— Node 按**盒子的**
 * 工作目录解，于是盘符换成了盒子所在的盘。真机上报出来的是
 * 「H:\GameJam\...\Profile(...).csv 不存在」，而工程在 I:，路径里除盘符外一个字不差。
 *
 * 插件已经改成回绝对路径了，但**用户手里的插件未必是新的**：日常只出 UE 5.5 的包，
 * 别的引擎版本用户装到的是上一次发版那一份，而且盒子还会如实告诉他「插件已是最新」。
 * 所以这一层必须留着：它让工具在旧插件上照样出数，而不是给用户一句他执行不了的
 * 「请升级插件」。
 *
 * ## 怎么落
 *
 * 不去猜引擎装在哪（相对路径是相对**引擎二进制目录**的，层数还随工程位置变），
 * 而是认那条尾巴：引擎的产物都在 `<工程>/Saved/...` 底下，而工程路径是盒子自己
 * 记着的。把 `Saved/` 之后的部分接到工程目录上就行。
 */

import { isAbsolute, resolve } from 'node:path'

/** 产物一律落在工程的 `Saved/` 下，这是拼回绝对路径的锚点 */
const SAVED_SEGMENT = /(^|[\\/])Saved[\\/]/

export function resolveEngineOutputPath(
  reported: string | undefined,
  projectPath: string | undefined
): string | undefined {
  if (!reported || isAbsolute(reported)) return reported
  if (!projectPath) return reported

  const match = SAVED_SEGMENT.exec(reported)
  if (!match) return reported

  const tail = reported.slice(match.index + match[1].length)
  return resolve(projectPath, tail)
}
