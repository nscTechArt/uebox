/**
 * 操作盒子本身：看盒子助手的对话、看盒子此刻的状态、管技能 / 第三方 MCP / 导入 / 备份。
 *
 * ## 为什么要有
 *
 * 外部客户端（Codex、Claude Code）连进来之后，拿到的是盒子助手手上那一套 —— 能动引擎、
 * 能动素材库，却看不见盒子自己：盒子助手刚才做了什么、哪个导入卡住了、哪个 MCP 连不上、
 * 哪个技能被关了。这些原来只能让用户切回盒子界面去看、去点。
 *
 * ## 为什么是三个工具而不是十几个
 *
 * 每个 MCP 客户端连上就把整张清单读一遍，每多一个工具每轮都多付一份描述的钱。
 * 所以按「读 / 写」切成三个，动作放进 `action`：和 `project_list` / `project_manage`
 * 一个道理。写的那个按动作算实际风险（`riskFor`）：重连一下和放弃一次导入不是一个量级。
 *
 * ## 故意不给的
 *
 * 恢复 / 删除备份、改盒子自己的 MCP 服务（停服务、换令牌会把调用方自己踢下线）、
 * 升级重启、改系统 PATH —— 这些要用户在盒子界面里亲手做。
 *
 * 依赖一律在 execute 里动态 import：它们会拉起数据库、electron、网络服务，
 * 不能进工具注册表的静态依赖图。
 */

import { z } from 'zod'

import { defineTool, type ToolRisk, type UnrealAgentTool } from '../defineTool'

// ── box_sessions ────────────────────────────────────────────────────────────

/** 列表默认回几条、最多几条 */
const DEFAULT_SESSION_LIST = 20
const MAX_SESSION_LIST = 100
/** 读一条对话时默认回多少字。超了从头部截掉 —— 最近的往往最有用 */
const DEFAULT_READ_CHARS = 20_000
const MAX_READ_CHARS = 100_000
/** 列表里每条对话的开头摘多少字当标题 */
const TITLE_CHARS = 60
/** 工具结果每条只留多少字：读对话是为了知道做了什么，不是回放每次的返回 */
const TOOL_RESULT_CHARS = 300

const sessionsInput = z.object({
  action: z
    .enum(['list', 'read'])
    .describe('list：列出盒子助手最近的对话；read：读一条对话的内容（要 session_id）'),
  session_id: z.string().optional().describe('read 时必填：list 返回的 id'),
  limit: z.number().optional().describe(`list 时回几条，默认 ${DEFAULT_SESSION_LIST}`),
  max_chars: z
    .number()
    .optional()
    .describe(`read 时最多回多少字，默认 ${DEFAULT_READ_CHARS}。超了只留最近的部分`)
})

interface LooseMessage {
  role?: string
  content?: unknown
  toolName?: string
  isError?: boolean
}

/**
 * 消息里的纯文本。content 可能是字符串，也可能是块数组。
 *
 * 音视频引用（`[[uebox-media …]]`）也是文本块，但那是给 streamFn 换链接用的标记，
 * 里面有本机路径和对象存储的 key，不是谁说的话，不交给外部客户端
 */
function textOf(message: LooseMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        (block as { type?: string })?.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        // 同 `promptMedia.parseMediaRef` 的判法；那个模块会拉起设置存储，不能静态引进来
        !(block as { text: string }).text.startsWith(MEDIA_REF_PREFIX)
    )
    .map((block) => block.text)
    .join('')
}

const MEDIA_REF_PREFIX = '[[uebox-media '

/** 盒子拼在用户原话前面的机器块（`<runtime-status>` 信封、任务板旧账……） */
const LEADING_MACHINE_BLOCK = /^\s*<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>\s*/i

/** 用户这句话本身：剥掉前面那些机器块 */
function userTextOf(message: LooseMessage): string {
  let text = textOf(message)
  for (let m = LEADING_MACHINE_BLOCK.exec(text); m; m = LEADING_MACHINE_BLOCK.exec(text)) {
    text = text.slice(m[0].length)
  }
  return text
}

/** 助手这一步调了哪些工具，只要名字 */
function toolCallsOf(message: LooseMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block) => (block as { type?: string })?.type === 'toolCall')
    .map((block) => String((block as { name?: unknown }).name ?? '?'))
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** 一条消息压成一段给模型读的文本。空的返回 undefined */
export function renderMessage(message: LooseMessage): string | undefined {
  switch (message.role) {
    case 'user': {
      const text = userTextOf(message).trim()
      return text ? `【用户】${text}` : undefined
    }
    case 'assistant': {
      const text = textOf(message).trim()
      const calls = toolCallsOf(message)
      const parts = [text, calls.length ? `（调用：${calls.join('、')}）` : ''].filter(Boolean)
      return parts.length ? `【助手】${parts.join('\n')}` : undefined
    }
    case 'toolResult': {
      const flag = message.isError ? '失败' : '结果'
      return `【${message.toolName ?? '工具'} ${flag}】${clip(textOf(message), TOOL_RESULT_CHARS)}`
    }
    default:
      return undefined
  }
}

