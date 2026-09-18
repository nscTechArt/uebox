/**
 * 拖进来的「路径」到底是不是一条磁盘上的真路径。
 *
 * 从 WinRAR / 7-Zip / 资源管理器自带的 ZIP 浏览里直接把里面的文件往外拖，拖过来的
 * 并不是磁盘上的文件。两种失败方式，第二种更坏：
 *
 *   1. **压缩包内的相对名**。WinRAR 递过来的是 `包名/子目录` 这么一截，不带盘符。
 *      拿它去 `fs.stat`，Node 会按**进程当前工作目录**去拼 —— 开发期指向仓库目录、
 *      打包后指向安装目录 —— 于是弹出一条用户完全看不懂的 ENOENT。
 *
 *   2. **临时解压目录里的真路径**。7-Zip 和资源管理器会先把文件解到 `%TEMP%` 再把
 *      路径给出来。这条路径 stat 得到、也导入得进去，然后系统把临时目录清掉，
 *      资产库里就留下一批指向不存在文件的死条目。第一种是吵闹的失败，
 *      这一种是**安静的失败**，用户可能几个月后才发现。
 *
 * 所以两种都要在入口拦掉，而不是等到底层报错。
 */

export type DroppedPathVerdict = 'ok' | 'not-absolute' | 'archive-temp'

/**
 * 是不是绝对路径：Windows 盘符（`C:\`、`C:/`）、UNC（`\\server\share`）、POSIX 根（`/x`）。
 *
 * 盘符后面必须跟分隔符。`C:foo` 是「C 盘当前目录下的 foo」，同样会被解析成一条
 * 我们没打算访问的路径，不能算绝对路径。
 */
export function isAbsoluteNativePath(filePath: string): boolean {
  if (!filePath) return false
  if (/^[a-zA-Z]:[\\/]/.test(filePath)) return true
  if (filePath.startsWith('\\\\')) return true
  return filePath.startsWith('/')
}

/**
 * 各家解压软件拖文件出来时用的临时目录名。
 *
 *   WinRAR       `Rar$DIa1234.5678`
 *   7-Zip        `7zO8C3A1B2F`
 *   资源管理器    `Temp1_素材包.zip`（同一个包再拖一次就是 Temp2_…）
 *   Bandizip     `BNZ.a1b2c3`
 *
 * 光看目录名会误伤 —— 谁都可以在自己硬盘上建一个叫 `7zBackup` 的文件夹。所以这些
 * 标记只在路径确实落在系统临时目录里时才作数，临时目录由主进程传进来。
 */
const EXTRACTOR_TEMP_SEGMENT = /^(rar\$[\w.$-]*|7z[\w.$-]+|temp\d+_.+|bnz\.[\w.$-]+)$/i

function toComparablePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase()
}

/**
 * 这条路径是不是解压软件临时解出来的。
 *
 * @param tempDir 系统临时目录。不传就只看目录名标记 —— 调用方拿不到临时目录时
 *                （比如纯单元测试）宁可判得严一点，也好过放一条会消失的路径进来。
 */
export function isExtractorTempPath(filePath: string, tempDir?: string): boolean {
  if (!filePath) return false

  const hasMarker = filePath.split(/[\\/]/).some((segment) => EXTRACTOR_TEMP_SEGMENT.test(segment))
  if (!hasMarker) return false
  if (!tempDir) return true

  const root = toComparablePath(tempDir).replace(/\/+$/, '')
  return root.length > 0 && toComparablePath(filePath).startsWith(`${root}/`)
}

/** 拖进来的一条路径能不能收。`ok` 之外的都该在入口挡掉，并告诉用户先解压。 */
export function classifyDroppedPath(filePath: string, tempDir?: string): DroppedPathVerdict {
  if (!isAbsoluteNativePath(filePath)) return 'not-absolute'
  if (isExtractorTempPath(filePath, tempDir)) return 'archive-temp'
  return 'ok'
}
