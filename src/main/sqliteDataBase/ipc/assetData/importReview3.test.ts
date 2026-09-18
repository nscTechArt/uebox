import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import Database from 'better-sqlite3'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { rollbackRemoteImportLocalRows } from './remoteImportLocalRollback'

const source = readFileSync('src/main/sqliteDataBase/ipc/assetData.ts', 'utf8')
const ast = ts.createSourceFile('import.ts', source, ts.ScriptTarget.Latest, true)
function executeNode(
  predicate: (node: ts.Node) => boolean,
  context: Record<string, unknown>
): Promise<unknown> {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found = node
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!found) throw new Error('Production import branch not found')
  const js = ts.transpileModule(found.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const result = 'cancelRemoteLocalWrites' in context ? ';return cancelRemoteLocalWrites' : ''
  return new Function(...Object.keys(context), `return (async () => {${js}${result}})()`)(
    ...Object.values(context)
  )
}

describe('import orchestration regression', () => {
  it('SMB loose assets collect dependencies and surface resolution errors', async () => {
    const backupAssets: Array<{ sourcePath: string }> = []
    const importIssueEntries: unknown[] = []
    const resolveDependencies = vi.fn()
    class Resolver {
      constructor(
        private config: {
          onAssetFound: (asset: unknown) => Promise<void>
          errorCallback: (error: unknown) => void
        }
      ) {}
      async resolveDependencies(): Promise<void> {
        resolveDependencies()
        await this.config.onAssetFound({
          originPath: 'D:/Texture.uasset',
          softPath: '/Game/Texture',
          name: 'Texture'
        })
        this.config.errorCallback({ message: 'missing material', affectedPaths: ['/Game/Missing'] })
      }
    }
    await executeNode(
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText(ast) ===
          '(isBackupMode && backupManager) || (isNetworkMode && networkPath)',
      {
        isBackupMode: false,
        backupManager: null,
        isNetworkMode: true,
        networkPath: 'Z:/vault',
        files: [{ path: 'D:/Asset.uasset', name: 'Asset.uasset' }],
        rootFolderPath: 'ALL',
        backupAssets,
        importIssueEntries,
        processedMetadata: new Map(),
        stripPathLeafExtension: (path: string) => path.replace(/\.[^.]+$/, ''),
        generateSafeAssetKey: (name: string) => name,
        basename,
        AssetDependencyResolver: Resolver,
        signal: new AbortController().signal
      }
    )
    expect(resolveDependencies).toHaveBeenCalledOnce()
    expect(backupAssets.map((asset) => asset.sourcePath)).toEqual([
      'D:/Asset.uasset',
      'D:/Texture.uasset'
    ])
    expect(importIssueEntries).toEqual([expect.objectContaining({ error: 'missing material' })])
  })

  it('the production cancellation callback cleans optimistic rows before completion', async () => {
    const db = new Database(':memory:')
    db.exec(
      "CREATE TABLE assetData (assetKey TEXT PRIMARY KEY, assetName TEXT); INSERT INTO assetData VALUES ('new', 'Pending')"
    )
    const cleanup = await executeNode(
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText(ast) === 'isRemoteServerMode' &&
        node.getText(ast).includes('cancelRemoteLocalWrites ='),
      {
        isRemoteServerMode: true,
        cancelRemoteLocalWrites: undefined,
        writerQueue: { enqueue: async (job: () => unknown) => job() },
        transaction: (
          connection: Database.Database,
          job: (connection: Database.Database) => unknown
        ) => connection.transaction(() => job(connection))(),
        db,
        rollbackRemoteImportLocalRows,
        localRemoteImportCreatedAssetKeys: new Set(['new']),
        localRemoteImportCreatedFolderKeys: new Set(),
        previousRemoteAssets: new Map()
      }
    )
    expect(typeof cleanup).toBe('function')
    if (typeof cleanup !== 'function') throw new Error('Cancellation cleanup missing')
    await cleanup()
    expect(db.prepare('SELECT * FROM assetData').all()).toEqual([])
    db.close()
  })
})
