interface AggregateLikeError extends Error {
  errors?: unknown[]
  code?: string
  errno?: number
  syscall?: string
  address?: string
  port?: number
  cause?: unknown
}

const describeSingleError = (error: unknown): string => {
  if (!error) {
    return 'Unknown error'
  }

  if (typeof error === 'string') {
    return error
  }

  if (error instanceof Error) {
    const parts: string[] = []
    const aggregateError = error as AggregateLikeError
    const message = error.message?.trim()

    if (message) {
      parts.push(message)
    } else if (error.name && error.name !== 'Error') {
      parts.push(error.name)
    }

    if (aggregateError.code) {
      parts.push(`code=${aggregateError.code}`)
    }
    if (aggregateError.syscall) {
      parts.push(`syscall=${aggregateError.syscall}`)
    }
    if (aggregateError.address) {
      parts.push(`address=${aggregateError.address}`)
    }
    if (aggregateError.port) {
      parts.push(`port=${aggregateError.port}`)
    }

    if (parts.length > 0) {
      return parts.join(' ')
    }
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const collectNestedErrors = (error: unknown, visited = new Set<unknown>()): string[] => {
  if (!error || visited.has(error)) {
    return []
  }
  visited.add(error)

  const current = describeSingleError(error)
  const details = current ? [current] : []

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      details.push(...collectNestedErrors(nested, visited))
    }
    return details
  }

  if (error instanceof Error) {
    const aggregateLike = error as AggregateLikeError

    if (Array.isArray(aggregateLike.errors)) {
      for (const nested of aggregateLike.errors) {
        details.push(...collectNestedErrors(nested, visited))
      }
    }

    if (aggregateLike.cause) {
      details.push(...collectNestedErrors(aggregateLike.cause, visited))
    }
  }

  return details
}

export const normalizeNotebookRagError = (
  error: unknown,
  context: 'index' | 'search' | 'embeddings'
): Error => {
  const details = Array.from(new Set(collectNestedErrors(error))).filter(Boolean)
  const fallback =
    context === 'search'
      ? 'Notebook search failed'
      : context === 'embeddings'
        ? 'Embeddings request failed'
        : 'Notebook vectorization failed'

  const detailText = details.join(' | ').trim()
  const message = detailText ? `${fallback}: ${detailText}` : fallback

  const normalized = new Error(message)
  if (error instanceof Error && error.stack) {
    normalized.stack = error.stack
  }
  return normalized
}