/** 从尾部往前装，装满为止。返回的是正序 */
export function takeRecent(
  blocks: string[],
  maxChars: number
): { kept: string[]; dropped: number } {
  const kept: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = blocks[i].length + 2
    if (kept.length > 0 && used + cost > maxChars) return { kept, dropped: i + 1 }
    kept.unshift(blocks[i])
    used += cost
  }
  return { kept, dropped: 0 }
}

/** 子任务、队员的会话不算用户看得见的对话 */
function isUserFacingSession(sessionId: string): boolean {
  return !sessionId.includes(':sub-') && !sessionId.includes(':mate-')
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(1, Math.floor(value ?? fallback)), max)
}

export function createBoxSessionsTool(): UnrealAgentTool<unknown> {
  return defineTool({
    name: 'box_sessions',
    namespace: 'box',
    risk: 'safe',
    description:
      '看虚幻盒子里内置助手的对话记录。\n\n' +
      '【什么时候用】用户说「盒子里刚才那个对话」「助手上次做到哪了」「看看它改了什么」时；' +
      '或者要接着盒子助手没做完的活干，先读一遍它做过什么、卡在哪。\n' +
      '先 list 找到对话，再 read 读内容。读到的是对话正文、每步调了哪些工具、工具结果的开头 —— ' +
      '具体改了什么以引擎和素材库的现状为准，回读确认后再下结论。',
    input: sessionsInput,
    async execute(input) {
      const { listTranscripts, loadTranscript } = await import('../../core/transcriptStore')

      if (input.action === 'list') {
        const limit = clampInt(input.limit, DEFAULT_SESSION_LIST, MAX_SESSION_LIST)
        const metas = (await listTranscripts())
          .filter((meta) => isUserFacingSession(meta.sessionId))
          .slice(0, limit)
        if (metas.length === 0) return { text: '盒子里还没有助手对话。' }

        const rows = await Promise.all(
          metas.map(async (meta) => {
            const messages = (await loadTranscript(meta.sessionId)) as LooseMessage[]
            const first = messages.find((m) => m.role === 'user')
            return {
              sessionId: meta.sessionId,
              title: first ? clip(userTextOf(first), TITLE_CHARS) || '（无文字）' : '（空对话）',
              updatedAt: new Date(meta.modifiedAt).toISOString(),
              messageCount: meta.messageCount
            }
          })
        )
        return {
          text: rows
            .map(
              (row) => `${row.sessionId}｜${row.updatedAt}｜${row.messageCount} 条｜${row.title}`
            )
            .join('\n'),
          details: rows
        }
      }

      const sessionId = input.session_id?.trim()
      if (!sessionId) throw new Error('read 要给 session_id。先用 action: "list" 找到它。')
      const messages = (await loadTranscript(sessionId)) as LooseMessage[]
      if (messages.length === 0) {
        throw new Error(`没有找到对话 ${sessionId}，或者它是空的。用 action: "list" 看看现有的。`)
      }

      const blocks = messages.map(renderMessage).filter((b): b is string => Boolean(b))
      const maxChars = clampInt(input.max_chars, DEFAULT_READ_CHARS, MAX_READ_CHARS)
      const { kept, dropped } = takeRecent(blocks, maxChars)
      const head = dropped > 0 ? `（前面 ${dropped} 段太长已省略，只留最近的部分）\n\n` : ''
      return { text: head + kept.join('\n\n') }
    }
  })
}

// ── box_status ──────────────────────────────────────────────────────────────

const STATUS_SECTIONS = ['editors', 'imports', 'mcp', 'skills', 'notebooks', 'backups'] as const
type StatusSection = (typeof STATUS_SECTIONS)[number]

const statusInput = z.object({
  sections: z
    .array(z.enum(STATUS_SECTIONS))
    .optional()
    .describe(
      '只看哪几块，省略就全看。editors：正在运行的虚幻编辑器；imports：素材导入任务和卡住待处理的导入；' +
        'mcp：接入的第三方 MCP 服务和连接状态；skills：技能清单和开关；notebooks：知识库清单；backups：数据库备份'
    )
})

