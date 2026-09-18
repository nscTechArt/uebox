/**
 * 命名规则配置文件管理（主进程）
 */
import { app } from 'electron'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type {
  CustomRule,
  CustomRuleMatch,
  NamingRulesConfig
} from '../../renderer/src/types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../renderer/src/types/namingRules'

const CONFIG_FILE_NAME = 'naming-rules.json'

/**
 * 获取配置文件路径。
 *
 * 拿不到就返回 null 而不是抛：`app.getPath` 在 electron 的 app 还没 ready、
 * 或者根本不在 electron 里（单元测试）的时候不可用。那不是错误，只是「这次没有
 * 用户配置可读」，调用方回落到默认值就行 —— 不该在日志里刷一条像故障的红字。
 */
function getConfigPath(): string | null {
  const userDataPath = app?.getPath?.('userData')
  return userDataPath ? join(userDataPath, CONFIG_FILE_NAME) : null
}

/**
 * 读取配置文件
 */
export function loadNamingRulesConfig(): NamingRulesConfig {
  const configPath = getConfigPath()
  // 走 mergeWithDefaults({}) 而不是 `{ ...DEFAULT }`：展开是**浅**拷贝，那四张嵌套的表
  // 会按引用交出去，谁改一下加载回来的 config 就污染了整个进程的出厂值。
  // 这两条回落路径（拿不到 userData、读盘失败）恰恰是最容易被忽略的，
  // 而 agent 侧每次 resolveUserNamingPolicy 在 app ready 之前都走这里
  if (!configPath) return mergeWithDefaults({})

  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(content) as NamingRulesConfig

      // 验证配置结构，如果缺少字段则使用默认值补充
      return mergeWithDefaults(config)
    }
  } catch (error) {
    console.error('[NamingRulesConfig] 读取配置文件失败:', error)
  }

  // 如果文件不存在或读取失败，返回默认配置（同上，必须是深拷贝）
  return mergeWithDefaults({})
}

/**
 * 保存配置文件
 */
