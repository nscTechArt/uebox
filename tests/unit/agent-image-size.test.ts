/**
 * 图片文件大小限制测试
 */
import { describe, it, expect } from 'vitest'
import { isFileSizeValid, getMaxImageSizeText } from '../../src/renderer/src/utils/imageUpload'

/** 创建指定大小的 mock File */
function createMockFile(sizeBytes: number, name = 'test.png'): File {
  const buffer = new ArrayBuffer(sizeBytes)
  return new File([buffer], name, { type: 'image/png' })
}

// ═══════════════════════════════════════════════════════════════════
//                    通用限制不受影响
// ═══════════════════════════════════════════════════════════════════

describe('isFileSizeValid — 通用限制不受影响', () => {
  it('✅ 50MB 通过', () => {
    expect(isFileSizeValid(createMockFile(50 * 1024 * 1024))).toBe(true)
  })

  it('❌ 101MB 被拦截', () => {
    expect(isFileSizeValid(createMockFile(101 * 1024 * 1024))).toBe(false)
  })
})

describe('getMaxImageSizeText', () => {
  it('非 Agent 模式显示 100MB', () => {
    expect(getMaxImageSizeText()).toBe('100MB')
  })
})
