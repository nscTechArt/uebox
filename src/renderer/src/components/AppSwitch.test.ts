import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppSwitch from './AppSwitch.vue'

const ROOT = process.cwd()
const source = readFileSync(resolve(ROOT, 'src/renderer/src/components/AppSwitch.vue'), 'utf8')

function rendererStyleSources(): string[] {
  const tracked = execSync('git ls-files src/renderer/src', { cwd: ROOT, encoding: 'utf8' })
  const untracked = execSync('git ls-files --others --exclude-standard src/renderer/src', {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .filter((f) => /\.(vue|css|less)$/.test(f))
    .filter((f) => !f.endsWith('components/AppSwitch.vue'))
    .filter((f) => existsSync(resolve(ROOT, f)))
}

describe('AppSwitch', () => {
  it('点一下就翻转，并同时发 update:checked 和 change', async () => {
    const wrapper = mount(AppSwitch, { props: { checked: false } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:checked')).toEqual([[true]])
    expect(wrapper.emitted('change')).toEqual([[true]])
  })

  it('禁用时点不动', async () => {
    const wrapper = mount(AppSwitch, { props: { checked: false, disabled: true } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('update:checked')).toBeUndefined()
  })

  it('是个真正的 switch 控件，读屏软件念得出开关态', () => {
    const wrapper = mount(AppSwitch, { props: { checked: true, ariaLabel: '自动启动' } })
    const button = wrapper.get('button')
    expect(button.attributes('role')).toBe('switch')
    expect(button.attributes('aria-checked')).toBe('true')
    expect(button.attributes('aria-label')).toBe('自动启动')
  })

  it('开启态使用专用蓝色 token，不借用全局中性 accent', () => {
    expect(source).toContain('background: var(--color-switch-checked-solid)')
    expect(source).not.toMatch(/\.app-switch--checked\s*{[^}]*var\(--color-accent-solid\)/s)
  })
})

/**
 * 开关只准有一种长相。
 *
 * 在这之前应用里有 11 套手写开关，轨道 32×18 / 36×20 / 40×20 / 42×24 / 44×24 五种尺寸，
 * 开启态还分成两派（实心蓝轨 + 白钮 vs 淡蓝轨 + 蓝钮）——
 * 同一个偏好设置页里上下两行的开关都不一样。所以这里盯死：不许再手写。
 */
/**
 * 只放行一个：录屏面板的「全屏 / 区域」。那不是布尔开关 ——
 * 滑块里带文字，两侧各代表一种录制模式，换成 AppSwitch 会把标签弄丢。
 */
const ALLOWED = new Set(['src/renderer/src/views/ScreenRecorder/ScreenRecorderPanel.vue'])

describe('开关只有一种实现', () => {
  it('没有别的地方自己写开关样式', () => {
    const offenders: string[] = []
    for (const file of rendererStyleSources()) {
      if (ALLOWED.has(file)) continue
      const text = readFileSync(resolve(ROOT, file), 'utf8')
      // 手写开关的指纹：一个名字带 switch/toggle 的选择器，块里把滑块 translateX 挪过去。
      // 名字里带 toggle 的折叠按钮、视图切换按钮组没有这个动作，不会被误抓。
      for (const m of text.matchAll(
        /^[ \t]*(\.[a-z-]*(?:switch|toggle)[a-z-]*[^{]*)\{([^{}]|\{[^{}]*\})*translateX\(/gim
      )) {
        offenders.push(`${file}: ${m[1].trim()}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
