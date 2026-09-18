/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowedMediaPath,
  assertVideoProject,
  contextPage,
  createVideoProject,
  conversationMessages,
  loadConversationVideoMessages
} from './project'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})
describe('task video context', () => {
  it('keeps original tool paths beside explicitly labeled context previews', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'task-video-original-'))
    dirs.push(root)
    const history = conversationMessages(
      {
        messagesBySid: {
          current: [
            {
              role: 'assistant',
              toolResults: [
                {
                  result: {
                    content: [
                      {
                        type: 'image',
                        mimeType: 'image/jpeg',
                        data: Buffer.from('preview').toString('base64')
                      }
                    ],
                    details: {
                      path: 'C:/original.png',
                      width: 2560,
                      height: 1440,
                      thinking: 'private'
                    }
                  }
                }
              ]
            }
          ]
        }
      },
      'current'
    )
    const project = await createVideoProject(root, 'current', history)
    const entry = project.entries[0]
    expect(entry.text).toContain('C:/original.png')
    expect(entry.text).not.toContain('private')
    expect(entry.imageNote).toContain('768px')
    expect(await fs.readFile(entry.images[0], 'utf8')).toBe('preview')
  })
  it('resolves the UI chat id from the host Agent id and refuses ambiguous mappings', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'task-video-mapping-'))
    dirs.push(root)
    const folder = path.join(root, 'chat-history')
    await fs.mkdir(folder)
    await fs.writeFile(
      path.join(folder, 'chat-messages.json'),
      JSON.stringify({
        messagesBySid: {
          'chat-a': [{ role: 'user', content: 'correct history' }],
          'agent-a': [{ role: 'user', content: 'wrong history' }]
        }
      })
    )
    const sessionsFile = path.join(folder, 'chat-sessions.json')
    await fs.writeFile(
      sessionsFile,
      JSON.stringify({ sessions: [{ id: 'chat-a', agentSessionId: 'agent-a' }] })
    )
    expect((await loadConversationVideoMessages(root, 'agent-a')).messages).toEqual([
      { role: 'user', content: 'correct history' }
    ])
    expect((await loadConversationVideoMessages(root, 'missing')).messages).toEqual([])
    await fs.writeFile(
      sessionsFile,
      JSON.stringify({
        sessions: [
          { id: 'chat-a', agentSessionId: 'agent-a' },
          { id: 'chat-b', agentSessionId: 'agent-a' }
        ]
      })
    )
    const ambiguous = await loadConversationVideoMessages(root, 'agent-a')
    expect(ambiguous.messages).toEqual([])
    expect(ambiguous.warning).toBeTruthy()
  })
  it('recovers early UI history and outcomes without crossing sessions or exposing reasoning', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'task-video-history-'))
    dirs.push(root)
    const history = conversationMessages(
      {
        messagesBySid: {
          current: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'early instruction' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
              ]
            },
            {
              role: 'assistant',
              content: 'finished',
              thinking: 'private reasoning',
              toolResults: [{ result: { video_path: 'C:/clip.mp4' } }],
              agentProcess: [{ type: 'tool-call', data: { arguments: 'do not copy' } }]
            }
          ],
          other: [{ role: 'user', content: 'another private conversation' }]
        }
      },
      'current'
    )
    const snapshot = await createVideoProject(root, 'current', history)
    const text = JSON.stringify(snapshot.entries)
    expect(text).toContain('early instruction')
    expect(text).toContain('C:/clip.mp4')
    expect(text).not.toContain('private')
    expect(text).not.toContain('do not copy')
    expect(await fs.readFile(snapshot.entries[0].images[0], 'utf8')).toBe('image')
  })
  it('persists visible history and image bytes, excluding thinking and tool arguments', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'task-video-test-'))
    dirs.push(root)
    const project = await createVideoProject(root, 'session-a', [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'toolCall', arguments: 'secret arguments' },
          { type: 'text', text: 'visible outcome' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: Buffer.from('image bytes').toString('base64')
          }
        ]
      }
    ])
    expect(project.entries[0].text).toBe('visible outcome')
    expect(await fs.readFile(project.entries[0].images[0], 'utf8')).toBe('image bytes')
    expect(await assertVideoProject(project.projectDir, 'session-a')).toBe(project.projectDir)
    await expect(assertVideoProject(project.projectDir, 'session-b')).rejects.toThrow(
      '不属于当前会话'
    )
    await expect(allowedMediaPath('relative.png')).rejects.toThrow('绝对路径')
  })
  it('pages a single huge tool result without losing its tail', () => {
    const entries = [{ index: 0, role: 'toolResult', text: 'x'.repeat(40000), images: [] }]
    let offset = 0
    let content = ''
    while (true) {
      const page = contextPage(entries, offset)
      expect(page.text.length).toBeLessThanOrEqual(12000)
      content += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(JSON.parse(content)).toEqual(entries[0])
  })
})
