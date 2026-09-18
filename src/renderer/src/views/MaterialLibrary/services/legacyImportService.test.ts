import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import type {
  LegacyNodeRow,
  LegacyReadResult
} from '@renderer/views/library-common/services/legacyImport'

const readLegacyNodes = vi.fn<() => Promise<LegacyReadResult>>()

vi.mock('@renderer/views/library-common/services/legacyImport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLegacyNodes: () => readLegacyNodes()
}))

const { previewMigration, executeMigration } = await import('./legacyImportService')

function row(patch: Partial<LegacyNodeRow>): LegacyNodeRow {
  return {
    id: 1,
    folderKey: '',
    bluePrintKey: 'key-1',
    name: '未命名',
    code: '',
    type: '',
    note: '',
    color: '',
    img: '',
    AvaVersion: '5.3',
    folderFatherKeys: '',
    updateTime: '1700000000',
    ...patch
  }
}

/** 旧版材质节点的特征：图代码里有 MaterialGraph */
const MATERIAL_CODE = `Begin Object Class="/Script/UnrealEd.MaterialGraph"
Begin Object Class="/Script/Engine.MaterialExpressionTextureSample" Name="Tex"
  Texture=Texture2D'"/Game/Textures/T_Rock.T_Rock"'
End Object
End Object`

/** 材质函数的特征 */
const FUNCTION_CODE = `Begin Object Class="/Script/Engine.MaterialExpressionFunctionOutput" Name="Out"
End Object`

/** 蓝图节点：材质导入不该收它 */
const BLUEPRINT_CODE = `Begin Object Class="/Script/BlueprintGraph.K2Node_Event" Name="Ev"
End Object`

const ROWS: LegacyNodeRow[] = [
  row({ bluePrintKey: 'm1', name: 'M_Rock', code: MATERIAL_CODE, folderKey: 'f1' }),
  row({ bluePrintKey: 'm2', name: 'M_Sand', code: MATERIAL_CODE, folderKey: 'f1' }),
  row({ bluePrintKey: 'fn1', name: 'MF_Blend', code: FUNCTION_CODE, folderKey: 'f2' }),
  row({ bluePrintKey: 'bp1', name: 'BP_Door', code: BLUEPRINT_CODE, folderKey: 'f1' })
]

const FOLDERS = [
  { id: 1, title: '地表', key: 'f1', folderKey: 'f1', folderName: '地表', deractFatherKey: '' },
  { id: 2, title: '函数', key: 'f2', folderKey: 'f2', folderName: '函数', deractFatherKey: '' }
]

describe('材质库旧版导入', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    readLegacyNodes.mockResolvedValue({ blueprints: ROWS, folders: FOLDERS })
  })

  /**
   * 旧库把蓝图和材质混在一张表里，靠 T3D 代码特征区分。
   * 蓝图节点必须被算进 totalSkipped 而不是悄悄导进材质库。
   */
  it('只收材质节点与材质函数，蓝图节点算作跳过', async () => {
    const preview = await previewMigration('db')

    expect(preview.entries.map((e) => e.name)).toEqual(['M_Rock', 'M_Sand', 'MF_Blend'])
    expect(preview.totalSkipped).toBe(1)
  })

  it('预览按文件夹汇总，多的排前面', async () => {
    const preview = await previewMigration('db')

    expect(preview.folders).toEqual([
      { folderKey: 'f1', title: '地表', entryCount: 2 },
      { folderKey: 'f2', title: '函数', entryCount: 1 }
    ])
  })

  it('导入后材质进库，图代码与依赖都带过来了', async () => {
    const store = useMaterialLibraryStore()
    const result = await executeMigration('db', new Set(['f1', 'f2']))

    expect(result.imported).toBe(3)
    expect(store.entries).toHaveLength(3)

    const rock = store.entries.find((e) => e.name === 'M_Rock')!
    expect(rock.entryType).toBe('material')
    expect(rock.sourceOrigin).toBe('legacy')
    expect(rock.tags).toContain('旧版导入')
    expect(rock.graphBlueprintCode).toContain('MaterialGraph')
    expect(rock.textureDependencies.map((d) => d.path)).toContain('/Game/Textures/T_Rock')
    // 旧库里只有图代码，没有编译结果
    expect(rock.compileStatus).toBe('unknown')
  })

  it('材质函数认成 function 类型', async () => {
    const store = useMaterialLibraryStore()
    await executeMigration('db', new Set(['f1', 'f2']))

    expect(store.entries.find((e) => e.name === 'MF_Blend')?.entryType).toBe('function')
  })

  it('没勾的文件夹不导', async () => {
    const store = useMaterialLibraryStore()
    const result = await executeMigration('db', new Set(['f2']))

    expect(result.imported).toBe(1)
    expect(store.entries.map((e) => e.name)).toEqual(['MF_Blend'])
  })

  /** ≥2 个成员的文件夹才值得变成集合，一个的单独摆着 */
  it('两个以上成员的文件夹变成集合', async () => {
    const store = useMaterialLibraryStore()
    const result = await executeMigration('db', new Set(['f1', 'f2']))

    expect(result.collections).toBe(1)
    expect(store.collections.map((c) => c.name)).toEqual(['地表'])
  })

  /**
   * bluePrintKey 是稳定的，所以同一个旧库导第二次不会产生副本 ——
   * 这正是界面上「N 个已在库中，会跳过」那句话的依据。
   */
  it('重复导入同一个库不会产生副本', async () => {
    const store = useMaterialLibraryStore()
    await executeMigration('db', new Set(['f1', 'f2']))

    const second = await executeMigration('db', new Set(['f1', 'f2']))

    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(3)
    expect(store.entries).toHaveLength(3)
  })

  it('第二次预览时能看出哪些已经导过了', async () => {
    await executeMigration('db', new Set(['f1', 'f2']))

    const preview = await previewMigration('db')
    expect(preview.entries.every((e) => e.exists)).toBe(true)
  })

  it('进度回调按处理条数推进', async () => {
    const onProgress = vi.fn()
    await executeMigration('db', new Set(['f1', 'f2']), onProgress)

    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(onProgress).toHaveBeenLastCalledWith(3, 3)
  })
})
