import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BrandSphere from './BrandSphere.vue'

/** 有几条测的是**样式规则本身**（混合模式、backdrop-filter），只能读源码验 */
const readStyle = (): string => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/BrandSphere.vue'),
    'utf8'
  )
  return source.slice(source.indexOf('<style'))
}

describe('BrandSphere', () => {
  it('响度下发成 CSS 变量，光团摊开和中心高光都从它算', async () => {
    const wrapper = mount(BrandSphere, { props: { size: 72, minimumSize: 72, level: 0.6 } })
    expect(wrapper.attributes('style')).toContain('--sphere-level: 0.6')

    await wrapper.setProps({ level: 0 })
    expect(wrapper.attributes('style')).toContain('--sphere-level: 0')
  })

  it('脏响度夹回 0–1，不让一个越界的数把球撑爆', () => {
    expect(mount(BrandSphere, { props: { level: 4 } }).attributes('style')).toContain(
      '--sphere-level: 1'
    )
    expect(mount(BrandSphere, { props: { level: -2 } }).attributes('style')).toContain(
      '--sphere-level: 0'
    )
  })

  it('玻璃是真的采样背后再糊开，不是画一个渐变假装', () => {
    const wrapper = mount(BrandSphere, { props: { size: 120 } })
    expect(wrapper.find('.sphere-frost').exists()).toBe(true)
    // 边缘是球最厚的地方，少了这一圈就只是一块蒙着雾的平板
    expect(wrapper.find('.sphere-edge').exists()).toBe(true)
    expect(wrapper.find('.sphere-specular').exists()).toBe(true)

    const style = readStyle()
    expect(style).toMatch(/\.sphere-frost[\s\S]*?backdrop-filter/)
    expect(style).toMatch(/\.sphere-edge[\s\S]*?backdrop-filter/)
  })

  it('深浅两套形态：浅色下混合模式必须翻面，否则白底上 screen 等于不叠', () => {
    const style = readStyle()
    const light = style.slice(style.indexOf("[data-theme='light']"))

    expect(style).toContain('--glass-blend: screen')
    expect(light).toContain('--glass-blend: normal')

    // 玻璃那几个半透明白 / 黑住在 palette，同样分两套：深色靠顶部提亮，浅色靠底部压暗
    const palette = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/assets/styles/palette.generated.css'),
      'utf8'
    )
    expect(palette.match(/--color-glass-bottom-shade:/g)).toHaveLength(2)
    expect(palette.match(/--color-glass-tint:/g)).toHaveLength(2)
  })

  it('三团是史莱姆不是光斑：轮廓自己会扭，所以有独立的一条 morph 动画', () => {
    const style = readStyle()

    // 圆形只会读成「一团光」，不规则且会变的圆角半径才是有粘性的东西
    expect(style).toMatch(/@keyframes sphere-morph-1[\s\S]*?border-radius/)
    expect(style).toMatch(/@keyframes sphere-morph-2/)
    expect(style).toMatch(/@keyframes sphere-morph-3/)
    // 路径和轮廓必须是两条动画：合成一条的话「往哪走」和「鼓成什么样」会同步
    expect(style).toMatch(/sphere-blob-1 9s[\s\S]*?sphere-morph-1 7s/)
  })

  it('说话人只换谁占上风，三团光始终都在 —— 换整套配色就成了两个球', () => {
    const user = mount(BrandSphere, { props: { speaker: 'user' } })
    expect(user.classes()).toContain('speaker-user')
    expect(user.findAll('.sphere-blob')).toHaveLength(3)

    const assistant = mount(BrandSphere, { props: { speaker: 'assistant' } })
    expect(assistant.classes()).toContain('speaker-assistant')
    expect(assistant.findAll('.sphere-blob')).toHaveLength(3)
  })

  it('不传语音相关的属性也能用 —— 欢迎页那颗只是个品牌球', () => {
    const wrapper = mount(BrandSphere, { props: { size: 180 } })
    expect(wrapper.classes()).toContain('speaker-idle')
    expect(wrapper.attributes('style')).toContain('--sphere-level: 0')
  })

  it('最小尺寸兜底：语音指示器给得比默认下限小也不会被拉大', () => {
    expect(
      mount(BrandSphere, { props: { size: 72, minimumSize: 72 } }).attributes('style')
    ).toContain('width: 72px')
    expect(mount(BrandSphere, { props: { size: 40 } }).attributes('style')).toContain(
      'width: 120px'
    )
  })

  it('球体颜色走 palette 的自发光光谱，不写死十六进制', () => {
    const style = readStyle()

    for (const token of [
      '--color-sphere-emerald',
      '--color-sphere-azure',
      '--color-sphere-indigo'
    ]) {
      expect(style).toContain(`var(${token})`)
    }
    // 渐变里写死颜色不会被颜色门禁拦下，所以这条在这里自己守
    expect(style).not.toMatch(/background:[^;]*#[0-9a-fA-F]{3,8}/)
  })
})
