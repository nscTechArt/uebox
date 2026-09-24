import { unwrapResult } from '@renderer/common/utils'
import i18n from '@renderer/i18n'

export const projectCoverAPI = {
  async restoreAutomatic(projectKey: string): Promise<void> {
    const result = await window.api.database.project.restoreAutomaticCover(projectKey)
    if (!unwrapResult(result)) throw new Error('Project cover mode was not updated')
  },
  async selectImage(): Promise<string | null> {
    const result = await window.api.dialog.showOpenDialog({
      title: i18n.global.t('page.home.project.messages.selectCoverTitle'),
      properties: ['openFile'],
      filters: [
        {
          name: i18n.global.t('page.home.project.messages.imageFile'),
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif']
        }
      ]
    })
    const path = result?.filePaths?.[0]
    if (result?.canceled || !path) return null
    const resultFile = await window.api.fs.readFile(path, {
      encoding: 'base64',
      maxLines: -1,
      maxBytes: -1
    })
    const content = unwrapResult({ ...resultFile, data: resultFile.content })
    if (!content) throw new Error('Empty image')
    const extension = path.split('.').pop()?.toLowerCase()
    const type =
      extension === 'png'
        ? 'png'
        : extension === 'webp'
          ? 'webp'
          : extension === 'gif'
            ? 'gif'
            : 'jpeg'
    return `data:image/${type};base64,${content}`
  },
  async save(projectKey: string, image: Uint8Array): Promise<void> {
    const result = await window.api.database.project.saveCover(projectKey, image)
    const saved = unwrapResult(result)
    if (!saved) throw new Error('Project cover was not saved')
  }
}
