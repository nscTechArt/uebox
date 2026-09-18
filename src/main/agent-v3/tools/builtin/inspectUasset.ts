/**
 * `inspect_uasset_file` —— 不开引擎，直接读 `.uasset` / `.umap` 的包头。
 *
 * ## 为什么要有它
 *
 * 编辑器崩了之后，磁盘上摆着一堆文件，而**没有任何工具能说出它们是什么**。
 * 2026-09-03 真机上，模型面对一个 1.3 KB 的旧文件只能靠经验猜「这大概是个
 * 重定向器」——猜对了，但那是运气，不是流程。同一天它还得靠文件大小反推
 * 「改名到底做完没有」。
 *
 * 包头里本来就写着答案：这个包里是什么类型的对象、它引用了谁。
 * 解析器仓库里早就有（`utils/uasset-reader-new.js`，导入流程一直在用），
 * 缺的只是把它接成一个工具。
 *
 * ## 它不替代引擎
 *
 * 只读包头：类型、引用、软引用。资产的**内容**（材质有几个节点、网格多少面）
 * 要引擎。所以定位是「引擎不在时的第一手信息」和「引擎在时的交叉验证」，
 * 不是内容浏览器的替代品。
 */

import { stat } from 'fs/promises'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { assertInAccessScope } from './accessScope'
import { assertPathAllowed } from './pathBoundary'

/** `analyzeFromFile` 的返回值里我们用到的那几块 */
interface AnalyzedImport {
  objectName?: string
  packageName?: string
  className?: string
}

interface AnalyzedExport {
  /** FPackageIndex：负数指 imports（-idx-1），正数指 exports（idx-1），0 是空 */
  classIndex?: number
  objectName?: string
  bIsAsset?: boolean
}

interface AnalyzedPackage {
  stack?: unknown
  message?: string
  header?: Record<string, unknown>
  imports?: { Imports?: AnalyzedImport[] }
  exports?: AnalyzedExport[]
  softPackageReferences?: { assetPathName?: string }[]
}

/** 去掉补位空字节和结尾的 `.对象名` */
function clean(raw: string | undefined): string {
  if (!raw) return ''
  return raw.split(String.fromCharCode(0)).join('').trim()
}

/**
 * FPackageIndex → 类名。
 *
 * 一个资产的「类」几乎总是一条 import（`/Script/Engine.StaticMesh` 之类），
 * 所以 classIndex 通常是负数。指到 export 的情况（蓝图生成类）这里报不出名字，
 * 如实回空而不是猜。
 */
function classNameOf(index: number | undefined, imports: AnalyzedImport[]): string {
  if (typeof index !== 'number' || index >= 0) return ''
  const at = -index - 1
  return clean(imports[at]?.objectName)
}

const InspectInput = z.object({
  path: z
    .string()
    .describe('.uasset / .umap 文件的绝对路径，如 "D:/P/Content/Props/SM_Rock.uasset"')
})

