import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { computed, ref, watch } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { importProjectConnection } from '../../utils/importProjectChoices'

// Run the actual handlers with delayed IPC, without touching a real UE project.
interface TestHandlers {
  doFolderImport: (...args: unknown[]) => Promise<void>
  doSingleAssetBackgroundImport: (...args: unknown[]) => Promise<void>
  handleAddProject: () => Promise<void>
  handleConfirm: () => Promise<void>
  handleCancel: () => void
  clearMissingSelection: () => void
  preparing: { value: boolean }
  selectedProject: { value: { projectKey: string } | undefined }
  refreshCompatibility: () => Promise<void>
  compatibilityBlocked: { value: number }
  compatibilityText: { value: string }
  sourceAssets: { value: Array<{ assetKey: string }> }
}
function handlers(names: string[], context: Record<string, unknown>): TestHandlers {
  const source = parse(
    readFileSync(
      'src/renderer/src/views/AssetManagement/components/modals/ImportToProjectModal.vue',
      'utf8'
    )
  ).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('handlers.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = ast.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))
  )
  const code = ts.transpileModule(declarations.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(context), `${code}; return {${names.join(',')}}`)(
    ...Object.values(context)
  )
}

describe('import project preparation', () => {
  it.each([true, false])(
    'external files use only the selected connection (connected=%s)',
    async (connected) => {
      const importExternalFiles = vi.fn(async () => ({ success: true, imported_count: 1 }))
      const dispatchEvent = vi.fn()
      const error = vi.fn()
      const project = { projectKey: 'chosen', projectPath: 'H:/Chosen' }
      const { doSingleAssetBackgroundImport } = handlers(['doSingleAssetBackgroundImport'], {
        importProjectConnection,
        connectedProjects: ref([
          { connectionId: 'other', projectPath: 'H:/Other/Game.uproject', isConnected: true },
          { connectionId: 'chosen', projectPath: 'H:/Chosen/Game.uproject', isConnected: connected }
        ]),
        isExternalFile: () => true,
        visible: ref(true),
        t: (key: string) => key,
        window: { dispatchEvent, api: { projectImport: { importExternalFiles } } },
        message: { error, success: vi.fn() }
      })
      await doSingleAssetBackgroundImport(project, {}, 'H:/Source/mesh.fbx', 'mesh.fbx')
      if (connected) {
        expect(importExternalFiles).toHaveBeenCalledWith(
          expect.objectContaining({ targetConnectionId: 'chosen' })
        )
        expect(error).not.toHaveBeenCalled()
      } else {
        expect(importExternalFiles).not.toHaveBeenCalled()
        expect(dispatchEvent).not.toHaveBeenCalled()
        expect(error).toHaveBeenCalledWith('importToProjectModal.targetNotConnected')
      }
    }
  )
  it('does not start after cancellation while compatibility is pending', async () => {
    let finish!: (value: object) => void
    const checkImportCompatibility = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const start = vi.fn()
    const controller = new AbortController()
    const { doFolderImport } = handlers(['doFolderImport'], {
      checkImportCompatibility,
      window: { dispatchEvent: start }
    })
    const pending = doFolderImport(
      {},
      [{ assetKey: 'one' }],
      [],
      true,
      [],
      false,
      controller.signal
    )
    controller.abort()
    finish({ blocked: [] })
    await pending
    expect(start).not.toHaveBeenCalled()
  })

  it('ignores repeated confirmation and invalidates callbacks on cancellation', async () => {
    let finish!: () => void
    const doFolderImport = vi.fn<(...args: unknown[]) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const visible = ref(true)
    const api = handlers(['preparing', 'importController', 'handleConfirm', 'handleCancel'], {
      ref,
      AbortController,
      loading: ref(false),
      projectsLoading: ref(false),
      loadFailed: ref(false),
      sortedProjects: ref([{ projectKey: 'target' }]),
      selectedProjectKey: ref('target'),
      props: { source: { assetKey: 'one', assetName: 'One.uasset' } },
      emit: vi.fn(),
      isPluginSource: () => false,
      getBasename: () => '',
      getArchiveExtension: () => '',
      isUnrealAsset: () => true,
      doFolderImport,
      visible,
      archiveDialogVisible: ref(false),
      pendingArchive: ref(null),
      stopProgressTick: vi.fn(),
      message: { error: vi.fn() },
      t: (key: string) => key
    })
    const first = api.handleConfirm()
    await api.handleConfirm()
    expect(doFolderImport).toHaveBeenCalledTimes(1)
    expect(api.preparing.value).toBe(true)
    api.handleCancel()
    expect((doFolderImport.mock.calls[0][6] as AbortSignal).aborted).toBe(true)
    expect(visible.value).toBe(false)
    finish()
    await first
    expect(api.preparing.value).toBe(false)
  })

  it('clears a selected target filtered out by a search', async () => {
    const sortedProjects = ref([{ projectKey: 'one' }])
    const selectedProjectKey = ref<string | null>('one')
    const { selectedProject, clearMissingSelection } = handlers(
      ['selectedProject', 'clearMissingSelection'],
      {
        computed,
        sortedProjects,
        selectedProjectKey
      }
    )
    const stop = watch(sortedProjects, clearMissingSelection, { flush: 'sync' })
    sortedProjects.value = []
    expect(selectedProject.value).toBeUndefined()
    expect(selectedProjectKey.value).toBeNull()
    stop()
  })

  it('does not apply an old compatibility result to a newly selected project', async () => {
    const resolvers: Array<(value: object) => void> = []
    const selectedProject = ref({ projectKey: 'old' })
    const api = handlers(
      [
        // 待导资产现在由 loadSourceAssets 先读好，预检直接吃这份结果，不再自己查库
        'sourceAssets',
        'sourceAssetsLoading',
        'sourceAssetsFailed',
        'compatibilityText',
        'compatibilityBlocked',
        'compatibilityFailed',
        'compatibilityRevision',
        'refreshCompatibility'
      ],
      {
        ref,
        selectedProject,
        visible: ref(true),
        props: { source: { assetKey: 'one' } },
        isUnrealAsset: () => true,
        t: (key: string) => key,
        checkImportCompatibility: () => new Promise((resolve) => resolvers.push(resolve))
      }
    )
    api.sourceAssets.value = [{ assetKey: 'one' }]
    const old = api.refreshCompatibility()
    selectedProject.value = { projectKey: 'new' }
    const current = api.refreshCompatibility()
    resolvers[1]({ blocked: [] })
    await current
    resolvers[0]({ blocked: [{ assetKey: 'one' }] })
    await old
    expect(api.compatibilityBlocked.value).toBe(0)
    expect(api.compatibilityText.value).toBe('importToProjectModal.versionPreflightDone')
  })
})

