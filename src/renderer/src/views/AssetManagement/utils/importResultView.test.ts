/**
 * importResultView.test.ts — 导入结果的呈现
 *
 * 第一条用例是**红灯测试**：它断言的正是修复前必然失败的行为 ——
 * 3 个文件掉了 1 个，界面显示「成功：3」而且结果弹窗根本不弹。
 */
import { describe, expect, it } from 'vitest'

import { buildImportResultView } from './importResultView'

describe('buildImportResultView', () => {
  it.each(['prompt_timeout', 'prompt_unavailable'] as const)(
    'offers recovery for %s without counting it twice',
    (reason) => {
      const view = buildImportResultView({
        taskId: 'task',
        vaultId: 'vault',
        rootFolderPath: 'D:/source',
        total: 1,
        done: 1,
        outcome: { total: 1, succeeded: 0, failed: 0, skipped: 1, handled: 1 },
        skips: [{ reason, path: 'D:/source/a', fileName: 'a' }]
      })
      expect(view.retriableCount).toBe(1)
      expect(view.retryContext?.vaultId).toBe('vault')
      expect(view.failedCount).toBe(0)
      expect(view.skippedCount).toBe(1)
    }
  )
  it('does not silently retry an intentional skip', () => {
    const view = buildImportResultView({
      taskId: 'task',
      total: 1,
      done: 1,
      skips: [{ reason: 'user_skip', path: 'D:/a', fileName: 'a' }]
    })
    expect(view.retriableCount).toBe(0)
  })
  it.each(['failed', 'partial'] as const)(
    'remote %s cannot display local indexing as successful saving',
    (remoteSyncStatus) => {
      const view = buildImportResultView({
        taskId: 'remote',
        total: 10,
        done: 10,
        remoteSyncStatus,
        outcome: { total: 10, handled: 10, succeeded: 10, failed: 0, skipped: 0 }
      })
      expect(view).toMatchObject({
        open: true,
        severity: 'error',
        successCount: 0,
        unconfirmedCount: 10
      })
    }
  )

  it('unreadable directories remain visible and retry retains the original vault', () => {
    const view = buildImportResultView({
      taskId: 'scan',
      vaultId: 'original',
      rootFolderPath: 'D:/source',
      total: 1,
      done: 1,
      outcome: { total: 1, succeeded: 1, failed: 0, skipped: 0, handled: 1 },
      failures: [
        {
          stage: 'scan',
          fileName: 'locked',
          path: 'D:/source/locked',
          error: 'EACCES',
          retriable: true
        }
      ]
    })
    expect(view).toMatchObject({
      open: true,
      severity: 'warning',
      failedCount: 0,
      scanIssueCount: 1
    })
    expect(view.retryContext?.vaultId).toBe('original')
  })

  it('复制失败的文件必须报成失败，不能算进成功数', () => {
    const view = buildImportResultView({
      taskId: 'import:1',
      total: 3,
      done: 3, // ← 主进程旧口径把失败文件也数进 done 了
      failedCount: 0, // ← 旧口径的 failedCount 只统计预处理失败
      rootFolderPath: 'D:/src/11',
      targetFolderKey: null,
      outcome: { total: 3, succeeded: 2, failed: 1, skipped: 0, handled: 3 },
      failures: [
        {
          stage: 'copy_to_network',
          fileName: 'SM_Rock.uasset',
          path: 'D:/src/11/SM_Rock.uasset',
          targetPath: '//nas/vault/11/SM_Rock.uasset',
          error: 'ETIMEDOUT: connection timed out',
          code: 'ETIMEDOUT',
          attempts: 3,
          retriable: true
        }
      ],
      skips: []
    })

    expect(view.successCount).toBe(2) // 旧实现：done - failedCount = 3 ❌
    expect(view.failedCount).toBe(1)
    expect(view.open).toBe(true) // 旧实现：failedCount=0 且无报告 → 根本不弹 ❌
    expect(view.severity).toBe('error')
    expect(view.retriableCount).toBe(1)
    expect(view.retryContext).toEqual({
      taskId: 'import:1',
      rootFolderPath: 'D:/src/11',
      targetFolderKey: null
    })
  })

  it('用户主动跳过算 skipped，不算成功也不算失败', () => {
    const view = buildImportResultView({
      taskId: 'import:2',
      total: 2,
      done: 2,
      outcome: { total: 2, succeeded: 1, failed: 0, skipped: 1, handled: 2 },
      skips: [{ reason: 'user_skip', fileName: 'a.png', path: 'D:/a.png' }],
      rootFolderPath: 'D:/x'
    })

    expect(view.successCount).toBe(1)
    expect(view.skippedCount).toBe(1)
    expect(view.severity).toBe('warning')
    expect(view.open).toBe(true)
    // 跳过是用户自己的决定，不给重试按钮
    expect(view.retryContext).toBeUndefined()
  })

  it('覆盖确认超时同样计入跳过，并留下原因', () => {
    const view = buildImportResultView({
      taskId: 'import:3',
      total: 1,
      done: 1,
      outcome: { total: 1, succeeded: 0, failed: 0, skipped: 1, handled: 1 },
      skips: [{ reason: 'prompt_timeout', fileName: 'b.png', path: 'D:/b.png' }]
    })

    expect(view.skippedCount).toBe(1)
    expect(view.skips[0].reason).toBe('prompt_timeout')
    expect(view.open).toBe(true)
  })

  it('不可重试的失败不给重试按钮', () => {
    const view = buildImportResultView({
      taskId: 'import:4',
      total: 1,
      done: 1,
      rootFolderPath: 'D:/src',
      outcome: { total: 1, succeeded: 0, failed: 1, skipped: 0, handled: 1 },
      failures: [
        {
          stage: 'copy_to_network',
          fileName: 'gone.uasset',
          path: 'D:/src/gone.uasset',
          error: 'ENOENT: no such file',
          code: 'ENOENT',
          retriable: false
        }
      ]
    })

    expect(view.failedCount).toBe(1)
    expect(view.retriableCount).toBe(0)
    expect(view.retryContext).toBeUndefined()
  })

  it('全部成功时不打扰用户', () => {
    const view = buildImportResultView({
      taskId: 'import:5',
      total: 2,
      done: 2,
      outcome: { total: 2, succeeded: 2, failed: 0, skipped: 0, handled: 2 }
    })

    expect(view.open).toBe(false)
    expect(view.severity).toBe('success')
  })

  it('取消导入时失败数要如实显示，不能显示成 0', () => {
    const view = buildImportResultView({
      taskId: 'import:cancel',
      total: 0,
      done: 0,
      failedCount: 5,
      failedFiles: [{ fileName: 'a.uasset', path: 'D:/a.uasset', error: '已取消' }],
      isCancelled: true
    })

    // 旧实现：failedCount 被塞进 readFailedCount，而弹窗的取消分支读 failedCount
    //         → 明明掉了 5 个文件，界面上写着 0
    expect(view.isCancelled).toBe(true)
    expect(view.failedCount).toBe(5)
    expect(view.open).toBe(true)
    expect(view.severity).toBe('error')
  })

  it('取消即使没有错误也保留结果供用户核对', () => {
    const view = buildImportResultView({
      taskId: 'import:cancel2',
      total: 0,
      done: 0,
      failedCount: 0,
      isCancelled: true
    })

    expect(view.open).toBe(true)
    expect(view.isCancelled).toBe(true)
  })

  it('缺 outcome 的旧 payload 有回退分支，不会崩', () => {
    const view = buildImportResultView({
      taskId: 'import:6',
      total: 5,
      done: 5,
      failedCount: 1,
      failedFiles: [{ fileName: 'x', path: 'D:/x', error: 'parse failed' }]
    })

    expect(view.successCount).toBe(4)
    expect(view.readFailedCount).toBe(1)
    expect(view.open).toBe(true)
  })
})