export function createInspectUassetTool(): UnrealAgentTool<never> {
  return defineTool({
    name: 'inspect_uasset_file',
    namespace: 'local',
    risk: 'safe',
    description:
      '不开引擎，直接读磁盘上一个 .uasset / .umap 里写的是什么。\n\n' +
      '【什么时候用】\n' +
      '- **编辑器崩了 / 还没起来**，但要知道磁盘上的现状：这个包是什么类型、引用了谁；\n' +
      '- 判断旧路径上剩下的那个小文件是不是**重定向器**（搬完资产留下的转发桩）；\n' +
      '- 引擎说的和磁盘上的对不上时，拿它做交叉验证。\n' +
      '【它能回答】包里是什么类（StaticMesh / ObjectRedirector / World …）、' +
      '引用了哪些 /Game 资产、软引用了哪些、文件多大什么时候改的。\n' +
      '【它答不了】资产的内容（材质节点、网格面数、蓝图图表）—— 那些要引擎，' +
      '用 ue_content_describe 之类。\n' +
      '【想知道整批搬迁做成没有】别逐个读，用 ue_content_rollback action=verify，' +
      '它一次把整份账本对完。',
    input: InspectInput,
    execute: async (args) => {
      const denied = assertPathAllowed(args.path)
      if (denied) return { text: denied, isError: true }

      const outOfScope = await assertInAccessScope(args.path)
      if (outOfScope) return { text: outOfScope, isError: true }

      let bytes: number
      let mtime: string
      try {
        const info = await stat(args.path)
        if (!info.isFile()) return { text: `${args.path} 不是文件。`, isError: true }
        bytes = info.size
        mtime = new Date(info.mtimeMs).toISOString()
      } catch {
        return { text: `文件不存在或读不了：${args.path}`, isError: true }
      }

      // 懒加载：这个解析器是一个三千行的 JS 模块，注册表 import 的时候不该把它拖进来
      const { analyzeFromFile } = await import('../../../utils/uasset-reader-new')
      let parsed: AnalyzedPackage | Error
      try {
        parsed = (await analyzeFromFile(args.path, { saveHexView: false })) as
          | AnalyzedPackage
          | Error
      } catch (error) {
        return { text: `解析失败：${(error as Error).message}`, isError: true }
      }
      if (parsed instanceof Error || !parsed || parsed.stack) {
        const why =
          parsed instanceof Error
            ? parsed.message
            : ((parsed as AnalyzedPackage)?.message ?? '未知原因')
        return {
          // 解析不了的常见原因是它压根不是 UE 包，或者版本太新
          text: `这个文件解析不了（${why}）。大小 ${bytes} 字节，最后修改 ${mtime}。`,
          isError: true
        }
      }

      const imports = parsed.imports?.Imports ?? []
      const exports = parsed.exports ?? []

      // 资产导出（bIsAsset）优先；没有就取第一个导出
      const main = exports.find((e) => e.bIsAsset) ?? exports[0]
      const mainClass = classNameOf(main?.classIndex, imports)
      const mainName = clean(main?.objectName)

      const gameRefs = new Set<string>()
      for (const imp of imports) {
        for (const candidate of [clean(imp.objectName), clean(imp.packageName)]) {
          if (candidate.startsWith('/Game/')) gameRefs.add(candidate)
        }
      }
      const softRefs = new Set<string>()
      for (const soft of parsed.softPackageReferences ?? []) {
        const candidate = clean(soft.assetPathName)
        if (candidate.startsWith('/Game/')) softRefs.add(candidate)
      }

      const isRedirector = mainClass === 'ObjectRedirector'
      const lines = [
        `${args.path}`,
        `类型：${mainClass || '（读不出来）'}${mainName ? `，对象名：${mainName}` : ''}`,
        `大小 ${bytes} 字节，最后修改 ${mtime}`,
        `导出对象 ${exports.length} 个，导入引用 ${imports.length} 条`
      ]

      if (isRedirector) {
        lines.push('')
        lines.push(
          '**这是一个重定向器**（旧路径上的转发桩）—— 资产本身已经搬到别处了，' +
            '引擎访问这个旧路径时会自动转到新位置。它指向下面这些 /Game 引用里的那一个：'
        )
      }

      if (gameRefs.size > 0) {
        lines.push('')
        lines.push(`引用的 /Game 资产（${gameRefs.size} 个）：`)
        for (const ref of Array.from(gameRefs).slice(0, 50)) lines.push(`- ${ref}`)
        if (gameRefs.size > 50) lines.push(`… 一共 ${gameRefs.size} 个`)
      }
      if (softRefs.size > 0) {
        lines.push('')
        lines.push(`软引用（${softRefs.size} 个）：`)
        for (const ref of Array.from(softRefs).slice(0, 50)) lines.push(`- ${ref}`)
      }
      if (gameRefs.size === 0 && softRefs.size === 0) {
        lines.push('')
        lines.push('没有引用任何 /Game 资产（引用的都是引擎内置的东西）。')
      }

      return {
        text: lines.join('\n'),
        details: {
          path: args.path,
          bytes,
          mtime,
          class: mainClass,
          object_name: mainName,
          is_redirector: isRedirector,
          exports: exports.length,
          imports: imports.length,
          game_references: Array.from(gameRefs),
          soft_references: Array.from(softRefs)
        }
      }
    }
  }) as unknown as UnrealAgentTool<never>
}