/** 导入任务列表只看最近几条，外加所有没结束的 */
const RECENT_IMPORTS = 5

async function editorsSection(): Promise<string> {
  const { default: detector } = await import('../../../utils/UnrealProcessDetector')
  const running = await detector.getRunningProjects()
  if (running.length === 0) return '没有正在运行的虚幻编辑器。'
  return running
    .map(
      (p) =>
        `- ${p.projectName}${p.engineVersion ? `（UE ${p.engineVersion}）` : ''}｜pid ${p.pid}｜${p.projectPath}`
    )
    .join('\n')
}

async function importsSection(): Promise<string> {
  const [{ getPublicDatabase }, { listImportTasks }, { listImportRecoveryContexts }] =
    await Promise.all([
      import('../../../sqliteDataBase'),
      import('../../../sqliteDataBase/models/importTask'),
      import('../../../services/asset/ImportRecoveryContextService')
    ])
  const tasks = listImportTasks(getPublicDatabase())
  const finished = (status: string): boolean => status === 'completed' || status === 'cancelled'
  const shown = tasks.filter((t, i) => i < RECENT_IMPORTS || !finished(t.status))
  const lines = shown.map(
    (t) =>
      `- ${t.taskId}｜${t.status}/${t.stage}｜${t.doneItems}/${t.totalItems}（${Math.round(t.percent)}%）｜${t.rootPath}` +
      (t.errorMessage ? `｜错误：${clip(t.errorMessage, 200)}` : '')
  )

  const stuck = await listImportRecoveryContexts(10)
  const stuckLines = stuck.map(
    (c) =>
      `- ${c.taskId}｜${c.status}｜${c.canResume ? '可续传' : '不能续传'}` +
      (c.rootFolderPath ? `｜${c.rootFolderPath}` : '') +
      (c.lastError ? `｜${clip(c.lastError, 200)}` : '')
  )

  return [
    lines.length ? `导入任务：\n${lines.join('\n')}` : '没有导入任务。',
    stuckLines.length
      ? `卡住待处理的导入（box_manage 的 resume_import / abandon_import 处理）：\n${stuckLines.join('\n')}`
      : '没有卡住的导入。'
  ].join('\n\n')
}

async function mcpSection(): Promise<string> {
  const [{ readMcpSettings }, { currentStatuses }] = await Promise.all([
    import('../../capabilities/mcp/store'),
    import('../../capabilities/mcp/index')
  ])
  const settings = await readMcpSettings()
  const statuses = new Map(currentStatuses().map((s) => [s.id, s]))
  const ids = Object.keys(settings.mcpServers)
  if (ids.length === 0) return '没有接入第三方 MCP 服务。'
  return ids
    .map((id) => {
      const status = statuses.get(id)
      const state = status?.disabled
        ? '已停用'
        : status?.connected
          ? `已连接，${status.toolCount} 个工具`
          : status?.error
            ? `连不上：${clip(status.error, 200)}`
            : '未连接'
      return `- ${id}｜${state}`
    })
    .join('\n')
}

async function skillsSection(): Promise<string> {
  const { discoverSkillsOnDisk, listSkillSummaries, readDisabledSkills } = await import(
    '../../capabilities/skills'
  )
  const skills = listSkillSummaries(await discoverSkillsOnDisk(), await readDisabledSkills())
  if (skills.length === 0) return '没有技能。'
  return skills
    .map((s) => `- ${s.name}｜${s.enabled ? '开' : '关'}｜${s.source}｜${s.description}`)
    .join('\n')
}

async function notebooksSection(): Promise<string> {
  const [{ getPublicDatabase }, { listNotebooks }] = await Promise.all([
    import('../../../sqliteDataBase'),
    import('../../../sqliteDataBase/models/notebook')
  ])
  const notebooks = listNotebooks(getPublicDatabase(), { limit: 100 })
  if (notebooks.length === 0) return '没有知识库。'
  return notebooks
    .map((nb) => `- ${nb.title}｜${nb.sourceCount ?? 0} 条来源｜${nb.notebookId}`)
    .join('\n')
}

async function backupsSection(): Promise<string> {
  const { DatabaseBackupService } = await import('../../../services/backup')
  const service = DatabaseBackupService.getInstance()
  const stats = service.getStats()
  const recent = service
    .listBackups()
    .slice(0, 5)
    .map(
      (b) => `- ${b.id}｜${b.createdAt}｜${Math.round(b.fileSize / 1024)} KB｜${b.integrityStatus}`
    )
  return [`共 ${stats.totalCount} 份，最近一次：${stats.lastBackupAt ?? '从未'}。`, ...recent].join(
    '\n'
  )
}

