import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { h, ref, type VNode } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { summarizeBlockedAssets } from './utils/blockedAssetsSummary'

/**
 * 版本冲突弹窗的按钮画在自定义 footer 里，测试得自己把它渲出来点一下。
 *
 * 按钮的文案是插槽函数。这里把 AppButton 换成了普通元素，Vue 对元素会当场把插槽求值
 * 成字符串；换成组件则留成 `{ default: fn }`。三种形态都认一下，别让脚手架挑实现。
 */
function footerButtons(options: { footer: () => VNode }): Map<string, () => void> {
  const children = options.footer().children as Array<VNode | null>
  const buttons = new Map<string, () => void>()
  for (const node of children) {
    if (!node) continue
    const slots = node.children as string | (() => string) | { default?: () => string }
    const label =
      typeof slots === 'string' ? slots : typeof slots === 'function' ? slots() : slots?.default?.()
    if (label) buttons.set(label, (node.props as { onClick: () => void }).onClick)
  }
  return buttons
}

// Execute production handlers with controlled event ordering and no real project writes.
function handlers(
  file: string,
  names: string[],
  context: Record<string, unknown>
): Record<string, (...args: unknown[]) => unknown> {
  const source = parse(readFileSync(`src/renderer/src/${file}`, 'utf8')).descriptor.scriptSetup!
    .content
  const ast = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = ast.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))
  )
  const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join('\n;\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(context), `${code}; return {${names.join(',')}}`)(
    ...Object.values(context)
  )
}

