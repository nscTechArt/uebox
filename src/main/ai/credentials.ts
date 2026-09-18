import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { app, safeStorage } from 'electron'
import type { ApiKeyRef } from './types'
import { isExpired, refreshOAuthTokens, type OAuthTokens } from './oauth'

/**
 * 密钥库。
 *
 * 三条硬规则：
 *
 * 1. **明文密钥不进 `models.json`**。那个文件用户会直接编辑、可能贴进 issue、
 *    可能被同步工具带走。它只存一个 id，密文在本模块管的单独文件里。
 * 2. **明文密钥不进渲染层**。IPC 只回 `hasKey: boolean`；要用密钥的地方
 *    （构造 provider）本来就在主进程。
 * 3. **safeStorage 不可用时拒绝落盘**，不静默降级成明文 —— 那等于骗用户。
 *    这种机器上引导用户改用环境变量。
 *
 */

const SECRETS_FILE = 'ai-provider-secrets.bin'

type SecretMap = Record<string, string>

let cache: SecretMap | null = null

function secretsPath(): string {
  return join(app.getPath('userData'), SECRETS_FILE)
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      '当前系统未提供安全存储（Electron safeStorage 不可用），拒绝把 API Key 明文写入磁盘。请改用环境变量方式配置密钥。'
    )
    this.name = 'EncryptionUnavailableError'
  }
}

async function loadSecrets(): Promise<SecretMap> {
  if (cache) return cache

  const path = secretsPath()
  if (!existsSync(path)) {
    cache = {}
    return cache
  }

  try {
    const bytes = await fs.readFile(path)
    // 写入时必然加密过（不可用时我们直接拒绝写），所以这里也必须解密。
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(bytes)
      : bytes.toString('utf-8')
    cache = JSON.parse(raw) as SecretMap
  } catch (error) {
    // 换机器、重装系统后密文解不开是正常现象，不该让整个 AI 配置读不出来。
    console.warn('[AI 密钥库] 读取失败，按空库处理:', error)
    cache = {}
  }
  return cache
}

async function persist(secrets: SecretMap): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError()
  }
  const path = secretsPath()
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, safeStorage.encryptString(JSON.stringify(secrets)))
  cache = secrets
}

/** 写入一个字面量密钥，返回可以放进 models.json 的引用 */
export async function saveLiteralKey(id: string, apiKey: string): Promise<ApiKeyRef> {
  const secrets = { ...(await loadSecrets()) }
  secrets[id] = apiKey
  await persist(secrets)
  return { kind: 'literal', id }
}

export async function deleteLiteralKey(id: string): Promise<void> {
  const secrets = { ...(await loadSecrets()) }
  if (!(id in secrets)) return
  delete secrets[id]
  await persist(secrets)
}

/**
 * 存一份账号登录换来的令牌。
 *
 * 复用同一个加密文件，值是 JSON 序列化后的 OAuthTokens —— 与明文密钥同等
 * 保护级别（refreshToken 泄漏等同于长期冒用账号，甚至比一把 API Key 更严重）。
 */
export async function saveOAuthTokens(
  id: string,
  provider: string,
  tokens: OAuthTokens
): Promise<ApiKeyRef> {
  const secrets = { ...(await loadSecrets()) }
  secrets[id] = JSON.stringify(tokens)
  await persist(secrets)
  return { kind: 'oauth', provider, id }
}

async function loadOAuthTokens(id: string): Promise<OAuthTokens | null> {
  const secrets = await loadSecrets()
  const raw = secrets[id]
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthTokens
  } catch {
    return null
  }
}

export class MissingApiKeyError extends Error {
  constructor(
    message: string,
    /** 缺的是哪个环境变量。界面据此给出精确提示 */
    readonly envVar?: string
  ) {
    super(message)
    this.name = 'MissingApiKeyError'
  }
}

/** 取密钥的命令最多跑多久。1Password 之类可能要弹生物识别，给宽一点 */
const SHELL_TIMEOUT_MS = 30_000

/**
 * 命令取到的密钥在进程内缓存多久。
 *
 * 不缓存的话每次构造 provider 都要 fork 一个进程 —— Agent 一轮几十次调用，
 * 每次都弹一下指纹解锁没法用。缓存又不能太长，否则轮换了密钥要重启才生效。
 */
const SHELL_CACHE_MS = 5 * 60 * 1000

const shellCache = new Map<string, { value: string; expiresAt: number }>()

/**
 * 执行命令取密钥。
 *
 * 安全边界：命令来自**本机的 models.json 或用户在设置里手输**，与 `.bashrc`、
 * git 的 credential helper 同级 —— 能写到这个文件的人本来就能在这台机器上
 * 执行任意命令。绝不要让远端内容（模型输出、网页、导入的配置）流到这里。
 *
 * 用 shell 执行是有意的：用户需要写管道和重定向（`op read ... | tr -d '\\n'`）。
 * 因此**不做转义**，也就更要守住上面那条来源约束。
 */
