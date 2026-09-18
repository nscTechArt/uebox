import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 图标换到 Phosphor 之后的尺寸补偿。
 *
 * 两套图集的「墨迹占框比例」不一样 —— 实测同样标称尺寸下 antd 平均占 0.957、
 * Phosphor 只占 0.818，照搬原来的字号每个图标都会小掉约 17%。补偿点只有一处：
 * main.ts 里 `app.provide('size', ...)`，Phosphor 组件用 inject 取这个默认值。
 *
 * 这个测试是防止有人「顺手」把那行删掉或改回 1em —— 删掉了界面不会报错，
 * 只会整体变虚，而变虚这件事没人会在 code review 里看出来。
 */
const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/src/main.ts'), 'utf8')

describe('Phosphor 图标全局尺寸补偿', () => {
  it('给 Phosphor 注入放大后的默认尺寸，抵消它比 antd 小的那部分', () => {
    const match = MAIN.match(/app\.provide\('size',\s*'([\d.]+)em'\)/)
    expect(match, "main.ts 里应当有 app.provide('size', '<n>em')").not.toBeNull()

    const scale = Number(match![1])
    // 0.957 / 0.818 ≈ 1.17；留一点余量，但不能退回 1em，也不能大到盖过正文
    expect(scale).toBeGreaterThanOrEqual(1.1)
    expect(scale).toBeLessThanOrEqual(1.25)
  })

  it('把 antd 内层的 title-content 排成 flex 行，图标才不会顶到文字上面去', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/assets/styles/antd-override.css'),
      'utf8'
    )
    // antd 把图标和文字一起塞进 .ant-menu-title-content，间距原本靠它自己的
    // `.anticon + span` 规则。裸 <svg> 不再命中那条，必须自己把这层做成 flex 行 ——
    // 而且只能写在全局：这个 span 是 antd 内部渲染的，拿不到 scoped 的 data-v 属性。
    expect(css).toMatch(
      /\.ant-menu-title-content\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:/
    )
    // svg 必须 flex: none，否则在 flex 行里会被压扁
    expect(css).toMatch(/\.ant-menu-title-content > svg,[\s\S]{0,80}\{[^}]*flex:\s*none;/)
  })

  it('图标自转用全局 .icon-spin，不再依赖 antd 的 spin 属性', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/assets/styles/components.css'),
      'utf8'
    )
    expect(css).toMatch(/\.icon-spin\s*\{[^}]*animation:\s*spin/)
    // 减少动效偏好下要停下来
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*?\.icon-spin[\s\S]*?animation:\s*none/)
  })
})