const SECTION_TITLES: Record<StatusSection, string> = {
  editors: '虚幻编辑器',
  imports: '素材导入',
  mcp: '第三方 MCP',
  skills: '技能',
  notebooks: '知识库',
  backups: '备份'
}

const SECTION_READERS: Record<StatusSection, () => Promise<string>> = {
  editors: editorsSection,
  imports: importsSection,
  mcp: mcpSection,
  skills: skillsSection,
  notebooks: notebooksSection,
  backups: backupsSection
}

export function createBoxStatusTool(): UnrealAgentTool<unknown> {
  return defineTool({
    name: 'box_status',
    namespace: 'box',
    risk: 'safe',
    description:
      '一次看清虚幻盒子此刻的状态：正在运行的虚幻编辑器、素材导入任务（含卡住的）、' +
      '接入的第三方 MCP 服务通不通、技能清单与开关、知识库清单、数据库备份。\n\n' +
      '【什么时候用】用户问「导入卡住了吗」「那个 MCP 连上没」「我装了哪些技能」这类关于盒子本身的问题；' +
      '或者要用 box_manage 动手之前，先看一眼现状拿到 id。只关心某几块就传 sections。',
    input: statusInput,
    async execute(input) {
      const wanted = input.sections?.length ? input.sections : [...STATUS_SECTIONS]
      // 各块互不依赖，一块读不出来不该让别的块也看不到
      const parts = await Promise.all(
        wanted.map(async (section) => {
          let body: string
          try {
            body = await SECTION_READERS[section]()
          } catch (error) {
            body = `读不出来：${(error as Error).message}`
          }
          return `## ${SECTION_TITLES[section]}\n${body}`
        })
      )
      return { text: parts.join('\n\n') }
    }
  })
}

// ── box_manage ──────────────────────────────────────────────────────────────

const MANAGE_ACTIONS = [
  'enable_skill',
  'disable_skill',
  'reconnect_mcp',
  'remove_mcp_server',
  'resume_import',
  'abandon_import',
  'reimport_asset',
  'reimport_folder',
  'backup_database'
] as const
type ManageAction = (typeof MANAGE_ACTIONS)[number]

/** 不可逆的那几个。其余都能撤回或重做 */
const DESTRUCTIVE_ACTIONS: ReadonlySet<ManageAction> = new Set([
  // 服务端会清掉那次导入的暂存区，续传的路就断了
  'abandon_import',
  // 配置从 mcp.json 里删掉，要用得重新填一遍
  'remove_mcp_server'
])

const manageInput = z.object({
  action: z
    .enum(MANAGE_ACTIONS)
    .describe(
      'enable_skill / disable_skill：开关一个技能（target=技能名）；' +
        'reconnect_mcp：重连全部第三方 MCP；remove_mcp_server：删掉一个第三方 MCP（target=服务 id）；' +
        'resume_import：续传一次卡住的导入（target=导入任务 id）；abandon_import：放弃它并清掉服务端暂存（target=导入任务 id）；' +
        'reimport_asset：重新导入一个资产（target=资产 key）；reimport_folder：重新导入一个文件夹（target=文件夹 key）；' +
        'backup_database：立刻备份一次盒子数据库'
    ),
  target: z
    .string()
    .optional()
    .describe(
      '动作的对象：技能名、MCP 服务 id、导入任务 id、资产 key 或文件夹 key。先用 box_status 拿到'
    )
})

function requireTarget(action: ManageAction, target: string | undefined): string {
  const value = target?.trim()
  if (!value) throw new Error(`${action} 要给 target。先用 box_status 看一眼拿到对应的名字或 id。`)
  return value
}

/** 外部 MCP 会话的工具清单在握手时就定了，第三方 MCP 变了要客户端重连才看得到 */
const MCP_TOOLS_NOTE =
  '盒子助手下一轮就能用上新的工具清单；通过 MCP 连进来的客户端要重新连接盒子才看得到变化。'

