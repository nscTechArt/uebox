import { app, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'

/** Export one existing file to the OS; never moves or edits the source itself. */
export async function startNativeFileDrag(
  event: IpcMainInvokeEvent,
  filePath: unknown
): Promise<{ success: boolean; data?: boolean }> {
  try {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      return { success: false }
    }
    if (!(await stat(filePath)).isFile()) return { success: false }
    const icon = await app.getFileIcon(filePath, { size: 'large' })
    if (event.sender.isDestroyed() || icon.isEmpty()) return { success: false }
    event.sender.startDrag({ file: filePath, icon })
    return { success: true, data: true }
  } catch {
    return { success: false }
  }
}
