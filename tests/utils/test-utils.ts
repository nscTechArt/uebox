import { mount, VueWrapper } from '@vue/test-utils'
import { ComponentPublicInstance } from 'vue'
import { vi } from 'vitest'

/**
 * 测试工具函数集合
 */

/**
 * 创建模拟的 Electron IPC 渲染器
 */
export const createMockElectronIpcRenderer = () => {
  return {
    send: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    invoke: vi.fn().mockResolvedValue(undefined)
  }
}

/**
 * 创建模拟的环境变量
 */
export const createMockEnv = (overrides: Partial<ImportMetaEnv> = {}) => {
  return {
    VITE_APP_ENV: 'test' as const,
    VITE_APP_BASE_URL: 'http://test-api.example.com/api',
    VITE_APP_NAME: 'Unreal Agent Test',
    ...overrides
  }
}

/**
 * 等待 Vue 组件更新
 */
export const flushPromises = () => {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 等待指定时间
 */
export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 创建测试包装器的辅助函数
 */
export const createWrapper = <T extends ComponentPublicInstance>(
  component: any,
  options: any = {}
): VueWrapper<T> => {
  return mount(component, {
    global: {
      mocks: {
        $t: (key: string) => key,
        ...options.global?.mocks
      },
      stubs: {
        'router-link': true,
        'router-view': true,
        ...options.global?.stubs
      },
      ...options.global
    },
    ...options
  })
}

/**
 * 模拟 Vue Router
 */
export const createMockRouter = () => {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    go: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    currentRoute: {
      value: {
        path: '/',
        name: 'home',
        params: {},
        query: {},
        meta: {}
      }
    }
  }
}

/**
 * 模拟 Pinia Store
 */
export const createMockStore = (initialState: any = {}) => {
  return {
    state: { ...initialState },
    getters: {},
    actions: {},
    $patch: vi.fn(),
    $reset: vi.fn(),
    $subscribe: vi.fn(),
    $onAction: vi.fn()
  }
}

/**
 * 模拟 HTTP 请求
 */
export const createMockAxios = () => {
  return {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    request: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: {
        use: vi.fn(),
        eject: vi.fn()
      },
      response: {
        use: vi.fn(),
        eject: vi.fn()
      }
    }
  }
}

/**
 * 断言辅助函数
 */
export const expectToBeVisible = (wrapper: VueWrapper<any>, selector: string) => {
  const element = wrapper.find(selector)
  expect(element.exists()).toBe(true)
  expect(element.isVisible()).toBe(true)
}

export const expectToHaveText = (wrapper: VueWrapper<any>, selector: string, text: string) => {
  const element = wrapper.find(selector)
  expect(element.exists()).toBe(true)
  expect(element.text()).toBe(text)
}

export const expectToHaveClass = (
  wrapper: VueWrapper<any>,
  selector: string,
  className: string
) => {
  const element = wrapper.find(selector)
  expect(element.exists()).toBe(true)
  expect(element.classes()).toContain(className)
}

/**
 * 事件触发辅助函数
 */
export const triggerClick = async (wrapper: VueWrapper<any>, selector: string) => {
  const element = wrapper.find(selector)
  expect(element.exists()).toBe(true)
  await element.trigger('click')
  await flushPromises()
}

export const triggerInput = async (wrapper: VueWrapper<any>, selector: string, value: string) => {
  const element = wrapper.find(selector)
  expect(element.exists()).toBe(true)
  await element.setValue(value)
  await flushPromises()
}

/**
 * 快照测试辅助函数
 */
export const expectToMatchSnapshot = (wrapper: VueWrapper<any>) => {
  expect(wrapper.html()).toMatchSnapshot()
}

/**
 * 性能测试辅助函数
 */
export const measurePerformance = async (
  fn: () => Promise<void> | void,
  name: string = 'operation'
) => {
  const start = performance.now()
  await fn()
  const end = performance.now()
  const duration = end - start
  console.log(`${name} took ${duration.toFixed(2)}ms`)
  return duration
}
