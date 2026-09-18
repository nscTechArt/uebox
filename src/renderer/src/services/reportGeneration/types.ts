export interface ReportState {
  status: 'idle' | 'collecting' | 'generating' | 'completed' | 'failed'
  progress: number
  message: string
  error?: string
  reportContent?: string
}
