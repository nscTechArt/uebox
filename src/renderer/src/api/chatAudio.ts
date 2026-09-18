import { unwrapResult } from '@renderer/common/utils'

export async function saveAudioCopy(filePath: string): Promise<void> {
  const result = await window.api.dialog.showSaveDialog({
    defaultPath: filePath.split(/[\\/]/).pop()
  })
  if (result.canceled || !result.filePath || result.filePath === filePath) return
  unwrapResult({ ...(await window.api.fs.copyFile(filePath, result.filePath)), data: undefined })
}
