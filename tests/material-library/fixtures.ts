import {
  createEmptyGraphSummary,
  getMaterialCoverStyle,
  type MaterialEntry
} from '@renderer/views/MaterialLibrary/types/material'

export function createStoredEntry(overrides: Partial<MaterialEntry> = {}): MaterialEntry {
  const entryType = overrides.entryType || 'material'

  return {
    id: overrides.id || `stored-${entryType}-1`,
    name: overrides.name || 'Stored Material',
    entryType,
    assetPath: overrides.assetPath || '/Game/Materials/M_Stored',
    engineVersion: overrides.engineVersion || '5.x',
    description: overrides.description || '',
    tags: overrides.tags || [],
    thumbnail: overrides.thumbnail,
    coverStyle: overrides.coverStyle || getMaterialCoverStyle(entryType),
    createdAt: overrides.createdAt || 100,
    updatedAt: overrides.updatedAt || 200,
    isFavorite: overrides.isFavorite || false,
    status: overrides.status || 'draft',
    materialDomain: overrides.materialDomain || 'Surface',
    blendMode: overrides.blendMode || 'Opaque',
    shadingModel: overrides.shadingModel || 'DefaultLit',
    twoSided: overrides.twoSided || false,
    usageFlags: overrides.usageFlags || [],
    compileStatus: overrides.compileStatus || 'success',
    compileDiagnostics: overrides.compileDiagnostics || [],
    lastHealthCheckAt: overrides.lastHealthCheckAt,
    nodeCount: overrides.nodeCount || 0,
    connectionCount: overrides.connectionCount || 0,
    graphSummary: overrides.graphSummary || createEmptyGraphSummary(),
    graphBlueprintCode: overrides.graphBlueprintCode ?? null,
    scalarParameters: overrides.scalarParameters || [],
    vectorParameters: overrides.vectorParameters || [],
    textureParameters: overrides.textureParameters || [],
    staticSwitchParameters: overrides.staticSwitchParameters || [],
    textureDependencies: overrides.textureDependencies || [],
    functionDependencies: overrides.functionDependencies || [],
    parameterCollectionDependencies: overrides.parameterCollectionDependencies || [],
    missingDependencies: overrides.missingDependencies || [],
    parentMaterialPath: overrides.parentMaterialPath,
    childInstancePaths: overrides.childInstancePaths || [],
    referencedByPaths: overrides.referencedByPaths || [],
    collectionId: overrides.collectionId,
    sourceOrigin: overrides.sourceOrigin || 'live',
    liveDataState: overrides.liveDataState || 'full',
    syncIssues: overrides.syncIssues || [],
    lastSyncedAt: overrides.lastSyncedAt ?? 200,
    lastSyncAttemptAt: overrides.lastSyncAttemptAt ?? 200,
    liveRefreshAvailable: overrides.liveRefreshAvailable ?? true,
    legacyKey: overrides.legacyKey
  } as MaterialEntry
}
