import { buildInfographicModelOptions } from '@renderer/services/infographic/modelOptions'

export type ImageGenerationAccess = { ok: true } | { ok: false; reasonKey: string }

/** The page can select any configured image model; the global role is only a default. */
export async function hasAvailableImageModel(): Promise<boolean> {
  try {
    const settings = await window.api.aiProvider.getSettings()
    return buildInfographicModelOptions(settings).length > 0
  } catch {
    return false
  }
}

export async function isImageGenerationConfigured(): Promise<boolean> {
  return hasAvailableImageModel()
}

export async function resolveImageGenerationAccess(): Promise<ImageGenerationAccess> {
  return (await hasAvailableImageModel())
    ? { ok: true }
    : { ok: false, reasonKey: 'aigcImagePanel.access.noImageModel' }
}
