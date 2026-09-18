/**
 * @vitest-environment node
 *
 * 对外暴露的工具必须先过一遍「设置 → 工具」里那份关掉名单。
 *
 * `selectExposedTools` 只按命名空间和风险收窄，看不见这份名单。少了这一道，
 * 用户在设置页关掉整摊内容工具、以为「关掉的完全不给」了，外部客户端
 * （Claude Code / Cursor）照样能把资产删掉 —— 对外的口子比盒子自己还宽。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const settings = vi.hoisted(() => ({ agentDisabledTools: [] as string[] }))
vi.mock('electron', () => ({ app: { getPath: () => '/test-userdata' } }))
vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ ...settings }) }
}))

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import { withoutDisabledTools } from './index'

function tool(name: string, namespace: string): UnrealAgentTool<never> {
  return defineTool({
    name,
    namespace,
    risk: 'destructive',
    description: '测试工具',
    input: z.object({}),
    execute: async () => ({ text: 'ok' })
  }) as unknown as UnrealAgentTool<never>
}

const TOOLS = [
  tool('ue_content_delete', 'ue.content'),
  tool('ue_get_actor', 'ue.actor'),
  tool('ue_spawn_actor', 'ue.actor')
]

beforeEach(() => {
  settings.agentDisabledTools = []
})

describe('对外暴露前先按用户开关收窄', () => {
  it('一个都没关就原样给出去', async () => {
    expect(await withoutDisabledTools(TOOLS)).toBe(TOOLS)
  })

  it('用户关掉的不对外暴露', async () => {
    settings.agentDisabledTools = ['ue_content_delete']
    const exposed = await withoutDisabledTools(TOOLS)

    expect(exposed.map((entry) => entry.name)).toEqual(['ue_get_actor', 'ue_spawn_actor'])
  })

  it('名单里有没装上的工具名也不报错，只是没得可滤', async () => {
    settings.agentDisabledTools = ['tool_that_no_longer_exists']

    expect((await withoutDisabledTools(TOOLS)).map((entry) => entry.name)).toEqual(
      TOOLS.map((entry) => entry.name)
    )
  })
})
