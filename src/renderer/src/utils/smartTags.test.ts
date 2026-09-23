import { describe, expect, it } from 'vitest'

import { computeSmartTags } from './smartTags'

/**
 * 资产详情面板上的智能标签。
 *
 * 和主进程导入时落库的那份用同一个判据（`shared/smartTagMatch.ts`）。原来这里是
 * 任意位置的裸子串：`SM_Door_01` 被标成 Diffuse（`_D` 撞 `_DOOR`）+ Material（`M_` 撞 `SM_`），
 * 和库里存的标签对不上。
 */
const names = (assetName: string): string[] => computeSmartTags(assetName).map((tag) => tag.name)

describe('computeSmartTags（渲染层）', () => {
  it('前缀只认名字开头，后缀只认通道位', () => {
    expect(names('SM_Door_01')).toEqual(['Static Mesh'])
  })

  it('真正的通道位照样命中，带扩展名也认得', () => {
    expect(names('T_Rock_D.png')).toContain('Diffuse/BaseColor')
    expect(names('T_Rock_D_01')).toContain('Diffuse/BaseColor')
  })

  it('空名字不出标签', () => {
    expect(computeSmartTags('')).toEqual([])
  })
})
