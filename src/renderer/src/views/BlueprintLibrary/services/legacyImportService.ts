/**
 * 旧版蓝图导入。
 *
 * 旧版 uebox-app 把蓝图节点和材质节点混在同一张表里，靠 T3D 代码的特征区分。
 * 这里导 `蓝图节点 / 蓝图函数 / 脚本代码`，材质节点归材质库那份导入
 * （见 MaterialLibrary/services/legacyImportService.ts）。
 */
import { useBlueprintLibraryStore } from '@renderer/store/modules/blueprintLibraryStore'
import type { Blueprint, BlueprintType } from '@renderer/views/BlueprintLibrary/types/blueprint'
import i18n from '@renderer/i18n'
import {
  buildFolderMap,
  buildPreviewFolders,
  detectLegacyNodeType,
  getFolderPath,
  matchesSelectedFolders,
  readLegacyNodes,
  type LegacyImportPreview,
  type LegacyImportReport,
  type LegacyNodeRow
} from '@renderer/views/library-common/services/legacyImport'

const UNKNOWN_FOLDER = '未知文件夹'

/** 只导入蓝图节点类型，材质节点归材质库 */
const ALLOWED_TYPES = new Set(['蓝图节点', '事件节点', '蓝图函数', '脚本代码'])

function mapBlueprintType(bpType: string): BlueprintType {
  if (bpType === '蓝图函数') return 'BlueprintFunctionLibrary'
  return 'BlueprintClass'
}

// ==================== 核心转换 ====================

function transformBlueprint(row: LegacyNodeRow, blueprintType: BlueprintType): Blueprint {
  const now = Date.now()
  const updateTime = row.updateTime ? Number(row.updateTime) * 1000 : now

  return {
    id: `legacy-${row.bluePrintKey}`,
    name: row.name || '未命名蓝图',
    blueprintType,
    engineVersion: row.AvaVersion || '5.3',
    description: row.note || '',
    tags: ['旧版导入'],
    // coverStyle 留空：封面按 blueprintType 渲染时现取，不把解析出的内置图地址存盘
    createdAt: updateTime,
    updatedAt: updateTime,
    isFavorite: false,
    status: 'draft',
    graphs: [
      {
        id: `legacy-graph-${row.bluePrintKey}`,
        name: '事件图表',
        type: 'event',
        code: row.code || '',
        nodeCount: 0,
        description: i18n.global.t('actionToast.legacyEventGraph'),
        createdAt: updateTime,
        updatedAt: updateTime
      }
    ],
    functions: [],
    variables: [],
    components: [],
    eventDispatchers: [],
    macros: []
  }
}

// ==================== 主入口 ====================

/**
 * 把选中的文件夹里的蓝图写进库。
 *
 * 已经在库里的按 id 跳过 —— 旧版的 bluePrintKey 是稳定的，所以重复导入同一个库
 * 不会产生副本，也不会覆盖用户后来改过的内容。
 */
export async function executeMigration(
  dbPath: string,
  selectedFolderKeys: Set<string>,
  onProgress?: (current: number, total: number) => void
): Promise<LegacyImportReport> {
  const store = useBlueprintLibraryStore()

  // 1. 读取旧版数据
  const { blueprints: rawBlueprints, folders } = await readLegacyNodes(dbPath)

  // 2. 构建文件夹映射
  const folderMap = buildFolderMap(folders)

  // 3. 过滤：只保留蓝图节点类型 + 用户选中的文件夹
  const eligibleBlueprints = rawBlueprints.filter((bp) => {
    if (!ALLOWED_TYPES.has(detectLegacyNodeType(bp.code))) return false
    return matchesSelectedFolders(bp.folderKey || '', selectedFolderKeys)
  })

  const total = eligibleBlueprints.length
  let imported = 0
  let skipped = 0

  // 4. 收集已有 ID 用于去重
  const existingIds = new Set(store.blueprints.map((bp) => bp.id))

  // 5. 按 folderKey 分组统计，用于创建集合
  const folderGroups = new Map<string, string[]>() // folderKey → blueprintId[]

  // 6. 批量转换和导入
  for (let i = 0; i < eligibleBlueprints.length; i++) {
    const row = eligibleBlueprints[i]
    const newId = `legacy-${row.bluePrintKey}`

    // 去重
    if (existingIds.has(newId)) {
      skipped++
      onProgress?.(i + 1, total)
      continue
    }

    const bpType = detectLegacyNodeType(row.code)
    const blueprintType = mapBlueprintType(bpType)
    const blueprint = transformBlueprint(row, blueprintType)

    // 直接写入 store
    store.blueprints.push(blueprint)
    existingIds.add(newId)
    imported++

    // 记录文件夹分组
    if (row.folderKey) {
      if (!folderGroups.has(row.folderKey)) {
        folderGroups.set(row.folderKey, [])
      }
      folderGroups.get(row.folderKey)!.push(newId)
    }

    onProgress?.(i + 1, total)
  }

  // 7. 为 ≥2 蓝图的文件夹创建集合
  let collectionsCreated = 0

  // 检查文件夹名是否有重复
  const titleCounts = new Map<string, number>()
  for (const [folderKey] of folderGroups) {
    const folder = folderMap.get(folderKey)
    if (folder) {
      const title = folder.title
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1)
    }
  }

  for (const [folderKey, bpIds] of folderGroups) {
    if (bpIds.length < 2) continue
    const folder = folderMap.get(folderKey)
    if (!folder) continue

    // 如有重名，使用完整路径
    const isDuplicate = (titleCounts.get(folder.title) || 0) > 1
    const collectionName = isDuplicate ? getFolderPath(folderKey, folderMap) : folder.title

    store.createCollection(collectionName, bpIds)
    collectionsCreated++
  }

  // 8. 持久化
  store.persistState()

  return {
    total,
    imported,
    skipped,
    collections: collectionsCreated
  }
}

/**
 * 预览旧版蓝图数据（不写入 store）
 */
export async function previewMigration(dbPath: string): Promise<LegacyImportPreview> {
  const { blueprints: rows, folders } = await readLegacyNodes(dbPath)
  const folderMap = buildFolderMap(folders)
  const existingIds = new Set(useBlueprintLibraryStore().blueprints.map((bp) => bp.id))

  const entries: LegacyImportPreview['entries'] = []
  let totalSkipped = 0

  for (const row of rows) {
    const legacyType = detectLegacyNodeType(row.code)
    if (!ALLOWED_TYPES.has(legacyType)) {
      totalSkipped++
      continue
    }
    const id = `legacy-${row.bluePrintKey}`
    entries.push({
      id,
      name: row.name || '未命名',
      type: legacyType,
      folderKey: row.folderKey || '',
      exists: existingIds.has(id)
    })
  }

  return {
    entries,
    folders: buildPreviewFolders(entries, folderMap, UNKNOWN_FOLDER),
    totalSkipped
  }
}