describe('project import screenshot regressions', () => {
  it('known version failures open project selection without retrying the same project', async () => {
    const chooseCompatibleProject = vi.fn()
    const checkImportCompatibility = vi.fn()
    const { handleImportRetry } = handlers('layout/MainLayout.vue', ['handleImportRetry'], {
      inspectingTask: ref({ retry: { project: {}, sources: [] } }),
      retrying: ref(false),
      hasVersionConflict: ref(true),
      chooseCompatibleProject,
      checkImportCompatibility
    })
    await handleImportRetry()
    expect(chooseCompatibleProject).toHaveBeenCalledOnce()
    expect(checkImportCompatibility).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'explicit partial import excludes rejected assets (cancelled=%s)',
    async (cancelled) => {
      const importUAssetsBatch = vi.fn(async () => ({
        success: true,
        succeeded: cancelled ? 0 : 1,
        cancelled
      }))
      const events = new EventTarget()
      const completion = vi.fn()
      events.addEventListener('project-import:complete', completion)
      const visible = ref(true)
      const { doFolderImport } = handlers(
        'views/AssetManagement/components/modals/ImportToProjectModal.vue',
        // describeBlockedAssets / askVersionConflict 是 doFolderImport 的依赖，跑真的那份
        ['describeBlockedAssets', 'askVersionConflict', 'doFolderImport'],
        {
          summarizeBlockedAssets,
          h,
          AppButton: 'button',
          checkImportCompatibility: async () => ({
            projectVersion: '5.1',
            blocked: [{ assetKey: 'new', assetName: 'Fog', version: '5.2' }]
          }),
          confirmDialog: (options: { footer: () => VNode }) => {
            footerButtons(options).get('importToProjectModal.importCompatibleOnly')!()
            return { destroy: vi.fn() }
          },
          t: (key: string) => key,
          visible,
          stats: {},
          message: { info: vi.fn() },
          window: Object.assign(events, {
            api: {
              projectImport: {
                importUAssetsBatch,
                onImportUAssetsBatchProgress: () => vi.fn()
              }
            }
          })
        }
      )
      await doFolderImport(
        { projectName: 'Test' },
        [{ assetKey: 'new' }, { assetKey: 'old' }],
        [],
        true
      )
      expect(importUAssetsBatch).toHaveBeenCalledWith(
        { projectName: 'Test' },
        [{ assetKey: 'old', assetName: '', skipDependencyResolution: false }],
        expect.objectContaining({ requestId: expect.any(String) })
      )
      expect(visible.value).toBe(false)
      expect(completion.mock.calls[0][0].detail.status).toBe(cancelled ? 'error' : 'completed')
    }
  )

  it('completion wins over a queued frame and the next task can still schedule progress', () => {
    const task = { status: 'running', progress: 0 }
    const tasks = new Map([
      ['first', task],
      ['next', { status: 'running', progress: 0 }]
    ])
    const frames: Array<() => void> = []
    const api = handlers(
      'views/AssetManagement/index.vue',
      [
        'progressFlushScheduled',
        'pendingProgressMap',
        'flushPendingProgress',
        'batchUpdateProgress',
        'handleProjectImportComplete'
      ],
      {
        importTasksMap: ref(tasks),
        requestAnimationFrame: (callback: () => void) => frames.push(callback),
        updateImportTask: (id: string, patch: object) => Object.assign(tasks.get(id)!, patch)
      }
    )
    api.batchUpdateProgress('first', { percent: 50 })
    api.handleProjectImportComplete({ detail: { id: 'first', status: 'error' } })
    frames.shift()!()
    api.batchUpdateProgress('first', { percent: 50 })
    expect(task).toMatchObject({ status: 'error', progress: 100 })
    api.batchUpdateProgress('next', { percent: 20 })
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(tasks.get('next')?.progress).toBe(20)
  })

  it.each([50, 100])('a failed task at %s percent does not cover the folder', (progress) => {
    const { getProjectImportTask } = handlers(
      'views/AssetManagement/components/AssetFileList.vue',
      ['getProjectImportTask'],
      {
        completedProjectImportFolders: new Map(),
        props: {
          importTasks: [
            { taskType: 'project-import', status: 'error', progress, sourceFolderKeys: ['folder'] }
          ]
        }
      }
    )
    expect(getProjectImportTask('folder')).toBeUndefined()
  })

  it('retry cancellation reaches the new request and cleans up its listener', async () => {
    const task = {
      id: 'failed',
      retry: { project: {}, sources: [{ assetKey: 'asset' }] },
      retryCoversAll: true
    }
    let finish!: (value: object) => void
    const importUAssetsBatch = vi.fn<
      (project: unknown, sources: unknown, options: { requestId: string }) => Promise<object>
    >(
      () =>
        new Promise<object>((resolve) => {
          finish = resolve
        })
    )
    const cancelImportUAssetsBatch = vi.fn()
    const unsubscribe = vi.fn()
    const events = new EventTarget()
    const dismiss = vi.fn()
    const updateTask = vi.fn()
    const { handleImportRetry } = handlers('layout/MainLayout.vue', ['handleImportRetry'], {
      inspectingTask: ref(task),
      retrying: ref(false),
      hasVersionConflict: ref(false),
      checkImportCompatibility: async () => ({ blocked: [] }),
      window: Object.assign(events, {
        api: {
          projectImport: {
            importUAssetsBatch,
            cancelImportUAssetsBatch,
            onImportUAssetsBatchProgress: () => unsubscribe
          }
        }
      }),
      importTasksStore: { updateTask },
      handleImportTaskDismiss: dismiss,
      isCleanImportReport: () => true,
      message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
      t: (key: string) => key
    })
    const pending = handleImportRetry()
    await vi.waitFor(() => expect(importUAssetsBatch).toHaveBeenCalledOnce())
    events.dispatchEvent(new CustomEvent('project-import:cancel', { detail: { id: 'different' } }))
    expect(cancelImportUAssetsBatch).not.toHaveBeenCalled()
    events.dispatchEvent(new CustomEvent('project-import:cancel', { detail: { id: task.id } }))
    expect(cancelImportUAssetsBatch).toHaveBeenCalledWith(
      importUAssetsBatch.mock.calls[0][2].requestId
    )
    finish({ success: true, cancelled: true })
    await pending
    expect(dismiss).not.toHaveBeenCalled()
    expect(updateTask).toHaveBeenLastCalledWith(
      task.id,
      expect.objectContaining({ status: 'error', progress: 100 })
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    events.dispatchEvent(new CustomEvent('project-import:cancel', { detail: { id: task.id } }))
    expect(cancelImportUAssetsBatch).toHaveBeenCalledOnce()
  })

  /**
   * 版本冲突弹窗：点哪个按钮，最后就该导哪些资产。
   *
   * `clicks` 里是按钮文案（t 被换成恒等函数，所以就是 i18n 的 key）。
   * 返回 importUAssetsBatch 实际收到的资产，没导成就是 null。
   */
  async function runVersionConflict(options: {
    unrealAssets: Array<{ assetKey: string }>
    click: string | null
  }): Promise<{ imported: Array<{ assetKey: string }> | null; buttons: string[] }> {
    const importUAssetsBatch = vi.fn(async () => ({ success: true, succeeded: 1 }))
    const events = new EventTarget()
    let buttons: string[] = []
    const confirmDialog = vi.fn((dialogOptions) => {
      const actions = footerButtons(dialogOptions)
      buttons = [...actions.keys()]
      if (options.click) actions.get(options.click)!()
      else dialogOptions.afterClose()
      return { destroy: vi.fn() }
    })
    const { doFolderImport } = handlers(
      'views/AssetManagement/components/modals/ImportToProjectModal.vue',
      // describeBlockedAssets / askVersionConflict 是 doFolderImport 的依赖，跑真的那份
      ['describeBlockedAssets', 'askVersionConflict', 'doFolderImport'],
      {
        summarizeBlockedAssets,
        h,
        AppButton: 'button',
        checkImportCompatibility: async () => ({
          projectVersion: '5.1',
          blocked: [{ assetKey: 'new', assetName: 'Fog', version: '5.2' }]
        }),
        confirmDialog,
        emit: vi.fn(),
        t: (key: string) => key,
        visible: ref(true),
        stats: {},
        message: { info: vi.fn() },
        window: Object.assign(events, {
          api: {
            projectImport: {
              importUAssetsBatch,
              onImportUAssetsBatchProgress: () => vi.fn()
            }
          }
        })
      }
    )
    await doFolderImport({ projectName: 'Test' }, options.unrealAssets, [], true)
    const call = importUAssetsBatch.mock.calls[0] as unknown as
      | [unknown, Array<{ assetKey: string }>]
      | undefined
    return { imported: call ? call[1] : null, buttons }
  }

  it('全挡住时没有「只导其余的」—— 没有「其余的」可导', async () => {
    const { buttons } = await runVersionConflict({
      unrealAssets: [{ assetKey: 'new' }],
      click: null
    })
    expect(buttons).toEqual(['importToProjectModal.cancel', 'importToProjectModal.forceImport'])
  })

  it.each([true, false])('取消就什么都不导 (all blocked=%s)', async (allBlocked) => {
    const { imported } = await runVersionConflict({
      unrealAssets: allBlocked ? [{ assetKey: 'new' }] : [{ assetKey: 'new' }, { assetKey: 'old' }],
      click: 'importToProjectModal.cancel'
    })
    expect(imported).toBeNull()
  })

  it('「仍然导入」把被挡的那项也照样拷过去', async () => {
    const { imported } = await runVersionConflict({
      unrealAssets: [{ assetKey: 'new' }],
      click: 'importToProjectModal.forceImport'
    })
    expect(imported?.map((asset) => asset.assetKey)).toEqual(['new'])
  })

  it('「仍然全部导入」连被挡的带没挡的一起导', async () => {
    const { imported, buttons } = await runVersionConflict({
      unrealAssets: [{ assetKey: 'new' }, { assetKey: 'old' }],
      click: 'importToProjectModal.forceImportAll'
    })
    expect(buttons).toContain('importToProjectModal.importCompatibleOnly')
    expect(imported?.map((asset) => asset.assetKey)).toEqual(['new', 'old'])
  })

  it('「只导其余的」把被挡的排掉', async () => {
    const { imported } = await runVersionConflict({
      unrealAssets: [{ assetKey: 'new' }, { assetKey: 'old' }],
      click: 'importToProjectModal.importCompatibleOnly'
    })
    expect(imported?.map((asset) => asset.assetKey)).toEqual(['old'])
  })
})
