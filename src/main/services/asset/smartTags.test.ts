/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { computeSmartTags } from './smartTags'

const tags = (name: string): string[] => computeSmartTags(name).map((rule) => rule.tag)

/**
 * 这一组全是**真机素材库（5500 个资产）里抓出来的误报**。
 *
 * 原来的判据里有一条 `nameUpper.includes(patternUpper)` —— 任意位置的裸子串，
 * 于是 `_D` 去撞 `_DOOR`、`M_` 去撞 `SM_`，规则在 95.6% 的资产上开火，
 * 打出来的大半是错的。每一条断言对应一次真实的错标。
 */
describe('智能标签不再被子串撞出误报', () => {
  it('`_D` 不撞 `_Door`，`M_` 不撞 `SM_`', () => {
    expect(tags('SM_Door_01')).toEqual(['StaticMesh'])
  })

  it('`_R` 不撞 `_Rock`', () => {
    expect(tags('SM_Rock_Large')).toEqual(['StaticMesh'])
  })

  it('`_M` 不撞 `Mannequin`', () => {
    expect(tags('SK_Mannequin')).toEqual(['SkeletalMesh'])
  })

  it('一个名字不该同时是 Roughness、Metallic 和 Animation', () => {
    expect(tags('A_METACITY_Ring')).toEqual(['Animation'])
  })

  it('MI_ 是材质实例，不该顺带打上 Roughness / Metallic', () => {
    expect(tags('MI_RING_PANO_MASTER')).toEqual(['MaterialInstance'])
  })
})

describe('该打的照样打', () => {
  it('结尾的通道位仍然命中', () => {
    expect(tags('T_Grass_D')).toEqual(['Diffuse', 'Texture'])
    expect(tags('T_Grass_N')).toEqual(['NormalMap', 'Texture'])
  })

  it('通道位后面还跟着编号时也命中（T_Rock_D_01）', () => {
    expect(tags('T_Rock_D_01')).toContain('Diffuse')
  })

  it('带扩展名时先摘扩展名再判通道位', () => {
    expect(tags('T_Rock_D.png')).toContain('Diffuse')
  })

  it('长词形式仍然命中', () => {
    expect(tags('T_Wall_Normal')).toContain('NormalMap')
    expect(tags('T_Wall_BaseColor')).toContain('Diffuse')
  })
})

describe('名字里没有约定信息时不硬凑', () => {
  it.each(['CorgiHouse.glb', 'Pikachu_Bodybuilder.glb', '未来高铁_01'])('%s → 无标签', (name) => {
    expect(tags(name)).toEqual([])
  })
})
