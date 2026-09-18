/**
 * NetworkAuthManager - 网络路径认证管理器
 * 负责：测试网络路径访问、使用凭据连接、安全存储凭据
 */
import { exec } from 'child_process'
import { promisify } from 'util'
import { safeStorage } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const execAsync = promisify(exec)

/**
 * 网络凭据接口
 */
export interface NetworkCredentials {
  username: string
  password: string
  domain?: string
}

/**
 * 网络路径访问测试结果
 */
export interface NetworkAccessResult {
  accessible: boolean
  requiresAuth: boolean
  canWrite: boolean
  error?: string
}

/**
 * 连接结果
 */
export interface ConnectionResult {
  success: boolean
  error?: string
}

/**
 * 网络认证管理器
 */
export class NetworkAuthManager {
  private static instance: NetworkAuthManager | null = null
  private readonly credentialsDir: string

  private constructor() {
    const userDataPath = app.getPath('userData')
    this.credentialsDir = join(userDataPath, 'network-credentials')
    this.ensureCredentialsDirectory()
  }

  /**
   * 获取单例实例
   */
  static getInstance(): NetworkAuthManager {
    if (!NetworkAuthManager.instance) {
      NetworkAuthManager.instance = new NetworkAuthManager()
    }
    return NetworkAuthManager.instance
  }

  /**
   * 确保凭据目录存在
   */
  private ensureCredentialsDirectory(): void {
    if (!existsSync(this.credentialsDir)) {
      fs.mkdir(this.credentialsDir, { recursive: true }).catch((e) =>
        console.warn('[NetworkAuthManager] 创建凭据目录失败:', e)
      )
    }
  }

