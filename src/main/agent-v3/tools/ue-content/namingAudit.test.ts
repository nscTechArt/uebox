/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { namingAuditTool } from './namingAudit'
import type { NamingAuditResponse } from './types'

function response(partial: Partial<NamingAuditResponse> = {}): NamingAuditResponse {
  return {
    ok: true,
    path: '/Game/Props',
    scanned: 3,
    compliant_count: 1,
    violation_count: 2,
    conflict_count: 1,
    skipped_count: 0,
    violations: [
      {
        path: '/Game/Props/rock',
        name: 'rock',
        class: 'StaticMesh',
        expected_prefix: 'SM_',
        reason: 'missing_prefix',
        suggested_name: 'SM_rock',
        suggested_path: '/Game/Props/SM_rock'
      },
      {
        path: '/Game/Props/T_Wood',
        name: 'T_Wood',
        class: 'StaticMesh',
        expected_prefix: 'SM_',
        reason: 'wrong_prefix',
        suggested_name: 'SM_Wood',
        suggested_path: '/Game/Props/SM_Wood',
        conflict: true
      }
    ],
    by_reason: { missing_prefix: 1, wrong_prefix: 1 },
    by_class: { StaticMesh: 2 },
    unknown_classes: { SoundWave: 4 },
    rules_used: ['StaticMesh -> SM_'],
    truncated: false,
    rules_source: 'Epic',
    note: '',
    ...partial
  }
}

const run = async (input: Record<string, unknown>, out: NamingAuditResponse): Promise<string> => {
  callRequest.mockResolvedValueOnce(out)
  const result = await namingAuditTool.execute('c1', input)
  return result.content.map((c) => ('text' in c ? c.text : '')).join('')
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset().mockReturnValue(1)
})

