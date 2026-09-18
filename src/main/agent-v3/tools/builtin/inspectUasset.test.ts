/**
 * @vitest-environment node
 *
 * 离线读包。这个工具存在的理由是「编辑器崩了也要能问出磁盘上是什么」，
 * 所以下面几条都是**结论会被拿去做决定**的性质：
 *   - 认出重定向器（旧路径上那个小文件到底是不是转发桩）
 *   - 类名要从 classIndex 正确解引用到 imports，别报错类型
 *   - 解析不了要说解析不了，不能沉默或者装作查到了
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const analyzeFromFile = vi.fn()
vi.mock('../../../utils/uasset-reader-new', () => ({
  analyzeFromFile: (...args: unknown[]) => analyzeFromFile(...args)
}))
vi.mock('./accessScope', () => ({ assertInAccessScope: async () => undefined }))
vi.mock('./pathBoundary', () => ({ assertPathAllowed: () => undefined }))

import { createInspectUassetTool } from './inspectUasset'

type Executable = {
  execute: (
    id: string,
    input: unknown
  ) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>
}

let dir: string
let file: string

const run = async (): Promise<{ text: string; details: Record<string, unknown> }> => {
  const tool = createInspectUassetTool() as unknown as Executable
  const result = await tool.execute('c1', { path: file })
  return {
    text: result.content.map((c) => ('text' in c ? c.text : '')).join(''),
    details: (result.details ?? {}) as Record<string, unknown>
  }
}

beforeEach(async () => {
  analyzeFromFile.mockReset()
  dir = await fs.mkdtemp(path.join(tmpdir(), 'ual-inspect-'))
  file = path.join(dir, 'SM_Rock.uasset')
  await fs.writeFile(file, Buffer.alloc(2048, 1))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('inspect_uasset_file', () => {
  it('是只读工具', () => {
    const tool = createInspectUassetTool()
    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.name).toBe('inspect_uasset_file')
  })

  it('从 classIndex 解引用出类名，并列出 /Game 引用', async () => {
    analyzeFromFile.mockResolvedValue({
      imports: {
        Imports: [
          { objectName: 'StaticMesh', packageName: '/Script/Engine' },
          { objectName: '/Game/Materials/M_Rock', packageName: '/Game/Materials/M_Rock' }
        ]
      },
      // classIndex = -1 指 imports[0]
      exports: [{ classIndex: -1, objectName: 'SM_Rock', bIsAsset: true }]
    })

    const { text, details } = await run()

    expect(text).toContain('类型：StaticMesh')
    expect(text).toContain('/Game/Materials/M_Rock')
    expect(details.class).toBe('StaticMesh')
    expect(details.is_redirector).toBe(false)
  })

  /**
   * 这一条是这个工具的核心用途：崩溃之后旧路径上剩一个 1.3 KB 的文件，
   * 「它是不是重定向器」原来只能靠文件大小猜。
   */
  it('认出重定向器，并说清它意味着什么', async () => {
    analyzeFromFile.mockResolvedValue({
      imports: {
        Imports: [
          { objectName: 'ObjectRedirector', packageName: '/Script/CoreUObject' },
          { objectName: '/Game/Props/SM_Rock', packageName: '/Game/Props/SM_Rock' }
        ]
      },
      exports: [{ classIndex: -1, objectName: 'rock', bIsAsset: true }]
    })

    const { text, details } = await run()

    expect(details.is_redirector).toBe(true)
    expect(text).toContain('重定向器')
    expect(text).toContain('/Game/Props/SM_Rock')
  })

  it('软引用单独列出来', async () => {
    analyzeFromFile.mockResolvedValue({
      imports: { Imports: [{ objectName: 'World', packageName: '/Script/Engine' }] },
      exports: [{ classIndex: -1, objectName: 'L_Main', bIsAsset: true }],
      softPackageReferences: [{ assetPathName: '/Game/Props/SM_Rock' }]
    })

    const { text, details } = await run()

    expect(text).toContain('软引用')
    expect(details.soft_references).toEqual(['/Game/Props/SM_Rock'])
  })

  // isError 的产出会被 defineTool 转成 ToolFailure 抛出来，所以这两条查异常文本
  it('解析失败时说失败，并把磁盘上的事实照给', async () => {
    analyzeFromFile.mockResolvedValue({ stack: 'boom', message: '版本不支持' })

    await expect(run()).rejects.toThrow(/解析不了[\s\S]*2048/)
  })

  it('文件不在就直说，不去解析', async () => {
    const tool = createInspectUassetTool() as unknown as Executable

    await expect(tool.execute('c1', { path: path.join(dir, 'nope.uasset') })).rejects.toThrow(
      '文件不存在'
    )
    expect(analyzeFromFile).not.toHaveBeenCalled()
  })
})
