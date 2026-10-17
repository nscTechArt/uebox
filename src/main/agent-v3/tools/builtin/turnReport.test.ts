import { describe, expect, it } from 'vitest'

import { createUpdatePlanTool, planReminder } from './turnReport'

function step(...calls: { id: string; name: string }[]): {
  content: { type: string; id: string; name: string }[]
} {
  return {
    content: [{ type: 'text', id: '', name: '' }, ...calls.map((c) => ({ type: 'toolCall', ...c }))]
  }
}

async function planWith(statuses: ('pending' | 'in_progress' | 'completed')[]): Promise<object> {
  const tool = createUpdatePlanTool()
  await tool.execute('p', {
    items: statuses.map((status, i) => ({ content: `第${i + 1}步`, status }))
  })
  return tool
}

describe('planReminder', () => {
  it('清单没走完：挂在这一步最后一个调用上，点名当前那步', async () => {
    const tools = [await planWith(['completed', 'in_progress', 'pending'])]
    const message = step({ id: 'a', name: 'read_local_file' }, { id: 'b', name: 'team_message' })
    expect(planReminder(tools, message, 'a')).toBeUndefined()
    expect(planReminder(tools, message, 'b')).toContain('第 2/3 步「第2步」')
  })

  it('这一步自己调了 update_plan 就不挂', async () => {
    const tools = [await planWith(['in_progress', 'pending'])]
    const message = step({ id: 'a', name: 'update_plan' }, { id: 'b', name: 'read_local_file' })
    expect(planReminder(tools, message, 'b')).toBeUndefined()
  })

  it('没建清单、或者全打完勾，都不挂', async () => {
    const message = step({ id: 'a', name: 'read_local_file' })
    expect(planReminder([createUpdatePlanTool()], message, 'a')).toBeUndefined()
    expect(planReminder([await planWith(['completed', 'completed'])], message, 'a')).toBeUndefined()
    expect(planReminder([], message, 'a')).toBeUndefined()
  })
})
