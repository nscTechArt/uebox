import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createMockElectronIpcRenderer,
  createMockEnv,
  flushPromises,
  sleep
} from '../utils/test-utils'

// 模拟一个简单的工具函数进行测试
const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0]
}

const calculateSum = (numbers: number[]): number => {
  return numbers.reduce((sum, num) => sum + num, 0)
}

const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  // 检查是否有连续的点
  if (email.includes('..')) return false
  return emailRegex.test(email)
}

describe('工具函数测试', () => {
  describe('formatDate', () => {
    it('应该正确格式化日期', () => {
      const date = new Date('2024-01-15T10:30:00.000Z')
      const result = formatDate(date)
      expect(result).toBe('2024-01-15')
    })

    it('应该处理不同的日期', () => {
      const date = new Date('2023-12-31T23:59:59.999Z')
      const result = formatDate(date)
      expect(result).toBe('2023-12-31')
    })
  })

  describe('calculateSum', () => {
    it('应该正确计算数组和', () => {
      expect(calculateSum([1, 2, 3, 4, 5])).toBe(15)
    })

    it('应该处理空数组', () => {
      expect(calculateSum([])).toBe(0)
    })

    it('应该处理负数', () => {
      expect(calculateSum([-1, -2, 3])).toBe(0)
    })

    it('应该处理小数', () => {
      expect(calculateSum([1.5, 2.5, 3])).toBe(7)
    })
  })

  describe('validateEmail', () => {
    it('应该验证有效的邮箱地址', () => {
      expect(validateEmail('test@example.com')).toBe(true)
      expect(validateEmail('user.name@domain.co.uk')).toBe(true)
      expect(validateEmail('test123@test-domain.org')).toBe(true)
    })

    it('应该拒绝无效的邮箱地址', () => {
      expect(validateEmail('invalid-email')).toBe(false)
      expect(validateEmail('test@')).toBe(false)
      expect(validateEmail('@example.com')).toBe(false)
      expect(validateEmail('test..test@example.com')).toBe(false)
      expect(validateEmail('')).toBe(false)
    })
  })
})

describe('测试工具函数', () => {
  describe('createMockElectronIpcRenderer', () => {
    it('应该创建模拟的 Electron IPC 渲染器', () => {
      const mockIpc = createMockElectronIpcRenderer()

      expect(mockIpc.send).toBeDefined()
      expect(mockIpc.on).toBeDefined()
      expect(mockIpc.removeAllListeners).toBeDefined()
      expect(mockIpc.invoke).toBeDefined()

      expect(vi.isMockFunction(mockIpc.send)).toBe(true)
      expect(vi.isMockFunction(mockIpc.invoke)).toBe(true)
    })
  })

  describe('createMockEnv', () => {
    it('应该创建默认的模拟环境变量', () => {
      const mockEnv = createMockEnv()

      expect(mockEnv.VITE_APP_ENV).toBe('test')
      expect(mockEnv.VITE_APP_BASE_URL).toBe('http://test-api.example.com/api')
      expect(mockEnv.VITE_APP_NAME).toBe('Unreal Agent Test')
    })

    it('应该允许覆盖环境变量', () => {
      const mockEnv = createMockEnv({
        VITE_APP_ENV: 'development',
        VITE_APP_NAME: 'Custom App'
      })

      expect(mockEnv.VITE_APP_ENV).toBe('development')
      expect(mockEnv.VITE_APP_NAME).toBe('Custom App')
      expect(mockEnv.VITE_APP_BASE_URL).toBe('http://test-api.example.com/api')
    })
  })

  describe('异步工具函数', () => {
    it('flushPromises 应该等待 Promise 解析', async () => {
      let resolved = false

      Promise.resolve().then(() => {
        resolved = true
      })

      expect(resolved).toBe(false)
      await flushPromises()
      expect(resolved).toBe(true)
    })

    it('sleep 应该等待指定时间', async () => {
      const start = Date.now()
      await sleep(50)
      const end = Date.now()

      expect(end - start).toBeGreaterThanOrEqual(45) // 允许一些误差
    })
  })
})

describe('模拟和间谍函数', () => {
  let mockFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockFn = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('应该跟踪函数调用', () => {
    mockFn('arg1', 'arg2')
    mockFn('arg3')

    expect(mockFn).toHaveBeenCalledTimes(2)
    expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2')
    expect(mockFn).toHaveBeenLastCalledWith('arg3')
  })

  it('应该支持返回值模拟', () => {
    mockFn.mockReturnValue('mocked result')

    const result = mockFn()
    expect(result).toBe('mocked result')
  })

  it('应该支持异步返回值模拟', async () => {
    mockFn.mockResolvedValue('async result')

    const result = await mockFn()
    expect(result).toBe('async result')
  })

  it('应该支持错误模拟', async () => {
    const error = new Error('Test error')
    mockFn.mockRejectedValue(error)

    await expect(mockFn()).rejects.toThrow('Test error')
  })
})
