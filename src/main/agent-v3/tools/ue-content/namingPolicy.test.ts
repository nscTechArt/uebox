import { describe, expect, it } from 'vitest'

import {
  applyCustomRules,
  compileCustomRules,
  describeCustomPrefixes,
  directoryOf,
  joinPackage,
  lookupByClass,
  resolveUserNamingPolicy
} from './namingPolicy'
import type { CustomRule, NamingRulesConfig } from '../../../../renderer/src/types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../../../renderer/src/types/namingRules'

function config(patch: Partial<NamingRulesConfig> = {}): NamingRulesConfig {
  return { ...DEFAULT_NAMING_RULES_CONFIG, ...patch }
}

/** 少打几个字的规则构造器。默认「结尾是」，那是最常用的那一档 */
function rule(patch: Partial<CustomRule> & { name: string }): CustomRule {
  return { match: 'endsWith', text: '', replacement: '', ...patch }
}

describe('resolveUserNamingPolicy', () => {
  /**
   * 默认规范是虚幻官方那一套（在插件里）。用户没改过命名规则页时这里必须是空的 ——
   * 把配置的出厂值发过去就是拿我们自己那份小表盖掉 Epic 官方表，而且会把插件
   * 特意拒绝检查的音频类型又塞回去。
   */
  it('用户一条没改时，前缀表是空的', () => {
    expect(resolveUserNamingPolicy(config()).prefixRules).toEqual({})
    expect(resolveUserNamingPolicy(config()).directories).toEqual({})
  })

  it('只交出用户改过的那几条，出厂值原样的丢掉', () => {
    const policy = resolveUserNamingPolicy(
      config({
        assetPrefixes: {
          ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes,
          StaticMesh: 'MESH_', // 改过
          SoundWave: 'A_', // 和出厂一样
          Foliage: 'FOL_' // 出厂没有 = 新增
        }
      })
    )
    expect(policy.prefixRules).toEqual({ StaticMesh: 'MESH_', Foliage: 'FOL_' })
  })

  it('空键空值都丢掉', () => {
    const policy = resolveUserNamingPolicy(
      config({ assetPrefixes: { StaticMesh: 'MESH_', Foliage: '', '': 'X_' } })
    )
    expect(policy.prefixRules).toEqual({ StaticMesh: 'MESH_' })
  })

  it('归属目录同样只交出改过的', () => {
    const policy = resolveUserNamingPolicy(
      config({
        assetTypeToDirectory: {
          ...DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory,
          Texture: '/Game/Art/Textures'
        }
      })
    )
    expect(policy.directories).toEqual({ Texture: '/Game/Art/Textures' })
  })

  /**
   * 这一层**只按开关过滤**。没名字、原文为空的都要走到 compileCustomRules 由它报出来 ——
   * 在这里静默丢掉的话，用户在设置页上看着那条规则，摘要却说「他什么都没配」。
   */
  it('停用的规则丢掉，废规则留给 compileCustomRules 去报', () => {
    const policy = resolveUserNamingPolicy(
      config({
        customRules: [
          rule({ name: '去掉 FINAL', text: '_FINAL' }),
          rule({ name: '停用的', text: 'x', replacement: 'y', enabled: false }),
          rule({ name: '', text: 'z' }),
          rule({ name: '没填原文', text: '' })
        ]
      })
    )
    expect(policy.customRules.map((r) => r.name)).toEqual(['去掉 FINAL', '', '没填原文'])
  })

  /**
   * 配置里的 namingConvention 出厂就是 pascalCase，分不出「用户选的」和
   * 「他从没打开过这一页」。分不出来的东西不猜 —— 交给插件的官方默认。
   *
   * 断言整份键集合而不是某个猜出来的键名：写 `'pascalCase' in policy` 那种没法失败，
   * 真的开始推导时字段多半叫 namingConvention，那条断言照样绿。
   */
  it('不从配置推导命名约定 —— 交出去的就这三样', () => {
    const policy = resolveUserNamingPolicy(config({ namingConvention: 'snake_case' }))
    expect(Object.keys(policy).sort()).toEqual(['customRules', 'directories', 'prefixRules'])
  })
})

