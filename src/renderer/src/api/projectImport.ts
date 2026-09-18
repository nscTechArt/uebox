import i18n from '@renderer/i18n'
import { unwrapResult } from '@renderer/common/utils'

interface ImportCompatibility {
  projectVersion: string
  blocked: Array<{ assetKey: string; assetName: string; version: string }>
}

export const checkImportCompatibility = async (
  project: { EngineAssociation?: string | null },
  sources: Array<{ assetKey?: string }>
): Promise<ImportCompatibility> => {
  // 过 IPC 的参数必须是能结构化克隆的。调用方手里一般是 Vue 的响应式对象（Proxy），
  // 直接丢进 invoke 会抛 "An object could not be cloned."，而且报错里完全看不出
  // 是哪个参数的问题。这里重建成纯对象，顺带只带主进程真正会读的两个字段 ——
  // 整行资产（含缩略图之类的大字段）没必要搬过去。
  const result = await window.api.projectImport.checkCompatibility(
    { EngineAssociation: project?.EngineAssociation ?? null },
    sources
      .map((source) => String(source?.assetKey || ''))
      .filter(Boolean)
      .map((assetKey) => ({ assetKey }))
  )
  return unwrapResult<ImportCompatibility>(
    {
      ...result,
      success: result.success && Boolean(result.data),
      data: result.data || { projectVersion: '', blocked: [] }
    },
    i18n.global.t('importToProjectModal.compatibilityCheckFailed')
  )
}

export const getImportProjectCollections = async (): Promise<ProjectCollectionRecord[]> =>
  unwrapResult(
    await window.api.database.projectCollection.getAll(),
    i18n.global.t('importToProjectModal.loadProjectsFailed')
  )
