import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useAssetTree } from './hooks/useAssetTree'

const mocks = vi.hoisted(() => ({ getByFatherKey: vi.fn() }))
vi.mock('@renderer/api/assetFolder', () => ({ assetFolderAPI: mocks }))
vi.mock('@renderer/api/assetData', () => ({ default: {} }))

const source = parse(readFileSync('src/renderer/src/views/AssetManagement/index.vue', 'utf8'))
  .descriptor.scriptSetup!.content
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const declaration = (name: string): ts.VariableDeclaration => {
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const match = statement.declarationList.declarations.find(
      (item) => item.name.getText(ast) === name
    )
    if (match) return match
  }
  throw new Error(`Missing handler: ${name}`)
}

describe('folder import tree refresh', () => {
  it.each([undefined, 'destination'])(
    'refreshes imported children for target %s',
    async (target) => {
      const tree = useAssetTree()
      const key = target || 'ALL'
      tree.treeData.value = [
        {
          key,
          title: key,
          type: 'folder',
          path: `/${key}`,
          childrenLoaded: true,
          isLeaf: true,
          children: []
        }
      ]
      mocks.getByFatherKey.mockResolvedValue([
        { folderKey: 'new-folder', folderName: 'PhotoR_Backgrounds', hasChildren: false }
      ])
      const loadCurrentFolderAssets = vi.fn(async () => {
        expect(tree.findNodeByKey('new-folder')?.title).toBe('PhotoR_Backgrounds')
      })
      const code = ts.transpileModule(
        `const ${declaration('refreshCurrentImportView').getText(ast)}`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
      ).outputText
      const refresh = new Function(
        'selectedKeys',
        'refreshNodeChildren',
        'loadCurrentFolderAssets',
        `${code}; return refreshCurrentImportView`
      )(
        ref(target ? ['another-folder'] : []),
        tree.refreshNodeChildren,
        loadCurrentFolderAssets
      ) as (target?: string) => Promise<void>

      await refresh(target)

      expect(mocks.getByFatherKey).toHaveBeenLastCalledWith(key)
      expect(tree.findNodeByKey(key)?.isLeaf).toBe(false)
      expect(loadCurrentFolderAssets).toHaveBeenCalledOnce()
    }
  )

  it('wires both successful and partially failed imports to the captured destination', () => {
    const handler = declaration('handleDragImport').initializer as ts.ArrowFunction
    const body = handler.body as ts.Block
    const attempt = body.statements.find(ts.isTryStatement)!
    for (const block of [attempt.tryBlock, attempt.catchClause!.block]) {
      expect(
        block.statements.some(
          (statement) =>
            statement.getText(ast) === 'await refreshCurrentImportView(targetFolderKey)'
        )
      ).toBe(true)
    }
    expect(
      body.statements.some((statement) =>
        statement
          .getText(ast)
          .includes('const targetFolderKey = selectedKeys.value[0] || ALL_FOLDER')
      )
    ).toBe(true)
  })
})
