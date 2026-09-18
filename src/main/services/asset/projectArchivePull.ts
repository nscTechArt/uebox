/**
 * projectArchivePull — 把服务器上的工程整包下到本地，zip 顺手解开。
 *
 * 和 projectArchiveUpload 配对：那边把工程打成一个文件送上去，这边把它取回来。
 * 下载走服务端现成的 `GET /api/vaults/:vaultId/files/<相对路径>`，先写 `.part` 再改名，
 * 半截文件不会冒充完整包；zip 解开并逐条校验 CRC 后删掉压缩包，磁盘只占一份。
 * rar / 7z 只下载不解 —— 盒子里没有对应的解包器，用户自己的工具解更靠谱。
 */
import * as http from 'http'
import * as https from 'https'
import * as nodeFs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { extractZip } from './zipExtract'

export type ProjectArchivePullStage = 'download' | 'extract'

export interface ProjectArchivePullParams {
  /** 完整下载地址（含服务器与库 id） */
  fileUrl: string
  headers?: Record<string, string>
  /** 落地文件名 */
  fileName: string
  /** 目标目录；zip 解开后工程目录出现在它下面 */
  destDir: string
  onStage?: (stage: ProjectArchivePullStage, progress: number, total: number) => void
  /** 0–100 的总进度：要解压时下载占前一半 */
  onPercent?: (percent: number) => void
}

export interface ProjectArchivePullResult {
  /** 解开后的工程目录；没解（rar/7z）时是压缩包本身 */
  localPath: string
  extracted: boolean
  fileCount: number
  archiveBytes: number
  downloadMs: number
  extractMs: number
  /** 下载速率，MB/s（十进制兆） */
  mbPerSec: number
}

/** 空闲超时：多久没有一个字节流动才算断，不是总时长 */
export const PULL_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const PROGRESS_THROTTLE_MS = 500

export function encodeRemotePath(remotePath: string): string {
  return remotePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function buildVaultFileUrl(
  serverUrl: string,
  remoteVaultId: string,
  remotePath: string
): string {
  return `${serverUrl}/api/vaults/${encodeURIComponent(remoteVaultId)}/files/${encodeRemotePath(remotePath)}`
}

/**
 * 下载到 targetPath，返回收到的字节数。服务器给了 Content-Length 就按它核对，
 * 少一个字节都算失败 —— 半截 zip 解不开，半截 rar 更是坑同事。
 */
export function downloadArchive(
  fileUrl: string,
  headers: Record<string, string>,
  targetPath: string,
  onBytes: (received: number, total: number | null) => void,
  idleTimeoutMs = PULL_IDLE_TIMEOUT_MS
): Promise<number> {
  const client = fileUrl.startsWith('https') ? https : http
  return new Promise<number>((resolve, reject) => {
    const req = client.get(fileUrl, { timeout: idleTimeoutMs, headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      const totalHeader = Number(res.headers['content-length'])
      const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null
      let received = 0
      let lastReport = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        const now = Date.now()
        if (now - lastReport >= PROGRESS_THROTTLE_MS) {
          lastReport = now
          onBytes(received, total)
        }
      })
      const sink = nodeFs.createWriteStream(targetPath)
      const incomplete = (): Error =>
        new Error(`下载不完整: 收到 ${received} 字节，服务器声明 ${total}`)
      pipeline(res, sink)
        .then(() => {
          if (total !== null && received !== total) {
            reject(incomplete())
            return
          }
          onBytes(received, total ?? received)
          resolve(received)
        })
        .catch((err: Error) => {
          // 连接中途断掉时 Node 报的是笼统的 aborted；字节数对不上就说清楚少了多少
          reject(total !== null && received !== total ? incomplete() : err)
        })
    })
    req.on('error', (err) => reject(new Error(`下载网络错误: ${err.message}`)))
    req.on('timeout', () => {
      req.destroy(new Error(`下载超时：${Math.round(idleTimeoutMs / 60000)} 分钟没有收到数据`))
    })
  })
}

export async function pullProjectArchive(
  params: ProjectArchivePullParams
): Promise<ProjectArchivePullResult> {
  const fileName = path.basename(params.fileName)
  if (!fileName || !params.destDir || !params.fileUrl) {
    throw new Error('取回参数不完整')
  }
  const destDir = params.destDir
  const partPath = path.join(destDir, `${fileName}.part`)
  const archivePath = path.join(destDir, fileName)
  const willExtract = path.extname(fileName).toLowerCase() === '.zip'
  const downloadShare = willExtract ? 50 : 100

  await fsp.mkdir(destDir, { recursive: true })
  try {
    params.onStage?.('download', 0, 1)
    const downloadStartedAt = Date.now()
    const archiveBytes = await downloadArchive(
      params.fileUrl,
      params.headers ?? {},
      partPath,
      (received, total) => {
        const ratio = total ? received / total : 0
        params.onPercent?.(Math.min(downloadShare, Math.floor(ratio * downloadShare)))
        params.onStage?.(
          'download',
          Math.floor(received / 1e6),
          Math.max(1, Math.ceil((total ?? received) / 1e6))
        )
      }
    )
    const downloadMs = Date.now() - downloadStartedAt
    await fsp.rename(partPath, archivePath)

    let extracted = false
    let fileCount = 1
    let localPath = archivePath
    let extractMs = 0
    if (willExtract) {
      params.onStage?.('extract', 0, 1)
      const extractStartedAt = Date.now()
      const result = await extractZip(archivePath, destDir, {
        onProgress: (p) => {
          const ratio = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : 1
          params.onPercent?.(Math.min(100, 50 + Math.floor(ratio * 50)))
          params.onStage?.('extract', p.entriesDone, Math.max(1, p.entriesTotal))
        }
      })
      extractMs = Date.now() - extractStartedAt
      extracted = true
      fileCount = result.fileCount
      localPath =
        result.topLevelDirs.length === 1 ? path.join(destDir, result.topLevelDirs[0]) : destDir
      // 解开并逐条校验过了，压缩包本身就没用了；留着等于再占一份磁盘
      await fsp.unlink(archivePath).catch(() => undefined)
    }

    params.onPercent?.(100)
    const mbPerSec =
      downloadMs > 0 ? Math.round((archiveBytes / 1e6 / (downloadMs / 1000)) * 10) / 10 : 0
    console.log(
      `[ProjectArchivePull] done archive="${fileName}" bytes=${archiveBytes} downloadMs=${downloadMs} ` +
        `rate=${mbPerSec}MB/s extracted=${extracted} files=${fileCount} extractMs=${extractMs} -> ${localPath}`
    )
    return { localPath, extracted, fileCount, archiveBytes, downloadMs, extractMs, mbPerSec }
  } catch (error) {
    // 只清没下完的 .part。已经改好名的整包**故意留着**：走到这一步说明字节数已经
    // 核对通过，失败多半出在解压（目标盘满了、权限不对、遇到不认识的压缩方式），
    // 包本身往往是好的 —— 删掉就等于逼用户把几十个 G 重下一遍，让他用 7-Zip 自己解更划算。
    // 解到一半的文件由 extractZip 自己回滚，不会留下半个工程。
    await fsp.unlink(partPath).catch(() => undefined)
    throw error
  }
}