export function saveNamingRulesConfig(config: NamingRulesConfig): boolean {
  const configPath = getConfigPath()
  if (!configPath) {
    console.error('[NamingRulesConfig] 拿不到用户数据目录，这次没保存')
    return false
  }

  try {
    // 确保目录存在
    const dir = dirname(configPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    // 写盘也过一遍 mergeWithDefaults：读写两侧用同一套规则，存进去的东西和下次
    // 读出来的东西才一致。为什么不改成「存原样」见 mergeWithDefaults 上面那段
    const validatedConfig = mergeWithDefaults(config)
    writeFileSync(configPath, JSON.stringify(validatedConfig, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('[NamingRulesConfig] 保存配置文件失败:', error)
    return false
  }
}

/**
 * 合并配置与默认值，确保所有必需字段都存在。
 *
 * **四张映射表逐条合并，出厂值垫底。** 这样后续版本新增的条目（新扩展名、新类型）
 * 才能到达老用户手里。
 *
 * 上一轮试过「整张要么用文件的、要么用出厂的」，想让用户删掉的那一行真的留在删掉的
 * 状态。结果是把问题搬了个家，没解决：设置页任何一次自动保存都会把**整个** config
 * 原样写回（`syncEditingToConfig` 是从合并后的编辑行重建的），「恢复默认」更是直接把
 * 出厂表整张写进文件。于是用户随便改一个开关，四张表就被钉在**那个版本**的快照上：
 *
 *   - 之后我们新增 `usdz → StaticMesh`，他永远收不到，导进来的文件没前缀、落进
 *     /Game/Imported，而页面上看不出为什么 —— `extensionToAssetType` 和
 *     `libraryAssetTypeToDirectory` 连编辑器都没有，除了「恢复默认」无从修补；
 *   - 之后我们改掉某个出厂前缀，`pickCustomized` 会把他那份陈旧快照当成「他自己定的」
 *     推给插件 —— 正是那个模块存在的目的所要防的事。
 *
 * 另外 `??` 那种写法会把模块级的 `DEFAULT_NAMING_RULES_CONFIG.xxx` **按引用**交出去
 * （原先的展开是新对象），谁改一下加载回来的 config 就污染了整个进程的默认值。
 *
 * 代价照旧：**删掉一行不会持久化**，下次读盘出厂那条又回来了。那是这套「全量表 +
 * 出厂垫底」结构的固有限制，要真正解决得改成「稀疏覆盖 + 显式删除列表」，
 * 那是一次独立的改造，不在这一轮。
 */
function mergeWithDefaults(config: Partial<NamingRulesConfig>): NamingRulesConfig {
  return {
    version: config.version || DEFAULT_NAMING_RULES_CONFIG.version,
    assetPrefixes: {
      ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes,
      ...(config.assetPrefixes || {})
    },
    // 逐条重建，不把出厂那个数组本身交出去 —— 它装的是可变对象，
    // 按引用交出去等于把进程级默认值摊开给每个调用方随手改
    textureSuffixPatterns: (
      config.textureSuffixPatterns || DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns
    ).map((p) => ({ ...p })),
    assetTypeToDirectory: {
      ...DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory,
      ...(config.assetTypeToDirectory || {})
    },
    libraryAssetTypeToDirectory: {
      ...DEFAULT_NAMING_RULES_CONFIG.libraryAssetTypeToDirectory,
      ...(config.libraryAssetTypeToDirectory || {})
    },
    extensionToAssetType: {
      ...DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType,
      ...(config.extensionToAssetType || {})
    },
    namingConvention: config.namingConvention || DEFAULT_NAMING_RULES_CONFIG.namingConvention,
    autoAddPrefix:
      config.autoAddPrefix !== undefined
        ? config.autoAddPrefix
        : DEFAULT_NAMING_RULES_CONFIG.autoAddPrefix,
    autoDetectTextureType:
      config.autoDetectTextureType !== undefined
        ? config.autoDetectTextureType
        : DEFAULT_NAMING_RULES_CONFIG.autoDetectTextureType,
    customRules: (config.customRules ?? DEFAULT_NAMING_RULES_CONFIG.customRules ?? []).map(
      normalizeCustomRule
    )
  }
}

/** 老配置里那个正则字段。留着只为把它翻成新形状，别在别处用 */
type LegacyCustomRule = CustomRule & { pattern?: string }

/**
 * 一条自定义规则读上来之后的规整。
 *
 * 两件事：
 *
 * 1. **enabled 补成真正的布尔值。** 类型上它是可选的，后端按 `!== false` 判
 *    （缺省=启用），而设置页那个开关的 checked 默认是 false —— 一条没写 enabled 的规则
 *    会显示成「关」，用户以为它没生效，整理时却照样按它改名。补一次，两边就说的是同一件事。
 * 2. **老的 `pattern`（正则）翻成 `match` + `text`。** 那个字段 2026-09-11 下线了，
 *    理由见 `CustomRuleMatch`。只翻译能确定等价的两种写法（`^字面量` 和 `字面量$`，
 *    外加整条都是普通字符的），剩下的翻不了 —— 与其猜一个语义不同的规则去改用户的资产，
 *    不如把 text 留空，让 compileCustomRules 报成 `empty`、摘要照实告诉用户重填一次。
 */
function normalizeCustomRule(rule: LegacyCustomRule): CustomRule {
  // pattern 不往下传：它已经不是配置的一部分了，跟着写回文件只会让下次读盘再走一遍迁移
  const { pattern = '', ...rest } = rule
  const enabled = rule.enabled !== false
  // **没有老的 pattern 就没什么要迁移的。** 光拿 text 当判据不行：一条刚加出来、
  // 还没填原文的新规则会被当成老配置去迁移，而 `plain` 那个正则是 `*`（空串也匹配），
  // 于是下面 `match` 被算成 'contains' 并盖掉用户刚在下拉里选的「开头是」——
  // 他填完名字还没填原文就关掉页面，回来看到的就是「包含」。
  // text 已经填了的照旧优先，免得手改过的文件里残留一个 pattern 把它顶掉
  if (rule.text || !pattern) return { ...rest, match: rule.match ?? 'contains', enabled }

  const plain = /^[A-Za-z0-9_-]*$/
  let match: CustomRuleMatch = 'contains'
  let text = ''
  if (pattern.startsWith('^') && plain.test(pattern.slice(1))) {
    match = 'startsWith'
    text = pattern.slice(1)
  } else if (pattern.endsWith('$') && plain.test(pattern.slice(0, -1))) {
    match = 'endsWith'
    text = pattern.slice(0, -1)
  } else if (plain.test(pattern)) {
    text = pattern
  }

  return { ...rest, match, text, enabled }
}

/**
 * 重置为默认配置
 */
export function resetNamingRulesConfig(): boolean {
  return saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG)
}
