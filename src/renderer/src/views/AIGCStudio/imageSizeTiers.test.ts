import { describe, expect, it } from 'vitest'
import { GPT_IMAGE_MODEL } from '../../../../shared/imageGenerationModels'
import {
  getActiveSizeTier,
  getResolutionPixels,
  getSizeTierOptions,
  resolveResolutionForRatio,
  resolveResolutionForTier
} from './imageSizeTiers'

describe('getSizeTierOptions', () => {
  it('只列出比例对得上的像素尺寸', () => {
    expect(getSizeTierOptions(GPT_IMAGE_MODEL, '1:1')).toEqual([
      { tier: 'auto', resolution: 'auto', pixels: null },
      { tier: '1K', resolution: '1024x1024', pixels: '1024x1024' },
      { tier: '2K', resolution: '2048x2048', pixels: '2048x2048' }
    ])
    expect(getSizeTierOptions(GPT_IMAGE_MODEL, '16:9')).toEqual([
      { tier: 'auto', resolution: 'auto', pixels: null },
      { tier: '2K', resolution: '2048x1152', pixels: '2048x1152' },
      { tier: '4K', resolution: '3840x2160', pixels: '3840x2160' }
    ])
  })

  it('比例只有一个尺寸时就只给一个档位', () => {
    expect(getSizeTierOptions(GPT_IMAGE_MODEL, '3:2').map((opt) => opt.tier)).toEqual([
      'auto',
      '1K'
    ])
    expect(getSizeTierOptions(GPT_IMAGE_MODEL, '9:16').map((opt) => opt.tier)).toEqual([
      'auto',
      '4K'
    ])
  })
})

describe('getActiveSizeTier', () => {
  it('把像素尺寸归到它的大小档位上', () => {
    expect(getActiveSizeTier(GPT_IMAGE_MODEL, '1024x1024')).toBe('1K')
    expect(getActiveSizeTier(GPT_IMAGE_MODEL, '2048x1152')).toBe('2K')
    expect(getActiveSizeTier(GPT_IMAGE_MODEL, '3840x2160')).toBe('4K')
    expect(getActiveSizeTier(GPT_IMAGE_MODEL, 'auto')).toBe('auto')
  })
})

describe('getResolutionPixels', () => {
  it('只有具体像素才有像素可显示', () => {
    expect(getResolutionPixels(GPT_IMAGE_MODEL, '1536x1024')).toBe('1536x1024')
    expect(getResolutionPixels(GPT_IMAGE_MODEL, 'auto')).toBeNull()
  })
})

describe('resolveResolutionForTier', () => {
  it('按比例给出该档位的尺寸', () => {
    expect(resolveResolutionForTier(GPT_IMAGE_MODEL, '16:9', '4K', 'auto')).toBe('3840x2160')
  })

  it('该比例下没有这个档位就回落到第一个', () => {
    expect(resolveResolutionForTier(GPT_IMAGE_MODEL, '3:2', '4K', 'auto')).toBe('auto')
  })
})

describe('resolveResolutionForRatio', () => {
  it('换比例时守住已经选好的档位', () => {
    expect(resolveResolutionForRatio(GPT_IMAGE_MODEL, '16:9', '2048x2048')).toBe('2048x1152')
  })

  it('新比例没有那个档位时才回落', () => {
    expect(resolveResolutionForRatio(GPT_IMAGE_MODEL, '16:9', '1024x1024')).toBe('auto')
  })
})
