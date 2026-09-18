import { afterEach, expect, it, vi } from 'vitest'
import { saveAudioCopy } from './chatAudio'

afterEach(() => vi.unstubAllGlobals())

it('copies only after choosing a destination and surfaces copy failures', async () => {
  const dialog = vi.fn()
  const copy = vi.fn()
  vi.stubGlobal('api', { dialog: { showSaveDialog: dialog }, fs: { copyFile: copy } })
  dialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
  await saveAudioCopy('C:/music/1.mp3')
  expect(copy).not.toHaveBeenCalled()
  dialog.mockResolvedValue({ canceled: false, filePath: 'C:/saved.mp3' })
  copy.mockResolvedValueOnce({ success: true })
  await saveAudioCopy('C:/music/1.mp3')
  expect(copy).toHaveBeenCalledWith('C:/music/1.mp3', 'C:/saved.mp3')
  copy.mockResolvedValueOnce({ success: false, error: 'Disk full' })
  await expect(saveAudioCopy('C:/music/1.mp3')).rejects.toThrow('Disk full')
})
