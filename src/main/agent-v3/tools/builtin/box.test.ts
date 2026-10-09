/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 操作盒子本身的三个工具。外部 MCP 客户端靠它们看见盒子，所以守的是：
 * 读的真只读、写的按动作报对风险、target 没给或给错时不去猜、
 * 一块状态读不出来不连累别的块。
 */

const transcripts = vi.hoisted(() => ({
  listTranscripts: vi.fn(),
  loadTranscript: vi.fn()
}))
const skills = vi.hoisted(() => ({
  discoverSkillsOnDisk: vi.fn(),
  readDisabledSkills: vi.fn(),
  setSkillDisabled: vi.fn(),
  listSkillSummaries: vi.fn()
}))
const mcpStore = vi.hoisted(() => ({ readMcpSettings: vi.fn(), removeMcpServer: vi.fn() }))
const mcpIndex = vi.hoisted(() => ({ currentStatuses: vi.fn(), reconnectMcp: vi.fn() }))
const resume = vi.hoisted(() => ({ resumeImport: vi.fn(), abandonImport: vi.fn() }))
const detector = vi.hoisted(() => ({ getRunningProjects: vi.fn() }))

vi.mock('../../core/transcriptStore', () => transcripts)
vi.mock('../../capabilities/skills', () => skills)
vi.mock('../../capabilities/mcp/store', () => mcpStore)
vi.mock('../../capabilities/mcp/index', () => mcpIndex)
vi.mock('../../../services/asset/ResumeImportService', () => resume)
vi.mock('../../../utils/UnrealProcessDetector', () => ({ default: detector }))

const {
  createBoxManageTool,
  createBoxSessionsTool,
  createBoxStatusTool,
  renderMessage,
  takeRecent
} = await import('./box')