async function runManage(action: ManageAction, target: string | undefined): Promise<string> {
  switch (action) {
    case 'enable_skill':
    case 'disable_skill': {
      const name = requireTarget(action, target)
      const { discoverSkillsOnDisk, setSkillDisabled } = await import('../../capabilities/skills')
      const skills = await discoverSkillsOnDisk()
      if (!skills.some((s) => s.name === name)) {
        throw new Error(`没有叫 ${name} 的技能。现有的：${skills.map((s) => s.name).join('、')}`)
      }
      await setSkillDisabled(name, action === 'disable_skill')
      return `已${action === 'disable_skill' ? '关掉' : '打开'}技能 ${name}，下一轮对话开始生效。`
    }
    case 'reconnect_mcp': {
      const { reconnectMcp } = await import('../../capabilities/mcp/index')
      const statuses = await reconnectMcp()
      const lines = statuses.map(
        (s) =>
          `- ${s.id}｜${s.disabled ? '已停用' : s.connected ? `已连接，${s.toolCount} 个工具` : `连不上：${s.error ?? '未知原因'}`}`
      )
      return `已重连第三方 MCP。\n${lines.join('\n') || '（没有配置任何服务）'}\n${MCP_TOOLS_NOTE}`
    }
    case 'remove_mcp_server': {
      const id = requireTarget(action, target)
      const [{ removeMcpServer }, { reconnectMcp }] = await Promise.all([
        import('../../capabilities/mcp/store'),
        import('../../capabilities/mcp/index')
      ])
      if (!(await removeMcpServer(id))) throw new Error(`没有 id 为 ${id} 的第三方 MCP 服务。`)
      await reconnectMcp()
      return `已删掉第三方 MCP 服务 ${id}。${MCP_TOOLS_NOTE}`
    }
    case 'resume_import': {
      const taskId = requireTarget(action, target)
      const { resumeImport } = await import('../../../services/asset/ResumeImportService')
      const result = await resumeImport({ taskId })
      if (!result.success) {
        throw new Error(`续传没成功（${result.status}）。${result.error ?? ''}`.trim())
      }
      return `导入 ${taskId} 已续传完成：补传 ${result.uploadedFiles} 个文件、${result.uploadedThumbnails} 张缩略图。`
    }
    case 'abandon_import': {
      const taskId = requireTarget(action, target)
      const { abandonImport } = await import('../../../services/asset/ResumeImportService')
      const result = await abandonImport({ taskId })
      // 两件事分开报：服务端没确认清掉暂存，就不能说清掉了
      return [
        result.success ? `已放弃导入 ${taskId}。` : `放弃导入 ${taskId} 没完全成功。`,
        result.stagingCleared ? '服务端暂存区已清掉。' : '服务端暂存区没确认清掉，可能还占着空间。',
        result.locallyDismissed ? '' : '本地的「未完成导入」提示没能消掉。',
        result.error ? `原因：${result.error}` : ''
      ]
        .filter(Boolean)
        .join('')
    }
    case 'reimport_asset': {
      const key = requireTarget(action, target)
      const { AssetImportService } = await import('../../../services/asset/AssetImportService')
      const ok = await new AssetImportService().reimportAsset(key)
      if (!ok) throw new Error(`资产 ${key} 重新导入失败。`)
      return `资产 ${key} 已重新导入。`
    }
    case 'reimport_folder': {
      const key = requireTarget(action, target)
      const { AssetImportService } = await import('../../../services/asset/AssetImportService')
      const result = await new AssetImportService().reimportFolder(key)
      return `文件夹 ${key} 重新导入：共 ${result.total} 个，成功 ${result.success}，失败 ${result.failed}。`
    }
    case 'backup_database': {
      const { DatabaseBackupService } = await import('../../../services/backup')
      const result = await DatabaseBackupService.getInstance().createFullBackup()
      if (!result.success) throw new Error(`备份失败：${result.message}`)
      return `已备份：${result.message}`
    }
  }
}

export function createBoxManageTool(): UnrealAgentTool<unknown> {
  return defineTool({
    name: 'box_manage',
    namespace: 'box',
    // 最坏情况。实际按动作算，见 riskFor
    risk: 'destructive',
    riskFor: (args): ToolRisk =>
      DESTRUCTIVE_ACTIONS.has(args.action) ? 'destructive' : 'mutating',
    concurrency: 'sequential',
    description:
      '管理虚幻盒子本身：开关技能、重连或删掉第三方 MCP 服务、续传或放弃卡住的素材导入、重新导入资产、备份盒子数据库。\n\n' +
      '【先看再动】target 用 box_status 拿到的名字或 id，别猜。\n' +
      '【不可逆的】abandon_import 会清掉服务端暂存，之后不能再续传；remove_mcp_server 会把那条配置删掉。' +
      '做之前跟用户说清楚。\n' +
      '恢复 / 删除备份、改盒子设置不在这里 —— 那些让用户在盒子界面里自己做。',
    input: manageInput,
    async execute(input) {
      return { text: await runManage(input.action, input.target) }
    }
  })
}

export function createBoxTools(): UnrealAgentTool<never>[] {
  return [
    createBoxSessionsTool(),
    createBoxStatusTool(),
    createBoxManageTool()
  ] as unknown as UnrealAgentTool<never>[]
}