describe('lookupByClass', () => {
  const table = { Texture: '/Game/Tex', StaticMesh: '/Game/SM', MaterialInstance: '/Game/MI' }

  it('引擎类名直接命中时不走别名', () => {
    expect(lookupByClass(table, 'StaticMesh')).toBe('/Game/SM')
  })

  it('Texture2D 这类引擎类名走别名落到配置里的 Texture', () => {
    expect(lookupByClass(table, 'Texture2D')).toBe('/Game/Tex')
    expect(lookupByClass(table, 'TextureCube')).toBe('/Game/Tex')
    expect(lookupByClass(table, 'MaterialInstanceConstant')).toBe('/Game/MI')
  })

  it('查不到就是查不到，不猜', () => {
    expect(lookupByClass(table, 'SoundWave')).toBeUndefined()
    // NiagaraSystem 不映射到 ParticleSystem —— 两者前缀不同，硬映射会改错
    expect(lookupByClass({ ParticleSystem: '/Game/FX' }, 'NiagaraSystem')).toBeUndefined()
  })
})

describe('describeCustomPrefixes', () => {
  /**
   * 用户改过的前缀**不再自动发给插件**。插件的 override 是整条规则替换，会把旧前缀从
   * KnownPrefixes 里抹掉，于是 T_Rock 变成「没有前缀」，建议名成了 TX_T_Rock ——
   * 而且 reason 是 missing_prefix，一个警告标记都不带。这里只把它报给模型。
   */
  it('把改过的前缀列成人能读的一行行', () => {
    expect(describeCustomPrefixes({ StaticMesh: 'MESH_' })).toEqual([
      'StaticMesh → MESH_（要传就用引擎类名：StaticMesh）'
    ])
  })

  /**
   * 配置用的是导入流程的类型名，插件只认引擎类名。只报配置键的话，模型照着传
   * `MaterialInstance: 'MTI_'` —— 那条规则永远匹配不上（插件那边的类名是
   * MaterialInstanceConstant），而 MTI_ 还是会进 KnownPrefixes，
   * 于是用户本来正确的 MTI_Rock 反被建议改成 MI_Rock。
   */
  it('有别名的配置键要把引擎类名一并写出来', () => {
    expect(describeCustomPrefixes({ MaterialInstance: 'MTI_' })).toEqual([
      'MaterialInstance → MTI_（要传就用引擎类名：MaterialInstanceConstant）'
    ])
    const [textureLine] = describeCustomPrefixes({ Texture: 'TX_' })
    expect(textureLine).toContain('Texture2D')
    expect(textureLine).toContain('TextureCube')
  })

  it('没改过就是空的', () => {
    expect(describeCustomPrefixes({})).toEqual([])
  })
})

describe('compileCustomRules', () => {
  it('三个位置都编译得出来，原样带过去', () => {
    const compiled = compileCustomRules([
      rule({ name: '结尾', match: 'endsWith', text: '_FINAL' }),
      rule({ name: '开头', match: 'startsWith', text: 'Temp_', replacement: 'WIP_' }),
      rule({ name: '中间', match: 'contains', text: '__' })
    ])
    expect(compiled.rejected).toEqual([])
    expect(compiled.rules.map((r) => [r.name, r.match, r.text])).toEqual([
      ['结尾', 'endsWith', '_FINAL'],
      ['开头', 'startsWith', 'Temp_'],
      ['中间', 'contains', '__']
    ])
  })

  /**
   * 这一格以前是自由填写的正则。2026-09-11 实测下来那条路走不通：`String.replace`
   * 中断不了，而灾难性回溯压根不需要括号 —— `a+a+a+a+a+a+a+a+a+a+$` 在 49 字符的
   * 名字上 34 秒。按形状拦两个方向都错（不带组的照样过，`\(\d+\)+$` 0.0003 毫秒却被判危险），
   * 所以整条路换成纯文本。这里守的是「正则语义一点都不许漏回来」。
   */
  it('原文按字面匹配，正则元字符不当正则用', () => {
    const compiled = compileCustomRules([
      rule({ name: '剥复制标记', match: 'endsWith', text: '(1)' })
    ])
    expect(applyCustomRules('SM_Door(1)', compiled).name).toBe('SM_Door')
    // 换成正则语义的话 (1) 是个捕获组，'SM_Door1' 才是被剥的那个
    expect(applyCustomRules('SM_Door1', compiled).name).toBe('SM_Door1')
  })

  it('replacement 里的 $1 也是字面量，不是反向引用', () => {
    const compiled = compileCustomRules([
      rule({ name: '换成美元一', match: 'endsWith', text: '_v2', replacement: '$1' })
    ])
    expect(applyCustomRules('Rock_v2', compiled).name).toBe('Rock$1')
  })

  it('没起名字的规则报成 unnamed，不静默丢掉', () => {
    const compiled = compileCustomRules([
      rule({ name: '', text: '_FINAL' }),
      rule({ name: '有名字的', text: '_v2' })
    ])
    expect(compiled.rejected).toEqual([{ rule: '(未命名)', reason: 'unnamed' }])
    expect(compiled.rules.map((r) => r.name)).toEqual(['有名字的'])
  })

  /** 空原文在任何名字里都算匹配，套上去等于给每个资产都插一段 */
  it('没填原文的规则报成 empty', () => {
    const compiled = compileCustomRules([
      rule({ name: '空的', text: '', replacement: 'X' }),
      rule({ name: '正常的', text: '_v2' })
    ])
    expect(compiled.rejected).toEqual([{ rule: '空的', reason: 'empty' }])
    expect(compiled.rules.map((r) => r.name)).toEqual(['正常的'])
  })

  it('match 缺失时按「包含」算，不当成一条废规则', () => {
    const compiled = compileCustomRules([
      { name: '老配置', text: '_tmp', replacement: '' } as CustomRule
    ])
    expect(compiled.rules[0].match).toBe('contains')
  })
})