describe('ue_content_naming_audit', () => {
  it('是只读工具，命名空间在 ue.content', () => {
    expect(namingAuditTool.unrealBox.risk).toBe('safe')
    expect(namingAuditTool.unrealBox.namespace).toBe('ue.content')
    expect(namingAuditTool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('use_project_rules=false 时，没给的参数一个都不传 —— 让插件用自己的默认值', async () => {
    await run({ path: '/Game/Props', use_project_rules: false }, response())
    const [method, params] = callRequest.mock.calls[0]
    expect(method).toBe('content.naming_audit')
    expect(params).toEqual({ path: '/Game/Props' })
  })

  it('use_project_rules=false 时 rules 覆盖表原样透传', async () => {
    await run(
      { rules: { SoundWave: 'S_' }, pascal_case: true, use_project_rules: false },
      response()
    )
    expect(callRequest.mock.calls[0][1]).toEqual({ rules: { SoundWave: 'S_' }, pascal_case: true })
  })

  /**
   * 默认规范是虚幻官方那一套，它在插件里。用户没动过命名规则页时，盒子一条 rules
   * 都不该发过去 —— 发了就是拿我们自己那份出厂小表盖掉 Epic 官方表。
   *
   * 单元测试里读不到用户配置（没有 electron 的 app），`loadNamingRulesConfig`
   * 回落到出厂值，正好就是「用户没改过」这个场景。
   */
  it('用户没改过命名规则时不发 rules —— 底就是官方那一套', async () => {
    await run({ path: '/Game/Props' }, response())
    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params).toEqual({ path: '/Game/Props' })
  })

  it('模型显式传的 rules 照常透传', async () => {
    await run({ rules: { SoundWave: 'S_' } }, response())
    const params = callRequest.mock.calls[0][1] as { rules: Record<string, string> }
    expect(params.rules).toEqual({ SoundWave: 'S_' })
  })

  it('盒子侧的两个开关不透传给插件', async () => {
    await run({ use_project_rules: true, check_directory: true }, response())
    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.use_project_rules).toBeUndefined()
    expect(params.check_directory).toBeUndefined()
  })

  it('摘要里有建议名、冲突标记、未检查的类型和下一步', async () => {
    const text = await run({}, response())
    expect(text).toContain('违规 2')
    expect(text).toContain('/Game/Props/rock → SM_rock')
    expect(text).toContain('目标名已存在')
    expect(text).toContain('SoundWave 4')
    expect(text).toContain('ue_content_move')
  })

  it('ignore_paths 原样透传', async () => {
    await run({ ignore_paths: ['/Game/StarterContent'], use_project_rules: false }, response())
    expect(callRequest.mock.calls[0][1]).toEqual({ ignore_paths: ['/Game/StarterContent'] })
  })

  /**
   * `details` 不进模型上下文。摘要里指着 `details.violations` 说「完整列表在这儿」
   * 是一句模型永远兑现不了的话 —— 2026-09-09 真机上它因此用 Python
   * 把整套命名规则重写了一遍才凑齐 123 条。
   */
  it('违规条目全量列进正文，不是只列前 20 条', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      path: `/Game/Props/rock${i}`,
      name: `rock${i}`,
      class: 'StaticMesh',
      expected_prefix: 'SM_',
      reason: 'missing_prefix',
      suggested_name: `SM_rock${i}`,
      suggested_path: `/Game/Props/SM_rock${i}`
    }))
    const text = await run({}, response({ violations: many, violation_count: 45 }))

    expect(text).toContain('/Game/Props/rock0 → SM_rock0')
    expect(text).toContain('/Game/Props/rock44 → SM_rock44')
    expect(text).not.toContain('details.violations')
  })

  /**
   * 截断时给的下一步必须是**模型真能执行**的那个，而且顺序要对。
   *
   * 这里绕过一圈：最早写「把 limit 调大」，那时盒子自己已经悄悄把 limit 顶到上限 2000，
   * 模型照着再调一次拿回一模一样的响应，白等一轮 180 秒 —— 所以改成只说收窄 path。
   * 现在盒子不再替模型定 limit（默认就是插件那边的 200），而摘要正文自己有 200 行的上限，
   * 于是调大 limit 既有效又不会撑爆上下文，该排在收窄 path 前面。
   */
  it('插件那边被截断时，先让调 limit，再让收窄 path', async () => {
    const text = await run({}, response({ truncated: true, violation_count: 500 }))
    expect(text).toContain('一共 500 条')
    expect(text).toContain('把 limit 调大')
    expect(text).toContain('最多 2000')
    // 「可以调大」不能说成「随便调，正文照样全量打」—— 那才是当初撑爆上下文的原因
    expect(text).toContain('正文这边最多列 200 条')
    expect(text).toContain('用 path 按目录分几次查')
  })

  /**
   * 摘要正文有 200 行的上限，超了必须说「只列了这些」并给下一步。
   * 说成「全部列在这里」的话，模型拿 200 条当全量，剩下的 4800 条谁都不会再管。
   */
  it('超过 200 条时不说「全部列在这里」，并说清一共多少', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({
      path: `/Game/Props/rock${i}`,
      name: `rock${i}`,
      class: 'StaticMesh',
      expected_prefix: 'SM_',
      reason: 'missing_prefix',
      suggested_name: `SM_rock${i}`,
      suggested_path: `/Game/Props/SM_rock${i}`
    }))
    const text = await run({}, response({ violations: many, violation_count: 260 }))

    expect(text).toContain('下面列 200 条')
    expect(text).not.toContain('全部列在这里')
    expect(text).toContain('/Game/Props/rock199 → SM_rock199')
    expect(text).not.toContain('/Game/Props/rock200 → SM_rock200')
    expect(text).toContain('一共 260 条')
  })

  /**
   * 插件的 limit 默认也是 200，所以「回来 200 条 + truncated」是最常见的那一种。
   * 拿手里这一页的长度去判「列全了没有」，两个数永远相等 —— 于是写成
   * 「200 条，全部列在这里」，两行之后又说「一共 5000 条」，自己打自己。
   */
  it('插件按 limit 截断在正好 200 条时，也不许说「全部列在这里」', async () => {
    const exactly200 = Array.from({ length: 200 }, (_, i) => ({
      path: `/Game/Props/rock${i}`,
      name: `rock${i}`,
      class: 'StaticMesh',
      expected_prefix: 'SM_',
      reason: 'missing_prefix',
      suggested_name: `SM_rock${i}`,
      suggested_path: `/Game/Props/SM_rock${i}`
    }))
    const text = await run(
      {},
      response({ violations: exactly200, violation_count: 5000, truncated: true })
    )

    expect(text).not.toContain('全部列在这里')
    expect(text).toContain('共 5000 条')
  })

  /**
   * 末尾那句「都已合规」是个**全工程**结论。上面刚说完「合规清单被截断了」，
   * 末尾再来一句「都已合规」，模型就照着这句回话 —— 一个 4800 个合规资产的工程里
   * 只看了 200 个，报出去的是「你的项目命名很规范」。
   */
  it('这次没看全时，不给「都已合规」的结论', async () => {
    const text = await run(
      { include_compliant: true },
      response({
        violation_count: 0,
        violations: [],
        by_reason: {},
        by_class: {},
        conflict_count: 0,
        compliant_count: 4800,
        compliant: [{ path: '/Game/Props/SM_Chair', class: 'StaticMesh' }]
      })
    )
    expect(text).not.toContain('有规则的类型都已合规')
    expect(text).toContain('没看全')
    expect(text).toContain('合规清单被截断了')
  })

  /**
   * `MF_Unarmed_Jog_Bwd` 是动画，`MF` 是「女版」不是材质函数。
   * 剥掉它会丢语义，还会让男女两套动画撞名 —— 工具不能替人拍板。
   */
  it('有歧义的建议要标出来，并给出保留原词的候选', async () => {
    const text = await run(
      {},
      response({
        ambiguous_count: 1,
        violation_count: 1,
        violations: [
          {
            path: '/Game/Anim/MF_Unarmed_Jog_Bwd',
            name: 'MF_Unarmed_Jog_Bwd',
            class: 'AnimSequence',
            expected_prefix: 'AS_',
            reason: 'wrong_prefix',
            suggested_name: 'AS_Unarmed_Jog_Bwd',
            suggested_path: '/Game/Anim/AS_Unarmed_Jog_Bwd',
            ambiguous: true,
            suggested_name_keep: 'AS_MF_Unarmed_Jog_Bwd',
            suggested_path_keep: '/Game/Anim/AS_MF_Unarmed_Jog_Bwd'
          }
        ]
      })
    )

    expect(text).toContain('有歧义')
    expect(text).toContain('AS_MF_Unarmed_Jog_Bwd')
    expect(text).toContain('别自己拍板')
  })

  it('全合规时不催人去改名', async () => {
    const text = await run(
      {},
      response({
        violation_count: 0,
        violations: [],
        by_reason: {},
        by_class: {},
        conflict_count: 0
      })
    )
    expect(text).toContain('已合规')
    expect(text).not.toContain('ue_content_move')
  })
})
