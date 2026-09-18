import i18n from '@renderer/i18n'
import { unwrapResult } from '@renderer/common/utils'

export async function startNativeFileDrag(filePath: string): Promise<void> {
  // Windows runs a nested native drag loop until drop/cancel. Its file events
  // re-enter this window without the original HTML drag's custom MIME data.
  // Capture them before ANY import target sees them, including folder targets.
  const blockSelfImport = (event: DragEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  }
  const events = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
  for (const name of events) window.addEventListener(name, blockSelfImport, true)
  try {
    const result = await window.api.startNativeFileDrag(filePath)
    unwrapResult(
      { ...result, data: result.data },
      i18n.global.t('assetFileList.externalDragFailed')
    )
  } finally {
    for (const name of events) window.removeEventListener(name, blockSelfImport, true)
  }
}
