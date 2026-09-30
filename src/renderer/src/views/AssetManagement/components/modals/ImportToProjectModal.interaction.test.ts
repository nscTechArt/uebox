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
      visibleProjects: ref([{ projectKey: 'target' }]),
      selectedProjectKey: ref('target'),
      props: { source: { assetKey: 'one', assetName: 'One.uasset' } },
      emit: vi.fn(),
      needsLaunch: ref(false),
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
    const visibleProjects = ref([{ projectKey: 'one' }])
    const selectedProjectKey = ref<string | null>('one')
    const { selectedProject, clearMissingSelection } = handlers(
      ['selectedProject', 'clearMissingSelection'],
      {
        computed,
        visibleProjects,
        selectedProjectKey
      }
    )
    const stop = watch(visibleProjects, clearMissingSelection, { flush: 'sync' })
    visibleProjects.value = []
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
    const added = { projectKey: 'added' }
    const keyword = ref('old search')
    const engineFilter = ref('5.1')
    const activeFilterKey = ref('group')
    const handleSelect = vi.fn()
    const addingProject = ref(false)
    const { handleAddProject } = handlers(['handleAddProject'], {
      ref,
      preparing: ref(false),
      addingProject,
      visible: ref(true),
      handleImportSingle: vi.fn(async () => (success ? added : undefined)),
      loadCollections: vi.fn(async () => {}),
      keyword,
      engineFilter,
      activeFilterKey,
      IMPORT_FILTER_ALL: '__all__',
      handleSelect,
      nextTick: async () => {},
      document: { querySelector: () => null }
    })
    await handleAddProject()
    expect(addingProject.value).toBe(false)
    if (success) {
      // Back to 全部 with no filters, so the new project is guaranteed to be on screen.
      expect(keyword.value).toBe('')
      expect(engineFilter.value).toBe('')
      expect(activeFilterKey.value).toBe('__all__')
      expect(handleSelect).toHaveBeenCalledWith(added)
    } else {
      expect(keyword.value).toBe('old search')
      expect(engineFilter.value).toBe('5.1')
      expect(activeFilterKey.value).toBe('group')
      expect(handleSelect).not.toHaveBeenCalled()
    }
  })

  it('clicking the active group tag again goes back to 全部', () => {
    const activeFilterKey = ref('__all__')
    const { handleClickFilter } = handlers(['handleClickFilter'], {
      preparing: ref(false),
      activeFilterKey,
      IMPORT_FILTER_ALL: '__all__'
    }) as unknown as { handleClickFilter: (key: string) => void }
    handleClickFilter('group')
    expect(activeFilterKey.value).toBe('group')
    handleClickFilter('group')
    expect(activeFilterKey.value).toBe('__all__')
  })
})

/**
 * 单个 GLB/FBX 这类文件要靠 UE 转换。选中的工程没开着时，「打开工程并导入」替用户
 * 在 UE 里打开，等它连上盒子再接着导 —— 以前是点完弹一句「没连上」就结束了。
 */
describe('opening the target project before an editor-only import', () => {
  const project = {
    projectKey: 'town',
    projectName: '淘金小镇',
    projectPath: 'H:/Town',
    originPath: 'H:/Town/Town.uproject'
  }
  interface LaunchSetup {
    api: {
      openProjectAndWait: (p: typeof project, signal: AbortSignal) => Promise<boolean>
      launchingProjectName: { value: string }
      launchTimedOut: { value: boolean }
    }
    invoke: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
    warning: ReturnType<typeof vi.fn>
    connect: () => void
  }
  function setup(res: object): LaunchSetup {
    const connectedProjects = ref<Array<Record<string, unknown>>>([])
    const invoke = vi.fn(async () => res)
    const error = vi.fn()
    const warning = vi.fn()
    const api = handlers(
      [
        'isReachable',
        'launchingProjectName',
        'launchTimedOut',
        'EDITOR_WAIT_MS',
        'waitForConnection',
        'openProjectAndWait'
      ],
      {
        ref,
        watch,
        importProjectConnection,
        connectedProjects,
        window: { api: { invoke } },
        message: { error, warning },
        t: (key: string) => key
      }
    ) as unknown as LaunchSetup['api']
    const connect = (): void => {
      connectedProjects.value = [
        { connectionId: 'c1', projectPath: 'H:/Town/Town.uproject', isConnected: true }
      ]
    }
    return { api, invoke, error, warning, connect }
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('opens without hiding the box, waits for the connection, then lets the import go on', async () => {
    const { api, invoke, connect } = setup({ success: true })
    const pending = api.openProjectAndWait(project, new AbortController().signal)
    await flush()
    expect(invoke).toHaveBeenCalledWith('shell:openUproject', 'H:/Town/Town.uproject', {
      forImport: true
    })
    expect(api.launchingProjectName.value).toBe('淘金小镇')
    connect()
    await expect(pending).resolves.toBe(true)
    expect(api.launchingProjectName.value).toBe('')
  })

  it('does not sit waiting when the plugin could not be installed', async () => {
    const { api, error } = setup({ success: true, pluginFailure: '没有随包插件' })
    await expect(api.openProjectAndWait(project, new AbortController().signal)).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('importToProjectModal.pluginNotInstalled')
  })

  it('stops waiting when the dialog is cancelled', async () => {
    const { api } = setup({ success: true })
    const controller = new AbortController()
    const pending = api.openProjectAndWait(project, controller.signal)
    await flush()
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(api.launchTimedOut.value).toBe(false)
  })

  it('gives up after the wait limit and tells the user to check UE', async () => {
    vi.useFakeTimers()
    try {
      const { api, warning } = setup({ success: true })
      const pending = api.openProjectAndWait(project, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      await expect(pending).resolves.toBe(false)
      expect(api.launchTimedOut.value).toBe(true)
      expect(warning).toHaveBeenCalledWith('importToProjectModal.editorWaitTimeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
