/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  explain,
  formatReports,
  knownCodes,
  sortFindings,
  verdictOf,
  type Finding,
  type SequenceReport
} from './findings'

const f = (code: string, severity: Finding['severity'], evidence = 'x'): Finding => ({
  code,
  severity,
  evidence,
  autoFixable: false
})

describe('解释表', () => {
  it('每条问题都给齐「现象 / 为什么 / 怎么改」', () => {
    // 缺「怎么改」的问题等于没诊断出来 —— 用户读完还是不知道该点哪
    for (const code of knownCodes()) {
      const e = explain(code)
      expect(e.what, code).toBeTruthy()
      expect(e.why, code).toBeTruthy()
      expect(e.how, code).toBeTruthy()
    }
  })

  it('未知 code 有兜底，不会印出 undefined', () => {
    const e = explain('something_we_have_not_written_yet')
    expect(e.what).toBeTruthy()
    expect(e.how).toBeTruthy()
  })

  it('绑定失效要说清它是静默失败的', () => {
    // 用户和模型都不会自己想到「轨道在、但什么都不做」这一层
    const e = explain('broken_binding')
    expect(e.why).toContain('不报错')
    expect(e.how).toContain('Rebind Possessable References')
  })

  it('「判不出来」要明说不代表坏了', () => {
    const e = explain('unresolved_binding')
    expect(e.why).toContain('不代表它坏了')
    expect(e.why).toContain('World Partition')
  })

  it('切轨空隙要解释「肉眼看不出来」', () => {
    expect(explain('camera_cut_gap').why).toContain('肉眼')
  })

  it('空轨道的改法里要先提醒别乱删', () => {
    // 空轨道可能是占位，明天要往里放东西
    expect(explain('empty_track').how).toContain('占位')
  })

  // 回归：子序列读不出来原来复用了 unresolved_binding 这个 code，
  // 于是渲染出「打开对应的关卡、退出 PIE 再查一次」—— 照做完全无效
  it('子序列读不出来有自己的解释，不复用绑定相关的说法', () => {
    const e = explain('subsequence_unreadable')
    expect(e.why).toContain('那个资产已经不在了')
    expect(e.how).not.toContain('PIE')
  })

  it('相机类型混用要警告 Convert to Spawnable 会删关卡里的 Actor', () => {
    // 名字看着像格式转换，实际是对关卡的破坏性改动
    const e = explain('mixed_camera_binding_types')
    expect(e.how).toContain('删除关卡里的原 Actor')
  })
})

describe('PASS / FAIL 判定', () => {
  it('只有 breaks_render 才判 FAIL', () => {
    expect(verdictOf([f('a', 'breaks_render')])).toBe('FAIL')
  })

  it('编辑器里表现不对不影响出片，判 PASS', () => {
    // 用户问的是「现在能不能渲」。把「有个空轨道」也算不通过，
    // 他就得自己重新判断一遍——而他问我们就是为了不用自己判断
    expect(verdictOf([f('a', 'breaks_preview'), f('b', 'cosmetic')])).toBe('PASS')
  })

  it('「判不出来」不判 FAIL', () => {
    expect(verdictOf([f('a', 'unknown')])).toBe('PASS')
  })

  it('没有问题当然 PASS', () => {
    expect(verdictOf([])).toBe('PASS')
  })
})

describe('排序', () => {
  it('会导致渲染失败的排最前 —— 用户扫一眼就要看到要不要停下来', () => {
    const sorted = sortFindings([
      f('c', 'cosmetic'),
      f('u', 'unknown'),
      f('r', 'breaks_render'),
      f('p', 'breaks_preview')
    ])
    expect(sorted.map((x) => x.severity)).toEqual([
      'breaks_render',
      'breaks_preview',
      'unknown',
      'cosmetic'
    ])
  })

  it('不改动入参数组', () => {
    const input = [f('c', 'cosmetic'), f('r', 'breaks_render')]
    sortFindings(input)
    expect(input[0].severity).toBe('cosmetic')
  })
})

describe('报告文本', () => {
  const report = (over: Partial<SequenceReport> = {}): SequenceReport => ({
    path: '/Game/Cine/Shot_01',
    findings: [],
    ...over
  })

  it('结论先行：标题上就带 PASS / FAIL', () => {
    const text = formatReports([report({ findings: [f('no_camera_cut_track', 'breaks_render')] })])
    expect(text).toContain('❌ FAIL')
  })

  it('没问题时明确说没问题，不留白', () => {
    expect(formatReports([report()])).toContain('没有发现问题')
  })

  it('每条问题都带位置证据', () => {
    const text = formatReports([
      report({ findings: [f('camera_cut_gap', 'breaks_render', '第 120–121 帧')] })
    ])
    expect(text).toContain('第 120–121 帧')
  })

  it('展开的是人话而不是 code', () => {
    const text = formatReports([
      report({ findings: [f('broken_binding', 'breaks_render', 'Hero')] })
    ])
    expect(text).toContain('绑定已失效')
    expect(text).toContain('怎么改')
  })

  it('多条序列时先给总览 —— 一轮 24 个 job 逐个读等于没体检', () => {
    const text = formatReports([
      report({ path: '/Game/A', findings: [f('no_camera_cut_track', 'breaks_render')] }),
      report({ path: '/Game/B' })
    ])
    expect(text).toContain('总览')
    expect(text).toContain('❌ FAIL `/Game/A`')
    expect(text).toContain('✅ PASS `/Game/B`')
  })

  it('单条序列不加总览，别啰嗦', () => {
    expect(formatReports([report()])).not.toContain('总览')
  })

  it('读取失败的那条如实报出来，不当成 PASS', () => {
    // 一轮 24 条里坏一条，用户要的是另外 23 条的结论，
    // 但坏的那条绝不能悄悄算成通过
    const text = formatReports([report({ error: '找不到资产' })])
    expect(text).toContain('读取失败')
    expect(text).toContain('找不到资产')
    expect(text).not.toContain('PASS')
  })

  it('末尾划清不渲染的边界', () => {
    // 用户问完「能不能渲」很容易接着说「那你帮我渲」
    const text = formatReports([report()])
    expect(text).toContain('只诊断，不渲染')
  })

  it('总览里点出有几项会导致渲染失败', () => {
    const text = formatReports([
      report({
        path: '/Game/A',
        findings: [f('a', 'breaks_render'), f('b', 'breaks_render'), f('c', 'cosmetic')]
      }),
      report({ path: '/Game/B' })
    ])
    expect(text).toContain('2 项会导致渲染失败')
  })
})
