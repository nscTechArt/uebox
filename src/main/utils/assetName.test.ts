import { describe, expect, it } from 'vitest'

import {
  getAssetNameFromFileName,
  stripAssetNameExtension,
  stripPathLeafExtension
} from './assetName'

describe('assetName helpers', () => {
  it('strips normal file extensions without blanking dotfiles', () => {
    expect(stripAssetNameExtension('Hero.uasset')).toBe('Hero')
    expect(stripAssetNameExtension('archive.tar.gz')).toBe('archive.tar')
    expect(stripAssetNameExtension('.gitignore')).toBe('.gitignore')
    expect(stripAssetNameExtension('.env.local')).toBe('.env')
  })

  it('returns a non-empty fallback for empty names', () => {
    expect(getAssetNameFromFileName('')).toBe('unnamed')
  })

  it('strips only the leaf extension for soft paths', () => {
    expect(stripPathLeafExtension('/Game/Maps/Hero.umap')).toBe('/Game/Maps/Hero')
    expect(stripPathLeafExtension('/Game/Zen/Data/cas/.ucas_root')).toBe(
      '/Game/Zen/Data/cas/.ucas_root'
    )
    expect(stripPathLeafExtension('/Game.v1/Zen/Data/cas/.ucas_root')).toBe(
      '/Game.v1/Zen/Data/cas/.ucas_root'
    )
  })
})
