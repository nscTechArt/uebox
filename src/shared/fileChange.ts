/** Immutable contents captured around one successful file operation. */
export interface FileChange {
  path: string
  before: string
  after: string
  created: boolean
}

export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

/** Combine consecutive snapshots of a file without hiding intervening external edits. */
export function mergeFileChanges(changes: FileChange[]): FileChange[] {
  const merged: FileChange[] = []
  const last = new Map<string, FileChange>()
  for (const change of changes) {
    const path = change.path.replace(/\\/g, '/')
    const key = /^[a-z]:\//i.test(path) ? path.toLowerCase() : path
    const previous = last.get(key)
    if (previous && previous.after === change.before) previous.after = change.after
    else {
      const snapshot = { ...change }
      merged.push(snapshot)
      last.set(key, snapshot)
    }
  }
  return merged
}

export function readFileChange(value: unknown): FileChange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const change = value as Partial<FileChange>
  if (
    typeof change.path !== 'string' ||
    typeof change.before !== 'string' ||
    typeof change.after !== 'string' ||
    typeof change.created !== 'boolean'
  )
    return undefined
  return change as FileChange
}

/** Bounded LCS: large rewrites use a replacement block instead of quadratic work. */
export function fileDiff(before: string, after: string): DiffLine[] {
  const split = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const a = split(before)
  const b = split(after)
  const rows: DiffLine[] = []
  let i = 0
  let j = 0
  const emit = (kind: DiffLine['kind']): void => {
    const oldLine = kind === 'add' ? undefined : i + 1
    const newLine = kind === 'remove' ? undefined : j + 1
    const text = kind === 'add' ? b[j] : a[i]
    rows.push({ kind, text, oldLine, newLine })
    if (kind !== 'add') i++
    if (kind !== 'remove') j++
  }
  while (i < a.length && j < b.length && a[i] === b[j]) emit('same')
  let endA = a.length
  let endB = b.length
  while (endA > i && endB > j && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - i
  const m = endB - j
  if (n * m <= 1_000_000) {
    const startI = i
    const startJ = j
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        lcs[x * width + y] =
          a[startI + x] === b[startJ + y]
            ? 1 + lcs[(x + 1) * width + y + 1]
            : Math.max(lcs[(x + 1) * width + y], lcs[x * width + y + 1])
      }
    }
    while (i < endA && j < endB) {
      if (a[i] === b[j]) emit('same')
      else if (
        lcs[(i - startI + 1) * width + j - startJ] >= lcs[(i - startI) * width + j - startJ + 1]
      )
        emit('remove')
      else emit('add')
    }
  }
  while (i < endA) emit('remove')
  while (j < endB) emit('add')
  while (i < a.length) emit('same')
  return rows
}
