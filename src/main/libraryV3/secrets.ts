/**
 * 服务端资产库的凭据：成员的刷新令牌、或者粘贴进来的身份令牌。
 *
 * 与 AI 密钥库（src/main/ai/credentials.ts）同一套规矩：
 *
 * 1. 只存在 Electron safeStorage 加密的单独文件里（userData/catalog-library-secrets.bin），
 *    不进配置文件、不进数据库、不进 localStorage（AGENTS.md 硬规则 10）。
 * 2. 明文不进渲染层：IPC 只回"有没有登录"。
 * 3. safeStorage 不可用时**拒绝落盘**，不静默降级成明文 —— 刷新令牌泄露等于
 *    长期冒用这个美术的身份（设计 3.8：30 天滑动、90 天上限）。
 *
 * 身份令牌（15 分钟）只放内存；重启后用刷新令牌再换。
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export interface ServerSecret {
  /** password 模式：会轮换的刷新令牌 */
  refreshToken?: string
  /** token 模式：用户粘贴的身份令牌 */
  identityToken?: string
}

export interface SecretCodec {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super(
      'Secure storage (Electron safeStorage) is unavailable; refusing to write credentials in plain text'
    )
    this.name = 'SecretStorageUnavailableError'
  }
}

export class SecretStore {
  private cache: Record<string, ServerSecret> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly codec: SecretCodec
  ) {}

  private async load(): Promise<Record<string, ServerSecret>> {
    if (this.cache) return this.cache
    try {
      const bytes = await fs.readFile(this.path)
      this.cache = JSON.parse(this.codec.decrypt(bytes)) as Record<string, ServerSecret>
    } catch {
      // 文件不存在，或换了机器解不开：当作没登录，重新登录即可
      this.cache = {}
    }
    return this.cache
  }

  async get(serverId: string): Promise<ServerSecret | null> {
    const all = await this.load()
    return all[serverId] ?? null
  }

  async set(serverId: string, secret: ServerSecret | null): Promise<void> {
    if (secret && !this.codec.available()) throw new SecretStorageUnavailableError()
    const all = { ...(await this.load()) }
    if (secret) all[serverId] = secret
    else delete all[serverId]
    this.cache = all
    // 串行写，避免刷新令牌轮换和登出同时写把新令牌覆盖掉
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        if (Object.keys(all).length === 0) {
          await fs.rm(this.path, { force: true })
          return
        }
        if (!this.codec.available()) throw new SecretStorageUnavailableError()
        await fs.mkdir(dirname(this.path), { recursive: true })
        const temp = `${this.path}.tmp`
        await fs.writeFile(temp, this.codec.encrypt(JSON.stringify(all)))
        await fs.rename(temp, this.path)
      })
    await this.writing
  }
}
