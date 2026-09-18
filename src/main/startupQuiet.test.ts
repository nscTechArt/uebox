/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = { dev: true }

vi.mock('@electron-toolkit/utils', () => ({
  get is() {
    return { dev: env.dev }
  }
}))

const originalLog = console.log
const originalWarn = console.warn
const originalError = console.error

let printed: unknown[][] = []

beforeEach(() => {
  vi.resetModules()
  env.dev = true
  delete process.env.UA_VERBOSE
  printed = []
  console.log = (...args: unknown[]) => {
    printed.push(args)
  }
  console.warn = (...args: unknown[]) => {
    printed.push(args)
  }
  console.error = (...args: unknown[]) => {
    printed.push(args)
  }
})

afterEach(() => {
  console.log = originalLog
  console.warn = originalWarn
  console.error = originalError
  delete process.env.UA_VERBOSE
})

async function loadQuiet(): Promise<typeof import('./startupQuiet')> {
  return import('./startupQuiet')
}

describe('启动期安静模式', () => {
  it('折叠 console.log，恢复后照常输出', async () => {
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.log('注册路由: system.ping')
    console.log('标签表初始化完成')
    expect(printed).toHaveLength(0)

    const suppressed = endQuietStartup()
    expect(suppressed).toBe(2)

    // 恢复之后是原来的 console.log（这里被测试自己接管了，所以能收到）
    console.log('启动之后的正常输出')
    expect(printed.at(-1)).toEqual(['启动之后的正常输出'])
  })

  it('恢复时报出折叠了多少条，并给出看全部的办法', async () => {
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.log('随便什么')
    endQuietStartup()

    expect(String(printed.at(-1)?.[0])).toMatch(/已折叠 1 条.*UA_VERBOSE=1/)
  })

  it('警告和报错一律照常输出，不受影响', async () => {
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.warn('端口被占用')
    console.error('数据库打不开')
    endQuietStartup()

    expect(printed[0]).toEqual(['端口被占用'])
    expect(printed[1]).toEqual(['数据库打不开'])
  })

  it('UA_VERBOSE=1 时完全不介入', async () => {
    process.env.UA_VERBOSE = '1'
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.log('该看见的')
    expect(printed).toEqual([['该看见的']])
    expect(endQuietStartup()).toBe(0)
  })

  it('生产环境不介入', async () => {
    env.dev = false
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.log('该看见的')
    expect(printed).toEqual([['该看见的']])
    expect(endQuietStartup()).toBe(0)
  })

  it('重复调用 endQuietStartup 不会二次改动 console', async () => {
    const { beginQuietStartup, endQuietStartup } = await loadQuiet()

    beginQuietStartup()
    console.log('一条')
    expect(endQuietStartup()).toBe(1)
    // 第二次是空操作，不再打印汇总行
    const lengthAfterFirst = printed.length
    expect(endQuietStartup()).toBe(0)
    expect(printed).toHaveLength(lengthAfterFirst)
  })
})
