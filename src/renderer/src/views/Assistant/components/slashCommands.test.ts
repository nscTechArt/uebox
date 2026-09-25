import { describe, expect, it } from 'vitest'

import {
  BUILTIN_SLASH_COMMANDS,
  buildGoalCommandDraft,
  filterSlashCommands,
  matchRunCommand,
  parseGoalCommandDraft,
  parseTeamCommandDraft,
  buildTeamCommandDraft,
  slashCommandInsertion
} from './slashCommands'

describe('slashCommands', () => {
  /**
   * 这张表是给用户看的承诺，**每一条都必须真的接了实现**。
   *
   * 加了却没接实现，就是把「敲了以为生效」从一个隐蔽的坑变成写在界面上的谎。
   * 四条分别落在：主进程 `core/goalLoop.ts` 的 `parseGoalCommand`、
   * 主进程 `core/team/teamCommand.ts` 的 `parseTeamCommand`、
   * `Welcome.vue` 的 `handleCreateImage`、`InputComposer.vue` 的 `isWikiCommand`。
   *
   * `/ask` 删掉了：只读已经是审批下拉里的一档，会话级、看得见、能改回来，
   * 比一次性前缀好；留着两条路会让「我到底是不是只读」变成要靠猜。
   */
  it('只收真的接了实现的命令', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      'goal',
      'team',
      'image',
      'wiki'
    ])
  })

  /** 带参数的填进输入框，不带参数的当场跑 —— 判据就是有没有参数占位 */
  it('带参数的是 insert，不带参数的是 run', () => {
    for (const command of BUILTIN_SLASH_COMMANDS) {
      expect(command.kind).toBe(command.argHintKey ? 'insert' : 'run')
    }
  })

  it('每条命令都有说明，文案一律走 i18n key', () => {
    for (const command of BUILTIN_SLASH_COMMANDS) {
      expect(command.descriptionKey).toMatch(/^assistantInputComposer\.slashCommands\./)
      if (command.argHintKey) {
        expect(command.argHintKey).toMatch(/^assistantInputComposer\.slashCommands\./)
      }
    }
  })

  it('空查询给出全部命令', () => {
    expect(filterSlashCommands('')).toHaveLength(BUILTIN_SLASH_COMMANDS.length)
  })

  /** 打字过程中的每一步都要能命中，`/g` `/go` `/goa` 一路到 `/goal` */
  it('按前缀命中，一路打下去都在', () => {
    for (const typed of ['g', 'go', 'goa', 'goal']) {
      expect(filterSlashCommands(typed).map((command) => command.name)).toEqual(['goal'])
    }
  })

  it('已有上下文按钮的压缩命令不再显示在菜单里', () => {
    expect(filterSlashCommands('').map((command) => command.name)).not.toContain('compact')
    expect(filterSlashCommands('c')).toEqual([])
    expect(filterSlashCommands('compact')).toEqual([])
  })

  /** 只读现在只有审批下拉那一条路，`/ask` 不该再被搜出来 */
  it('已经删掉的 /ask 搜不到', () => {
    expect(filterSlashCommands('ask')).toEqual([])
  })

  describe('matchRunCommand', () => {
    /**
     * 用户可以不碰面板，直接把 `/compact` 敲全然后回车。拦不住的话那句话
     * 就当正文发给模型了 —— 模型回一句「好的我来压缩」然后什么也没发生。
     */
    it('认出敲全了的无参命令', () => {
      expect(matchRunCommand('/compact')?.name).toBe('compact')
      expect(matchRunCommand('  /image  ')?.name).toBe('image')
      expect(matchRunCommand('/COMPACT')?.name).toBe('compact')
    })

    /** 带参数的命令不能在这儿被当成动作吞掉，它们要正常走发送 */
    it('带参数的命令不算', () => {
      expect(matchRunCommand('/goal 做一扇门')).toBeNull()
      expect(matchRunCommand('/goal')).toBeNull()
      expect(matchRunCommand('/wiki')).toBeNull()
    })

    /** 后面跟了话就是用户在说话，不是在下命令 */
    it('命令后面跟了正文就不算', () => {
      expect(matchRunCommand('/compact 顺便帮我看看')).toBeNull()
      expect(matchRunCommand('帮我 /compact')).toBeNull()
      expect(matchRunCommand('')).toBeNull()
    })
  })

  it('大小写不敏感', () => {
    expect(filterSlashCommands('GOAL').map((command) => command.name)).toEqual(['goal'])
  })

  /** 只按命令名匹配 —— 命令一共几条，靠描述模糊命中只会把想要的那条挤下去 */
  it('不拿说明文案去凑命中', () => {
    expect(filterSlashCommands('目标')).toEqual([])
    expect(filterSlashCommands('zzz')).toEqual([])
  })

  /**
   * 尾随空格不能省：三条命令后面都要跟正文，而且没有空格时
   * `parseSkillSlashQuery` 会认为这仍是一次搜索，面板不肯关。
   */
  it('填回输入框时带上尾随空格', () => {
    expect(slashCommandInsertion('goal')).toBe('/goal ')
  })

  it('目标模式只折叠命令前缀，目标原文可以原样还原', () => {
    expect(parseGoalCommandDraft('/goal ')).toBe('')
    expect(parseGoalCommandDraft('/goal 做一扇门')).toBe('做一扇门')
    expect(parseGoalCommandDraft('/goals 做一扇门')).toBeNull()
    expect(buildGoalCommandDraft('做一扇门')).toBe('/goal 做一扇门')
  })

  it('/team 草稿同一个折法，和 /goal 互不串', () => {
    expect(parseTeamCommandDraft('/team ')).toBe('')
    expect(parseTeamCommandDraft('/team 做一个塔防游戏')).toBe('做一个塔防游戏')
    expect(parseTeamCommandDraft('/teams 做一个塔防游戏')).toBeNull()
    expect(parseTeamCommandDraft('/goal 做一个塔防游戏')).toBeNull()
    expect(parseGoalCommandDraft('/team 做一个塔防游戏')).toBeNull()
    expect(buildTeamCommandDraft('做一个塔防游戏')).toBe('/team 做一个塔防游戏')
  })
})
