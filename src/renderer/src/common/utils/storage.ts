/**
 * 存储工具类，提供加密和解密功能
 */
export class StorageUtils {
  // private static readonly SECRET_KEY = 'vue-electron-app-secret-key'

  /**
   * 简单加密数据
   * @param data 要加密的数据
   * @returns 加密后的字符串
   */
  static encrypt(data: any): string {
    try {
      const jsonStr = JSON.stringify(data)
      const encoded = btoa(encodeURIComponent(jsonStr))
      return encoded
    } catch (error) {
      console.error('加密数据失败:', error)
      return ''
    }
  }

  /**
   * 解密数据
   * @param encryptedData 加密的字符串
   * @returns 解密后的数据
   */
  static decrypt<T>(encryptedData: string): T | null {
    try {
      const decoded = decodeURIComponent(atob(encryptedData))
      return JSON.parse(decoded) as T
    } catch (error) {
      console.error('解密数据失败:', error)
      return null
    }
  }

  /**
   * 创建自定义序列化器
   * @returns 序列化器对象
   */
  static createCustomSerializer() {
    return {
      serialize: (value: any): string => {
        return this.encrypt(value)
      },
      deserialize: <T>(value: string): T | null => {
        return this.decrypt<T>(value)
      }
    }
  }
}
