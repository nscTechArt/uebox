/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTeamLive, mailIdsIn, renderLiveMail, type TeamLive } from './teamLive'
import { createTeamStore, PRODUCER, type TeamStore } from './teamStore'
import { createMessageTool, createTeamTools } from './teamTools'
import type { SubAgentResult } from '../../tools/builtin/task'

/**
 * 当场对话要答对三件事：对方在跑时这句话真的插进去了；「读到」是真读到；
 * 两个人互相等的时候不会卡死。
 */

let dir: string
let store: TeamStore
let live: TeamLive

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'team-live-'))
  store = createTeamStore({ stateDir: join(dir, 'state'), workspaceDir: join(dir, 'ws') })
  await store.ensure()
  await store.putMember({ name: '美术', persona: 'a', tier: 'strong', readOnly: false, hiredAt: 1 })
  await store.putMember({ name: '程序', persona: 'b', tier: 'strong', readOnly: false, hiredAt: 2 })
  live = createTeamLive(store)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const text = async (tool: ReturnType<typeof createMessageTool>, args: unknown): Promise<string> => {
  const result = await tool.execute('call', args as never)
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

describe('送法', () => {
  it('对方在跑：插进它的下一步；读到之前是「送到」，读到之后才是「已读」', async () => {
    const steered: string[] = []
    live.attach('程序', { steer: (t) => steered.push(t) })
    const { mail, delivery } = await live.send('美术', '程序', '角色在 /Game/Hero')
    expect(delivery).toBe('live')
    expect(steered[0]).toContain(`[team mail ${mail.id} · from 美术]`)
    expect((await store.mail())[0]).toMatchObject({ deliveredAt: expect.any(Number) })
    expect((await store.mail())[0]?.readAt).toBeUndefined()

    await live.consumed('程序', steered[0]!)
    expect((await store.mail())[0]?.readAt).toEqual(expect.any(Number))
  })

  it('对方没在跑：进信箱，下次接活时交给它', async () => {
    const { delivery } = await live.send('美术', '程序', 'hi')
    expect(delivery).toBe('queued')
    expect((await store.takeInbox('程序')).map((m) => m.text)).toEqual(['hi'])
  })

  it('插进去了但它没来得及读就收工：退回信箱，不丢', async () => {
    const detach = live.attach('程序', { steer: () => undefined })
    await live.send('美术', '程序', '别忘了存盘')
    await detach()
    expect((await store.takeInbox('程序')).map((m) => m.text)).toEqual(['别忘了存盘'])
  })
})

describe('回执与回复', () => {
  it('等回执：对方读到那一刻返回', async () => {
    const steered: string[] = []
    live.attach('程序', { steer: (t) => steered.push(t) })
    const { mail } = await live.send('美术', '程序', 'x')
    const receipt = live.waitRead(mail.id, 1000)
    live.consumed('程序', steered[0]!)
    await expect(receipt).resolves.toBe('read')
  })

  it('等回复：对方带 reply_to 回话就交回来', async () => {
    live.attach('程序', { steer: () => undefined })
    live.attach('美术', { steer: () => undefined })
    const { mail } = await live.send('美术', '程序', '贴图要几张？')
    const waiting = live.waitReply('美术', mail.id, 1000)
    const { delivery } = await live.send('程序', '美术', '三张', mail.id)
    expect(delivery).toBe('handed')
    await expect(waiting).resolves.toMatchObject({ kind: 'reply', mail: { text: '三张' } })
  })

  it('防死锁：A 在等 B 回话，B 反过来问 A —— A 被叫醒，看到 B 的问题', async () => {
    live.attach('程序', { steer: () => undefined })
    const { mail } = await live.send('美术', '程序', '接口定了吗？')
    const aWaits = live.waitReply('美术', mail.id, 1000)
    await live.send('程序', '美术', '你先说贴图尺寸')
    await expect(aWaits).resolves.toMatchObject({
      kind: 'incoming',
      mails: [{ text: '你先说贴图尺寸' }]
    })
  })

  it('等不到就超时返回，不挂死', async () => {
    live.attach('程序', { steer: () => undefined })
    const { mail } = await live.send('美术', '程序', 'x')
    await expect(live.waitReply('美术', mail.id, 20)).resolves.toEqual({ kind: 'timeout' })
  })

  it('制作人正等着这个队员交活时，队员要等制作人回话：直接告诉它写进结论', async () => {
    live.attach(PRODUCER, { steer: () => undefined })
    const done = live.awaiting('美术')
    const tool = createMessageTool(store, '美术', live)
    await expect(
      tool.execute('c', { to: PRODUCER, text: '要什么风格？', wait: 'reply' } as never)
    ).rejects.toThrow(/写进你的结论/)
    done()
  })

  it('工具层：回执写进回话', async () => {
    const steered: string[] = []
    live.attach('程序', { steer: (t) => steered.push(t) })
    const tool = createMessageTool(store, '美术', live)
    const pending = text(tool, { to: '程序', text: '好了', wait: 'read', wait_seconds: 10 })
    // 先落盘再插进去，机器忙的时候要一会儿 —— 等它真的插进去了再「读」
    while (steered.length === 0) await new Promise((r) => setTimeout(r, 5))
    live.consumed('程序', steered[0]!)
    await expect(pending).resolves.toMatch(/已插进它的下一步[\s\S]*回执：程序 已读到/)
  })
})

describe('后台派活', () => {
  it('wait=false：立刻回来；干完的结论作为留言送给制作人，等它的人被叫醒', async () => {
    let finish!: (r: SubAgentResult) => void
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const tools = createTeamTools({
      store,
      live,
      objective: 'x',
      namespaces: [],
      runMember: () =>
        new Promise((resolve) => {
          finish = resolve
          started()
        }),
      runAcceptance: async () => ''
    })
    const send = tools.find((t) => t.name === 'team_send')!
    const out = await send.execute('c', { to: '美术', message: '画主角', wait: false } as never)
    expect(out.content.map((c) => ('text' in c ? c.text : '')).join('')).toMatch(/在后台干/)
    expect(live.pendingJobs().map((j) => j.member)).toEqual(['美术'])

    const settled = live.nextSettle(1000)
    await running
    finish({ text: '主角画好了', messageCount: 1 })
    await expect(settled).resolves.toBe(true)
    expect(live.pendingJobs()).toEqual([])
    const inbox = await store.takeInbox(PRODUCER)
    expect(inbox[0]?.text).toMatch(/^【交活】美术 回话：\n主角画好了/)
  })
})

describe('标记', () => {
  it('插进去的那段带编号，读到时认得回来', () => {
    const rendered = renderLiveMail({
      id: 'm7',
      from: PRODUCER,
      to: '美术',
      text: '改成卡通风',
      at: 0
    })
    expect(rendered).toMatch(/^\[team mail m7 · from 制作人\] This is not the user speaking\./)
    expect(mailIdsIn(rendered)).toEqual(['m7'])
  })
})
