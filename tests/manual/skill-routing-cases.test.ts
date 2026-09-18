/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error —— 评测脚手架是 .mjs，没有类型声明
import {
  CASES,
  NO_SKILL_CASES,
  POSITIVE_CASES,
  pairedSchedule,
  quotedTriggers,
  referencedSkills
} from './skill-routing-cases.mjs'

/**
 * 用例集本身要被守住，理由和判定器一样：它错了，跑出来的数字就是假的。
 *
 * 这里守四件事：
 *   1. 提到的技能名真实存在（写错一个字，整条用例永远判 `wrong-skill`）；
 *   2. **`say` 没有逐字抄 description 里的触发词** —— 那些词就在模型上下文里，
 *      抄了等于先把答案给它看，命中率虚高；
 *   3. 正例都声明了 `requiredCompeting`，否则那条样本对「会不会跳过技能」无效；
 *   4. 无技能例确实是「不需要任何技能」的问法。
 */

const SKILLS_DIR = join(process.cwd(), 'resources', 'skills')

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

const descriptionOf = (name: string): string => {
  const raw = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''
  return /description:\s*([\s\S]*?)(?=\n[a-z_-]+:|$)/.exec(fm)?.[1] ?? ''
}

describe('用例集：提到的技能必须真实存在', () => {
  it('每个 expect / nearby 都能在 resources/skills 里找到', () => {
    for (const name of referencedSkills()) {
      expect(skillDirs, `用例里提到的技能不存在：${name}`).toContain(name)
      expect(existsSync(join(SKILLS_DIR, name, 'SKILL.md'))).toBe(true)
    }
  })

  it('nearby 不能包含 expect 自己 —— 那样「混淆」判定没有意义', () => {
    for (const c of POSITIVE_CASES) {
      expect(c.nearby, c.tag).not.toContain(c.expect)
    }
  })

  it('tag 唯一', () => {
    const tags = CASES.map((c: { tag: string }) => c.tag)
    expect(new Set(tags).size, `有重复 tag：${tags.join(', ')}`).toBe(tags.length)
  })
})

describe('用例集：say 不能逐字抄 description 里的触发词', () => {
  it('抠得出触发短语（抠不出来就说明这条检查是空的）', () => {
    const triggers = quotedTriggers(descriptionOf('ue-sequencer'))
    expect(triggers.length).toBeGreaterThan(3)
    expect(triggers).toContain('绕着它转一圈')
  })

  it('每条正例的 say 都不含目标技能 description 里的任何触发短语', () => {
    for (const c of POSITIVE_CASES) {
      for (const trigger of quotedTriggers(descriptionOf(c.expect))) {
        expect(
          c.say.includes(trigger),
          `用例 ${c.tag} 逐字抄了 ${c.expect} 的触发词「${trigger}」—— ` +
            '那句话就在模型上下文里，抄了会把命中率测成虚高'
        ).toBe(false)
      }
    }
  })

  it('也不能抄邻域技能的触发词 —— 那等于把混淆答案直接喂进去', () => {
    for (const c of POSITIVE_CASES) {
      for (const near of c.nearby) {
        for (const trigger of quotedTriggers(descriptionOf(near))) {
          expect(c.say.includes(trigger), `用例 ${c.tag} 抄了邻域 ${near} 的「${trigger}」`).toBe(
            false
          )
        }
      }
    }
  })

  it('反过来验一次：真抄了要能被抓住', () => {
    const trigger = quotedTriggers(descriptionOf('ue-sequencer'))[0]
    const fake = `帮我${trigger}好吗`
    expect(fake.includes(trigger)).toBe(true)
  })
})

describe('用例集：竞争工具与无技能例', () => {
  it('正例都声明了 requiredCompeting —— 没有它，样本对「会不会跳过技能」无效', () => {
    for (const c of POSITIVE_CASES) {
      expect(c.requiredCompeting.length, `${c.tag} 没声明竞争工具`).toBeGreaterThan(0)
    }
  })

  it('无技能例：expect 为 null，不声明竞争工具，也不依赖引擎', () => {
    expect(NO_SKILL_CASES.length).toBeGreaterThanOrEqual(5)
    for (const c of NO_SKILL_CASES) {
      expect(c.expect, c.tag).toBeNull()
      expect(c.requiredCompeting, c.tag).toEqual([])
      expect(c.needsEngine, c.tag).toBe(false)
    }
  })

  it('三类用例都有，且数量对得上 0-7 的规模（17 条）', () => {
    const withNearby = POSITIVE_CASES.filter((c: { nearby: string[] }) => c.nearby.length > 0)
    expect(POSITIVE_CASES.length).toBe(12)
    expect(withNearby.length).toBe(4)
    expect(NO_SKILL_CASES.length).toBe(5)
    expect(CASES.length).toBe(17)
  })

  it('needsEngine 的标注和技能领域一致 —— UE 类必须为 true', () => {
    for (const c of POSITIVE_CASES) {
      if (c.expect.startsWith('ue-')) {
        expect(c.needsEngine, `${c.tag}（${c.expect}）是 UE 技能，应当标 needsEngine`).toBe(true)
      }
    }
  })
})

describe('配对随机化调度（预登记 §4）', () => {
  it('同一种子出同一张表 —— 不可复现的随机化等于没有预登记', () => {
    const a = pairedSchedule(CASES, 5)
    const b = pairedSchedule(CASES, 5)
    expect(a).toEqual(b)
  })

  it('换种子就换表', () => {
    expect(pairedSchedule(CASES, 5)).not.toEqual(pairedSchedule(CASES, 5, 12345))
  })

  it('每条用例都跑满 reps 次', () => {
    const plan = pairedSchedule(CASES, 5)
    expect(plan.length).toBe(CASES.length * 5)
    for (const c of CASES) {
      expect(plan.filter((p: { tag: string }) => p.tag === c.tag).length, c.tag).toBe(5)
    }
  })

  it('先后次数平衡：偶数 reps 时每条用例 AB 和 BA 各一半', () => {
    const plan = pairedSchedule(CASES, 4)
    for (const c of CASES) {
      const mine = plan.filter((p: { tag: string }) => p.tag === c.tag)
      const ab = mine.filter((p: { order: string }) => p.order === 'AB').length
      expect(ab, `${c.tag} 的先后不平衡`).toBe(2)
    }
  })

  it('奇数 reps 时每条用例最多偏 1 次 —— 不能出现 5 次全是 A 先', () => {
    const plan = pairedSchedule(CASES, 5)
    for (const c of CASES) {
      const mine = plan.filter((p: { tag: string }) => p.tag === c.tag)
      const ab = mine.filter((p: { order: string }) => p.order === 'AB').length
      expect(Math.abs(ab - (mine.length - ab)), `${c.tag} 偏得太多`).toBeLessThanOrEqual(1)
    }
  })

  it('整体打散：同一条用例的重复不连着跑', () => {
    const plan = pairedSchedule(CASES, 5)
    let runs = 0
    for (let i = 1; i < plan.length; i++) if (plan[i].tag === plan[i - 1].tag) runs++
    // 17 条用例 × 5 次共 85 项，完全随机时相邻同 tag 的期望约 85/17 ≈ 5
    expect(runs).toBeLessThan(15)
  })
})
