/**
 * 「这两个字符串指的是不是同一个 UE 工程」——唯一那把尺子的测试。
 *
 * 这个文件一度不存在：整个改造把 `projectPathKey` 指定成唯一的尺子，却没给它
 * 一条用例，唯一的间接覆盖是某个工具测试里的一行。问题在于它判错不会报错 ——
 * 两个跨工程的闸门（`isOutOfSessionScope` 管写、`retargetToProject` 管切）
 * 都拿它比，判错的表现是命令静默落进另一个工程。
 */
import { describe, expect, it } from 'vitest'

import { isSameProjectPath, projectPathKey } from './projectPathKey'

describe('projectPathKey', () => {
  it('抹平大小写、斜杠方向和结尾斜杠', () => {
    const want = 'i:/dev/pond'
    expect(projectPathKey('I:/Dev/Pond')).toBe(want)
    expect(projectPathKey('I:\\Dev\\Pond')).toBe(want)
    expect(projectPathKey('I:/Dev/Pond/')).toBe(want)
    expect(projectPathKey('I:\\Dev\\Pond\\\\')).toBe(want)
    expect(projectPathKey('  I:/Dev/Pond  ')).toBe(want)
  })

  /*
   * 插件报上来的是工程目录，模型调 `open_project` 给的往往是 `.uproject` 文件
   * 本身。不削成目录的话两者永远比不上，而表现不是报错 —— 真机上出现过：
   * 切目标那边认为是同一个工程、切了过去并告诉用户「已经改发给它」，
   * 作用域那边认为没连上、一个 `ue.*` 工具都没注册。
   */
  it('把 .uproject 削成它所在的目录，大小写不限', () => {
    expect(projectPathKey('I:/Dev/Pond/Pond.uproject')).toBe('i:/dev/pond')
    expect(projectPathKey('I:\\Dev\\Pond\\Pond.UPROJECT')).toBe('i:/dev/pond')
    expect(isSameProjectPath('I:/Dev/Pond/Pond.uproject', 'i:\\dev\\pond')).toBe(true)
  })

  /*
   * **这个文件存在的全部理由。**
   *
   * 没有分隔符时原样返回，不要 `slice(0, -1)`：那会把 `'Pond.uproject'` 啃成
   * `'pond.uprojec'` —— 一个非空的垃圾键，过得了「空就拒绝」那道闸，然后和谁
   * 都比不上。模型直接把工程名当路径给的时候就会撞上这一条。
   *
   * 同样的 bug 此刻还活在 `capabilities/mcp/externalTarget.ts` 里。
   */
  it('裸文件名不削 —— 不许啃成 pond.uprojec', () => {
    expect(projectPathKey('Pond.uproject')).toBe('pond.uproject')
    expect(projectPathKey('Pond.uproject')).not.toBe('pond.uprojec')
    // 非空，所以过得了「空就拒绝」，但不该和任何真实工程判等
    expect(isSameProjectPath('Pond.uproject', 'I:/Dev/Pond')).toBe(false)
  })

  it('UNC 路径照样削到目录', () => {
    expect(projectPathKey('\\\\build01\\share\\Pond\\Pond.uproject')).toBe('//build01/share/pond')
  })

  it('空、null、undefined 都给空串', () => {
    expect(projectPathKey('')).toBe('')
    expect(projectPathKey('   ')).toBe('')
    expect(projectPathKey(null)).toBe('')
    expect(projectPathKey(undefined)).toBe('')
  })

  /*
   * 「不知道」不是「相同」。
   *
   * 两个闸门都靠这一条：归属路径说不出来时不能判成「和要写的那个是同一个工程」，
   * 否则证不明的状态会被当成已证明。
   */
  it('空串谁都不等于，包括另一个空串', () => {
    expect(isSameProjectPath('', '')).toBe(false)
    expect(isSameProjectPath(undefined, undefined)).toBe(false)
    expect(isSameProjectPath('I:/Dev/Pond', '')).toBe(false)
    expect(isSameProjectPath(null, 'I:/Dev/Pond')).toBe(false)
  })

  it('不同工程不能判等 —— 前缀相同也不行', () => {
    expect(isSameProjectPath('I:/Dev/Pond', 'I:/Dev/Pond2')).toBe(false)
    expect(isSameProjectPath('I:/Dev/Pond', 'I:/Dev')).toBe(false)
  })
})
