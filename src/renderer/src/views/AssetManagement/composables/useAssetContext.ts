import { inject } from 'vue'
import { AssetContextKey, type AssetContext } from '../context'

export const useAssetContext = (): AssetContext => {
  const context = inject(AssetContextKey)

  if (!context) {
    throw new Error('useAssetContext must be used within an AssetProvider')
  }

  return context
}
