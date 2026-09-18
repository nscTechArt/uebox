import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer per-session image drafts', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const sessions = read('src/renderer/src/store/modules/chatSessions.ts')

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

  it('keeps image drafts memory-only and outside persisted session data', () => {
    const persistPaths = sessions.match(/paths:\s*\[([^\]]+)\]/)?.[1] || ''

    expect(sessions).toContain('const imageDraftsById = ref<Record<string, ChatImageDraft[]>>({})')
    expect(persistPaths).not.toContain('imageDraftsById')

    // 钉住整张存盘清单，而不是「不许出现 draftsById」—— 文字草稿是 a4e05f7 起
    // **故意**存盘的（打了半段话关掉应用，那段话不该没）。图片草稿仍然不许进：
    // 它是 base64，几张截图就能把这块存储顶爆。往这张单子里加东西要有意为之。
    expect(persistPaths.replace(/[\s']/g, '').split(',')).toEqual([
      'sessions',
      'permissionModeById',
      'draftsById'
    ])
  })
})
