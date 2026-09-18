import { describe, expect, it } from 'vitest'

import { FORMAT_ALIAS_MAP } from './types'

/**
 * 别名表本身的约束。
 *
 * 这些不是风格问题，每一条都对应一个真机上量到的错误结果。
 */
describe('FORMAT_ALIAS_MAP', () => {
  /**
   * 每个虚幻资产落盘都是 `.uasset`。把它列进某个别名，那个别名就会匹配
   * 库里所有 UE 资产 —— 筛选等于没做。
   *
   * 真机验证：`uasset` 在 模型/材质/蓝图/UI/特效/粒子 六个别名里，
   * 问「有哪些材质」返回了整个库（8 个资产里混着贴图和动画）。
   *
   * 例外是「资产」「虚幻资产」—— 它们的语义本来就是「所有 UE 资产」。
   */
  const INTENTIONAL = new Set(['资产', '虚幻资产'])

  it('语义化别名里不能出现 uasset', () => {
    const offenders = Object.entries(FORMAT_ALIAS_MAP)
      .filter(([name]) => !INTENTIONAL.has(name))
      .filter(([, values]) => values.some((v) => v.toLowerCase() === 'uasset'))
      .map(([name]) => name)

    expect(offenders).toEqual([])
  })

  it('「资产」「虚幻资产」保留 uasset —— 它们就是这个意思', () => {
    expect(FORMAT_ALIAS_MAP['资产']).toContain('uasset')
    expect(FORMAT_ALIAS_MAP['虚幻资产']).toContain('uasset')
  })

  /**
   * 扩展名与类型名靠**大小写**区分：类型名一律 PascalCase（StaticMesh、
   * Texture2D），扩展名一律小写（fbx、png）。
   *
   * 原来的判据是先 toLowerCase 再测 `^[a-z0-9]+$` —— 小写之后
   * `Material` 必然匹配，所有类型名都被当成扩展名，拿去和文件扩展名比
   * 永远比不中。凡是别名里只有类型名的（材质/蓝图/特效），筛选恒为空。
   */
  it('类型名保持 PascalCase，扩展名保持小写', () => {
    const isExtension = (v: string): boolean => /^\.?[a-z0-9]+$/.test(v)
    for (const [alias, values] of Object.entries(FORMAT_ALIAS_MAP)) {
      for (const value of values) {
        // 每个值要么是干净的小写扩展名，要么是首字母大写的类型名，
        // 不能是 "staticMesh" 这种两头不靠的写法
        const looksLikeType = /^[A-Z]/.test(value)
        expect(isExtension(value) || looksLikeType, `${alias} 的 "${value}"`).toBe(true)
      }
    }
  })

  it('常用别名都还在', () => {
    for (const alias of ['模型', '贴图', '材质', '蓝图', '动画', '特效']) {
      expect(FORMAT_ALIAS_MAP[alias]?.length, alias).toBeGreaterThan(0)
    }
  })
})
