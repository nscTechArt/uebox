/**
 * @vitest-environment node
 *
 * 命名规则配置的读写。
 *
 * 这里守三件在界面上完全看不出来、只能靠测试盯住的事：
 *
 * 1. 后续版本新增的条目要能到达老用户 —— 四张映射表必须逐条合并、出厂值垫底。
 *    试过整张替换（想让删除生效），结果是把用户的表钉死在某个版本的快照上，
 *    新增的扩展名再也进不去，详见 mergeWithDefaults 的注释。
 * 2. 交出去的表**不能是模块级默认对象本身** —— 按引用交出去的话，谁改一下
 *    加载回来的 config 就污染了整个进程。
 * 3. 没写 `enabled` 的规则算**启用**。后端按 `!== false` 判，而设置页那个开关的
 *    checked 默认是 false —— 不在读的时候补齐，用户就会看到一条显示「关」、
 *    实际却在改他资产名字的规则。
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { loadNamingRulesConfig, saveNamingRulesConfig } from './namingRulesConfig'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../renderer/src/types/namingRules'

const CONFIG_FILE = 'naming-rules.json'

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'naming-rules-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function writeConfig(partial: Record<string, unknown>): void {
  writeFileSync(join(userDataDir, CONFIG_FILE), JSON.stringify(partial), 'utf-8')
}

describe('loadNamingRulesConfig', () => {
  it('没有配置文件时回落到出厂值', () => {
    expect(loadNamingRulesConfig().assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
  })

  it('逐条合并：文件里没有的条目由出厂值补上，后续版本新增的才到得了老用户', () => {
    writeConfig({ assetPrefixes: { StaticMesh: 'MESH_' } })

    const prefixes = loadNamingRulesConfig().assetPrefixes
    expect(prefixes.StaticMesh).toBe('MESH_') // 用户改的赢
    expect(prefixes.Texture).toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes.Texture) // 出厂垫底
  })

  it('交出来的表是新对象，不是模块级默认值本身', () => {
    writeConfig({ version: '1.0.0' })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetTypeToDirectory).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory)
    expect(cfg.libraryAssetTypeToDirectory).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.libraryAssetTypeToDirectory
    )
    expect(cfg.extensionToAssetType).not.toBe(DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType)
    // 这一张装的是**可变对象**，数组本身是新的还不够，里面每一条也得是新的
    expect(cfg.textureSuffixPatterns).not.toBe(DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns)
    expect(cfg.textureSuffixPatterns[0]).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns[0]
    )

    // 改一下加载回来的配置，不该污染下一次读取。
    // 右边写死 'SM_'：拿 DEFAULT_NAMING_RULES_CONFIG.assetPrefixes.StaticMesh 去比的话，
    // 真的污染了两边会一起变成 'POLLUTED_'，这条断言永远绿
    cfg.assetPrefixes.StaticMesh = 'POLLUTED_'
    cfg.textureSuffixPatterns[0].suffix = '_POLLUTED'
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('SM_')
    expect(loadNamingRulesConfig().textureSuffixPatterns[0].suffix).toBe('_D')
  })

  /**
   * 配置文件还不存在（全新安装）和拿不到 userData（app 还没 ready、单元测试）这两条
   * 回落路径最容易被漏掉，而 agent 侧每次 resolveUserNamingPolicy 都可能走后者。
   * 以前这两条 `return { ...DEFAULT }` —— 展开是浅拷贝，四张嵌套表照样按引用交出去。
   */
  it('没有配置文件时交出来的也是深拷贝', () => {
    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.textureSuffixPatterns[0]).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns[0]
    )

    cfg.assetPrefixes.StaticMesh = 'POLLUTED_'
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('SM_')
  })

  it('读盘失败（文件是坏 JSON）时也不交出默认对象本身', () => {
    writeFileSync(join(userDataDir, CONFIG_FILE), '{ 这不是 JSON', 'utf-8')

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetPrefixes.StaticMesh).toBe('SM_')
  })

  it('整个字段缺失（老版本配置）仍然回落到出厂值', () => {
    writeConfig({ version: '1.0.0' })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetTypeToDirectory).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory)
  })

  it('没写 enabled 的自定义规则按启用算，补成真正的布尔值', () => {
    writeConfig({
      customRules: [{ name: '去掉 FINAL', match: 'endsWith', text: '_FINAL', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].enabled).toBe(true)
  })

  it('显式 enabled:false 原样保留', () => {
    writeConfig({
      customRules: [
        { name: '停用的', match: 'contains', text: 'x', replacement: 'y', enabled: false }
      ]
    })

    expect(loadNamingRulesConfig().customRules?.[0].enabled).toBe(false)
  })

  /**
   * 老配置里那个 `pattern`（正则）2026-09-11 下线了（理由见 CustomRuleMatch）。
   * 能确定等价的锚定字面量翻过来，翻不了的把 text 留空 —— 让 compileCustomRules
   * 报成 empty、摘要照实告诉用户重填一次，而不是猜一个语义不同的规则去改他的资产。
   */
  it('老的正则规则翻成新形状：锚定字面量翻得过来', () => {
    writeConfig({
      customRules: [
        { name: '结尾', pattern: '_FINAL$', replacement: '' },
        { name: '开头', pattern: '^Temp_', replacement: 'WIP_' },
        { name: '中间', pattern: 'copy', replacement: '' }
      ]
    })

    const rules = loadNamingRulesConfig().customRules ?? []
    expect(rules.map((r) => [r.match, r.text])).toEqual([
      ['endsWith', '_FINAL'],
      ['startsWith', 'Temp_'],
      ['contains', 'copy']
    ])
    // pattern 不往下传，否则下次读盘还会再走一遍迁移
    expect(rules.every((r) => !('pattern' in r))).toBe(true)
  })

  it('翻不了的正则把 text 留空，不猜一个语义不同的规则', () => {
    writeConfig({
      customRules: [{ name: '真正的正则', pattern: '(\\w+_)+FINAL', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].text).toBe('')
  })

  /**
   * 迁移的判据是「有没有老的 pattern」，不是「text 填了没有」。
   *
   * 拿 text 当判据的话，一条刚在设置页加出来、名字填了原文还没填的新规则会被当成老配置
   * 走迁移，而那个 `plain` 正则是 `*`（空串也匹配），于是 match 被算成 contains，
   * 盖掉用户刚在下拉里选的「开头是」—— 他这时关掉页面，回来看到的就是「包含」。
   */
  it('新规则原文还空着时，不把用户选的匹配位置改掉', () => {
    writeConfig({
      customRules: [{ name: '还没填完', match: 'startsWith', text: '', replacement: '' }]
    })

    const rule = loadNamingRulesConfig().customRules?.[0]
    expect(rule?.match).toBe('startsWith')
    expect(rule?.text).toBe('')
  })

  it('存盘再读回来也不会把匹配位置改掉', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      customRules: [{ name: '还没填完', match: 'endsWith', text: '', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].match).toBe('endsWith')
  })
})

describe('saveNamingRulesConfig', () => {
  it('用户改过的值存得住，读回来还是他那个', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' }
    })

    expect(existsSync(join(userDataDir, CONFIG_FILE))).toBe(true)
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('MESH_')
  })

  /**
   * 已知限制，写下来免得下一个人以为是 bug：删掉一行**不会**持久化。
   * 读写两侧都以出厂值垫底，所以出厂那条下次还会回来。要真正支持删除得改成
   * 「稀疏覆盖 + 显式删除列表」，见 mergeWithDefaults 的注释。
   */
  it('已知限制：删掉出厂那一行不会持久化', () => {
    const withoutSoundWave = { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes }
    delete (withoutSoundWave as Record<string, string>).SoundWave

    saveNamingRulesConfig({ ...DEFAULT_NAMING_RULES_CONFIG, assetPrefixes: withoutSoundWave })

    expect(loadNamingRulesConfig().assetPrefixes).toHaveProperty('SoundWave')
  })
})
