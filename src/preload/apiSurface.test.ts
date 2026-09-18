/** @vitest-environment node */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 渲染层用到的每个 `window.api.*` 方法，preload 里都得真的实现。
 *
 * ## 为什么需要这条
 *
 * `src/preload/index.d.ts` 是**手写**的类型声明，和 `index.ts` 的实现之间
 * 没有任何强制关系。在 .d.ts 里声明一个方法但忘了实现，类型检查全绿，
 * 渲染层照样能写出调用 —— 直到运行时才炸 `xxx is not a function`。
 *
 * 而且后果不只是"这个功能不能用"：真实案例里
 * `aiProvider.onOAuthDeviceCode` 只有声明没有实现，它在
 * `AIProviderSettings.vue` 的 `onMounted` 里被调用，抛出去中断了 Vue 的
 * post-flush 队列 —— **整个应用界面不再更新，看上去像卡死**，
 * 而且从「模型」页蔓延到旁边几个完全无关的设置页。
 *
 * ## 判据口径
 *
 * 只按方法名匹配，不校验命名空间。preload 是一个 2000 多行的大对象字面量，
 * 精确解析命名空间要上 AST，成本远高于收益 —— 而真正会发生的失败是
 * 「这个名字压根没实现过」，按名字就能抓住。宁可放过跨命名空间的重名，
 * 也不要为了严谨引入一个会误报的检查。
 */

const PRELOAD = join(__dirname, 'index.ts')
const RENDERER = join(__dirname, '..', 'renderer', 'src')
const AIGC_STUDIO = join(RENDERER, 'views', 'AIGCStudio')
const SPOTLIGHT_WINDOW = join(RENDERER, 'views', 'SpotlightWindow.vue')

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSources(full, out)
      continue
    }
    if (!/\.(ts|vue)$/.test(entry.name)) continue
    // 测试自己会 mock window.api，里面的调用不代表真实依赖
    if (entry.name.includes('.test.')) continue
    out.push(full)
  }
  return out
}

/** `window.api.ns.method` / `window.api?.ns?.method` 都要认 */
const CALL_PATTERN = /window\.api\??\.([A-Za-z0-9_]+)\??\.([A-Za-z0-9_]+)/g

interface Usage {
  namespace: string
  method: string
  file: string
}

function collectUsages(): Usage[] {
  const usages: Usage[] = []
  for (const file of collectSources(RENDERER)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(CALL_PATTERN)) {
      usages.push({ namespace: match[1], method: match[2], file })
    }
  }
  return usages
}

function collectRawEventChannels(dir: string): string[] {
  const pattern = /window\.electron\??\.ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g
  const channels = new Set<string>()

  for (const file of collectSources(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) {
      channels.add(match[1])
    }
  }

  return [...channels]
}

function readRawEventAllowlist(): Set<string> {
  const preload = readFileSync(PRELOAD, 'utf8')
  const match = preload.match(/const RAW_EVENT_CHANNELS = new Set\(\s*`([^`]+)`/)
  if (!match) throw new Error('没有找到 preload 的 RAW_EVENT_CHANNELS')
  return new Set(match[1].trim().split(/\s+/))
}

describe('preload API 面', () => {
  it('渲染层调用的方法在 preload 里都有实现', () => {
    const preload = readFileSync(PRELOAD, 'utf8')
    const seen = new Set<string>()
    const missing: string[] = []

    for (const usage of collectUsages()) {
      const key = `${usage.namespace}.${usage.method}`
      if (seen.has(key)) continue
      seen.add(key)

      // 对象字面量的 `method:` 或函数声明的 `method(`
      const implemented = new RegExp(`(^|[^A-Za-z0-9_])${usage.method}\\s*[:(]`, 'm').test(preload)
      if (!implemented) {
        missing.push(`window.api.${key}  ←  ${usage.file.replace(/.*[\\/]src[\\/]/, 'src/')}`)
      }
    }

    expect(
      missing,
      missing.length
        ? `这些方法渲染层在调、preload 里却没有实现（.d.ts 里声明了不算）：\n  ${missing.join('\n  ')}`
        : ''
    ).toEqual([])
  })

  // 上面那条得真的能抓到东西，否则正则写错了会静默通过
  it('确实扫到了调用点（防止正则写坏后空跑）', () => {
    const usages = collectUsages()
    expect(usages.length).toBeGreaterThan(100)
    expect(usages.some((u) => u.namespace === 'agentV3')).toBe(true)
  })

  it('AI 创作订阅的主进程事件都已通过 preload 放行', () => {
    const channels = collectRawEventChannels(AIGC_STUDIO)
    const allowlist = readRawEventAllowlist()
    const missing = channels.filter((channel) => !allowlist.has(channel))

    expect(channels).toContain('image:event')
    expect(missing, `这些 AI 创作事件会被 preload 拦截：${missing.join(', ')}`).toEqual([])
  })

  it('Spotlight 搜索与执行走专用桥接，不会退化成只显示 AI 兜底', () => {
    const preload = readFileSync(PRELOAD, 'utf8')
    const spotlightWindow = readFileSync(SPOTLIGHT_WINDOW, 'utf8')

    expect(preload).toContain("ipcRenderer.invoke('spotlight:search', query)")
    expect(preload).toContain("ipcRenderer.send('spotlight:execute', action, data)")
    expect(spotlightWindow).toContain('spotlightAPI.search(q)')
    expect(spotlightWindow).toContain('spotlightAPI.execute(item.type, cleanData)')
    expect(spotlightWindow).not.toContain('window.electron')
  })
})
