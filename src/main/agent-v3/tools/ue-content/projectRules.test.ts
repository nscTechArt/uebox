import { describe, expect, it } from 'vitest'

import { applyProjectNamingRules } from './projectRules'
import type { UserNamingPolicy } from './namingPolicy'
import type { NamingAuditResponse } from './types'
import type { CustomRule } from '../../../../renderer/src/types/namingRules'

function policy(patch: Partial<UserNamingPolicy> = {}): UserNamingPolicy {
  return {
    prefixRules: { StaticMesh: 'SM_' },
    customRules: [],
    directories: {},
    ...patch
  }
}

function response(patch: Partial<NamingAuditResponse> = {}): NamingAuditResponse {
  return {
    ok: true,
    path: '/Game',
    scanned: 2,
    compliant_count: 1,
    violation_count: 1,
    conflict_count: 0,
    skipped_count: 0,
    violations: [
      {
        path: '/Game/Temp/rock_FINAL',
        name: 'rock_FINAL',
        class: 'StaticMesh',
        expected_prefix: 'SM_',
        reason: 'missing_prefix',
        suggested_name: 'SM_rock_FINAL',
        suggested_path: '/Game/Temp/SM_rock_FINAL',
        conflict: false
      }
    ],
    by_reason: { missing_prefix: 1 },
    by_class: { StaticMesh: 1 },
    unknown_classes: {},
    rules_used: ['StaticMesh'],
    truncated: false,
    rules_source: 'epic',
    note: '',
    ...patch
  }
}

const STRIP_FINAL: CustomRule = {
  name: '去掉 FINAL',
  match: 'endsWith',
  text: '_FINAL',
  replacement: ''
}

