export type SpotlightAction = 'project' | 'asset' | 'ai' | 'note'

export interface SpotlightSearchResult {
  id: string
  type: SpotlightAction
  title: string
  description?: string
  icon: string
  data: Record<string, unknown>
}

export interface SpotlightSearchResponse {
  success: boolean
  data: SpotlightSearchResult[]
  error?: string
}
