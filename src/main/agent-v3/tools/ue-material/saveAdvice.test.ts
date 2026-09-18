/**
 * @vitest-environment node
 *
 * 工具**不许教模型替用户按「保存全部」**。
 *
 * 2026-09-11 由盒子自己的 agent 点出的矛盾：`material_get_referencers` 三处都写着
 * 「先 ue_save(scope=all)」，而 `ue_save` 自己写着 all「会把用户手改到一半的东西
 * 也存了」、默认推荐 touched，文件头更直接：「替用户保存他改到一半的东西是越界的，
 * 而且不可撤销」。照前一条做，模型会替用户按下保存全部。
 *
 * 为什么不是「改一句话」那么轻：这条建议出现在**工具返回值**里，也就是在模型最
 * 可能照做的那一刻递给它的下一步。跨工具的建议必须和被建议的那个工具的立场一致，
 * 否则就是一个工具在指使另一个工具越界。
 *
 * 断言写成扫全部 `ue.material` 工具的描述，而不是只钉这一个：同类建议以后加在
 * 别的材质工具上时同样要被拦住。
 */

import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../../testSupport/toolMocks'

// 工厂要包一层箭头函数：`vi.mock` 提升到 import 之前，直接传引用会在初始化前访问它
vi.mock('electron', () => electronMock())
vi.mock('../../../services', () => servicesMock())
vi.mock('../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { materialTools } from './index'

/** `ue_save` 里那个会连用户改动一起存的档位，各种写法 */
const SAVE_ALL_PATTERNS = [
  /ue_save\s*\(\s*scope\s*=\s*all\s*\)/,
  /ue_save\s*（\s*scope\s*=\s*all\s*）/
]

describe('材质工具不许教模型按「保存全部」', () => {
  it('没有一个材质工具的描述里叫模型 ue_save(scope=all)', () => {
    const offenders = materialTools
      .filter((tool) => SAVE_ALL_PATTERNS.some((re) => re.test(tool.description ?? '')))
      .map((tool) => tool.name)

    expect(offenders).toEqual([])
  })

  /**
   * 描述改干净了不等于返回值也干净 —— 这两处是分开写的，
   * 而返回值那一处才是模型最可能照做的时刻。
   */
  it('源码里也没有残留（含返回值里的那两处）', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

    // 注释里可以提这件事（说明为什么不许），所以只扫非注释行
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')

    for (const re of SAVE_ALL_PATTERNS) {
      expect(code).not.toMatch(re)
    }
  })

  /**
   * 正向的那一半：该说的还得说。
   * 只删掉「scope=all」而不给替代做法，模型会退回「那我就不存了」，
   * 然后拿一份过期的引用清单去决定删不删 —— 那比越界保存更糟。
   */
  it('仍然告诉模型未保存的包会让结论失真，并指向 ue_list_unsaved', () => {
    const tool = materialTools.find((t) => t.name === 'material_get_referencers')
    expect(tool).toBeDefined()

    expect(tool!.description).toContain('未保存')
    expect(tool!.description).toContain('ue_save')
    expect(tool!.description).toContain('ue_list_unsaved')
  })
})