  /**
   * 测试网络路径访问权限
   * @param networkPath 网络路径，如 \\\\server\\share
   */
  async testAccess(networkPath: string): Promise<NetworkAccessResult> {
    try {
      // 标准化路径
      const normalizedPath = this.normalizePath(networkPath)

      // 检查路径是否可访问
      const accessible = await this.checkPathAccessible(normalizedPath)
      if (!accessible) {
        // 尝试判断是需要认证还是路径不存在
        const authRequired = await this.checkRequiresAuth(normalizedPath)
        return {
          accessible: false,
          requiresAuth: authRequired,
          canWrite: false,
          error: authRequired ? '需要认证' : '路径无法访问'
        }
      }

      // 检查写权限
      const canWrite = await this.checkWritePermission(normalizedPath)

      return {
        accessible: true,
        requiresAuth: false,
        canWrite
      }
    } catch (error) {
      return {
        accessible: false,
        requiresAuth: false,
        canWrite: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 使用凭据连接网络共享
   * @param networkPath 网络路径
   * @param credentials 凭据
   */
  async connectWithCredentials(
    networkPath: string,
    credentials: NetworkCredentials
  ): Promise<ConnectionResult> {
    try {
      const normalizedPath = this.normalizePath(networkPath)

      // 先断开已存在的连接（忽略错误）
      await this.disconnect(normalizedPath).catch(() => {})

      // 构建 net use 命令
      const { username, password, domain } = credentials
      const userArg = domain ? `${domain}\\${username}` : username

      // 转义密码中的特殊字符
      const escapedPassword = this.escapeForCmd(password)

      const cmd = `net use "${normalizedPath}" /user:${userArg} "${escapedPassword}" /persistent:no`

      console.log(`[NetworkAuthManager] 连接网络共享: ${normalizedPath}`)

      await execAsync(cmd, { windowsHide: true })

      console.log(`[NetworkAuthManager] 连接成功: ${normalizedPath}`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[NetworkAuthManager] 连接失败:`, errorMsg)

      // 解析常见错误
      let friendlyError = '连接失败'
      if (errorMsg.includes('1326') || errorMsg.includes('logon failure')) {
        friendlyError = '用户名或密码错误'
      } else if (errorMsg.includes('53') || errorMsg.includes('network path')) {
        friendlyError = '找不到网络路径'
      } else if (errorMsg.includes('1219')) {
        friendlyError = '已存在使用不同凭据的连接，请先断开'
      } else if (errorMsg.includes('5')) {
        friendlyError = '访问被拒绝'
      }

      return { success: false, error: friendlyError }
    }
  }

  /**
   * 断开网络共享连接
   */
  async disconnect(networkPath: string): Promise<void> {
    try {
      const normalizedPath = this.normalizePath(networkPath)
      const cmd = `net use "${normalizedPath}" /delete /y`
      await execAsync(cmd, { windowsHide: true })
      console.log(`[NetworkAuthManager] 已断开: ${normalizedPath}`)
    } catch (error) {
      // 忽略"连接不存在"的错误
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (!errorMsg.includes('2250')) {
        console.warn(`[NetworkAuthManager] 断开连接失败:`, errorMsg)
      }
    }
  }

  /**
   * 加密存储凭据
   */
  async saveCredentials(networkPath: string, credentials: NetworkCredentials): Promise<void> {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[NetworkAuthManager] 加密不可用，跳过凭据存储')
        return
      }

      const key = this.getCredentialKey(networkPath)
      const filePath = join(this.credentialsDir, `${key}.enc`)

      const data = JSON.stringify(credentials)
      const encrypted = safeStorage.encryptString(data)

      await fs.writeFile(filePath, encrypted)
      console.log(`[NetworkAuthManager] 凭据已保存: ${networkPath}`)
    } catch (error) {
      console.error('[NetworkAuthManager] 保存凭据失败:', error)
      throw error
    }
  }

  /**
   * 读取已存储的凭据
   */
  async loadCredentials(networkPath: string): Promise<NetworkCredentials | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return null
      }

      const key = this.getCredentialKey(networkPath)
      const filePath = join(this.credentialsDir, `${key}.enc`)

      if (!existsSync(filePath)) {
        return null
      }

      const encrypted = await fs.readFile(filePath)
      const decrypted = safeStorage.decryptString(encrypted)
      const credentials = JSON.parse(decrypted) as NetworkCredentials

      console.log(`[NetworkAuthManager] 凭据已加载: ${networkPath}`)
      return credentials
    } catch (error) {
      console.error('[NetworkAuthManager] 加载凭据失败:', error)
      return null
    }
  }

  /**
   * 删除已存储的凭据
   */
  async deleteCredentials(networkPath: string): Promise<void> {
    try {
      const key = this.getCredentialKey(networkPath)
      const filePath = join(this.credentialsDir, `${key}.enc`)

      if (existsSync(filePath)) {
        await fs.unlink(filePath)
        console.log(`[NetworkAuthManager] 凭据已删除: ${networkPath}`)
      }
    } catch (error) {
      console.error('[NetworkAuthManager] 删除凭据失败:', error)
    }
  }

  /**
   * 检查路径是否可访问（使用 dir 命令）
   */
  private async checkPathAccessible(networkPath: string): Promise<boolean> {
    try {
      await execAsync(`dir "${networkPath}" /b`, {
        windowsHide: true,
        timeout: 10000
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * 检查是否需要认证
   */
  private async checkRequiresAuth(networkPath: string): Promise<boolean> {
    try {
      // 尝试通过 net use 的错误信息判断
      const result = await execAsync(`net use "${networkPath}" 2>&1`, {
        windowsHide: true,
        timeout: 10000
      }).catch((e) => e)

      const output = result?.stderr || result?.stdout || String(result)

      // 错误码 1326 表示登录失败（需要认证）
      if (output.includes('1326') || output.includes('logon')) {
        return true
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * 检查写权限
   */
  private async checkWritePermission(networkPath: string): Promise<boolean> {
    try {
      const testFile = join(networkPath, `.write-test-${Date.now()}`)
      await fs.writeFile(testFile, 'test')
      await fs.unlink(testFile)
      return true
    } catch {
      return false
    }
  }

  /**
   * 标准化网络路径
   */
  private normalizePath(path: string): string {
    // 确保使用反斜杠，移除末尾斜杠
    return path.replace(/\//g, '\\').replace(/\\+$/, '')
  }

  /**
   * 将网络路径转换为安全的文件名
   */
  private getCredentialKey(networkPath: string): string {
    // 将 \\server\share 转换为 server_share
    return networkPath
      .replace(/^\\\\/, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .toLowerCase()
  }

  /**
   * 转义 CMD 特殊字符
   */
  private escapeForCmd(str: string): string {
    // 转义双引号和特殊字符
    return str.replace(/"/g, '""').replace(/%/g, '%%')
  }
}

// 导出单例获取函数
export const getNetworkAuthManager = (): NetworkAuthManager => {
  return NetworkAuthManager.getInstance()
}
