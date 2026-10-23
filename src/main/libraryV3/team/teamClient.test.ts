// @vitest-environment node
/**
 * 成员面的错误：按 `{code}` 选界面文案（契约 1.2），而不是只看状态码 —— 409 有七种意思。
 */
import { describe, expect, it } from 'vitest'
import { codeForStatus, parseTeamFailure } from './teamClient'

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))

describe('team failures', () => {
  it('keeps the server code', () => {
    const error = parseTeamFailure(409, json({ error: 'asked recently', code: 'asked-recently' }))
    expect(error.code).toBe('asked-recently')
    expect(error.status).toBe(409)
    expect(error.body).toMatchObject({ code: 'asked-recently' })
  })

  it('falls back to the status when there is no code', () => {
    expect(parseTeamFailure(403, json({ error: 'no' })).code).toBe('not-allowed')
    expect(parseTeamFailure(401, json({ error: 'no' })).code).toBe('signed-out')
    expect(parseTeamFailure(503, Buffer.from('busy')).code).toBe('lore-unavailable')
  })

  it('treats an empty 404 as a route this server does not have yet', () => {
    expect(parseTeamFailure(404, Buffer.alloc(0)).code).toBe('not-implemented')
    expect(parseTeamFailure(404, json({ error: 'no such', code: 'not-found' })).code).toBe(
      'not-found'
    )
  })

  it('maps the rest of the table', () => {
    expect(codeForStatus(410)).toBe('invite-expired')
    expect(codeForStatus(423)).toBe('archived')
    expect(codeForStatus(501)).toBe('not-implemented')
    expect(codeForStatus(500)).toBe('server')
  })
})
