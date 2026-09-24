/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { migrateTool } from './migrate'
import type { MigrateResponse } from './types'

function response(partial: Partial<MigrateResponse> = {}): MigrateResponse {
  return {
    ok: true,
    dry_run: false,
    destination_content_dir: 'D:/Other/Content',
    root_count: 1,
    planned: 0,
    copied: 3,
    skipped: 1,
    failed: 0,
    external_skipped: 1,
    total_bytes: 5 * 1024 * 1024,
    files: [
      { package: '/Game/Props/SM_Rock', status: 'copied', bytes: 1024, is_root: true },
      { package: '/Game/Props/M_Rock', status: 'copied', bytes: 1024, is_root: false },
      { package: '/Game/Shared/T_Rock', status: 'skipped_exists', bytes: 1024, is_root: false },
      {
        package: '/MyPlugin/T_Extra',
        status: 'external_skipped',
        bytes: 0,
        is_root: false,
        error: 'no such plugin'
      }
    ],
    files_truncated: false,
    notes: [],
    elapsed_ms: 42,
    ...partial
  }
}

const run = async (input: Record<string, unknown>, out: MigrateResponse): Promise<string> => {
  callRequest.mockResolvedValueOnce(out)
  const result = await migrateTool.execute('c1', {
    paths: ['/Game/Props/SM_Rock'],
    destination: 'D:/Other/Other.uproject',
    ...input
  })
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_content_migrate', () => {
  it('会写别的工程的磁盘 → mutating、串行', () => {
    expect(migrateTool.unrealBox.risk).toBe('mutating')
    expect(migrateTool.name).toBe('ue_content_migrate')
  })

  it('参数透传，超时给足半小时', async () => {
    await run({ dry_run: true }, response({ dry_run: true, copied: 0, planned: 3 }))
    expect(callRequest.mock.calls[0][0]).toBe('content.migrate')
    expect(callRequest.mock.calls[0][1]).toEqual({
      paths: ['/Game/Props/SM_Rock'],
      destination: 'D:/Other/Other.uproject',
      dry_run: true
    })
    expect(callRequest.mock.calls[0][3]).toBe(30 * 60 * 1000)
  })

  it('摘要：拷了多少、跳过多少、插件内容没拷的单独列', async () => {
    const text = await run({}, response())
    expect(text).toContain('已拷贝 3 个文件（5.0 MB）到 D:/Other/Content')
    expect(text).toContain('跳过 1')
    expect(text).toContain('插件内容跳过 1')
    expect(text).toContain('/Game/Props/SM_Rock：copied')
    expect(text).toContain('/MyPlugin/T_Extra：external_skipped —— no such plugin')
  })

  it('预演明说没有拷贝', async () => {
    const text = await run({ dry_run: true }, response({ dry_run: true, copied: 0, planned: 3 }))
    expect(text).toContain('预演，没有拷贝任何文件')
    expect(text).toContain('共 3 个文件')
  })

  it('断链和未保存的源要说出来', async () => {
    const text = await run(
      {},
      response({ missing: ['/Game/Gone/T_Old'], unsaved_sources: ['/Game/Props/M_Rock'] })
    )
    expect(text).toContain('断链依赖')
    expect(text).toContain('/Game/Gone/T_Old')
    expect(text).toContain('有未保存改动的源资产：1 个')
  })
})

/**
 * 插件只要有一个文件没拷成就回 ok:false 且不带顶层 error。以前走 callUe，
 * 整份响应被压成「content.migrate 失败：未提供失败原因」，拷过去的数量和逐文件原因全丢。
 */
describe('ue_content_migrate 部分失败', () => {
  const failedFile = {
    package: '/Game/Props/T_Big',
    status: 'failed' as const,
    bytes: 0,
    is_root: false,
    error: 'Copy failed (result=1, dest size -1 vs source 4096)'
  }

  it('拷了一半：不抛，第一句是部分完成，失败原因逐条列出', async () => {
    const text = await run(
      {},
      response({
        ok: false,
        copied: 3,
        failed: 1,
        files: [...response().files, failedFile]
      })
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe('⚠️ 部分完成：3 个文件成功 / 1 个文件失败。')
    expect(text).toContain('已拷贝 3 个文件')
    expect(text).toContain('/Game/Props/T_Big：Copy failed')
    expect(text).not.toContain('未提供失败原因')
  })

  it('一个都没拷成才算失败，原因带上', async () => {
    callRequest.mockResolvedValueOnce(
      response({ ok: false, copied: 0, skipped: 0, failed: 1, files: [failedFile] })
    )
    await expect(
      migrateTool.execute('c1', { paths: ['/Game/Props/T_Big'], destination: 'D:/Other' })
    ).rejects.toThrow(/一个文件都没拷成[\s\S]*Copy failed/)
  })

  it('全部因为目标已存在而跳过：插件回 ok:false，但这不是失败', async () => {
    const text = await run({}, response({ ok: false, copied: 0, skipped: 4, failed: 0 }))
    expect(text).toContain('已拷贝 0 个文件')
    expect(text).toContain('跳过 4')
    expect(text).not.toContain('部分完成')
  })

  it('参数错这类没有 files 的 ok:false 照旧抛，原因不丢', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      error: "on_conflict must be 'skip' or 'overwrite'",
      __rpc: { code: 400 }
    })
    await expect(
      migrateTool.execute('c1', { paths: ['/Game/A'], destination: 'D:/Other' })
    ).rejects.toThrow(/on_conflict must be[\s\S]*400/)
  })
})
