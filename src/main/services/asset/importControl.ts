// Shared by scanning, importing and vault switching; no database or Electron imports.
const active = new Map<string, AbortController>()
let switching = false

export function beginAssetImport(taskId: string): AbortController {
  if (switching) throw new Error('正在切换保管库，请稍后重新导入')
  if (active.has(taskId)) throw new Error('导入任务正在运行')
  const controller = new AbortController()
  active.set(taskId, controller)
  return controller
}

export function finishAssetImport(taskId: string, controller: AbortController): void {
  if (active.get(taskId) === controller) active.delete(taskId)
}

export function cancelAssetImport(taskId: string): boolean {
  const controller = active.get(taskId)
  if (!controller) return false
  controller.abort(new Error('已取消导入'))
  return true
}

export function beginImportVaultSwitch(): void {
  if (active.size > 0) throw new Error('资产正在导入，请等待完成或取消导入后再切换保管库')
  if (switching) throw new Error('正在切换保管库，请稍后重试')
  switching = true
}

export function finishImportVaultSwitch(): void {
  switching = false
}