describe('applyProjectNamingRules', () => {
  it('没有自定义规则也没开目录检查时，只记一笔「用了什么」', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy(),
      checkDirectory: false,
      keepCompliant: false
    })
    // 前缀只报告、不参与审计：发给插件会让它把旧前缀忘掉，于是命名本来就对的资产
    // 反被建议改成「新前缀 + 旧名字」，而且不带任何警告标记
    expect(out.project_rules_applied).toEqual({
      custom_prefixes: ['StaticMesh → SM_（要传就用引擎类名：StaticMesh）'],
      custom_rules: 0
    })
    expect(out.violations[0].suggested_name).toBe('SM_rock_FINAL')
    expect(out.project_rule_renames).toBeUndefined()
  })

  it('自定义规则改写违规条目的建议名，并记下是哪条规则', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy({ customRules: [STRIP_FINAL] }),
      checkDirectory: false,
      keepCompliant: false
    })
    const v = out.violations[0]
    expect(v.suggested_name).toBe('SM_rock')
    expect(v.suggested_path).toBe('/Game/Temp/SM_rock')
    expect(v.custom_rules?.[0].rule).toBe('去掉 FINAL')
  })

  it('改写过之后冲突结论作废：标 conflict_unknown，旧的 conflict 字段删掉', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [
          {
            ...response().violations[0],
            conflict: true,
            conflict_keep: true,
            // 两个候选都以 _FINAL 结尾，所以两边都会被规则改写 —— 这一条守的是
            // 「都改写了，两个 conflict 结论都作废」；只有一边被改写的情况在下面单独一条
            suggested_name_keep: 'SM_keep_rock_FINAL'
          }
        ]
      }),
      {
        policy: policy({ customRules: [STRIP_FINAL] }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    const v = out.violations[0]
    expect(v.conflict_unknown).toBe(true)
    expect('conflict' in v).toBe(false)
    expect('conflict_keep' in v).toBe(false)
    expect(v.conflict_keep_unknown).toBe(true)
  })

  it('前缀合规但撞上自定义规则的资产单列一组，不混进 violations', () => {
    const out = applyProjectNamingRules(
      response({ compliant: [{ path: '/Game/Props/SM_Chair_FINAL', class: 'StaticMesh' }] }),
      {
        policy: policy({ customRules: [STRIP_FINAL] }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    expect(out.violation_count).toBe(1) // 没被污染
    expect(out.project_rule_renames).toHaveLength(1)
    expect(out.project_rule_renames![0]).toMatchObject({
      path: '/Game/Props/SM_Chair_FINAL',
      suggested_path: '/Game/Props/SM_Chair',
      conflict_unknown: true
    })
  })

  it('开了目录检查才报位置不对，且按引擎类名的别名查得到配置里的键', () => {
    const withTexture = response({
      violations: [],
      violation_count: 0,
      compliant: [{ path: '/Game/Temp/T_Rock', class: 'Texture2D' }]
    })
    const opts = {
      policy: policy({ directories: { Texture: '/Game/Art/Textures' } }),
      keepCompliant: false
    }

    const off = applyProjectNamingRules(withTexture, { ...opts, checkDirectory: false })
    expect(off.project_rule_renames).toBeUndefined()
    expect(off.directory_mismatch_count).toBeUndefined()

    const on = applyProjectNamingRules(withTexture, { ...opts, checkDirectory: true })
    expect(on.directory_mismatch_count).toBe(1)
    expect(on.project_rule_renames![0]).toMatchObject({
      path: '/Game/Temp/T_Rock',
      suggested_path: '/Game/Art/Textures/T_Rock',
      directory_expected: '/Game/Art/Textures'
    })
  })

  it('目录已经对了就不报', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [{ path: '/Game/Art/Textures/T_Rock', class: 'Texture2D' }]
      }),
      {
        policy: policy({ directories: { Texture: '/Game/Art/Textures/' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.directory_mismatch_count).toBe(0)
    expect(out.project_rule_renames).toBeUndefined()
  })

  it('没起名字的规则报出来，不默默跳过', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy({
        customRules: [{ name: '', match: 'endsWith', text: 'x', replacement: '' }]
      }),
      checkDirectory: false,
      keepCompliant: false
    })
    expect(out.rejected_custom_rules).toEqual([{ rule: '(未命名)', reason: 'unnamed' }])
  })

  it('没填原文的规则报成 empty，且不去动任何名字', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy({
        customRules: [{ name: '空的', match: 'contains', text: '', replacement: 'X' }]
      }),
      checkDirectory: false,
      keepCompliant: false
    })
    expect(out.rejected_custom_rules).toEqual([{ rule: '空的', reason: 'empty' }])
    expect(out.violations[0].suggested_name).toBe('SM_rock_FINAL')
  })

  /**
   * 这一格是自由填写的。`Meshes` 和 `/Game/Meshes` 长得差不多，而前者会让
   * ue_content_move 整批拒掉（"Destination must be a package path"）。
   * 悄悄跳过的话摘要会说「用户没配归属目录」，而他明明配了。
   */
  it('不是包路径的归属目录报出来，且不算「查过」', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [{ path: '/Game/Props/SM_Chair', class: 'StaticMesh' }]
      }),
      {
        policy: policy({ directories: { StaticMesh: 'Meshes' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.rejected_directories).toEqual([{ type: 'StaticMesh', value: 'Meshes' }])
    // 全填坏了要落到自己那一档。requested_but_no_table 的文案说的是「用户没改过
    // 任何一条」—— 用在这里就是当着用户的面否认他刚填过的东西
    expect(out.directory_check).toBe('requested_but_directories_invalid')
    expect(out.project_rule_renames).toBeUndefined()
  })

  /** 报到用户看得见的那一行上：设置页的行键是 Texture，不是 Texture2D / TextureCube */
  it('填坏的归属目录按配置键报一条，不按引擎类名报三条', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [
          { path: '/Game/Art/T_Rock', class: 'Texture2D' },
          { path: '/Game/Art/T_Sky', class: 'TextureCube' },
          { path: '/Game/Art/T_Fog', class: 'VolumeTexture' }
        ]
      }),
      {
        policy: policy({ directories: { Texture: 'Textures' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.rejected_directories).toEqual([{ type: 'Texture', value: 'Textures' }])
  })

  /**
   * 「归属目录」的含义是「这类资产归到哪个根下面」，从来不是「不许再分子目录」。
   * 要求完全相等的话，一个按类别分过子目录的工程会被建议把整棵树拍平，
   * 而其中同名的那些还会在同一批里撞成同一个目标路径。
   */
  it('资产在配置目录的子目录里算放对了，不建议拍平', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [
          { path: '/Game/Meshes/Props/SM_Door', class: 'StaticMesh' },
          { path: '/Game/Meshes/Env/SM_Door', class: 'StaticMesh' },
          { path: '/Game/Meshes/SM_Ok', class: 'StaticMesh' },
          { path: '/Game/Elsewhere/SM_Moved', class: 'StaticMesh' }
        ]
      }),
      {
        policy: policy({ directories: { StaticMesh: '/Game/Meshes' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.directory_check).toBe('checked')
    // 只有真在别处的那一个要搬
    expect(out.directory_mismatch_count).toBe(1)
    expect(out.project_rule_renames).toHaveLength(1)
    expect(out.project_rule_renames![0].path).toBe('/Game/Elsewhere/SM_Moved')
  })

  /** 前缀相同但不是同一层目录：/Game/Meshes2 不在 /Game/Meshes 下面 */
  it('目录前缀撞字不算在同一个目录下', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [{ path: '/Game/Meshes2/SM_Rock', class: 'StaticMesh' }]
      }),
      {
        policy: policy({ directories: { StaticMesh: '/Game/Meshes' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.directory_mismatch_count).toBe(1)
  })

  /** 「没查」和「查了没问题」在别的字段上长得一样，必须有一个字段分得开 */
  it('要求查目录但用户没自定义过归属目录时，标 requested_but_no_table', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy({ directories: {} }),
      checkDirectory: true,
      keepCompliant: false
    })
    expect(out.directory_check).toBe('requested_but_no_table')
    expect(out.directory_mismatch_count).toBeUndefined()
  })

  it('没要求查目录时标 not_requested', () => {
    const out = applyProjectNamingRules(response(), {
      policy: policy(),
      checkDirectory: false,
      keepCompliant: false
    })
    expect(out.directory_check).toBe('not_requested')
  })

  /** 插件的 truncated 只反映 violations，合规那头得自己按 compliant_count 对数 */
  it('合规清单被插件截断时标 compliant_truncated', () => {
    const out = applyProjectNamingRules(
      response({
        compliant_count: 5000,
        compliant: [{ path: '/Game/Props/SM_Chair_FINAL', class: 'StaticMesh' }]
      }),
      {
        policy: policy({ customRules: [STRIP_FINAL] }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    expect(out.compliant_truncated).toBe(true)
  })

  it('清掉 conflict 之后 conflict_count 跟着重算，不留下对不上的数', () => {
    const out = applyProjectNamingRules(
      response({
        conflict_count: 1,
        violations: [{ ...response().violations[0], conflict: true }]
      }),
      {
        policy: policy({ customRules: [STRIP_FINAL] }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    expect(out.violations[0].conflict_unknown).toBe(true)
    expect(out.conflict_count).toBe(0)
  })

  /** 模型被工具描述引导去选 keep 候选，那条也必须走过同样的规则和目录 */
  it('ambiguous 的第二候选也套规则、也跟着换目录', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [
          {
            ...response().violations[0],
            path: '/Game/Anim/MF_Walk_FINAL',
            class: 'AnimSequence',
            suggested_name: 'AS_Walk_FINAL',
            suggested_path: '/Game/Anim/AS_Walk_FINAL',
            ambiguous: true,
            suggested_name_keep: 'AS_MF_Walk_FINAL',
            suggested_path_keep: '/Game/Anim/AS_MF_Walk_FINAL',
            conflict_keep: true
          }
        ]
      }),
      {
        policy: policy({
          customRules: [STRIP_FINAL],
          directories: { AnimSequence: '/Game/Art/Anims' }
        }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    const v = out.violations[0]
    expect(v.suggested_path).toBe('/Game/Art/Anims/AS_Walk')
    expect(v.suggested_name_keep).toBe('AS_MF_Walk')
    expect(v.suggested_path_keep).toBe('/Game/Art/Anims/AS_MF_Walk')
    expect('conflict_keep' in v).toBe(false)
    expect(v.conflict_keep_unknown).toBe(true)
  })

  /**
   * 插件只给 wrong_prefix 出第二候选，而 wantDir 在 missing_prefix 上也为真 ——
   * 不加闸就会给一条根本没有第二候选的条目盖上「keep 候选没查过」，
   * 「有这个标记 = 有第二候选」这条不变量当场作废。
   */
  it('没有第二候选的条目不盖 conflict_keep_unknown，哪怕目录要改', () => {
    const out = applyProjectNamingRules(
      response({
        violation_count: 1,
        violations: [
          {
            path: '/Game/Props/chair',
            name: 'chair',
            class: 'StaticMesh',
            expected_prefix: 'SM_',
            reason: 'missing_prefix',
            suggested_name: 'SM_chair',
            suggested_path: '/Game/Props/SM_chair'
          }
        ]
      }),
      {
        policy: policy({ directories: { StaticMesh: '/Game/Meshes' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    const v = out.violations[0]
    expect(v.suggested_path).toBe('/Game/Meshes/SM_chair')
    expect(v.conflict_unknown).toBe(true)
    expect('conflict_keep_unknown' in v).toBe(false)
  })

  it('模型没要 include_compliant 时，那份合规清单不往外倒', () => {
    const withCompliant = response({
      compliant: [{ path: '/Game/Props/SM_Chair', class: 'StaticMesh' }]
    })
    const dropped = applyProjectNamingRules(withCompliant, {
      policy: policy({ customRules: [STRIP_FINAL] }),
      checkDirectory: false,
      keepCompliant: false
    })
    expect(dropped.compliant).toBeUndefined()

    const kept = applyProjectNamingRules(withCompliant, {
      policy: policy({ customRules: [STRIP_FINAL] }),
      checkDirectory: false,
      keepCompliant: true
    })
    expect(kept.compliant).toHaveLength(1)
  })

  it('原始响应不被改动 —— 调用方可能还要拿它对账', () => {
    const original = response()
    applyProjectNamingRules(original, {
      policy: policy({ customRules: [STRIP_FINAL] }),
      checkDirectory: false,
      keepCompliant: false
    })
    expect(original.violations[0].suggested_name).toBe('SM_rock_FINAL')
    expect(original.violations[0].conflict).toBe(false)
  })
  /**
   * 插件那个 conflict_count 是**全量扫描**的（在 Violations.Num() < Limit 之前就加了）。
   * 无条件按返回的那一页重算，等于把 137 说成 6 —— 模型把另外 131 个当安全的发出去。
   */
  it('截断时不动 conflict_count，用插件那个全量数', () => {
    const out = applyProjectNamingRules(
      response({
        truncated: true,
        violation_count: 5000,
        conflict_count: 137,
        violations: [{ ...response().violations[0], conflict: true }]
      }),
      {
        policy: policy({ customRules: [STRIP_FINAL] }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    expect(out.conflict_count).toBe(137)
  })

  it('一条都没改写时也不动 conflict_count —— 那时插件的数本来就是对的', () => {
    const out = applyProjectNamingRules(
      response({
        conflict_count: 4,
        violations: [{ ...response().violations[0], conflict: true }]
      }),
      { policy: policy(), checkDirectory: false, keepCompliant: false }
    )
    expect(out.conflict_count).toBe(4)
    expect(out.violations[0].conflict).toBe(true)
  })

  /**
   * 规则很可能只命中 keep 候选而不命中主候选：MF_Walk 的主候选已经是 AS_Walk，
   * 「MF_ → Female_」匹配不上它，可 AS_MF_Walk 匹配得上。按主候选判早退就跳过了这一步，
   * 而工具描述恰恰引导模型在有歧义时去选 keep 候选。
   */
  it('规则只命中 keep 候选时也要改写，不能早退', () => {
    const out = applyProjectNamingRules(
      response({
        conflict_count: 1,
        violations: [
          {
            ...response().violations[0],
            path: '/Game/Anim/MF_Walk',
            class: 'AnimSequence',
            suggested_name: 'AS_Walk',
            suggested_path: '/Game/Anim/AS_Walk',
            // 主候选真的被占了，而规则改不到它 —— 这个结论依然成立
            conflict: true,
            ambiguous: true,
            suggested_name_keep: 'AS_MF_Walk',
            suggested_path_keep: '/Game/Anim/AS_MF_Walk',
            conflict_keep: true
          }
        ]
      }),
      {
        policy: policy({
          customRules: [
            { name: 'MF 改 Female', match: 'contains', text: 'MF_', replacement: 'Female_' }
          ]
        }),
        checkDirectory: false,
        keepCompliant: false
      }
    )
    const v = out.violations[0]
    expect(v.suggested_name_keep).toBe('AS_Female_Walk')
    // keep 候选被改写了 → 它那个 conflict_keep 作废，换成「没查」
    expect('conflict_keep' in v).toBe(false)
    expect(v.conflict_keep_unknown).toBe(true)
    /*
     * **主候选一个字都没动，插件查的就是这个名字，它那个 conflict 依然成立。**
     * 一起删掉的话：表头少算一个占用（1 → 0）、那一行也没了 ⚠️、
     * 而 conflict_unknown 又只由主候选那一支置位，于是摘要连「必须先 dry_run」
     * 那段都不打 —— 模型把一个已经被占的名字当安全的发出去，整批被 on_conflict=fail 拒掉。
     */
    expect(v.suggested_name).toBe('AS_Walk')
    expect(v.conflict).toBe(true)
    expect(v.conflict_unknown).toBeUndefined()
    expect(out.conflict_count).toBe(1)
  })

  /** 表非空 ≠ 查过。只配了 Texture 却在扫 StaticMesh，一次比对都没发生 */
  it('表非空但一个类都没匹配上时，仍然标 requested_but_no_table', () => {
    const out = applyProjectNamingRules(
      response({
        violations: [],
        violation_count: 0,
        compliant: [{ path: '/Game/Props/SM_Chair', class: 'StaticMesh' }]
      }),
      {
        policy: policy({ directories: { Texture: '/Game/Art/Textures' } }),
        checkDirectory: true,
        keepCompliant: false
      }
    )
    expect(out.directory_check).toBe('requested_but_no_table')
  })
})
