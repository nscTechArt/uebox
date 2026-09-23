/**
 * `unreal.Rotator` 位置参数的静态拦截。
 *
 * 要守的只有一件事：按 (pitch, yaw, roll) 直觉写的位置参数不能进引擎 ——
 * 那样 yaw 会被写进 pitch，78 个部件全摆错而引擎不报错。关键字写法永远放行。
 */

import { describe, expect, it } from 'vitest'
import { describePositionalRotatorRefusal, findPositionalRotatorCalls } from './pythonRotatorGuard'

describe('findPositionalRotatorCalls', () => {
  it('三个位置参数 —— 真机翻车的那一行', () => {
    const hits = findPositionalRotatorCalls('rot = unreal.Rotator(0.0, yaw, 0.0)')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      line: 1,
      snippet: 'unreal.Rotator(0.0, yaw, 0.0)',
      args: ['0.0', 'yaw', '0.0']
    })
  })

  it('关键字写法放行', () => {
    expect(
      findPositionalRotatorCalls('unreal.Rotator(roll=0.0, pitch=0.0, yaw=90.0)')
    ).toHaveLength(0)
  })

  it('多行关键字写法、每个实参后面跟注释，照样放行', () => {
    const script = [
      'rot = unreal.Rotator(',
      '    roll=0.0,   # X axis',
      '    pitch=0.0,  # Y axis',
      '    yaw=90.0,   # Z axis',
      ')'
    ].join('\n')
    expect(findPositionalRotatorCalls(script)).toHaveLength(0)
  })

  it('注释里的撇号不会让真正按位置传的那处漏网', () => {
    const script = [
      "r = unreal.Rotator(0.0,  # the pitch's value",
      '    yaw, 0.0)',
      "name = 'x'"
    ].join('\n')
    expect(findPositionalRotatorCalls(script)).toHaveLength(1)
  })

  it('注释里写的示例不拦', () => {
    expect(findPositionalRotatorCalls('# unreal.Rotator(0, 90, 0) 这样写是错的')).toHaveLength(0)
  })

  it('全零位置参数放行 —— 顺序无所谓', () => {
    expect(findPositionalRotatorCalls('unreal.Rotator(0, 0, 0)')).toHaveLength(0)
    expect(findPositionalRotatorCalls('unreal.Rotator(0.0, -0.0, +0)')).toHaveLength(0)
  })

  it('空构造和单参数（拷贝构造 / 星号展开）放行', () => {
    expect(findPositionalRotatorCalls('unreal.Rotator()')).toHaveLength(0)
    expect(findPositionalRotatorCalls('unreal.Rotator(other)')).toHaveLength(0)
    expect(findPositionalRotatorCalls('unreal.Rotator(*vals)')).toHaveLength(0)
  })

  it('位置 + 关键字混用照样拦（位置的那部分仍然错序）', () => {
    expect(findPositionalRotatorCalls('unreal.Rotator(0, 90, roll=0)')).toHaveLength(1)
  })

  it('嵌套括号里的逗号不算分隔', () => {
    const hits = findPositionalRotatorCalls('unreal.Rotator(math.degrees(a), f(b, c), 0)')
    expect(hits).toHaveLength(1)
    expect(hits[0].args).toEqual(['math.degrees(a)', 'f(b, c)', '0'])
  })

  it('字符串里的逗号不算分隔，关键字里的 == 不算赋值', () => {
    expect(findPositionalRotatorCalls('unreal.Rotator("a,b", c)')).toHaveLength(1)
    expect(findPositionalRotatorCalls('unreal.Rotator(a == 1, b)')).toHaveLength(1)
  })

  it('多行脚本报对行号，每处都记', () => {
    const script = [
      'import unreal',
      'a = unreal.Rotator(roll=0, pitch=0, yaw=90)',
      'b = unreal.Rotator(0, 90, 0)',
      'cam.set_level_viewport_camera_info(loc, unreal.Rotator(0.0, 180.0, 0.0))'
    ].join('\n')
    const hits = findPositionalRotatorCalls(script)
    expect(hits.map((h) => h.line)).toEqual([3, 4])
  })

  it('from unreal import Rotator 的裸写法也拦', () => {
    expect(findPositionalRotatorCalls('Rotator(0, 45, 0)')).toHaveLength(1)
  })

  it('括号没配对时不崩', () => {
    expect(findPositionalRotatorCalls('unreal.Rotator(0, 90')).toHaveLength(0)
  })
})

describe('describePositionalRotatorRefusal', () => {
  // 实参自己带着轴名的，按名字对 —— 按 (pitch, yaw, roll) 硬映射给的「照抄版」是转乱的
  it('实参带轴名时按名字给关键字写法', () => {
    const text = describePositionalRotatorRefusal(
      findPositionalRotatorCalls('r = unreal.Rotator(rot.roll, rot.pitch, rot.yaw + 90)')
    )
    expect(text).toContain('unreal.Rotator(roll=rot.roll, pitch=rot.pitch, yaw=rot.yaw + 90)')
    expect(text).not.toContain('roll=rot.yaw')
  })

  it('说清顺序、给出可照抄的关键字重写', () => {
    const text = describePositionalRotatorRefusal(
      findPositionalRotatorCalls('unreal.Rotator(0.0, yaw, 0.0)')
    )
    expect(text).toContain('(roll, pitch, yaw)')
    expect(text).toContain('第 1 行')
    expect(text).toContain('unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw)')
    expect(text).toContain('没有执行')
  })

  it('两个参数时不瞎猜映射，只给模板', () => {
    const text = describePositionalRotatorRefusal(
      findPositionalRotatorCalls('unreal.Rotator(0, 90)')
    )
    expect(text).toContain('unreal.Rotator(roll=…, pitch=…, yaw=…)')
  })
})
