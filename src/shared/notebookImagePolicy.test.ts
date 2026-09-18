import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_READ_MAX,
  MAX_IMAGES_PER_SOURCE,
  MIN_IMAGES_PER_SOURCE,
  normalizeMaxImages
} from './notebookImagePolicy'

describe('normalizeMaxImages', () => {
  it('用户填的数原样用 —— 这个数不该被我们写死', () => {
    expect(normalizeMaxImages(1)).toBe(1)
    expect(normalizeMaxImages(3)).toBe(3)
    expect(normalizeMaxImages(20)).toBe(20)
    expect(normalizeMaxImages(50)).toBe(50)
  })

  it('挡手滑：0、负数、四位数都收进范围', () => {
    expect(normalizeMaxImages(0)).toBe(MIN_IMAGES_PER_SOURCE)
    expect(normalizeMaxImages(-5)).toBe(MIN_IMAGES_PER_SOURCE)
    expect(normalizeMaxImages(9999)).toBe(MAX_IMAGES_PER_SOURCE)
  })

  it('小数取整，别发出半张图的请求', () => {
    expect(normalizeMaxImages(3.7)).toBe(3)
  })

  it('填了不是数字的东西按出厂默认走，而不是变成 NaN 一张不读', () => {
    expect(normalizeMaxImages('abc')).toBe(DEFAULT_IMAGE_READ_MAX)
    expect(normalizeMaxImages(null)).toBe(DEFAULT_IMAGE_READ_MAX)
    expect(normalizeMaxImages(undefined)).toBe(DEFAULT_IMAGE_READ_MAX)
    // 空串走 Number() 会变成 0，跟着 clamp 就成了 1 —— 从没设过的用户每篇只读一张
    expect(normalizeMaxImages('')).toBe(DEFAULT_IMAGE_READ_MAX)
  })

  it('数字字符串也认 —— 设置表里存出来的可能是字符串', () => {
    expect(normalizeMaxImages('8')).toBe(8)
  })

  it('出厂默认落在合法范围里', () => {
    expect(DEFAULT_IMAGE_READ_MAX).toBeGreaterThanOrEqual(MIN_IMAGES_PER_SOURCE)
    expect(DEFAULT_IMAGE_READ_MAX).toBeLessThanOrEqual(MAX_IMAGES_PER_SOURCE)
  })
})