describe('adding an import destination', () => {
  it.each([true, false])('selects the added project only on success (%s)', async (success) => {
    const added = { projectKey: 'added', collectionKey: 'group' }
    const keyword = ref('old search')
    const engineFilter = ref('5.1')
    const expandedCollections = ref(new Set<string>())
    const handleSelect = vi.fn()
    const addingProject = ref(false)
    const { handleAddProject } = handlers(['handleAddProject', 'expandCollection'], {
      ref,
      preparing: ref(false),
      addingProject,
      visible: ref(true),
      handleImportSingle: vi.fn(async () => (success ? added : undefined)),
      loadCollections: vi.fn(async () => {}),
      collections: ref([{ collectionKey: 'group', items: [added] }]),
      keyword,
      engineFilter,
      expandedCollections,
      handleSelect,
      nextTick: async () => {},
      document: { querySelector: () => null }
    })
    await handleAddProject()
    expect(addingProject.value).toBe(false)
    if (success) {
      expect(keyword.value).toBe('')
      expect(engineFilter.value).toBe('')
      // The new project sits inside a collection, so that collection has to be open to see it.
      expect([...expandedCollections.value]).toEqual(['group'])
      expect(handleSelect).toHaveBeenCalledWith(added)
    } else {
      expect(keyword.value).toBe('old search')
      expect(engineFilter.value).toBe('5.1')
      expect(expandedCollections.value.size).toBe(0)
      expect(handleSelect).not.toHaveBeenCalled()
    }
  })

  it('opens and closes a collection in place instead of navigating into it', () => {
    const keyword = ref('')
    const engineFilter = ref('')
    const { toggleCollection, isCollectionOpen } = handlers(
      ['expandedCollections', 'isFiltering', 'isCollectionOpen', 'toggleCollection'],
      { ref, computed, preparing: ref(false), keyword, engineFilter }
    ) as unknown as {
      toggleCollection: (key: string) => void
      isCollectionOpen: (key: string) => boolean
    }
    expect(isCollectionOpen('group')).toBe(false)
    toggleCollection('group')
    expect(isCollectionOpen('group')).toBe(true)
    toggleCollection('group')
    expect(isCollectionOpen('group')).toBe(false)
    // A search only leaves collections that matched, so hiding their members hides the result.
    keyword.value = 'forest'
    expect(isCollectionOpen('group')).toBe(true)
  })
})
