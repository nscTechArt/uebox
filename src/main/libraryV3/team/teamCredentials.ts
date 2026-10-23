/**
 * 把这台电脑上的团队登录交给 UE 插件（契约 2.5「UE 怎么拿到身份」）。
 *
 * 插件（ubas-vcs 的 LoreSourceControl，LoreTeamService.cpp）每次用前读
 * `%LOCALAPPDATA%\UnrealBox\team\*.json`（或环境变量 UNREALBOX_TEAM_DIR 指的目录），形状：
 *
 *   { "member": "<成员面地址>", "tokenDpapi": "<base64>" }   // 也认 identityToken / token（明文）
 *
 * `member` 是成员面的地址（插件拿它当请求的基地址），不是账号名。令牌用当前用户的 DPAPI 保护
 * （CryptProtectData，无附加熵），插件用 CryptUnprotectData 解；读不到就是「这台电脑还没登录」。
 *
 * 写进去的是 `POST /v1/auth/cli-token` 领的长令牌（最长 30 天）：插件不用跟着盒子十几分钟换一次，
 * 盒子在剩不到五分之一寿命时重领。离开团队（从列表移除最后一个库）时删掉。
 *
 * DPAPI 走系统自带的 PowerShell（不加原生依赖）；令牌只经环境变量交给子进程，不上命令行。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface TeamCredentialFile {
  member: string
  tokenDpapi?: string
  identityToken?: string
  /** 令牌过期时刻（秒，照服务端） */
  expires: number | null
  /** 账号名（插件不读，给人排查用） */
  account: string | null
  writtenAt: number
}

export function teamCredentialDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.UNREALBOX_TEAM_DIR) return env.UNREALBOX_TEAM_DIR
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'UnrealBox', 'team')
  if (env.HOME) return join(env.HOME, '.unrealbox', 'team')
  return null
}

/** 一台服务器一个文件：`127.0.0.1_47484.json` */
export function credentialFileName(memberUrl: string): string {
  const url = new URL(memberUrl)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${url.hostname.replace(/[^A-Za-z0-9.-]/g, '_')}_${port}.json`
}

/** 剩不到五分之一寿命（或不知道寿命）就该重领 */
export function needsRenewal(
  file: Pick<TeamCredentialFile, 'expires' | 'writtenAt'> | null,
  nowMs: number
): boolean {
  if (!file || !file.expires) return true
  const expiresMs = file.expires * 1000
  const lifetime = expiresMs - file.writtenAt
  if (lifetime <= 0) return true
  return nowMs >= expiresMs - lifetime / 5
}

const PROTECT_SCRIPT =
  'Add-Type -AssemblyName System.Security; ' +
  '$b=[Text.Encoding]::UTF8.GetBytes($env:UEBOX_TEAM_TOKEN); ' +
  '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,' +
  '[Security.Cryptography.DataProtectionScope]::CurrentUser))'

/** Windows：当前用户的 DPAPI；拿不到回 null（调用方退回明文，Windows 以外本来就没有 DPAPI） */
export async function protectForCurrentUser(token: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  return await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROTECT_SCRIPT],
      { env: { ...process.env, UEBOX_TEAM_TOKEN: token }, windowsHide: true }
    )
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      const value = out.trim()
      resolve(code === 0 && /^[A-Za-z0-9+/=]+$/.test(value) ? value : null)
    })
  })
}

export async function readTeamCredential(
  memberUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<TeamCredentialFile | null> {
  const dir = teamCredentialDir(env)
  if (!dir) return null
  try {
    return JSON.parse(
      await fs.readFile(join(dir, credentialFileName(memberUrl)), 'utf8')
    ) as TeamCredentialFile
  } catch {
    return null
  }
}

export async function writeTeamCredential(
  input: {
    memberUrl: string
    account: string | null
    identityToken: string
    expires: number | null
  },
  options: {
    env?: NodeJS.ProcessEnv
    protect?: (token: string) => Promise<string | null>
    now?: () => number
  } = {}
): Promise<string | null> {
  const dir = teamCredentialDir(options.env)
  if (!dir) return null
  const protectedToken = await (options.protect ?? protectForCurrentUser)(input.identityToken)
  const file: TeamCredentialFile = {
    member: input.memberUrl.replace(/\/+$/, ''),
    ...(protectedToken ? { tokenDpapi: protectedToken } : { identityToken: input.identityToken }),
    expires: input.expires,
    account: input.account,
    writtenAt: (options.now ?? Date.now)()
  }
  await fs.mkdir(dir, { recursive: true })
  const target = join(dir, credentialFileName(input.memberUrl))
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, target)
  return target
}

export async function removeTeamCredential(
  memberUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const dir = teamCredentialDir(env)
  if (!dir) return
  await fs.rm(join(dir, credentialFileName(memberUrl)), { force: true })
}
