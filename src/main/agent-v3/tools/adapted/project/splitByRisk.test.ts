/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { electronMock, servicesMock, targetContextMock } from '../../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../../services', () => servicesMock())
vi.mock('../../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import {
  READ_ACTIONS,
  WRITE_ACTIONS,
  createProjectListTool,
  createProjectWriteTool
} from './splitByRisk'

/**
 * 工程管理按风险拆成两个工具的约束。
 *
 * 注册表按**工具**声明 risk，而这七个动作从「列一份模板清单」到
 * 「往用户关卡里放 Actor」差了两个量级：
 *
 *   - 全标 mutating：默认的 auto-edit 模式静默放行，一句话就可能改了关卡
 *   - 全标 destructive：连列举都弹窗，用户很快学会无脑点确认，更危险
 */
describe('project 工具的动作划分', () => {
  it('两组动作不重叠', () => {
    const overlap = READ_ACTIONS.filter((a) => (WRITE_ACTIONS as readonly string[]).includes(a))
    expect(overlap).toEqual([])
  })

  it('底层七个动作一个不落', () => {
    expect([...READ_ACTIONS, ...WRITE_ACTIONS].sort()).toEqual(
      [
        'create_project',
        'import_assets',
        'import_assets_to_scene',
        'list_projects',
        'list_templates',
        'open_project',
        'setup_level_sequence'
      ].sort()
    )
  })

  // 只读组里不能混进任何会写的东西 —— 它是 safe，永远不会问用户
  it('只读组只有列举', () => {
    expect([...READ_ACTIONS].sort()).toEqual(['list_projects', 'list_templates'])
  })

  /**
   * 会碰用户工程或关卡的动作必须都在写组里。
   * 漏一个就意味着它挂在 safe 工具上，静默执行。
   */
  it.each([
    'create_project',
    'open_project',
    'import_assets',
    'import_assets_to_scene',
    'setup_level_sequence'
  ])('%s 属于写组', (action) => expect(WRITE_ACTIONS as readonly string[]).toContain(action))
})

/**
 * schema 常驻系统提示词，每一轮对话都付一次钱。
 *
 * 原先两个工具都直接继承底层那一份七动作的 schema，于是只读的 `project_list`
 * 背着 create_project / import_assets / setup_level_sequence 的全部参数 ——
 * 实测约 1,200 token，而它一个都调不到（execute 入口会挡掉）。
 */
describe('project_list 的 schema', () => {
  const schema = (createProjectListTool() as { inputSchema?: unknown }).inputSchema as z.ZodTypeAny
  const json = JSON.stringify(z.toJSONSchema(schema))

  it('只有 action 一个字段', () => {
    expect(Object.keys((schema as z.ZodObject).shape)).toEqual(['action'])
  })

  it('action 只接受两个只读动作', () => {
    expect(schema.safeParse({ action: 'list_templates' }).success).toBe(true)
    expect(schema.safeParse({ action: 'list_projects' }).success).toBe(true)
    expect(schema.safeParse({ action: 'create_project' }).success).toBe(false)
  })

  // 逐个点名：漏掉哪个参数没删干净，这里要能说出是哪个
  it.each([
    'templateName',
    'projectName',
    'targetDir',
    'engineVersion',
    'projectKey',
    'projectPath',
    'assetKeys',
    'folder',
    'destinationPath',
    'scenePlacement',
    'sequenceName',
    'actorAssetPath',
    'animationAssetPath',
    'spawnTransform'
  ])('不带写操作参数 %s', (field) => expect(json).not.toContain(field))

  // 写工具反过来必须留着全部字段，否则模型建不了工程
  it('project_manage 仍然带着全部写参数', () => {
    const write = (createProjectWriteTool() as { inputSchema?: unknown }).inputSchema
    const writeJson = JSON.stringify(z.toJSONSchema(write as z.ZodTypeAny))
    for (const field of ['templateName', 'assetKeys', 'spawnTransform']) {
      expect(writeJson).toContain(field)
    }
  })
})

/**
 * 真机上的一幕：用户说「打开」，模型回「我先看看本机装了哪些引擎……这样才能
 * 确定用什么引擎打开这个工程」，然后花 11 秒盘点了九个引擎。
 *
 * 它那句话是错的：open_project 就是 `shell.openPath(.uproject)`，用哪个引擎由
 * Windows 按 EngineAssociation 自己定，这个工具连引擎参数都没有。原描述里
 * open_project 只有「打开一个已有工程」六个字，模型只能按现实世界的直觉补 ——
 * 而现实世界里双击 .uproject 确实可能弹版本选择框。
 */
describe('open_project 的描述', () => {
  const description = String((createProjectWriteTool() as { description?: string }).description)

  it('明说打开工程不用先挑引擎', () => {
    expect(description).toContain('打开工程不用先挑引擎')
    expect(description).toContain('EngineAssociation')
  })

  // 点名 list_engines：泛泛说「别做多余的事」拦不住它，它得知道拦的是哪一步
  it('点名劝阻「先 list_engines 盘点一遍」', () => {
    expect(description).toContain('list_engines')
  })
})

/**
 * 2026-09-11：写工具的 action 枚举也必须只有写动作。
 *
 * 拆分原来只做了一半 —— `project_list` 换了窄 schema，`project_manage` 沿用底层
 * 那份七动作的，枚举里露着两个 list 而描述里又没讲，模型只能挑一个先试。
 * 运行时一直拒绝，所以这不是能力问题，是声明在骗人；更坏的是模型可能因此
 * 以为「列工程」该走这个 destructive 工具，一次只读操作平白弹一次审批框。
 */
describe('两个工具暴露给模型的 action 枚举', () => {
  const actionsOf = (tool: { inputSchema?: unknown }): string[] => {
    const shape = (tool.inputSchema as { shape?: { action?: { options?: string[] } } } | undefined)
      ?.shape
    return shape?.action?.options ?? []
  }

  it('project_manage 的枚举里没有 list 动作', () => {
    const actions = actionsOf(createProjectWriteTool() as { inputSchema?: unknown })

    expect(actions).not.toContain('list_templates')
    expect(actions).not.toContain('list_projects')
    expect(actions).toContain('create_project')
    expect(actions).toContain('import_assets')
  })

  it('project_list 的枚举里只有 list 动作', () => {
    const actions = actionsOf(createProjectListTool() as { inputSchema?: unknown })

    expect([...actions].sort()).toEqual(['list_projects', 'list_templates'])
  })

  /** 两个工具的并集仍是后端全集 —— 收窄的是入口，不是能力 */
  it('两边合起来还是七个动作，一个都没少', () => {
    const union = new Set([
      ...actionsOf(createProjectListTool() as { inputSchema?: unknown }),
      ...actionsOf(createProjectWriteTool() as { inputSchema?: unknown })
    ])

    expect(union.size).toBe(7)
  })
})
