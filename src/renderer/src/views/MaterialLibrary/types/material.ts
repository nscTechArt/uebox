export type MaterialEntryType = 'material' | 'instance' | 'function'

export type MaterialEntryStatus = 'draft' | 'verified' | 'archived'

export type MaterialCompileStatus = 'success' | 'warning' | 'error' | 'unknown'

export type MaterialSourceOrigin = 'legacy' | 'live' | 'local'

export type MaterialLiveDataState = 'full' | 'partial' | 'unavailable'

export type MaterialViewMode = 'grid' | 'list'

export type MaterialSortType = 'recent' | 'name' | 'created'

export interface MaterialDiagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info'
  node?: string
}

export interface MaterialGraphSummary {
  nodeCount: number
  connectionCount: number
  keyNodeClasses: string[]
  textureNodeCount: number
  functionCallCount: number
}

export interface MaterialParameterValue {
  name: string
  type: 'scalar' | 'vector' | 'texture' | 'staticSwitch'
  inheritedValue?: unknown
  overrideValue?: unknown
  isOverridden?: boolean
  source?: 'parameter' | 'nodeProperty'
}

export interface MaterialDependency {
  path: string
  name: string
  kind: 'texture' | 'function' | 'parameterCollection'
  assetKey?: string
  assetType?: string
  thumbnail?: string
  isResolved?: boolean
}

export interface MaterialEntryBase {
  id: string
  name: string
  entryType: MaterialEntryType
  assetPath: string
  engineVersion: string
  description: string
  tags: string[]
  thumbnail?: string
  coverStyle: string
  createdAt: number
  updatedAt: number
  isFavorite: boolean
  status: MaterialEntryStatus
  materialDomain: string
  blendMode: string
  shadingModel: string
  twoSided: boolean
  usageFlags: string[]
  compileStatus: MaterialCompileStatus
  compileDiagnostics: MaterialDiagnostic[]
  lastHealthCheckAt?: number
  nodeCount: number
  connectionCount: number
  graphSummary: MaterialGraphSummary
  graphBlueprintCode: string | null
  scalarParameters: MaterialParameterValue[]
  vectorParameters: MaterialParameterValue[]
  textureParameters: MaterialParameterValue[]
  staticSwitchParameters: MaterialParameterValue[]
  textureDependencies: MaterialDependency[]
  functionDependencies: MaterialDependency[]
  parameterCollectionDependencies: MaterialDependency[]
  missingDependencies: string[]
  parentMaterialPath?: string
  childInstancePaths: string[]
  referencedByPaths: string[]
  collectionId?: string
  sourceOrigin: MaterialSourceOrigin
  liveDataState: MaterialLiveDataState
  syncIssues: string[]
  lastSyncedAt?: number
  lastSyncAttemptAt?: number
  liveRefreshAvailable: boolean
  legacyKey?: string
}

export interface MaterialAsset extends MaterialEntryBase {
  entryType: 'material'
}

export interface MaterialInstanceAsset extends MaterialEntryBase {
  entryType: 'instance'
  parentMaterialPath: string
}

export interface MaterialFunctionAsset extends MaterialEntryBase {
  entryType: 'function'
}

export type MaterialEntry = MaterialAsset | MaterialInstanceAsset | MaterialFunctionAsset

export interface MaterialCollection {
  id: string
  name: string
  entryIds: string[]
  createdAt: number
}

export interface MaterialLibraryFilters {
  searchQuery: string
  entryType: MaterialEntryType | 'all'
  favoriteState: 'all' | 'favorite' | 'unfavorite'
  blendMode: string
  materialDomain: string
  shadingModel: string
  compileStatus: MaterialCompileStatus | 'all'
  hasTextureDependencies: 'all' | 'yes' | 'no'
  hasFunctionDependencies: 'all' | 'yes' | 'no'
  hasChildInstances: 'all' | 'yes' | 'no'
  activeCollectionId: string | null
}

export const MATERIAL_ENTRY_LABELS: Record<MaterialEntryType, string> = {
  material: '材质',
  instance: '材质实例',
  function: '材质函数'
}

export const MATERIAL_COMPILE_LABELS: Record<MaterialCompileStatus, string> = {
  success: '正常',
  warning: '警告',
  error: '错误',
  unknown: '未知'
}

const MATERIAL_COVER_STYLES: Record<MaterialEntryType, string> = {
  material: 'background: #131920; box-shadow: inset 0 -3px 0 0 #f59e0b;',
  instance: 'background: #131920; box-shadow: inset 0 -3px 0 0 #06b6d4;',
  function: 'background: #131920; box-shadow: inset 0 -3px 0 0 #10b981;'
}

export function getMaterialCoverStyle(entryType: MaterialEntryType): string {
  return MATERIAL_COVER_STYLES[entryType]
}

export function getMaterialEntryLabel(entryType: MaterialEntryType): string {
  return MATERIAL_ENTRY_LABELS[entryType]
}

export function getMaterialCompileLabel(status: MaterialCompileStatus): string {
  return MATERIAL_COMPILE_LABELS[status]
}

export function createEmptyGraphSummary(): MaterialGraphSummary {
  return {
    nodeCount: 0,
    connectionCount: 0,
    keyNodeClasses: [],
    textureNodeCount: 0,
    functionCallCount: 0
  }
}

export function getParameterCount(entry: MaterialEntry): number {
  return (
    entry.scalarParameters.length +
    entry.vectorParameters.length +
    entry.textureParameters.length +
    entry.staticSwitchParameters.length
  )
}

export function getDependencyCount(entry: MaterialEntry): number {
  return (
    entry.textureDependencies.length +
    entry.functionDependencies.length +
    entry.parameterCollectionDependencies.length
  )
}

export function formatMaterialValue(value: unknown): string {
  if (value == null) return 'Unknown'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
