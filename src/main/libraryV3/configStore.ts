/**
 * 用户添加了哪些服务器、哪些库 —— 一个普通 JSON 文件（userData/catalog-libraries.json）。
 *
 * 只放不敏感的东西（地址、固定的 CA、成员名、库 id）；令牌在 secrets.ts 的加密文件里。
 * 这份文件是"用户配置了什么"的唯一来源，删掉就是全部移除；库里的数据一行都不在本机。
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { CatalogLibraryRecord, CatalogServerRecord } from '../../shared/catalogLibrary'

export interface CatalogConfig {
  version: 1
  servers: CatalogServerRecord[]
  libraries: CatalogLibraryRecord[]
  /** 资产库页面上次选中的服务器库（null = 本地库）；只是界面偏好 */
  activeKey?: string | null
}

const EMPTY: CatalogConfig = { version: 1, servers: [], libraries: [] }

export class CatalogConfigStore {
  private cache: CatalogConfig | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async read(): Promise<CatalogConfig> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, 'utf8')) as Partial<CatalogConfig>
      this.cache = {
        version: 1,
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
        libraries: Array.isArray(parsed.libraries) ? parsed.libraries : [],
        activeKey: typeof parsed.activeKey === 'string' ? parsed.activeKey : null
      }
    } catch {
      this.cache = { ...EMPTY, servers: [], libraries: [] }
    }
    return this.cache
  }

  async update(mutate: (config: CatalogConfig) => void): Promise<CatalogConfig> {
    const current = await this.read()
    const next: CatalogConfig = {
      version: 1,
      servers: current.servers.map((server) => ({ ...server })),
      libraries: current.libraries.map((library) => ({ ...library })),
      activeKey: current.activeKey ?? null
    }
    mutate(next)
    this.cache = next
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dirname(this.path), { recursive: true })
        const temp = `${this.path}.tmp`
        await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        await fs.rename(temp, this.path)
      })
    await this.writing
    return next
  }
}
