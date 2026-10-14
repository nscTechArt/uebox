import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatSessionFiles, fileNameFor } from './chatSessionFiles'

let root: string
let dir: string
let legacy: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-sessions-'))
  dir = join(root, 'sessions')
  legacy = join(root, 'chat-messages.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const progress = (n: number): unknown => ({
  type: 'notify-users',
  data: {
    message: `输出 ${n}`,
    notifyType: 'progress',
    toolCallId: 'c1',
    toolName: 'run_shell_command'
  },
  timestamp: n
})

describe('ChatSessionFiles', () => {
  it('把旧的单文件拆成一个对话一个文件，顺带收拢进度，原文件留作备份', async () => {
    writeFileSync(
      legacy,
      JSON.stringify({
        messagesBySid: {
          a: [
            { id: 'u', role: 'user', content: 'hi', status: 'done' },
            {
              id: 't',
              role: 'assistant',
              content: '…',
              status: 'typing',
              agentProcess: [progress(1), progress(2)]
            }
          ],
          b: []
        },
        historySummaryBySid: { a: '摘要' },
        compressedUserCountBySid: { a: 2 }
      })
    )
    const files = new ChatSessionFiles(dir, legacy)

    const index = await files.open()

    expect(Object.keys(index).sort()).toEqual(['a', 'b'])
    expect(index.a.typing).toEqual(['t'])
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(`${legacy}.migrated`)).toBe(true)
    const a = JSON.parse(files.readSync('a')!)
    expect(a).toMatchObject({ sid: 'a', historySummary: '摘要', compressedUserCount: 2 })
    expect(a.messages[1].agentProcess).toEqual([progress(2)])
  })

  it('写、读、删，索引跟着走；索引丢了能从文件重建', async () => {
    const files = new ChatSessionFiles(dir, legacy)
    await files.open()
    await files.write([
      { sid: 'a', json: JSON.stringify({ sid: 'a', messages: [] }) },
      { sid: 'odd/sid:*', json: JSON.stringify({ sid: 'odd/sid:*', messages: [] }), typing: ['x'] }
    ])
    expect(fileNameFor('odd/sid:*')).toMatch(/^h_[0-9a-f]+\.json$/)
    expect(await files.readMany(['a', 'missing'])).toEqual({ a: '{"sid":"a","messages":[]}' })

    await files.write([{ sid: 'a', json: null }])
    expect(files.readSync('a')).toBeNull()

    rmSync(join(dir, 'index.json'))
    const reopened = await new ChatSessionFiles(dir, legacy).open()
    expect(Object.keys(reopened)).toEqual(['odd/sid:*'])
  })

  it('索引里没登记的对话照样按文件名读得到', async () => {
    const files = new ChatSessionFiles(dir, legacy)
    await files.open()
    await files.write([{ sid: 'a', json: '{"sid":"a","messages":[]}' }])
    // 模拟「文件写成了、索引没跟上」
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, sessions: {} }))

    const reopened = new ChatSessionFiles(dir, legacy)
    expect(reopened.readSync('a')).toBe('{"sid":"a","messages":[]}')
    expect(await reopened.readMany(['a'])).toEqual({ a: '{"sid":"a","messages":[]}' })
  })

  it('拆到一半失败时旧文件留在原处，下次启动接着拆', async () => {
    writeFileSync(legacy, JSON.stringify({ messagesBySid: { a: [], b: [] } }))
    const files = new ChatSessionFiles(dir, legacy)
    // 让 b 那个文件写不进去：同名占一个目录
    mkdirSync(join(dir, 'b.json.tmp'), { recursive: true })

    await files.open()
    expect(existsSync(legacy)).toBe(true)

    rmSync(join(dir, 'b.json.tmp'), { recursive: true })
    const index = await new ChatSessionFiles(dir, legacy).open()
    expect(Object.keys(index).sort()).toEqual(['a', 'b'])
    expect(existsSync(legacy)).toBe(false)
  })

  it('旧文件读不进来也挪开，不会每次启动都再试', async () => {
    writeFileSync(legacy, '{坏的')
    const files = new ChatSessionFiles(dir, legacy)

    expect(await files.open()).toEqual({})
    expect(readFileSync(`${legacy}.migrated`, 'utf8')).toBe('{坏的')
  })
})
