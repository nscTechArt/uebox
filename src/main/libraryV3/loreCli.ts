/**
 * 随包的官方 lore.exe（Epic Games，MIT，版本见 resources/lore/lore-cli.json）。
 *
 * 导入 = 美术以本人身份提交推送；下载 / 拖进 UE = 在稀疏影子副本里按需物化。
 * 字节只走 Lore 自己的 QUIC/TLS 通道，目录服务不转一个字节（设计 2.4，ADR 0008）。
 *
 * 可执行文件不进 git（38 MB）：`node scripts/fetch-lore-cli.mjs` 按 lore-cli.json 里
 * 固定的 SHA-256 放到 resources/lore/<平台>/，打包时 electron-builder 的 extraResources
 * 把它带进安装包的 resources/lore/。运行时按下面的顺序找，并且**每次启动都核对哈希**：
 * 一份被换过的 lore.exe 会拿着美术的身份令牌推送，必须拒绝。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LorePin {
  version: string
  platforms: Record<string, { file: string; sha256: string }>
}

export interface LoreBinary {
  path: string
  version: string
  sha256: string
  /** 哈希与固定版本一致（UNREAL_BOX_LORE_PATH 指定的开发用二进制可以不一致，但会标出来） */
  pinned: boolean
}

export function platformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export function readPin(resourcesRoots: string[]): LorePin | null {
  for (const root of resourcesRoots) {
    const file = join(root, 'lore', 'lore-cli.json')
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as LorePin
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * 找 lore.exe。`resourcesRoots` 依次是：打包后的 process.resourcesPath、开发时仓库的 resources/。
 * 找不到回 null —— 浏览照常，导入和下载按钮给出原因。
 */
export async function resolveLoreBinary(options: {
  resourcesRoots: string[]
  envPath?: string | null
  platform?: string
}): Promise<{ binary: LoreBinary | null; problem: string | null }> {
  const pin = readPin(options.resourcesRoots)
  const key = options.platform ?? platformKey()
  const expected = pin?.platforms[key] ?? null
  const candidates: Array<{ path: string; fromEnv: boolean }> = []
  if (options.envPath) candidates.push({ path: options.envPath, fromEnv: true })
  if (expected) {
    for (const root of options.resourcesRoots) {
      candidates.push({ path: join(root, 'lore', expected.file), fromEnv: false })
      candidates.push({ path: join(root, 'lore', key, expected.file), fromEnv: false })
    }
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    const sha256 = await sha256File(candidate.path)
    const pinned = expected !== null && sha256 === expected.sha256
    if (!pinned && !candidate.fromEnv) {
      return {
        binary: null,
        problem: `lore.exe at ${candidate.path} does not match the pinned SHA-256 (${expected?.sha256 ?? 'none'})`
      }
    }
    return {
      binary: { path: candidate.path, version: pin?.version ?? 'unknown', sha256, pinned },
      problem: null
    }
  }
  return {
    binary: null,
    problem: expected
      ? 'lore.exe is not installed; run `node scripts/fetch-lore-cli.mjs` (development) or reinstall'
      : `No pinned lore CLI for ${key}`
  }
}

export interface LoreRunOptions {
  cwd: string
  identityToken: string
  /** 部署 CA 的 PEM 文件：Lore CLI 用 SSL_CERT_FILE 校验 lores:// 的证书 */
  caFile?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  /** 临时文件放哪（别让 lore 往 C: 盘的 TEMP 里写大文件） */
  tempDir?: string | null
}

export interface LoreResult {
  code: number
  stdout: string
  stderr: string
}

export class LoreCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly result: LoreResult
  ) {
    const tail = `${result.stderr}\n${result.stdout}`.trim().slice(-800)
    super(`lore ${args[0] ?? ''} failed (${result.code}): ${tail}`)
    this.name = 'LoreCommandError'
  }
}

/** 一次 lore 调用。身份令牌只放在参数里给子进程，不写日志 */
export async function runLore(
  binary: string,
  args: string[],
  options: LoreRunOptions
): Promise<LoreResult> {
  options.signal?.throwIfAborted()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.caFile) env.SSL_CERT_FILE = options.caFile
  if (options.tempDir) {
    env.TEMP = options.tempDir
    env.TMP = options.tempDir
  }
  const fullArgs = [
    ...args,
    '--non-interactive',
    '--no-pager',
    '--identity-token',
    options.identityToken
  ]
  return await new Promise<LoreResult>((resolve, reject) => {
    const child = spawn(binary, fullArgs, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString('utf8')).slice(-64_000)
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString('utf8')).slice(-64_000)
    })
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => child.kill(), options.timeoutMs)
        : null
    const onAbort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const scrub = (text: string): string => text.split(options.identityToken).join('<token>')
      resolve({ code: code ?? -1, stdout: scrub(stdout), stderr: scrub(stderr) })
    })
  })
}

export async function runLoreChecked(
  binary: string,
  args: string[],
  options: LoreRunOptions
): Promise<LoreResult> {
  const result = await runLore(binary, args, options)
  if (result.code !== 0) throw new LoreCommandError(args, result)
  return result
}

/** 断线类的错误值得重试一两次（F-001 的脚本也这么做） */
export function isTransientLoreFailure(result: LoreResult): boolean {
  return /Disconnected from server|transport error|Connection to lores?:\/\/[^ ]+ failed|timed out/i.test(
    `${result.stdout}\n${result.stderr}`
  )
}
