/**
 * 409「有未保存的改动」的翻译。
 *
 * 最要紧的一条是死循环那条：清单里混着 `/Temp/` 下存不了的包时，
 * 「先 ue_save 再重试」是一条走不通的路，而模型试完之后唯一剩下的
 * 就是把东西全丢掉的 force=true。
 */

import { describe, it, expect } from 'vitest'
import { describeUnsavedRefusal } from './unsavedRefusal'

const refusal = (details: Record<string, unknown>): unknown => ({
  ok: false,
  __rpc: { code: 409 },
  details
})

describe('describeUnsavedRefusal', () => {
  it('不是 409 就不插手', () => {
    expect(describeUnsavedRefusal({ ok: false, __rpc: { code: 500 } }, '打开另一张关卡')).toBeNull()
    expect(describeUnsavedRefusal({ ok: true }, '打开另一张关卡')).toBeNull()
  })

  it('把动作说具体，别只说「这个操作」', () => {
    const message = String(
      describeUnsavedRefusal(refusal({ unsaved: ['/Game/A'], unsaved_count: 1 }), '重启编辑器')
    )
    expect(message).toContain('重启编辑器')
  })

  /**
   * 老插件（没有 unsavable 字段）要退回原来那套话术，一个字都不能少 ——
   * 盒子会连上各种版本的插件，新话术不能以旧插件读不出内容为代价。
   */
  it('插件没给 unsavable 时，退回「先保存再重试」', () => {
    const message = String(
      describeUnsavedRefusal(
        refusal({ unsaved: ['/Game/A', '/Game/B'], unsaved_count: 2 }),
        '打开另一张关卡'
      )
    )

    expect(message).toContain('ue_save')
    expect(message).toContain('/Game/A')
    expect(message).toContain('2')
    expect(message).toContain('用户明确说')
    expect(message).toContain('无法撤销')
  })

  /**
   * 这条是这个文件存在的理由。
   *
   * `/Temp/` 下的包 ue_save 存不了，「先保存再重试」在它们身上是死循环。
   * 要说清三件事：哪些能存、哪些存不了、存不了的那些下一步该干什么。
   */
  it('清单里混着存不了的包时，两栏分开说，并给出 ue_save_level 这条出路', () => {
    const message = String(
      describeUnsavedRefusal(
        refusal({
          unsaved: [
            '/Game/PCG/PCG_Forest',
            '/Temp/Untitled_1',
            '/Temp/__ExternalActors__/Untitled_1/1/24/QVESC4L66GVXAG75BAJBSQ'
          ],
          unsaved_count: 3,
          unsavable: [
            '/Temp/Untitled_1',
            '/Temp/__ExternalActors__/Untitled_1/1/24/QVESC4L66GVXAG75BAJBSQ'
          ]
        }),
        '打开另一张关卡'
      )
    )

    // 能存的那栏只能有能存的
    const savableSection = message.split('存不了的')[0]
    expect(savableSection).toContain('/Game/PCG/PCG_Forest')
    expect(savableSection).not.toContain('/Temp/Untitled_1')

    // 存不了的那栏要明说「存完再试还是这一份清单」，否则模型还会去存一次
    expect(message).toContain('ue_save 对它们无效')
    expect(message).toContain('/Temp/Untitled_1')

    // 唯一那条真出路
    expect(message).toContain('ue_save_level')

    // force 的代价要说全：它丢的是整份清单，不是只丢存不了的那几个
    expect(message).toContain('force=true')
    expect(message).toContain('无法撤销')
  })

  /**
   * 反馈里被当成「两个工具互相矛盾」的那一半。判据是刻意分开的，
   * 但模型看不到插件源码里的注释，所以这句话得写进拒绝信息本身。
   */
  it('解释 ue_list_unsaved 为什么说「没有未保存的改动」', () => {
    const message = String(
      describeUnsavedRefusal(
        refusal({
          unsaved: ['/Temp/Untitled_1'],
          unsaved_count: 1,
          unsavable: ['/Temp/Untitled_1']
        }),
        '打开另一张关卡'
      )
    )

    expect(message).toContain('ue_list_unsaved')
    expect(message).toContain('不矛盾')
  })

  it('清单很长时截断，并说清还剩多少条', () => {
    const many = Array.from({ length: 25 }, (_, i) => `/Game/Asset_${i}`)
    const message = String(
      describeUnsavedRefusal(refusal({ unsaved: many, unsaved_count: 25 }), '重启编辑器')
    )

    expect(message).toContain('/Game/Asset_0')
    expect(message).not.toContain('/Game/Asset_20')
    expect(message).toContain('另有 15 个')
  })
})
