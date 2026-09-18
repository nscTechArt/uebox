/**
 * zip 解压加固（Zip Slip 防护）。
 *
 * 为什么原来的 `zip.extractAllTo(dir, true)` 不够：zip 条目名是**压缩包作者写的字符串**，
 * 里面可以是 `../../../AppData/Roaming/...` 或 `C:\Windows\...`。解压库把它拼到目标目录上
 * 就写到目标目录外面去了。模板包一直是本地文件时这个风险还够不着；一旦模板可以从社区源
 * 下载，它就是一条真实的、别人可控的写文件路径。
 *
 * 这里的做法是不信任条目名：自己算出目标路径，再断言它确实落在目标目录里面，
 * 不满足就整包拒绝 —— 不是跳过那一条。一个包里出现越界条目，这个包本身就该被当成恶意的。
 */
import { promises as fs } from 'fs'
import path from 'path'
import type AdmZip from 'adm-zip'

/** 越界条目专用错误，调用方据此给出"这个模板包不安全"的提示 */
export class UnsafeZipEntryError extends Error {
  constructor(readonly entryName: string) {
    super(`模板包中存在越界路径条目：${entryName}`)
    this.name = 'UnsafeZipEntryError'
  }
}

/**
 * 把一个 zip 条目名解析成安全的绝对路径，越界返回 null。
 *
 * 单独导出是为了能直接测：这是整个功能里最不该只靠"看起来对"的一段。
 */
export function resolveSafeEntryPath(destDir: string, entryName: string): string | null {
  // zip 规范里分隔符是 `/`，但现实中确实有包写成 `\` —— 两种都当分隔符处理，
  // 否则 `..\..\x` 在 posix 解析下会被当成一整个文件名而躲过检查。
  const normalized = entryName.replace(/\\/g, '/')

  // 绝对路径（/etc/x）和盘符（C:/x）直接判死，它们根本不该出现在压缩包里
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null

  const resolvedDest = path.resolve(destDir)
  const target = path.resolve(resolvedDest, normalized)

  // 必须严格在目标目录**内部**。加分隔符是为了挡住 `/tmp/foo-evil` 冒充 `/tmp/foo`
  const prefix = resolvedDest.endsWith(path.sep) ? resolvedDest : resolvedDest + path.sep
  if (target !== resolvedDest && !target.startsWith(prefix)) return null

  return target
}

/**
 * 安全地把整个 zip 解压到 destDir。
 *
 * 先全量校验再落盘：越界条目在写任何文件之前就把整包拒了，避免"写了一半才发现有问题"
 * 留下一地需要清理的残骸。
 */
export async function extractZipSafely(zip: AdmZip, destDir: string): Promise<void> {
  const entries = zip.getEntries()

  const planned: { entry: (typeof entries)[number]; target: string }[] = []
  for (const entry of entries) {
    const target = resolveSafeEntryPath(destDir, entry.entryName)
    if (target === null) throw new UnsafeZipEntryError(entry.entryName)
    planned.push({ entry, target })
  }

  await fs.mkdir(destDir, { recursive: true })

  for (const { entry, target } of planned) {
    if (entry.isDirectory) {
      await fs.mkdir(target, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
}
