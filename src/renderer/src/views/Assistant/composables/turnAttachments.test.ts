/**
 * 守的是那次真机事故：用户拖了一段视频问「视频里有什么」，模型回「没看到视频文件或路径」。
 *
 * 两层原因，这里各钉一条：
 * - 附件上下文作为单独一条推进历史，而内核只收最后一条 —— 并进用户那条才到得了模型。
 * - 视频要带着**路径**过去，agent 才能自己用 `analyze_video` 去看。
 */

import { describe, expect, it } from 'vitest'

import { bubbleAttachments, describeMediaFiles, mergeTurnContext } from './turnAttachments'

describe('describeMediaFiles', () => {
  it('把本地路径原样交给 agent，并指明用哪个工具看', () => {
    const note = describeMediaFiles([
      { filePath: 'D:\\素材\\9月19日.mp4', fileName: '9月19日.mp4', kind: 'video' },
      { filePath: 'D:\\素材\\旁白.m4a', fileName: '旁白.m4a', kind: 'audio' }
    ])

    expect(note).toContain('视频：9月19日.mp4（本地路径：D:\\素材\\9月19日.mp4）')
    expect(note).toContain('音频：旁白.m4a（本地路径：D:\\素材\\旁白.m4a）')
    expect(note).toContain('analyze_video')
  })

  it('没有音视频就不产出任何东西', () => {
    expect(describeMediaFiles([])).toBeUndefined()
  })
})

describe('mergeTurnContext', () => {
  it('附件放在用户的话前面，并成同一条', () => {
    const merged = mergeTurnContext('视频里有什么', ['【用户附带的音视频】\n- 视频：a.mp4'])

    expect(typeof merged).toBe('string')
    expect(merged).toContain('a.mp4')
    expect((merged as string).endsWith('视频里有什么')).toBe(true)
  })

  it('用户只拖了附件没打字，也照样带过去', () => {
    expect(mergeTurnContext('', ['附件说明'])).toContain('附件说明')
  })

  it('带图的消息保留图片，附件文本插在最前面', () => {
    const merged = mergeTurnContext(
      [
        { type: 'text', text: '看看这张' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }
      ],
      ['附件说明']
    )

    expect(Array.isArray(merged)).toBe(true)
    const items = merged as Exclude<typeof merged, string>
    expect(items[0].text).toContain('附件说明')
    expect(items[1].text).toBe('看看这张')
    expect(items[2].type).toBe('image_url')
  })

  it('没有附件时原样返回，不改消息形状', () => {
    const content = [{ type: 'text' as const, text: 'hi' }]
    expect(mergeTurnContext(content, [])).toBe(content)
    expect(mergeTurnContext('hi', ['  '])).toBe('hi')
  })
})

describe('bubbleAttachments', () => {
  it('Excel、文档、音视频合成一排，各自带上种类', () => {
    expect(
      bubbleAttachments(
        [{ fileName: '表.xlsx', rowCount: 3 }],
        [
          { fileName: '说明.pdf', kind: 'document' },
          { fileName: 'clip.mp4', kind: 'video' }
        ]
      )
    ).toEqual([
      { fileName: '表.xlsx', rowCount: 3, kind: 'excel' },
      { fileName: '说明.pdf', kind: 'document' },
      { fileName: 'clip.mp4', kind: 'video' }
    ])
  })

  it('什么都没有就不挂这一排', () => {
    expect(bubbleAttachments(undefined, [])).toBeUndefined()
  })
})
