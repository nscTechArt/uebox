import { describe, expect, it } from 'vitest'
import {
  ladderBadge,
  ladderState,
  ladderValue,
  setLadderState,
  setLadderValue
} from './thinkingLadder'

/**
 * 这个编辑器唯一容易做错的地方：把「不可用」和「没写」当成同一件事。
 *
 * 它们的行为完全相反 —— 前者让内核把这一档从下拉里去掉，后者是跟随内置数据。
 * 合并之后用户就没法表达「这一档我确定它没有」，界面会照旧列出模型根本
 * 没有的档位（DeepSeek V4 Flash 被列出 minimal / medium 就是这么来的）。
 */
describe('ladderState', () => {
  it('键不存在 = 跟随内置', () => {
    expect(ladderState(undefined, 'high')).toBe('inherit')
    expect(ladderState({ low: 'low' }, 'high')).toBe('inherit')
  })

  it('值为 null = 这一档不可用，不是「没写」', () => {
    expect(ladderState({ high: null }, 'high')).toBe('absent')
  })

  it('值为字符串 = 自定义名字', () => {
    expect(ladderState({ high: 'think-harder' }, 'high')).toBe('custom')
  })

  // 空字符串仍然是「用户正在编辑这一档」，不能掉回 inherit 让输入框消失
  it('空字符串仍算自定义', () => {
    expect(ladderState({ high: '' }, 'high')).toBe('custom')
  })
})

describe('setLadderState', () => {
  it('改成不可用时写入 null，而不是删掉这个键', () => {
    expect(setLadderState(undefined, 'high', 'absent')).toEqual({ high: null })
  })

  it('改回跟随内置时把键删掉', () => {
    expect(setLadderState({ high: null, low: 'low' }, 'high', 'inherit')).toEqual({ low: 'low' })
  })

  // 面对空框用户得猜该填什么，而绝大多数模型的名字就是档位本身
  it('改成自定义时预填档位原名', () => {
    expect(setLadderState(undefined, 'high', 'custom')).toEqual({ high: 'high' })
  })

  it('已经填过名字时不覆盖它', () => {
    expect(setLadderState({ high: 'think-harder' }, 'high', 'custom')).toEqual({
      high: 'think-harder'
    })
  })

  /** 留一个 `{}` 在 models.json 里，「配过」和「没配过」就分不开了 */
  it('最后一档改回跟随内置后整张表归为 undefined', () => {
    expect(setLadderState({ high: null }, 'high', 'inherit')).toBeUndefined()
  })

  it('不改动传进来的那张表', () => {
    const original = { high: null }
    setLadderState(original, 'low', 'absent')
    expect(original).toEqual({ high: null })
  })
})

describe('setLadderValue', () => {
  it('改名字只动这一档', () => {
    expect(setLadderValue({ low: null }, 'high', 'x')).toEqual({ low: null, high: 'x' })
  })

  // 编辑中途清空是常事，这时候切状态会让输入框直接消失
  it('清空不会掉回跟随内置', () => {
    expect(ladderState(setLadderValue({ high: 'x' }, 'high', ''), 'high')).toBe('custom')
  })
})

describe('ladderValue', () => {
  it('只有自定义状态才有值', () => {
    expect(ladderValue({ high: 'x' }, 'high')).toBe('x')
    expect(ladderValue({ high: null }, 'high')).toBe('')
    expect(ladderValue(undefined, 'high')).toBe('')
  })
})

describe('ladderBadge', () => {
  it('配过几档就显示几', () => {
    expect(ladderBadge({ high: null, low: 'low' })).toBe(' (2)')
  })

  it('没配过时不显示角标', () => {
    expect(ladderBadge(undefined)).toBe('')
  })
})
