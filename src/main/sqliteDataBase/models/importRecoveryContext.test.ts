import { describe, expect, it, vi } from 'vitest'

import { listImportRecoveryContexts } from './importRecoveryContext'

describe('importRecoveryContext model', () => {
  it('does not include failed recovery records in the default auto prompt list', () => {
    const all = vi.fn(() => [])
    const prepare = vi.fn(() => ({ all }))
    const db = { prepare } as any

    listImportRecoveryContexts(db)

    expect(all).toHaveBeenCalledWith('ready', 'resuming', 10)
  })
})
