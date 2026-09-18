import { analyzeFromFile } from '../../utils/uasset-reader-new'

/**
 * 只读地取出一个 UE 包引用了哪些 `/Game/...` 资产。
 *
 * 为什么不复用 `UnrealAssetProcessor.processFile`：它是**导入用**的完整处理器，
 * 顺手就把缩略图转出来存盘了。判断「这个资产是不是已经导全了」本该是一次纯查询，
 * 走那条路的代价是每查一个包就在磁盘上多几张没人引用的缩略图，还白花转码时间。
 *
 * 返回 `null` 只表示**解析失败**。解析成功但没有依赖返回的是空数组 —— 这两件事
 * 必须分得开：混为一谈的话，一个完整的、无依赖的资产会被当成「查不出来」，
 * 于是每次都重新导一遍。
 */

/** `analyzeFromFile` 的返回值里我们只用到这两块 */
type AnalyzedPackage = {
  stack?: unknown
  message?: string
  imports?: { Imports?: Array<{ objectName?: string; packageName?: string }> }
  softPackageReferences?: Array<{ assetPathName?: string }>
}

export type PackageAnalyzer = (filePath: string) => Promise<AnalyzedPackage | Error>

const defaultAnalyzer: PackageAnalyzer = (filePath) =>
  analyzeFromFile(filePath, { saveHexView: false }) as Promise<AnalyzedPackage | Error>

/**
 * 去掉补位的空字节和结尾的 `.对象名`。
 *
 * **刻意不做「编码修复」。** 底层解析器交出来的已经是解好的 Unicode 字符串，
 * 再套一层 `fixChineseEncoding` 只会把好字符改坏：那个函数把「非 ASCII 且非常用汉字」
 * 一律当成乱码，于是 `é`、日文假名、韩文全部中招 ——
 * `/Game/Textures/T_Café` 会被改成 `/Game/Textures/T_Caf�`，
 * 于是依赖找不到，导入却报「成功、无警告」。
 *
 * 万一真遇到没解开的乱码，代价只是这条依赖找不到、上报一条警告，
 * 导入会被标成不完整 —— 比静默改坏一条合法路径安全得多。
 */
const normalizeReference = (raw: string | undefined): string => {
  if (!raw) return ''
  return raw
    .split(String.fromCharCode(0))
    .join('')
    .trim()
    .replace(/\.[^.]*$/, '')
}

const isUserPath = (p: string): boolean => p.startsWith('/Game/')

/**
 * @param selfSoftPath 自己的软路径，用来把「引用自己」剔掉
 * @returns `/Game/...` 依赖列表；解析失败返回 null
 */
export const readPackageImports = async (
  filePath: string,
  options: { analyze?: PackageAnalyzer; selfSoftPath?: string } = {}
): Promise<string[] | null> => {
  const analyze = options.analyze ?? defaultAnalyzer

  let result: AnalyzedPackage | Error
  try {
    result = await analyze(filePath)
  } catch {
    return null
  }

  // 解析器出错的两种表现：抛出来的 Error，和带 stack 的结果对象
  if (result instanceof Error || !result || result.stack) return null

  const refs = new Set<string>()

  for (const imp of result.imports?.Imports ?? []) {
    for (const candidate of [
      normalizeReference(imp?.objectName),
      normalizeReference(imp?.packageName)
    ]) {
      if (!candidate || !candidate.includes('/')) continue
      if (!isUserPath(candidate)) continue
      if (options.selfSoftPath && candidate === options.selfSoftPath) continue
      refs.add(candidate)
    }
  }

  for (const ref of result.softPackageReferences ?? []) {
    const candidate = normalizeReference(ref?.assetPathName)
    if (!candidate || !isUserPath(candidate)) continue
    if (options.selfSoftPath && candidate === options.selfSoftPath) continue
    refs.add(candidate)
  }

  // 解析成功、没有依赖 —— 返回空数组，不是 null
  return Array.from(refs)
}

/**
 * 带缓存的读取器。一次导入里同一个包会被反复问到（几百个动画共用一副骨骼）。
 */
export const createPackageImportsReader = (
  cache: Map<string, string[] | null>,
  options: { analyze?: PackageAnalyzer } = {}
): ((target: string) => Promise<string[] | null>) => {
  return async (target: string): Promise<string[] | null> => {
    if (cache.has(target)) return cache.get(target) ?? null
    const imports = await readPackageImports(target, { analyze: options.analyze })
    cache.set(target, imports)
    return imports
  }
}
