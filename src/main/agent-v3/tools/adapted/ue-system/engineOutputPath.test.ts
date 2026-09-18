// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

import { resolveEngineOutputPath } from './engineOutputPath'

const PROJECT = 'I:/GameJam/LowPolyShooterPackv'

describe('resolveEngineOutputPath', () => {
  /**
   * 真机原样：引擎回的是相对它自己二进制目录的路径，盒子按自己的工作目录解，
   * 补出来的盘符是盒子所在的盘，其余一个字不差 —— 最难查的那种错。
   */
  it('相对路径按工程目录落回去，不看盒子在哪', () => {
    expect(
      resolveEngineOutputPath(
        '../../../../GameJam/LowPolyShooterPackv/Saved/Profiling/CSV/Profile(20260914_041741).csv',
        PROJECT
      )
    ).toBe(resolve(PROJECT, 'Saved/Profiling/CSV/Profile(20260914_041741).csv'))
  })

  it('绝对路径原样放行（新插件回的就是这种）', () => {
    const absolute = resolve(PROJECT, 'Saved/Profiling/CSV/Profile(1).csv')
    expect(resolveEngineOutputPath(absolute, PROJECT)).toBe(absolute)
  })

  it('认不出锚点或不知道工程在哪就原样返回，交给下游报错', () => {
    expect(resolveEngineOutputPath('../../SomethingElse/out.csv', PROJECT)).toBe(
      '../../SomethingElse/out.csv'
    )
    expect(resolveEngineOutputPath('../../../Proj/Saved/x.csv', undefined)).toBe(
      '../../../Proj/Saved/x.csv'
    )
    expect(resolveEngineOutputPath(undefined, PROJECT)).toBeUndefined()
  })
})
