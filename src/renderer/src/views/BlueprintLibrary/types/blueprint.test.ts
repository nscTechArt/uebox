import { describe, expect, it } from 'vitest'
import { coverStyleHasDeadAssetUrl, getBlueprintCoverStyle, getCoverForType } from './blueprint'

/** 旧版导入的包清单里真实存在过的坏数据（见 system_vault_aigc/ssss.ueblueprint） */
const LEGACY_DEAD_COVER_STYLE =
  'background-image: url(file:///C:/Program%20Files/unreal-agent/resources/app.asar/out/renderer/assets/mesh-blue-Hh4YOF0f.png); background-size: cover; background-position: center'

describe('coverStyleHasDeadAssetUrl', () => {
  it('file:// 绝对地址是死链', () => {
    expect(coverStyleHasDeadAssetUrl(LEGACY_DEAD_COVER_STYLE)).toBe(true)
  })

  it('打包产物与 dev 源的根相对地址离开原环境就是死链', () => {
    expect(coverStyleHasDeadAssetUrl('background-image: url(/assets/mesh-blue-Hh4YOF0f.png)')).toBe(
      true
    )
    expect(
      coverStyleHasDeadAssetUrl("background-image: url('/src/renderer/src/assets/imgs/x.png')")
    ).toBe(true)
  })

  it('纯渐变等环境无关样式不是死链', () => {
    expect(coverStyleHasDeadAssetUrl('background: linear-gradient(135deg, #123, #456)')).toBe(false)
    expect(coverStyleHasDeadAssetUrl('')).toBe(false)
  })
})

describe('getBlueprintCoverStyle', () => {
  it('持久化的 coverStyle 指向死链时回退到按类型现取的封面', () => {
    const style = getBlueprintCoverStyle({
      blueprintType: 'BlueprintClass',
      thumbnail: undefined,
      coverStyle: LEGACY_DEAD_COVER_STYLE
    })
    expect(style).toBe(getCoverForType('BlueprintClass'))
    expect(style).not.toContain('file:')
  })

  it('环境无关的 coverStyle 原样使用', () => {
    const gradient = 'background: linear-gradient(135deg, #123, #456)'
    expect(getBlueprintCoverStyle({ blueprintType: 'BlueprintClass', coverStyle: gradient })).toBe(
      gradient
    )
  })

  it('有缩略图时优先用缩略图', () => {
    const style = getBlueprintCoverStyle({
      blueprintType: 'BlueprintClass',
      thumbnail: 'local-resource:///vault/pkg/cover.png',
      coverStyle: LEGACY_DEAD_COVER_STYLE
    })
    expect(style).toContain('local-resource:///vault/pkg/cover.png')
  })
})