describe('applyCustomRules', () => {
  it('按顺序链式套用，后一条作用在前一条的结果上', () => {
    const result = applyCustomRules(
      'Temp_Rock_FINAL',
      compileCustomRules([
        rule({ name: '去掉 FINAL', match: 'endsWith', text: '_FINAL' }),
        rule({ name: 'Temp 改 WIP', match: 'startsWith', text: 'Temp_', replacement: 'WIP_' })
      ])
    )
    expect(result.name).toBe('WIP_Rock')
    expect(result.hits.map((h) => h.rule)).toEqual(['去掉 FINAL', 'Temp 改 WIP'])
  })

  it('位置不对就不算命中', () => {
    const compiled = compileCustomRules([
      rule({ name: '结尾是 Temp_', match: 'endsWith', text: 'Temp_' })
    ])
    const result = applyCustomRules('Temp_Rock', compiled)
    expect(result.name).toBe('Temp_Rock')
    expect(result.hits).toEqual([])
  })

  it('「包含」换掉每一处，不是只换第一处', () => {
    const compiled = compileCustomRules([
      rule({ name: '合并下划线', match: 'contains', text: '__', replacement: '_' })
    ])
    expect(applyCustomRules('A__B__C', compiled).name).toBe('A_B_C')
  })

  it('没命中的规则不进 hits', () => {
    const result = applyCustomRules(
      'SM_Rock',
      compileCustomRules([rule({ name: '去掉 FINAL', text: '_FINAL' })])
    )
    expect(result.name).toBe('SM_Rock')
    expect(result.hits).toEqual([])
  })

  /**
   * 名字被清成空串时保留原名，和插件里 `if (Base.IsEmpty()) { Base = Name; }` 对齐。
   * 不保留的话 suggested_path 会以 / 结尾，而那在 ue_content_move 那边是「搬过去、名字不变」
   */
  it('规则把名字清空时保留原名，不产出空名字', () => {
    const result = applyCustomRules(
      'T_Rock',
      compileCustomRules([
        rule({ name: '去掉前缀', match: 'startsWith', text: 'T_' }),
        rule({ name: '去掉词干', match: 'contains', text: 'Rock' })
      ])
    )
    expect(result.name).toBe('Rock')
  })

  /**
   * 纯字符串操作跑不出指数级。这条不是性能测试，是「换掉正则之后，一个正常长度的
   * 资产名不可能再让主进程停住」的下限 —— 以前 `a+a+…$` 这类在 49 字符上是 34 秒。
   */
  it('最坏形状也是毫秒级', () => {
    const compiled = compileCustomRules(
      Array.from({ length: 12 }, (_, i) => rule({ name: `r${i}`, match: 'contains', text: 'a' }))
    )
    const started = Date.now()
    applyCustomRules('a'.repeat(60), compiled)
    expect(Date.now() - started).toBeLessThan(100)
  })
})

describe('路径拼接', () => {
  it('directoryOf 取目录部分', () => {
    expect(directoryOf('/Game/Temp/SM_Rock')).toBe('/Game/Temp')
    expect(directoryOf('/SM_Rock')).toBe('/')
  })

  /** 顶层的 directoryOf 返回 '/'，再拼一个斜杠就是 //Name */
  it('joinPackage 在顶层不拼出两个斜杠', () => {
    expect(joinPackage('/', 'SM_Rock')).toBe('/SM_Rock')
    expect(joinPackage('/Game/Meshes', 'SM_Rock')).toBe('/Game/Meshes/SM_Rock')
    expect(joinPackage('/Game/Meshes/', 'SM_Rock')).toBe('/Game/Meshes/SM_Rock')
  })
})
