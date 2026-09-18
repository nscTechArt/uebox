import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'

/** Only for outputs created by this operation. Historical input files remain valid. */
export async function assertFreshFile(path: string | undefined, since: number): Promise<void> {
  if (!path) throw new Error('没有返回本次产物的文件路径')
  /*
   * 相对路径当场报错，不许往下走。
   *
   * 产物是**引擎那边**写的，而引擎给出的路径可能是相对它自己安装目录的
   * （`FPaths::ProjectDir()` 会被 `DefaultConvertToRelativePath` 相对化，
   * UE 5.7 GenericPlatformMisc.cpp:1311）。`stat` 拿到相对路径会按**盒子自己的**
   * 工作目录去补，于是盘符换成了盒子所在的盘 —— 真机上报出来的是
   * 「H:\\...\\Saved\\Profiling\\CSV\\Profile(...).csv 不存在」，而工程在 I:，
   * 路径里除盘符外一个字都不差，没人看得出发生了什么。
   * 宁可说「引擎给的是相对路径」，也不要拿一个自己拼出来的盘符去找文件。
   */
  if (!isAbsolute(path)) {
    /*
     * 不写「请升级插件」。用户的插件**可能已经是他能装到的最新一份**：
     * 日常只出 UE 5.5 的分发包，别的引擎版本装到的是上次发版那一份，而盒子还会
     * 如实告诉他 `pluginUpToDate: true` —— 照着这句提示去升级，他会撞上一个
     * 走不通的动作（真机上就这么发生过）。
     * 调用方该做的是把这个路径落到工程目录上（见 `ue-system/engineOutputPath.ts`），
     * 落不了才轮到报错。
     */
    throw new Error(
      `引擎返回的是相对路径，盒子无法定位这次的产物：${path}。` +
        `别按它去找文件，也别让用户去升级插件 —— 换一条能出数的路（例如 ue_get_performance_stats），` +
        `或者把这个路径连同当前工程目录一起报给用户，让他自己打开`
    )
  }
  const file = await stat(path)
  if (!file.isFile() || file.size === 0) throw new Error(`产物不是非空文件：${path}`)
  if (file.mtimeMs < since) throw new Error(`返回的是旧文件，未确认本次产物：${path}`)
}
