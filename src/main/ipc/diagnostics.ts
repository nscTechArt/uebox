import { ipcMain } from 'electron'

import {
  dismissImportRecoveryContext,
  listImportRecoveryContexts,
  type ImportRecoveryContextSummary
} from '../services/asset/ImportRecoveryContextService'
import {
  abandonImport,
  resumeImport,
  type AbandonImportRequest,
  type ResumeImportRequest
} from '../services/asset/ResumeImportService'

export function registerDiagnosticsIPC(): void {
  ipcMain.handle('diagnostics:resume-import', async (_event, request: ResumeImportRequest) => {
    return resumeImport(request || {})
  })

  ipcMain.handle('diagnostics:abandon-import', async (_event, request: AbandonImportRequest) => {
    return abandonImport(request || {})
  })

  ipcMain.handle(
    'diagnostics:list-import-recovery',
    async (_event, request?: { limit?: number }): Promise<ImportRecoveryContextSummary[]> => {
      return listImportRecoveryContexts(request?.limit || 10)
    }
  )

  ipcMain.handle(
    'diagnostics:dismiss-import-recovery',
    async (
      _event,
      request?: { taskId?: string; diagnosticId?: string }
    ): Promise<{ success: boolean }> => {
      return { success: dismissImportRecoveryContext(request || {}) }
    }
  )
}
