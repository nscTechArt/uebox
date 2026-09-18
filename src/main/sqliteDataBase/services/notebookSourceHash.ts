import { createHash } from 'crypto'

export const computeNotebookSourceContentHash = (content: string | null | undefined): string =>
  createHash('sha256')
    .update(content ?? '', 'utf8')
    .digest('hex')
