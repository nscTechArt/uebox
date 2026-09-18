import { expect, it, vi } from 'vitest'
import { useImageStudioStore } from './imageStore'

it('preserves upload failure details when restoring history after a refresh', async () => {
  const error = '参考图上传失败 HTTP 400：Image too large. Maximum size is 10MB'
  vi.mocked(window.electron.ipcRenderer.invoke).mockImplementation(async (channel) => {
    if (channel === 'image:getHistory') {
      return {
        success: true,
        data: [{ id: 1, task_id: 'upload-failed', status: 'failed', error_msg: error }]
      }
    }
    return { tasks: [] }
  })
  const store = useImageStudioStore()
  await store.loadHistory()
  expect(store.historyTasks[0].error).toBe(error)
})
