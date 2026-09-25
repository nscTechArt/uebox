/**
 * 输入框里的内置斜杠命令。
 *
 * ## 为什么要有这张表
 *
 * 在这之前，命令**只有解析、没有界面**：输入 `/goa` 面板说「未找到匹配技能」，
 * 补全成 `/goal` 面板直接消失 —— 一个真命令给出的反馈和一个拼错的词一模一样。
 * 命令是打出来的，不是猜出来的，所以得有一张能被搜到的表。
 *
 * ## 只收真的能用的
 *
 * 这里**只放真正接了实现的命令**。`skillCommands.ts` 原来那份 29 个词的保留字表
 * 是 V2 Router 时代的遗物（`/router`、`/direct`、`/blueprint` …），那批命令随扁平
 * 单 agent 一起下线了，解析出来的 override 一路传到 `executeAgent()` 就被丢掉 ——
 * 留在保留字里的唯一效果是让这些词既不触发命令、也不触发技能搜索。
 *
 * 把死命令列进这张表会更糟：那等于把「用户敲了以为生效」从一个隐蔽的坑
 * 变成一句写在界面上的承诺。
 */

/**
 * 命令选中之后怎么处理。
 *
 * - `insert`：填成 `/name ` 留在输入框里，等用户接着写参数。`/goal <目标>` 这类。
 * - `run`：**当场执行**，输入框清空。`/image` 这类不带参数、本身就是一个动作的。
 *
 * 分这两档是因为「选中即执行」对带参数的命令是错的（把「我在挑命令」和
 * 「我写完了」搅成一件事），而对不带参数的命令，填进输入框再让用户按一次回车
 * 是白让他多按一下。
 */
export type SlashCommandKind = 'insert' | 'run'

/**
 * 一条内置命令。
 *
 * 文案一律走 i18n key，**包括参数占位** —— 那也是要给人读的话
 * （「目标」/「objective」），写死中文就等于让英文界面漏一块。
 */
export interface SlashCommand {
  /** 命令名，不带斜杠 */
  name: string
  /** 选中之后填进输入框还是当场执行 */
  kind: SlashCommandKind
  /** 参数占位的 i18n key。不带参数的命令给空串 */
  argHintKey: string
  /** 说明文案的 i18n key */
  descriptionKey: string
}

/**
 * 斜杠菜单里可见的内置命令，按「用得多」排在前面。
 *
 * 加命令时**先把实现接上再进这张表**，顺序反过来就是在界面上撒谎。
 * 每条对应的实现见 `slashCommands.test.ts` 里那条清单测试。
 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'goal',
    kind: 'insert',
    argHintKey: 'assistantInputComposer.slashCommands.goalArg',
    descriptionKey: 'assistantInputComposer.slashCommands.goal'
  },
  {
    // 工作室模式：制作人自己组队、分工，一路做到交付。见 docs/AI游戏工作室设计-2026-09-25.md
    name: 'team',
    kind: 'insert',
    argHintKey: 'assistantInputComposer.slashCommands.teamArg',
    descriptionKey: 'assistantInputComposer.slashCommands.team'
  },
  {
    name: 'image',
    kind: 'run',
    argHintKey: '',
    descriptionKey: 'assistantInputComposer.slashCommands.image'
  },
  {
    name: 'wiki',
    kind: 'insert',
    argHintKey: 'assistantInputComposer.slashCommands.wikiArg',
    descriptionKey: 'assistantInputComposer.slashCommands.wiki'
  }
]

/**
 * 已经有可见按钮的兼容命令，不再放进斜杠菜单制造重复入口。
 * 仍保留手动输入的识别，避免旧习惯或已保存草稿突然变成普通聊天文本。
 */
const HIDDEN_RUN_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'compact',
    kind: 'run',
    argHintKey: '',
    descriptionKey: ''
  }
]

/**
 * 按输入的词筛命令。
 *
 * 打分口径和 `filterSkillCommands` 保持一致（精确 → 前缀 → 包含），
 * 两组结果挨着显示，排序规则不一样的话用户会觉得面板在乱跳。
 *
 * 只匹配命令名，不匹配说明文案：命令一共就几条，靠描述模糊命中只会把
 * 明明想要的那条挤下去。
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...BUILTIN_SLASH_COMMANDS]

  return BUILTIN_SLASH_COMMANDS.map((command, index) => {
    const name = command.name.toLowerCase()
    const score =
      name === normalized ? 0 : name.startsWith(normalized) ? 1 : Number.POSITIVE_INFINITY
    return { command, index, score }
  })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.command)
}

/**
 * 选中一条命令后填回输入框的文本。
 *
 * 带尾随空格 —— 命令后面几乎总要跟参数，不带的话用户还得自己敲一下，
 * 而且没有空格时 `parseSkillSlashQuery` 会认为这仍是一次命令搜索，面板不肯关。
 */
export function slashCommandInsertion(name: string): string {
  return `/${name} `
}

const GOAL_COMMAND_PREFIX = slashCommandInsertion('goal')

/**
 * 把输入框中的 `/goal ` 前缀解析成界面上可编辑的目标文字。
 *
 * 返回空字符串代表已进入目标模式、但还没写目标；返回 `null`
 * 才代表它不是目标模式。这样界面可以把命令前缀折叠成标签，实际发送的文本仍保持不变。
 */
export function parseGoalCommandDraft(value: string): string | null {
  return value.startsWith(GOAL_COMMAND_PREFIX) ? value.slice(GOAL_COMMAND_PREFIX.length) : null
}

/** 把界面上的目标文字还原为主进程认得的 `/goal <目标>` 命令。 */
export function buildGoalCommandDraft(objective: string): string {
  return `${GOAL_COMMAND_PREFIX}${objective}`
}

const TEAM_COMMAND_PREFIX = slashCommandInsertion('team')

/** 同 `parseGoalCommandDraft`，认的是 `/team ` */
export function parseTeamCommandDraft(value: string): string | null {
  return value.startsWith(TEAM_COMMAND_PREFIX) ? value.slice(TEAM_COMMAND_PREFIX.length) : null
}

/** 把界面上的一句话还原为主进程认得的 `/team <一句话>` 命令。 */
export function buildTeamCommandDraft(objective: string): string {
  return `${TEAM_COMMAND_PREFIX}${objective}`
}

/**
 * 整段输入是不是一条「当场执行」的命令。
 *
 * 用在**发送那一刻**：用户完全可以不碰面板，直接把 `/compact` 敲全然后回车。
 * 不在这儿拦下来，那句话就当正文发给模型了 —— 模型会礼貌地回一句
 * 「好的我来压缩」然后什么也没发生，正是这轮要消灭的那种假生效。
 *
 * 只认光秃秃的命令本身：`/compact 顺便帮我看看` 不算，那是用户在说话。
 */
export function matchRunCommand(value: string): SlashCommand | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('/')) return null

  const name = trimmed.slice(1)
  return (
    [...BUILTIN_SLASH_COMMANDS, ...HIDDEN_RUN_COMMANDS].find(
      (command) => command.kind === 'run' && command.name === name
    ) ?? null
  )
}