async function text(
  tool: { execute: (id: string, args: unknown) => Promise<{ content: unknown }> },
  args: unknown
): Promise<string> {
  const result = await tool.execute('call-1', args)
  return (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('box_sessions', () => {
  const tool = createBoxSessionsTool()

  it('只读', () => {
    expect(tool.unrealBox.risk).toBe('safe')
    expect(tool.unrealBox.namespace).toBe('box')
  })

  it('列表拿第一句用户话当标题，子任务和队员的会话不列', async () => {
    transcripts.listTranscripts.mockResolvedValue([
      { sessionId: 's1', modifiedAt: 0, messageCount: 4, createdAt: 0 },
      { sessionId: 's1:sub-1', modifiedAt: 0, messageCount: 2, createdAt: 0 },
      { sessionId: 's1:mate-art', modifiedAt: 0, messageCount: 2, createdAt: 0 }
    ])
    transcripts.loadTranscript.mockResolvedValue([
      { role: 'user', content: [{ type: 'text', text: '把门做成能开的' }] }
    ])

    const out = await text(tool, { action: 'list' })

    expect(out).toContain('s1｜')
    expect(out).toContain('把门做成能开的')
    expect(out).not.toContain(':sub-')
    expect(out).not.toContain(':mate-')
  })

  it('read 不给 session_id 就打回，不去猜', async () => {
    await expect(tool.execute('c', { action: 'read' })).rejects.toThrow('session_id')
  })

  it('read 带出对话正文和调了哪些工具', async () => {
    transcripts.loadTranscript.mockResolvedValue([
      { role: 'user', content: '开门' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先看看蓝图' },
          { type: 'toolCall', name: 'ue_blueprint_describe', arguments: {} }
        ]
      },
      { role: 'toolResult', toolName: 'ue_blueprint_describe', content: '有 3 个节点' }
    ])

    const out = await text(tool, { action: 'read', session_id: 's1' })

    expect(out).toContain('【用户】开门')
    expect(out).toContain('ue_blueprint_describe')
    expect(out).toContain('有 3 个节点')
  })

  it('对话不存在：说清楚，并指去 list', async () => {
    transcripts.loadTranscript.mockResolvedValue([])
    await expect(tool.execute('c', { action: 'read', session_id: 'nope' })).rejects.toThrow(
      /没有找到对话.*list/
    )
  })
})

describe('读对话的裁剪', () => {
  it('超长时留最近的，并报省略了多少段', () => {
    const { kept, dropped } = takeRecent(['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)], 110)
    expect(kept).toEqual(['b'.repeat(50), 'c'.repeat(50)])
    expect(dropped).toBe(1)
  })

  it('最后一段本身就超长也至少留下它', () => {
    const { kept } = takeRecent(['x'.repeat(500)], 10)
    expect(kept).toHaveLength(1)
  })

  it('工具结果只留开头，失败的标出来', () => {
    const out = renderMessage({
      role: 'toolResult',
      toolName: 'ue_x',
      isError: true,
      content: '错'.repeat(1000)
    })!
    expect(out).toContain('ue_x 失败')
    expect(out.length).toBeLessThan(400)
  })

  it('用户消息剥掉信封等机器块，音视频引用（带本机路径）不交出去', () => {
    const out = renderMessage({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<runtime-status scope="rt-1">\nnow: 2026-10-01\n</runtime-status>\n\n把灯调暗'
        },
        {
          type: 'text',
          text: '[[uebox-media {"kind":"video","key":"k","fileName":"a.mp4","filePath":"C:\\\\a.mp4"}]]'
        }
      ]
    })
    expect(out).toBe('【用户】把灯调暗')
  })
})

describe('box_status', () => {
  const tool = createBoxStatusTool()

  it('只读', () => {
    expect(tool.unrealBox.risk).toBe('safe')
  })

  it('一块读不出来不连累别的块', async () => {
    detector.getRunningProjects.mockRejectedValue(new Error('tasklist 挂了'))
    mcpStore.readMcpSettings.mockResolvedValue({ version: 1, mcpServers: { fs: {}, gh: {} } })
    mcpIndex.currentStatuses.mockReturnValue([
      { id: 'fs', connected: true, toolCount: 5 },
      { id: 'gh', connected: false, toolCount: 0, error: 'token 失效' }
    ])

    const out = await text(tool, { sections: ['editors', 'mcp'] })

    expect(out).toContain('读不出来：tasklist 挂了')
    expect(out).toContain('fs｜已连接，5 个工具')
    expect(out).toContain('gh｜连不上：token 失效')
  })

  it('只看点名的那几块', async () => {
    skills.discoverSkillsOnDisk.mockResolvedValue([])
    skills.readDisabledSkills.mockResolvedValue(new Set())
    skills.listSkillSummaries.mockReturnValue([
      { name: 'asset-library', enabled: false, source: 'builtin', description: '素材库' }
    ])

    const out = await text(tool, { sections: ['skills'] })

    expect(out).toContain('asset-library｜关')
    expect(out).not.toContain('## 虚幻编辑器')
  })
})

describe('box_manage', () => {
  const tool = createBoxManageTool()

  it('按动作报风险：放弃导入、删 MCP 是破坏性的，其余是普通改动', () => {
    const riskFor = tool.unrealBox.riskFor!
    expect(tool.unrealBox.risk).toBe('destructive')
    expect(riskFor({ action: 'abandon_import', target: 't' })).toBe('destructive')
    expect(riskFor({ action: 'remove_mcp_server', target: 'fs' })).toBe('destructive')
    expect(riskFor({ action: 'disable_skill', target: 'x' })).toBe('mutating')
    expect(riskFor({ action: 'backup_database' })).toBe('mutating')
  })

  it('不给 target 就打回，并指去 box_status', async () => {
    await expect(tool.execute('c', { action: 'disable_skill' })).rejects.toThrow('box_status')
  })

  it('技能名对不上：不写盘，列出现有的', async () => {
    skills.discoverSkillsOnDisk.mockResolvedValue([{ name: 'asset-library' }])

    await expect(tool.execute('c', { action: 'disable_skill', target: 'nope' })).rejects.toThrow(
      'asset-library'
    )
    expect(skills.setSkillDisabled).not.toHaveBeenCalled()
  })

  it('关技能', async () => {
    skills.discoverSkillsOnDisk.mockResolvedValue([{ name: 'asset-library' }])

    const out = await text(tool, { action: 'disable_skill', target: 'asset-library' })

    expect(skills.setSkillDisabled).toHaveBeenCalledWith('asset-library', true)
    expect(out).toContain('下一轮')
  })

  it('删 MCP 之后重连，并提醒外部客户端要重连盒子', async () => {
    mcpStore.removeMcpServer.mockResolvedValue(true)
    mcpIndex.reconnectMcp.mockResolvedValue([])

    const out = await text(tool, { action: 'remove_mcp_server', target: 'fs' })

    expect(mcpIndex.reconnectMcp).toHaveBeenCalled()
    expect(out).toContain('重新连接')
  })

  it('放弃导入：服务端没确认清掉暂存，就不说清掉了', async () => {
    resume.abandonImport.mockResolvedValue({
      success: true,
      stagingCleared: false,
      locallyDismissed: true
    })

    const out = await text(tool, { action: 'abandon_import', target: 'task-1' })

    expect(resume.abandonImport).toHaveBeenCalledWith({ taskId: 'task-1' })
    expect(out).toContain('没确认清掉')
  })

  it('续传失败时如实报错', async () => {
    resume.resumeImport.mockResolvedValue({
      success: false,
      status: 'expired',
      uploadedFiles: 0,
      uploadedThumbnails: 0,
      committed: false,
      error: '会话已过期'
    })

    await expect(tool.execute('c', { action: 'resume_import', target: 't' })).rejects.toThrow(
      '会话已过期'
    )
  })
})
