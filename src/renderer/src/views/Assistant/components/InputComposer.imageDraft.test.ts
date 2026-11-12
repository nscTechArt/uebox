import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer per-session image drafts', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')

  it('reads the pending images from the current conversation and writes every list change back', () => {
    expect(composer).toContain('chatSessionsStore.getImageDraft(props.chatSid)')
    expect(composer).toContain('chatSessionsStore.trySetImageDraft(props.chatSid, images)')
    expect(composer).toContain('replacePendingImages([...pendingImages.value, pendingImage])')
    expect(composer).toContain(
      'replacePendingImages(pendingImages.value.filter((_, imageIndex) => imageIndex !== index))'
    )
    expect(composer).toContain('replacePendingImages([])')
  })

  it('restores the parent layout state when a tab returns with pending images', () => {
    expect(composer).toMatch(
      /watch\(\s*\(\) => pendingImages\.value\.length,[\s\S]*?\{ immediate: true \}\s*\)/
    )
  })

  // 图片草稿不落盘、存盘清单是哪几项，由 store/modules/persistPick.test.ts 读真实存储来验证
})