async function runShellCommand(command: string): Promise<string> {
  const cached = shellCache.get(command)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = await new Promise<string>((resolveExec, rejectExec) => {
    // Windows 用 cmd.exe，其余用 /bin/sh —— execFile + shell 参数而不是 exec，
    // 免得再套一层解析
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command]

    execFile(
      shell,
      args,
      { timeout: SHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // stderr 可能带密钥片段，截断并且只在错误时露出，不进日志
          const detail = String(stderr || error.message)
            .trim()
            .slice(0, 200)
          rejectExec(new MissingApiKeyError(`取密钥的命令执行失败：${detail}`))
          return
        }
        resolveExec(String(stdout).trim())
      }
    )
  })

  if (!value) {
    throw new MissingApiKeyError('取密钥的命令执行成功但没有输出')
  }

  shellCache.set(command, { value, expiresAt: Date.now() + SHELL_CACHE_MS })
  return value
}

/**
 * 环境变量名的形状：全大写字母开头，只含大写字母、数字、下划线。
 *
 * 真实密钥不会长这样（`sk-` 开头、含小写和连字符），所以这条判据不会误伤。
 */
const ENV_VAR_SHAPE = /^[A-Z][A-Z0-9_]*$/

/**
 * 把用户在**单个输入框**里填的东西解析成密钥来源。
 *
 * 三种形态共用一个框（与 pi-web 一致），靠形状区分：
 *   `!op read op://...`  → 执行命令取
 *   `OPENAI_API_KEY`     → 读环境变量
 *   `sk-proj-...`        → 就是密钥本身
 *
 * 返回 null 表示输入为空，调用方据此决定「沿用原值」还是「置空」。
 */
export function parseApiKeyInput(
  raw: string
):
  | { kind: 'shell'; command: string }
  | { kind: 'env'; name: string }
  | { kind: 'literal'; value: string }
  | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim()
    return command ? { kind: 'shell', command } : null
  }

  if (ENV_VAR_SHAPE.test(trimmed)) {
    return { kind: 'env', name: trimmed }
  }

  return { kind: 'literal', value: trimmed }
}

/** 仅供测试：清掉命令取密钥的缓存 */
export function resetShellCacheForTest(): void {
  shellCache.clear()
}

/**
 * 把密钥引用解析成真正的密钥。
 *
 * 返回空串表示「这个 provider 不需要密钥」（本机推理），
 * 而不是「密钥缺失」—— 后者会抛错。
 */
export async function resolveApiKey(ref: ApiKeyRef): Promise<string> {
  if (ref.kind === 'none') return ''

  if (ref.kind === 'env') {
    const value = String(process.env[ref.name] || '').trim()
    if (!value) {
      throw new MissingApiKeyError(`环境变量 ${ref.name} 未设置或为空`, ref.name)
    }
    return value
  }

  if (ref.kind === 'shell') {
    return runShellCommand(ref.command)
  }

  if (ref.kind === 'oauth') {
    const tokens = await loadOAuthTokens(ref.id)
    if (!tokens) {
      throw new MissingApiKeyError('登录信息不存在，请重新登录该账号')
    }
    if (!isExpired(tokens)) return tokens.accessToken

    // 过期了就续期并写回，否则每次调用都要续一遍
    const refreshed = await refreshOAuthTokens(ref.provider, tokens)
    const secrets = { ...(await loadSecrets()) }
    secrets[ref.id] = JSON.stringify(refreshed)
    await persist(secrets)
    return refreshed.accessToken
  }

  const secrets = await loadSecrets()
  const value = String(secrets[ref.id] || '').trim()
  if (!value) {
    throw new MissingApiKeyError('密钥不存在，可能是换了机器导致密文无法解开，请重新填写')
  }
  return value
}

/**
 * 密钥是否可用。供界面显示状态，不返回密钥本身。
 *
 * shell 这一档**不执行命令** —— 界面每次打开都跑一遍用户的取密钥命令，
 * 等于点一下设置就弹一次指纹解锁，而且 1Password 那类工具还会记一次审计。
 * 配了命令就当作「已配置」，真正能不能取到留给首次调用时报错。
 */
export async function hasApiKey(ref: ApiKeyRef): Promise<boolean> {
  if (ref.kind === 'shell') return Boolean(ref.command.trim())

  // oauth 同理不执行续期：界面每次打开都续一次会平白消耗刷新令牌，
  // 也可能因为网络问题把「已登录」显示成「未登录」。存着令牌就算已配置。
  if (ref.kind === 'oauth') return (await loadOAuthTokens(ref.id)) !== null

  try {
    await resolveApiKey(ref)
    return true
  } catch {
    return false
  }
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** 仅供测试：清掉进程内缓存 */
export function resetSecretsCacheForTest(): void {
  cache = null
}
