import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { effectScope, ref, watch } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// Run the actual handlers with deferred IO; no real vault is opened or modified.
function handlers(
  file: string,
  names: string[],
  context: Record<string, unknown>,
  extra = ''
): Record<string, (...args: unknown[]) => unknown> {
  const source = parse(readFileSync(`src/renderer/src/views/AssetManagement/${file}`, 'utf8'))
    .descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = ast.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))
  )
  const code = ts.transpileModule(
    declarations.map((item) => item.getText(ast)).join('\n;\n') + '\n;\n' + extra,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  return new Function(...Object.keys(context), `${code}; return { ${names.join(', ')} }`)(
    ...Object.values(context)
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('asset review fixes', () => {
  it('permanent deletion waits for confirmation and cannot cross a vault switch', async () => {
    const confirmDialog = vi.fn()
    const performPermanentDeleteInTrash = vi.fn()
    const currentVault = ref({ id: 'A' })
    const { requestPermanentDelete, processDeleteRequest, handleContextMenuClick } = handlers(
      'components/AssetFileList.vue',
      [
        'requestPermanentDelete',
        'processDeleteRequest',
        'collectTrashTargets',
        'handleContextMenuClick'
      ],
      {
        currentRightClickAsset: ref({ assetKey: 'right-click' }),
        // 回收站的恢复 / 彻底删除都按选择集合来，没选中才退回右键那一项
        selectedItems: ref([]),
        confirmDialog,
        performPermanentDeleteInTrash,
        currentVault,
        isTrashView: ref(true),
        t: (key: string) => key
      }
    )
    requestPermanentDelete([])
    expect(confirmDialog).not.toHaveBeenCalled()
    processDeleteRequest(['asset'], [])
    expect(performPermanentDeleteInTrash).not.toHaveBeenCalled()
    await confirmDialog.mock.calls[0][0].onOk()
    // 回收站里的彻底删除现在也吃文件夹（删掉的文件夹本身就列在回收站里）
    expect(performPermanentDeleteInTrash).toHaveBeenCalledWith(['asset'], [])
    await handleContextMenuClick('permanent-delete', {})
    currentVault.value = { id: 'B' }
    await confirmDialog.mock.calls[1][0].onOk()
    expect(performPermanentDeleteInTrash).toHaveBeenCalledTimes(1)
  })

  /**
   * 回收站里「彻底删除」一直是整批的，「恢复」以前只认右键点中的那一个 ——
   * 破坏性的那一半批量、可撤销的那一半不批量，正好反了。文件夹同理：
   * 删掉的文件夹现在就列在回收站里，恢复它才是把整棵目录拿回来的唯一办法。
   */
  it('restore in the trash takes the whole selection, folders included', async () => {
    const restoreMany = vi.fn(async () => ({ restored: ['a1', 'a2'], failed: [] }))
    const restoreFolder = vi.fn(async () => ({ restored: true }))
    const removeFiles = vi.fn()
    const refreshTree = vi.fn(async () => undefined)
    const messages: string[] = []
    const { performRestoreInTrash, collectTrashTargets } = handlers(
      'components/AssetFileList.vue',
      ['collectTrashTargets', 'performRestoreInTrash'],
      {
        selectedItems: ref([
          { assetKey: 'a1' },
          { assetKey: 'a2' },
          { type: 'folder', folderKey: 'f1' }
        ]),
        currentRightClickAsset: ref({ assetKey: 'a1' }),
        currentVault: ref({ id: 'A' }),
        isHttpNetworkVault: ref(false),
        assetDataAPI: { restoreMany },
        assetFolderAPI: { restore: restoreFolder },
        assetContext: { removeFiles, refreshTree },
        message: {
          success: (text: string) => messages.push(text),
          warning: (text: string) => messages.push(text),
          error: (text: string) => messages.push(text)
        },
        resolveErrorText: (_error: unknown, fallback: string) => fallback,
        t: (key: string) => key,
        console: { error: vi.fn() }
      }
    )

    const targets = collectTrashTargets() as { assetKeys: string[]; folderKeys: string[] }
    expect(targets).toEqual({ assetKeys: ['a1', 'a2'], folderKeys: ['f1'] })

    await performRestoreInTrash(targets.assetKeys, targets.folderKeys)

    // 资产走批量接口，文件夹一个一个来（每个都是递归恢复整棵树）
    expect(restoreMany).toHaveBeenCalledWith(['a1', 'a2'])
    expect(restoreFolder).toHaveBeenCalledWith('f1')
    expect(removeFiles).toHaveBeenCalledWith(['a1', 'a2', 'f1'])
    // 文件夹回来了，树上得看得见
    expect(refreshTree).toHaveBeenCalled()
    expect(messages).toEqual(['assetFileList.restore.done'])
  })

  it('restore reports a partial result instead of claiming success', async () => {
    const messages: string[] = []
    const { performRestoreInTrash } = handlers(
      'components/AssetFileList.vue',
      ['collectTrashTargets', 'performRestoreInTrash'],
      {
        selectedItems: ref([]),
        currentRightClickAsset: ref(null),
        currentVault: ref({ id: 'A' }),
        isHttpNetworkVault: ref(false),
        assetDataAPI: {
          restoreMany: async () => ({
            restored: ['a1'],
            failed: [{ assetKey: 'a2', error: '它不在回收站里' }]
          })
        },
        assetFolderAPI: { restore: vi.fn() },
        assetContext: { removeFiles: vi.fn(), refreshTree: vi.fn() },
        message: {
          success: (text: string) => messages.push(`success:${text}`),
          warning: (text: string) => messages.push(`warning:${text}`),
          error: (text: string) => messages.push(`error:${text}`)
        },
        resolveErrorText: (_error: unknown, fallback: string) => fallback,
        t: (key: string) => key,
        console: { error: vi.fn() }
      }
    )

    await performRestoreInTrash(['a1', 'a2'], [])

    expect(messages).toEqual(['warning:assetFileList.restore.partial'])
  })

  it.each([false, true])(
    'reset uses bounded paging and ignores late old-folder completion (failure=%s)',
    async (failure) => {
      const oldPage = deferred<unknown[]>()
      const currentFiles = ref<unknown[]>([])
      const selectedKeys = ref(['A'])
      const fileListLoading = ref(false)
      const loadAssetsByFolder = vi.fn((key: string) =>
        key === 'A' ? oldPage.promise : Promise.resolve([{ id: 'B' }])
      )
      const message = { error: vi.fn() }
      const context = {
        selectedKeys,
        currentFiles,
        fileListLoading,
        isSearching: ref(true),
        filterForm: {},
        isShowingShortcutView: ref(false),
        hasActiveFilters: ref(false),
        currentPage: ref(1),
        pageSize: ref(50),
        hasMore: ref(false),
        currentFolderCounts: { folders: 0, files: 0 },
        resetPagination: vi.fn(),
        localStorage: { getItem: () => null },
        sortConfig: { sortBy: 'assetName', sortOrder: 'asc' },
        assetFolderAPI: { getChildCount: async () => 0 },
        assetDataAPI: { getCountByFolderKey: async () => 5000 },
        getSubFolders: vi.fn(),
        loadAssetsByFolder,
        message,
        t: (key: string) => key,
        // 这三个是后来加进 handleResetFilter / beginListRequest 的依赖。
        // 缺了它们，重置会在 ReferenceError 上被 try/catch 吞掉，
        // 测试看到的是「加载压根没发生」—— 而那和真的没加载长得一模一样
        showDependencies: ref(true),
        suppressShowDependenciesReload: false,
        listGeneration: ref(0),
        console: { log: vi.fn(), error: vi.fn() }
      }
      const api = handlers(
        'index.vue',
        [
          'browseListRequestToken',
          'beginListRequest',
          'isStaleListRequest',
          'mapSubFolderToListItem',
          'loadBrowsePage',
          'loadCurrentFolderAssets',
          'handleResetFilter'
        ],
        context
      )
      const pending = api.handleResetFilter()
      await vi.waitFor(() => expect(loadAssetsByFolder).toHaveBeenCalled())
      expect(loadAssetsByFolder.mock.calls[0]).toEqual(['A', 'assetName', 'asc', true, 50, 0])
      selectedKeys.value = ['B']
      await api.loadCurrentFolderAssets()
      if (failure) oldPage.reject(new Error('old folder unavailable'))
      else oldPage.resolve([{ id: 'A' }])
      await pending
      expect(currentFiles.value).toEqual([{ id: 'B' }])
      expect(fileListLoading.value).toBe(false)
      expect(message.error).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'late notes/tags cannot replace the selected asset (failure=%s)',
    async (failure) => {
      const noteA = deferred<unknown>()
      const tagsA = deferred<unknown>()
      const noteContent = ref('')
      const currentTags = ref([])
      const selectedTagIds = ref([])
      const props = { asset: ref({ assetKey: 'A' }), folder: ref(null as { key: string } | null) }
      const asset = {
        get asset() {
          return props.asset.value
        },
        get folder() {
          return props.folder.value
        }
      }
      const context = {
        props: asset,
        currentVault: ref({ id: 'vault' }),
        watch,
        noteContent,
        currentTags,
        selectedTagIds,
        // 详细说明的关联，和文件夹那一侧的同一套「换目标先作废」状态
        assetNoteId: ref(null),
        folderNoteContent: ref(''),
        folderNoteId: ref(null),
        window: {
          api: {
            database: {
              assetData: {
                getById: (key: string) =>
                  key === 'A' ? noteA.promise : Promise.resolve({ data: { note: 'B note' } })
              },
              assetTag: {
                getTagIdsByAssetKey: (key: string) =>
                  key === 'A' ? tagsA.promise : Promise.resolve({ success: true, data: [2] })
              },
              tag: { getById: async () => ({ success: true, data: { id: 2, name: 'B tag' } }) }
            }
          }
        },
        console: { error: vi.fn() }
      }
      const source = parse(
        readFileSync(
          'src/renderer/src/views/AssetManagement/components/AssetDetailsPanel.vue',
          'utf8'
        )
      ).descriptor.scriptSetup!.content
      const watchSource = source.slice(
        source.indexOf('watch(', source.indexOf('// 切换资产或保管库')),
        source.indexOf('// 监听资产对象变化')
      )
      const scope = effectScope()
      try {
        scope.run(() =>
          handlers(
            'components/AssetDetailsPanel.vue',
            [
              'tagsRequestId',
              'noteRequestId',
              'loadAssetTags',
              'loadAssetNote',
              // 文件夹侧的备注走同一套请求序号，watch 是紧挨着的那一个
              'loadFolderNote'
            ],
            context,
            watchSource
          )
        )
        props.asset.value = { assetKey: 'B' }
        await vi.waitFor(() => expect(noteContent.value).toBe('B note'))
        if (failure) {
          noteA.reject(new Error('old note failed'))
          tagsA.reject(new Error('old tags failed'))
        } else {
          noteA.resolve({ data: { note: 'A note' } })
          tagsA.resolve({ success: true, data: [1] })
        }
        await Promise.allSettled([noteA.promise, tagsA.promise])
        expect(noteContent.value).toBe('B note')
        expect(currentTags.value).toEqual([{ id: 2, name: 'B tag', color: undefined }])
        expect(selectedTagIds.value).toEqual([2])
      } finally {
        scope.stop()
      }
    }
  )
})
