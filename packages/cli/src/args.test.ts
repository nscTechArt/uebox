/** @vitest-environment node */
import { beforeEach, describe, expect, it } from 'vitest'

import { assertArgsInputExclusive, parse } from './args.js'
import { run } from './cli.js'
import { isSettled, resetSettledForTest } from './interrupt.js'
import { exitCodeFor, UeboxError } from './errors.js'

describe('parse', () => {
  it('拆出命令和公共选项', () => {
    const parsed = parse(['tools', 'list', '--json', '--search', 'blueprint'])

    expect(parsed.command).toEqual(['tools', 'list'])
    expect(parsed.json).toBe(true)
    expect(parsed.search).toBe('blueprint')
  })

  /** §4：公共选项允许出现在子命令前后。写在前面是很自然的手感，不该报错 */
  it('公共选项写在子命令前面也认', () => {
    const before = parse(['--json', 'tools', 'list'])
    const after = parse(['tools', 'list', '--json'])

    expect(before.command).toEqual(after.command)
    expect(before.json).toBe(after.json)
  })

  /** 猜错的代价是执行了一条用户没打算执行的命令，所以不做模糊匹配 */
  it('未知选项立刻报用法错误', () => {
    try {
      parse(['tools', 'list', '--nope'])
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as UeboxError).code).toBe('INVALID_ARGUMENT')
      expect(exitCodeFor((error as UeboxError).code)).toBe(2)
    }
  })

  it('工程路径原样保留，带空格和中文都不动它', () => {
    const parsed = parse(['tools', 'call', 'ue_get_selection', '--project', 'D:/我的 工程/Demo'])

    expect(parsed.project).toBe('D:/我的 工程/Demo')
    expect(parsed.command).toEqual(['tools', 'call', 'ue_get_selection'])
  })

  describe('--timeout', () => {
    it('接受正整数秒', () => {
      expect(parse(['doctor', '--timeout', '300']).timeoutSeconds).toBe(300)
    })

    it('非数字、零、负数、超上限都挡下', () => {
      for (const bad of ['abc', '0', '-5', '99999']) {
        expect(() => parse(['doctor', '--timeout', bad])).toThrow(/--timeout/)
      }
    })
  })

  describe('--limit', () => {
    it('取 1–1000 的整数', () => {
      expect(parse(['actors', 'list', '--limit', '1']).limit).toBe(1)
      expect(parse(['actors', 'list', '--limit', '1000']).limit).toBe(1000)
    })

    it('0、1001、小数都挡下', () => {
      for (const bad of ['0', '1001', '1.5']) {
        expect(() => parse(['actors', 'list', '--limit', bad])).toThrow(/--limit/)
      }
    })
  })

  it('--lang 只认两种', () => {
    expect(parse(['--lang', 'en-US', 'doctor']).lang).toBe('en-US')
    expect(() => parse(['--lang', 'fr', 'doctor'])).toThrow(/--lang/)
  })

  it('--world 只认 auto / editor', () => {
    expect(parse(['viewport', 'screenshot', '--world', 'editor']).world).toBe('editor')
    expect(() => parse(['viewport', 'screenshot', '--world', 'game'])).toThrow(/--world/)
  })
})

describe('assertArgsInputExclusive', () => {
  it('两种参数输入只能给一个', () => {
    const parsed = parse(['tools', 'call', 'x', '--args', '{}', '--args-file', 'a.json'])

    expect(() => assertArgsInputExclusive(parsed)).toThrow(/只能给一个/)
  })

  it('各给一个、或者都不给，都可以', () => {
    expect(() =>
      assertArgsInputExclusive(parse(['tools', 'call', 'x', '--args', '{}']))
    ).not.toThrow()
    expect(() =>
      assertArgsInputExclusive(parse(['tools', 'call', 'x', '--args-file', 'a.json']))
    ).not.toThrow()
    expect(() => assertArgsInputExclusive(parse(['tools', 'call', 'x']))).not.toThrow()
  })
})

describe('中断边界', () => {
  beforeEach(() => resetSettledForTest())

  /**
   * 真机上抓到的：一条截图命令已经把图交付完、成功结果也打到 stdout 了，
   * SIGINT 在收尾那一刻到达，处理函数照样 exit(130) —— 一次完全成功的操作
   * 对外报成「中断，结局不明」，脚本据此会去重做一遍。
   */
  it('结果一旦定下来就标记为已结算，中断不再改判', async () => {
    expect(isSettled()).toBe(false)

    // 走一条不连服务的命令：它照样经过 output() 这个唯一出口
    const result = await run(['frobnicate', '--json'], {})

    expect(result.exitCode).toBe(2)
    expect(isSettled()).toBe(true)
  })

  it('--help / --version 不经过结算 —— 它们本来就没有「结局不明」可言', async () => {
    await run(['--version'], {})
    expect(isSettled()).toBe(false)
  })
})
