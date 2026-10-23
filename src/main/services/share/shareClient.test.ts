import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchSharedSkill, publishSharedSkill, ShareError } from './shareClient'

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when needed.\n---\n\nbody\n`

function reply(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('publishSharedSkill', () => {
  it('带上账户的 Key，回发布结果', async () => {
    reply(201, { id: 'a-skill', version: 1, status: 'pending', url: 'https://uebox.ai/s/a-skill' })
    const result = await publishSharedSkill('ubx-sk-x', [
      { path: 'SKILL.md', content: skillMd('a-skill') }
    ])
    expect(result).toEqual({
      id: 'a-skill',
      version: 1,
      status: 'pending',
      url: 'https://uebox.ai/s/a-skill'
    })
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ubx-sk-x')
  })

  it('Key 失效报「没连接」，界面据此让用户重新连', async () => {
    reply(401, { error: { code: 'unauthorized', message: 'Invalid' } })
    await expect(publishSharedSkill('k', [])).rejects.toMatchObject({ code: 'not-connected' })
  })

  it('被拒时按原因代号给中文，没列到的用服务端原句', async () => {
    reply(400, { error: { code: 'invalid_request', param: 'name_taken', message: 'taken' } })
    await expect(publishSharedSkill('k', [])).rejects.toThrow('已经被别的账户用了')

    reply(400, { error: { code: 'invalid_request', param: 'whatever', message: 'Something odd' } })
    const err = await publishSharedSkill('k', []).catch((e: ShareError) => e)
    expect(err).toBeInstanceOf(ShareError)
    expect((err as ShareError).message).toBe('Something odd')
  })
})

describe('fetchSharedSkill', () => {
  it('作者名取自账户，内容不合规就拒装', async () => {
    reply(200, {
      id: 'a-skill',
      author: { id: 'u1', name: '陈东', image: null },
      version: 3,
      installs: 7,
      updated_at: '2026-10-21T00:00:00.000Z',
      files: [{ path: 'SKILL.md', content: skillMd('a-skill') }]
    })
    expect(await fetchSharedSkill('a-skill')).toMatchObject({
      author: '陈东',
      version: 3,
      installs: 7
    })

    reply(200, {
      id: 'a-skill',
      files: [
        { path: 'SKILL.md', content: skillMd('a-skill') },
        { path: 'scripts/run.py', content: 'x' }
      ]
    })
    await expect(fetchSharedSkill('a-skill')).rejects.toMatchObject({ code: 'invalid' })
  })
})
