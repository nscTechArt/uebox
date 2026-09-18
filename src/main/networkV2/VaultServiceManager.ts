/**
 * VaultServiceManager — V2 网络保管库生命周期管理
 *
 * 根据当前角色（Server / Client）管理 AssetServer / SyncClient 的生命周期：
 * - Server 模式：启动 AssetServer，注册 Vault，写入 .vault 发现文件
 * - Client 模式：读取 .vault，创建 SyncClient 连接到 Server
 *
 * 作为单例使用，由 VaultManager 在切换保管库时调用。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { AssetServer } from './AssetServer'
import { SyncClient } from './SyncClient'
import type { SyncClientConfig } from './SyncClient'
import type { VaultDiscovery, ServerConfig } from './SyncProtocol'
import { PROTOCOL_VERSION, VAULT_DISCOVERY_FILE } from './SyncProtocol'
import type { VaultAccessKeys } from './ServerAuth'
import { rememberVaultAccessKey } from './vaultAccessKeys'

/** 启动 Server 时要用的访问码，以及是否把写码也分发到共享目录 */
export interface VaultServerAccess {
  keys: VaultAccessKeys
  /** 勾选后，能访问这个共享文件夹的电脑自动获得写权限（不用手动填码） */
  publishWriteKeyToShare?: boolean
}

// ─────────────────────────── 类型 ───────────────────────────

export type VaultRole = 'server' | 'client' | 'none'

export interface NetworkVaultState {
  role: VaultRole
  /** 本地 vaultId（= UI 的 currentVault.id），也是 activeVaults / syncClients 的 key */
  vaultId: string
  /**
   * 远端 vaultId。Client 模式下与 `vaultId` **不是同一个值**。
   *
   * 访问码表按 (serverUrl, 远端 vaultId) 索引，早先这里没有这个字段，
   * 调用方只能拿本地 vaultId 去查 —— 一律查不到，于是权限探测 401、
   * 界面把共享写权限显示成只读。
   */
  remoteVaultId?: string
  name: string
  networkPath: string
  port: number
  serverHost?: string
  /** http 或 https，用于权限查询等场景拼接完整 URL */
  serverScheme?: string
  connected: boolean
}

/** 由状态拼出远端服务器地址（http://host:port）。缺 host/port 时返回 undefined */
export function serverUrlOfState(state?: NetworkVaultState | null): string | undefined {
  if (!state?.serverHost || !state.port) return undefined
  return `${state.serverScheme || 'http'}://${state.serverHost}:${state.port}`
}

// ─────────────────────────── 管理器 ───────────────────────────

export class VaultServiceManager {
  private static instance: VaultServiceManager | null = null

