/**
 * @vitest-environment node
 *
 * `ue_organize_actors` 的回执契约（AGENTS.md §5 第 14 条）：
 * 文件夹以插件读回的 actors[].folder_path 为准；count < total_found 时第一句报数；
 * 一个都没挪动不算成功。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { createOrganizeActorsTool, describeActualFolders } from './organizeActors'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown): Promise<ToolResult> =>
  (createOrganizeActorsTool() as unknown as Executable).execute(input)

const actor = (name: string, folder: string): Record<string, string> => ({
  name,
  class: 'PointLight',
  path: `/Game/Maps/Main.Main:PersistentLevel.${name}`,
  folder_path: folder
})

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('ue_organize_actors', () => {
  it('文件夹名跟引擎读回的走，不回显请求', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      total_found: 2,
      actors: [actor('L1', 'Lighting/Indoor'), actor('L2', 'Lighting/Indoor')]
    })

    const r = await run({ folder_path: '/Lighting/Indoor/', class: 'PointLight' })

    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('"Lighting/Indoor"')
    expect(String(r.message)).not.toContain('/Lighting/Indoor/')
    expect(String(r.message).startsWith('⚠️')).toBe(false)
  })

  it('count < total_found 时第一句是部分完成', async () => {
    callRequest.mockResolvedValue({
      count: 2,
      total_found: 3,
      actors: [actor('L1', 'Lighting'), actor('L2', 'Lighting')]
    })

    const r = await run({ folder_path: 'Lighting', class: 'PointLight' })

    const message = String(r.message)
    expect(message.startsWith('⚠️ 部分完成：2 个 Actor 成功 / 1 个 Actor 失败')).toBe(true)
    expect(message).toContain('另有 1 个')
    // 序列化后第一段就是 message
    expect(Object.keys(r)[0]).toBe('message')
  })

  it('一个都没挪动时不算成功', async () => {
    callRequest.mockResolvedValue({ count: 0, total_found: 4, actors: [] })

    const r = await run({ folder_path: 'Lighting', class: 'PointLight' })

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('一个都没移进文件夹')
  })

  it('读回的文件夹不一致时逐个列出', () => {
    expect(
      describeActualFolders([actor('A', 'X'), actor('B', 'Y'), actor('C', 'X')] as never, 'X')
    ).toBe('"X"（2 个）、"Y"（1 个）')
  })

  it('没有读回数据时标明是请求值', () => {
    expect(describeActualFolders([], 'Lighting')).toContain('未经引擎读回')
  })
})
