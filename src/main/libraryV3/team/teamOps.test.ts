// @vitest-environment node
/**
 * 成员面路由表：渲染层只能按名字调、参数逐个校验、`{p}` 永远是库绑定的工程。
 */
import { describe, expect, it } from 'vitest'
import { TeamOpError, buildTeamRoute, isTeamOp } from './teamOps'

describe('team ops', () => {
  it('only knows the names in the table', () => {
    expect(isTeamOp('submits')).toBe(true)
    expect(isTeamOp('constructor')).toBe(false)
    expect(isTeamOp('toString')).toBe(false)
    expect(isTeamOp(42)).toBe(false)
  })

  it('builds the activity query with only the filters that are set', () => {
    const route = buildTeamRoute('submits', 'xinghai', {
      limit: 50,
      author: 'ajie',
      milestones: true,
      q: '#1532',
      state: 'bogus'
    })
    expect(route).toMatchObject({ method: 'GET', path: '/v1/projects/xinghai/submits' })
    expect(route.query).toMatchObject({ limit: 50, author: 'ajie', milestones: 1, q: '#1532' })
    expect(route.query?.state).toBeUndefined()
  })

  it('escapes the project id and ids in the path', () => {
    expect(buildTeamRoute('bisect', 'a/b', { id: '../x' }).path).toBe(
      '/v1/projects/a%2Fb/bisects/..%2Fx'
    )
  })

  it('refuses an empty reject reason (打回 needs a reason the author sees)', () => {
    expect(() => buildTeamRoute('reject', 'xinghai', { number: 12, reason: '' })).toThrow(
      TeamOpError
    )
    expect(buildTeamRoute('reject', 'xinghai', { number: 12, reason: '法线方向反了' })).toEqual({
      method: 'POST',
      path: '/v1/projects/xinghai/submits/12/reject',
      body: { reason: '法线方向反了' }
    })
  })

  it('take-back without paths means all of that person’s check-outs', () => {
    const route = buildTeamRoute('takeBack', 'xinghai', { holder: 'xiaowang', reason: '' })
    expect(route.body).toEqual({
      holder: 'xiaowang',
      paths: undefined,
      reason: undefined,
      askId: undefined
    })
  })

  it('compare defaults the end to latest and keeps latest as a word', () => {
    expect(buildTeamRoute('compare', 'xinghai', { from: 4 }).query).toMatchObject({
      from: 4,
      to: 'latest'
    })
    expect(buildTeamRoute('compare', 'xinghai', { from: 'latest', to: 8 }).query).toMatchObject({
      from: 'latest',
      to: 8
    })
  })

  it('only accepts the three verdicts', () => {
    expect(() =>
      buildTeamRoute('bisectVerdict', 'xinghai', { id: 'b1', number: 6, verdict: 'maybe' })
    ).toThrow(TeamOpError)
    expect(
      buildTeamRoute('bisectVerdict', 'xinghai', { id: 'b1', number: 6, verdict: 'skip' }).body
    ).toEqual({ number: 6, verdict: 'skip' })
  })

  it('folder rules keep only the parts that were given', () => {
    expect(
      buildTeamRoute('putFolderRules', 'xinghai', { path: 'Config', submit: { mode: 'only' } }).body
    ).toEqual({
      path: 'Config',
      submit: { mode: 'only' }
    })
  })

  it('delivery checks send path, action and size only', () => {
    const route = buildTeamRoute('submitPlan', 'xinghai', {
      files: [{ path: 'Content/Env/Rocks/Rock_12.uasset', size: 10, extra: 'x' }]
    })
    expect(route.body).toEqual({
      purpose: 'delivery',
      files: [
        { path: 'Content/Env/Rocks/Rock_12.uasset', action: 'added', size: 10, class: undefined }
      ]
    })
  })
})
