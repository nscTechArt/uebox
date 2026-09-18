type SharpFn = typeof import('sharp').default
type SharpModule = typeof import('sharp') & {
  default?: SharpFn
}

let sharpPromise: Promise<SharpFn> | null = null

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getSharp(): Promise<SharpFn> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((module) => {
        const normalizedModule = module as SharpModule
        const sharp = normalizedModule.default ?? normalizedModule
        if (typeof sharp !== 'function') {
          throw new Error('sharp default export is unavailable')
        }
        return sharp
      })
      .catch((error) => {
        sharpPromise = null
        throw new Error(`Failed to load sharp: ${toErrorMessage(error)}`)
      })
  }

  return sharpPromise
}