  private assetServer: AssetServer | null = null
  private syncClients: Map<string, SyncClient> = new Map()
  private activeVaults: Map<string, NetworkVaultState> = new Map()

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): VaultServiceManager {
    if (!VaultServiceManager.instance) {
      VaultServiceManager.instance = new VaultServiceManager()
    }
    return VaultServiceManager.instance
  }

  // ─────────────────────────── Server 模式 ───────────────────────────

  async startServer(
    vaultId: string,
    name: string,
    networkPath: string,
    db: Database.Database,
    access: VaultServerAccess,
    config?: Partial<ServerConfig>
  ): Promise<NetworkVaultState> {
    if (!this.assetServer) {
      this.assetServer = new AssetServer(config)
    }

    this.assetServer.registerVault(vaultId, name, networkPath, db, access.keys)

    let port = this.assetServer.port
    if (!this.assetServer.isRunning) {
      port = await this.assetServer.start()
    }

    await this.writeDiscoveryFile(networkPath, vaultId, name, port, access)

    const state: NetworkVaultState = {
      role: 'server',
      vaultId,
      name,
      networkPath,
      port,
      connected: true
    }
    this.activeVaults.set(vaultId, state)

    console.log(`[VaultServiceManager] Server 模式已启动: ${name} on :${port}`)
    return state
  }

  async stopServer(vaultId: string): Promise<void> {
    if (this.assetServer) {
      // 先移除 .vault 发现文件
      const state = this.activeVaults.get(vaultId)
      if (state) {
        this.removeDiscoveryFile(state.networkPath)
      }

      this.assetServer.unregisterVault(vaultId)
      this.activeVaults.delete(vaultId)

      // 检查是否还有其他 server-role vault 在用这个 AssetServer
      const hasOtherServerVaults = Array.from(this.activeVaults.values()).some(
        (s) => s.role === 'server'
      )
      if (!hasOtherServerVaults) {
        await this.assetServer.stop()
        this.assetServer = null
      }
    } else {
      this.activeVaults.delete(vaultId)
    }

    console.log(`[VaultServiceManager] Server Vault 已停止: ${vaultId}`)
  }

  // ─────────────────────────── Client 模式 ───────────────────────────

  async startClient(
    networkPath: string,
    localDb: Database.Database,
    localVaultId?: string
  ): Promise<NetworkVaultState> {
    const discovery = this.readDiscoveryFile(networkPath)
    if (!discovery) {
      throw new Error(`无法读取服务发现文件: ${path.join(networkPath, VAULT_DISCOVERY_FILE)}`)
    }

    if (discovery.protocolVersion > PROTOCOL_VERSION) {
      throw new Error(
        `服务器协议版本 (v${discovery.protocolVersion}) 高于客户端 (v${PROTOCOL_VERSION})，请升级到最新版本`
      )
    }

    const clientId = this.getClientId()
    const hostname = os.hostname()
    const serverUrl = `http://${discovery.server}:${discovery.port}`

    // 优先用写码（拿到写码说明主机开放了写入），否则用只读码
    const accessKey = discovery.writeKey || discovery.readKey
    if (discovery.authRequired && !accessKey) {
      throw new Error(
        '该资产库要求访问码，但共享目录内没有提供。请向主机索取配对码，在资产库设置里填写。'
      )
    }

    const clientConfig: SyncClientConfig = {
      serverUrl,
      vaultId: discovery.vaultId,
      clientId,
      hostname,
      apiKey: accessKey
    }

    // 让主进程里所有绕过 SyncClient 的直连调用点（缩略图、导入下载、
    // uebox-asset 代理）也能拿到同一把码
    rememberVaultAccessKey(serverUrl, discovery.vaultId, accessKey)

    // 防止重复创建：先停掉已有的 SyncClient（避免双 WS → 服务端踢旧连接 → 重连循环）
    const mapKey = localVaultId || discovery.vaultId
    const existingClient = this.syncClients.get(mapKey)
    if (existingClient) {
      console.log(`[VaultServiceManager] 已有 Client (${mapKey})，先停止旧连接`)
      existingClient.removeAllListeners() // 解绑所有事件，防止迟到的 status 事件覆盖新客户端状态
      existingClient.stop()
      this.syncClients.delete(mapKey)
    }

    const syncClient = new SyncClient(localDb, clientConfig)

    // 使用本地 vaultId 作为 activeVaults/syncClients 的 key
    // 这样前端用 currentVault.id 查询时才能匹配到

    syncClient.on('status', (status: string) => {
      const st = this.activeVaults.get(mapKey)
      if (st) {
        st.connected = status === 'connected'
      }
    })

    // 先注册 Client 和 State，让 UI 立即显示
    this.syncClients.set(mapKey, syncClient)

    const state: NetworkVaultState = {
      role: 'client',
      vaultId: mapKey,
      remoteVaultId: discovery.vaultId,
      name: discovery.name,
      networkPath,
      port: discovery.port,
      serverHost: discovery.server,
      serverScheme: 'http',
      connected: false
    }
    this.activeVaults.set(mapKey, state)

    console.log(
      `[VaultServiceManager] Client 模式已注册: ${discovery.name} → ${serverUrl} (localId: ${mapKey})`
    )

    // 后台启动同步，不阻塞 UI 渲染
    syncClient.start().catch((err) => {
      console.warn(`[VaultServiceManager] 后台同步失败: ${err.message}`)
    })

    return state
  }

  /**
   * 直连资产服务器模式 — 不依赖 .vault 发现文件
   * 通过 serverUrl + remoteVaultId 直接启动 SyncClient
   *
   * @param serverUrl       完整 HTTP 地址，如 "http://192.168.1.100:18900"
   * @param remoteVaultId   远端 vault 的 ID
   * @param name            vault 显示名称
   * @param localDb         本地 SQLite 数据库
   * @param localVaultId    本地 vault ID（用于 UI 状态关联）
   */
  async startClientDirect(
    serverUrl: string,
    remoteVaultId: string,
    name: string,
    localDb: Database.Database,
    localVaultId: string,
    options?: {
      apiOnly?: boolean
      apiKey?: string
    }
  ): Promise<NetworkVaultState> {
    const normalizedUrl = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
    const apiOnly = options?.apiOnly ?? false

    // 让主进程里绕过 SyncClient 的直连调用点（缩略图、导入下载、
    // uebox-asset 代理）也能拿到同一把码
    rememberVaultAccessKey(normalizedUrl, remoteVaultId, options?.apiKey)

    const clientId = this.getClientId()
    const hostnameStr = os.hostname()

    const clientConfig: SyncClientConfig = {
      serverUrl: normalizedUrl,
      vaultId: remoteVaultId,
      clientId,
      hostname: hostnameStr,
      apiKey: options?.apiKey
    }

    // 使用本地 vaultId 作为 key，保持与 UI currentVault.id 一致
    const mapKey = localVaultId

    // 防止重复创建：先停掉已有的 SyncClient（避免双 WS → 服务端踢旧连接 → 重连循环）
    const existingClient = this.syncClients.get(mapKey)
    if (existingClient) {
      console.log(`[VaultServiceManager] 已有 Client (${mapKey})，先停止旧连接`)
      existingClient.removeAllListeners() // 解绑所有事件，防止迟到的 status 事件覆盖新客户端状态
      existingClient.stop()
      this.syncClients.delete(mapKey)
    }

    const syncClient = new SyncClient(localDb, clientConfig)

    syncClient.on('status', (status: string) => {
      const st = this.activeVaults.get(mapKey)
      if (st) {
        st.connected = status === 'connected'
      }
    })

    this.syncClients.set(mapKey, syncClient)

    // 解析 host:port
    let serverHost = normalizedUrl
    let port = 18900
    let serverScheme = 'http'
    try {
      const parsed = new URL(normalizedUrl)
      serverHost = parsed.hostname
      port = parseInt(parsed.port, 10) || 18900
      serverScheme = parsed.protocol.replace(':', '')
    } catch {
      /* 保持默认值 */
    }

    const state: NetworkVaultState = {
      role: 'client',
      vaultId: mapKey,
      remoteVaultId,
      name,
      networkPath: '', // 资产服务器直连模式无本地网络路径
      port,
      serverHost,
      serverScheme,
      connected: false
    }
    this.activeVaults.set(mapKey, state)

    if (apiOnly) {
      // API-Only 模式：仅通过 HTTP 拉取数据，不建立 WebSocket 长连接
      // SyncClient 仍然注册在 syncClients 中，用于 IPC 写操作代理（HTTP）
      console.log(
        `[VaultServiceManager] 资产服务器 API 模式已注册: ${name} → ${normalizedUrl} (localId: ${mapKey})`
      )
      syncClient
        .pullChanges()
        .then(() => {
          state.connected = true
          console.log(`[VaultServiceManager] 资产服务器数据拉取完成: ${name}`)
        })
        .catch((err) => {
          console.warn(`[VaultServiceManager] 资产服务器数据拉取失败: ${err.message}`)
        })
    } else {
      // 完整模式：HTTP 同步 + WebSocket 实时推送
      console.log(
        `[VaultServiceManager] 资产服务器直连模式已注册: ${name} → ${normalizedUrl} (localId: ${mapKey})`
      )
      syncClient.start().catch((err) => {
        console.warn(`[VaultServiceManager] 资产服务器直连后台同步失败: ${err.message}`)
      })
    }

    return state
  }

  stopClient(vaultId: string): void {
    const client = this.syncClients.get(vaultId)
    if (client) {
      client.stop()
      this.syncClients.delete(vaultId)
    }
    this.activeVaults.delete(vaultId)
    console.log(`[VaultServiceManager] Client 已断开: ${vaultId}`)
  }

  // ─────────────────────────── 查询 ───────────────────────────

  getClient(vaultId: string): SyncClient | undefined {
    return this.syncClients.get(vaultId)
  }

  getAllStates(): NetworkVaultState[] {
    return Array.from(this.activeVaults.values())
  }

  getRole(vaultId: string): VaultRole {
    return this.activeVaults.get(vaultId)?.role || 'none'
  }

  getServer(): AssetServer | null {
    return this.assetServer
  }

  // ─────────────────────────── 关闭全部 ───────────────────────────

  async shutdown(): Promise<void> {
    Array.from(this.syncClients.keys()).forEach((vaultId) => {
      this.stopClient(vaultId)
    })

    if (this.assetServer) {
      // 先收集所有 server vault 的路径用于清理 .vault 文件
      // （因为 stop() 会 clear vaults map）
      const serverPaths: string[] = []
      this.activeVaults.forEach((state) => {
        if (state.role === 'server') {
          serverPaths.push(state.networkPath)
        }
      })
      for (const p of serverPaths) {
        this.removeDiscoveryFile(p)
      }

      await this.assetServer.stop()
      this.assetServer = null
    }

    this.activeVaults.clear()
    console.log('[VaultServiceManager] 已关闭全部服务')
  }

  // ─────────────────────────── 工具 ───────────────────────────

  private async writeDiscoveryFile(
    networkPath: string,
    vaultId: string,
    name: string,
    port: number,
    access: VaultServerAccess
  ): Promise<void> {
    const discovery: VaultDiscovery = {
      protocolVersion: PROTOCOL_VERSION,
      server: this.getLocalIP(),
      port,
      vaultId,
      name,
      updatedAt: Date.now(),
      authRequired: true,
      // 只读码随共享目录分发 —— 能读到这个目录的人今天本来就能读到全部资产，
      // 所以这不降低安全性，却让老部署升级后**零操作**继续工作。
      readKey: access.keys.readKey,
      // 写码只有主机显式勾选「允许共享目录里的同事写入」才下发
      ...(access.publishWriteKeyToShare && access.keys.writeKey
        ? { writeKey: access.keys.writeKey }
        : {})
    }
    const filePath = path.join(networkPath, VAULT_DISCOVERY_FILE)
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(discovery, null, 2), 'utf-8')
      // .vault 里现在有凭据，尽量收紧权限（Windows 上 chmod 基本是 no-op，
      // 共享目录的 ACL 才是真正的门，这里只是 POSIX 侧的补充）
      await fs.promises.chmod(filePath, 0o600).catch(() => undefined)
    } catch (err) {
      console.warn('[VaultServiceManager] 写入发现文件失败（不影响服务启动）:', err)
    }
  }

  /** 轮换访问码 / 切换共享写权限后刷新 .vault */
  async refreshDiscoveryFile(vaultId: string, access: VaultServerAccess): Promise<void> {
    const state = this.activeVaults.get(vaultId)
    if (!state || state.role !== 'server' || !state.networkPath) return
    await this.writeDiscoveryFile(state.networkPath, vaultId, state.name, state.port ?? 0, access)
  }

  private readDiscoveryFile(networkPath: string): VaultDiscovery | null {
    const filePath = path.join(networkPath, VAULT_DISCOVERY_FILE)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private removeDiscoveryFile(networkPath: string): void {
    const filePath = path.join(networkPath, VAULT_DISCOVERY_FILE)
    try {
      fs.unlinkSync(filePath)
    } catch {
      // 忽略
    }
  }

  private getLocalIP(): string {
    const interfaces = os.networkInterfaces()
    const allIPs: string[] = []
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          allIPs.push(iface.address)
        }
      }
    }
    if (allIPs.length === 0) return '127.0.0.1'

    // 分级优先选择局域网 IP（避免 Docker/WSL 虚拟网卡 172.17.x.x 被误选）
    // 优先级: 192.168.x.x > 10.x.x.x > 172.16-31.x.x
    const ip192 = allIPs.find((ip) => ip.startsWith('192.168.'))
    if (ip192) return ip192

    const ip10 = allIPs.find((ip) => ip.startsWith('10.'))
    if (ip10) return ip10

    const ip172 = allIPs.find((ip) => {
      if (!ip.startsWith('172.')) return false
      const second = parseInt(ip.split('.')[1], 10)
      return second >= 16 && second <= 31
    })
    if (ip172) return ip172

    return allIPs[0]
  }

  private getClientId(): string {
    const hostname = os.hostname()
    const username = os.userInfo().username
    return `${hostname}-${username}`
  }
}
