import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

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

describe('vault import review regressions', () => {
  it('settles only the matching overwrite prompt after timeout or cancellation', () => {
    const overwriteConfirmData = ref<{ confirmId: string } | null>({ confirmId: 'new' })
    const overwriteConfirmVisible = ref(true)
    const clearOverwriteCountdown = vi.fn()
    const { handleOverwriteSettled } = handlers(
      'views/AssetManagement/index.vue',
      ['handleOverwriteSettled'],
      {
        overwriteConfirmData,
        overwriteConfirmVisible,
        clearOverwriteCountdown
      }
    )
    handleOverwriteSettled({ confirmId: 'old' })
    expect(overwriteConfirmVisible.value).toBe(true)
    handleOverwriteSettled({ confirmId: 'new' })
    expect(overwriteConfirmVisible.value).toBe(false)
    expect(overwriteConfirmData.value).toBeNull()
    expect(clearOverwriteCountdown).toHaveBeenCalledOnce()
  })
  it('an older prompt response cannot close the next task prompt', async () => {
    let finish!: () => void
    const currentImportError = ref({ taskId: 'a' })
    const importErrorModalVisible = ref(true)
    const { handleResolveImportError } = handlers(
      'views/AssetManagement/index.vue',
      ['handleResolveImportError'],
      {
        currentImportError,
        importErrorModalVisible,
        assetDataAPI: {
          resolveImportError: () =>
            new Promise<void>((resolve) => {
              finish = resolve
            })
        }
      }
    )
    const pending = handleResolveImportError('ignore')
    currentImportError.value = { taskId: 'b' }
    finish()
    await pending
    expect(currentImportError.value.taskId).toBe('b')
    expect(importErrorModalVisible.value).toBe(true)
  })

  it.each(['original', 'other'])(
    'retry uses all scanned files and refuses a different vault (%s)',
    async (vault) => {
      const files = Array.from({ length: 300 }, (_, index) => ({
        type: 'file',
        path: `D:/source/${index}.png`,
        name: `${index}.png`
      }))
      const importFolderStructureWithMetadata = vi.fn(async () => ({}))
      const readFolderContentsRecursive = vi.fn(async () => ({
        success: true,
        data: files,
        diagnostics: { skippedItems: [] }
      }))
      const failure = { path: files[299].path, fileName: files[299].name, retriable: true }
      const { retryFailedImportFiles } = handlers(
        'views/AssetManagement/index.vue',
        ['retryFailedImportFiles'],
        {
          importResultData: ref({
            failures: [failure],
            retryContext: {
              taskId: 'old',
              vaultId: 'original',
              rootFolderPath: 'D:/source',
              targetFolderKey: 'folder'
            }
          }),
          currentVault: ref({ id: vault }),
          importRetryLoading: ref(false),
          importResultModalVisible: ref(true),
          createImportTaskId: () => 'retry',
          addImportTask: vi.fn(),
          updateImportTask: vi.fn(),
          cancelledVaultImports: new Set(),
          filterRetriableFailures: (items: unknown[]) => items,
          ALL_FOLDER: 'ALL',
          window: { api: { fs: { readFolderContentsRecursive } } },
          assetDataAPI: { importFolderStructureWithMetadata },
          copyConcurrencyForMain: () => 1,
          message: { warning: vi.fn(), error: vi.fn() },
          t: (key: string) => key
        }
      )
      await retryFailedImportFiles()
      if (vault === 'other') {
        expect(readFolderContentsRecursive).not.toHaveBeenCalled()
        expect(importFolderStructureWithMetadata).not.toHaveBeenCalled()
      } else {
        expect(importFolderStructureWithMetadata).toHaveBeenCalledWith(
          [files[299]],
          'D:/source',
          'folder',
          1,
          'retry',
          {
            retryOfTaskId: 'old',
            vaultId: 'original',
            forceOverwrite: false,
            scanIssues: []
          }
        )
      }
    }
  )
  it('single click opens and closes the import actions', () => {
    const importMenuOpen = ref(false)
    const { handleFabClick } = handlers('views/AssetManagement/index.vue', ['handleFabClick'], {
      importMenuOpen
    })
    handleFabClick()
    expect(importMenuOpen.value).toBe(true)
    handleFabClick()
    expect(importMenuOpen.value).toBe(false)
  })
})
