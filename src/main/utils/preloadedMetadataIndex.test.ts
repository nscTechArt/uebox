import { describe, expect, it } from 'vitest'
import {
  PreloadedMetadataIndex,
  normalizePathForMatch,
  packageFolderRelativePath,
  packageRelativePath
} from './preloadedMetadataIndex'

const CLOTHING = {
  name: 'M_yifu_Inst',
  package: '/Game/0_MHC_Lecturer/Materials/M1_Clothing/M_yifu_Inst'
}
const CLOTHING2 = {
  name: 'M_yifu_Inst',
  package: '/Game/0_MHC_Lecturer/Materials/M1_Clothing2/M_yifu_Inst'
}

describe('normalizePathForMatch', () => {
  it('反斜杠转正斜杠、去资产扩展名、转小写', () => {
    expect(normalizePathForMatch('I:\\LAOTAN\\Proj\\Content\\A\\M_Yifu_Inst.uasset')).toBe(
      'i:/laotan/proj/content/a/m_yifu_inst'
    )
  })

  it('只去 uasset / umap，别的扩展名原样留着', () => {
    expect(normalizePathForMatch('/p/Content/A/Level.umap')).toBe('/p/content/a/level')
    expect(normalizePathForMatch('/p/Content/A/notes.txt')).toBe('/p/content/a/notes.txt')
  })
})

describe('packageRelativePath / packageFolderRelativePath', () => {
  it('去掉 /Game 前缀', () => {
    expect(packageRelativePath(CLOTHING2.package)).toBe(
      '0_MHC_Lecturer/Materials/M1_Clothing2/M_yifu_Inst'
    )
    expect(packageFolderRelativePath(CLOTHING2.package)).toBe(
      '0_MHC_Lecturer/Materials/M1_Clothing2'
    )
  })

  it('不在 /Game 下的包不参与配对', () => {
    expect(packageRelativePath('/Engine/Transient/Foo')).toBe('')
    expect(packageRelativePath('')).toBe('')
  })
})

describe('PreloadedMetadataIndex', () => {
  it('同名不同目录的资产各归各的，不再互相串', () => {
    const index = new PreloadedMetadataIndex([CLOTHING, CLOTHING2])

    expect(
      index.match(
        'I:/LAOTAN/Lecturer_UE_5_6/Content/0_MHC_Lecturer/Materials/M1_Clothing2/M_yifu_Inst.uasset'
      )
    ).toBe(CLOTHING2)
    expect(
      index.match(
        'I:\\LAOTAN\\Lecturer_UE_5_6\\Content\\0_MHC_Lecturer\\Materials\\M1_Clothing\\M_yifu_Inst.uasset'
      )
    ).toBe(CLOTHING)
  })

  it('多个后缀都命中时取最长的那个', () => {
    const shallow = { name: 'M_x', package: '/Game/Materials/M_x' }
    const deep = { name: 'M_x', package: '/Game/A/Materials/M_x' }
    const index = new PreloadedMetadataIndex([shallow, deep])

    expect(index.match('D:/P/Content/A/Materials/M_x.uasset')).toBe(deep)
    expect(index.match('D:/P/Content/Materials/M_x.uasset')).toBe(shallow)
  })

  it('路径对不上但名字全局唯一时，仍然按名字认（和按路径配对之前的行为一致）', () => {
    const index = new PreloadedMetadataIndex([CLOTHING])
    expect(index.match('D:/搬走了/M_yifu_Inst.uasset')).toBe(CLOTHING)
  })

  it('路径对不上且有同名歧义时，宁可不配 —— 交给调用方自己解析 uasset', () => {
    const index = new PreloadedMetadataIndex([CLOTHING, CLOTHING2])
    expect(index.match('D:/搬走了/M_yifu_Inst.uasset')).toBeUndefined()
  })

  it('名字没见过就返回 undefined', () => {
    const index = new PreloadedMetadataIndex([CLOTHING])
    expect(index.match('D:/P/Content/A/M_buchunzai.uasset')).toBeUndefined()
  })
})
