import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import type { ExternalTeamSummary, TeamStateView } from '@core/shared/agentTeam'

const api = vi.hoisted(() => ({
  externalTeams: vi.fn(),
  teamState: vi.fn(),
  teamEnd: vi.fn(),
  teamTaskReopen: vi.fn(),
  teamJobReopen: vi.fn()
}))
vi.mock('@renderer/api/agentV3', () => ({ agentV3API: api }))
vi.mock('@renderer/api/aiProvider', () => ({
  aiProviderAPI: { getSettings: vi.fn(async () => ({ providers: [] })) }
}))

import ExternalTeams from './index.vue'

const TEAMS: ExternalTeamSummary[] = [
  {
    id: 'ext-2',
    objective: '做一个塔防',
    projectPath: 'D:/Games/TD',
    createdAt: 2_000,
    ended: false,
    verdict: 'pass',
    passed: true,
    members: 3
  },
  {
    id: 'ext-1',
    objective: '做一个跑酷',
    createdAt: 1_000,
    ended: true,
    verdict: null,
    passed: false,
    members: 1
  }
]

function state(objective: string): TeamStateView {
  return {
    objective,
    verdict: null,
    verdictStale: false,
    deliveries: 0,
    members: [],
    board: [],
    mail: [],
    external: true
  }
}

const BoardStub = {
  name: 'TeamBoardPanel',
  props: ['team', 'sessionId'],
  emits: ['end'],
  template: '<div class="board-stub">{{ team.objective }}</div>'
}

function mountPage(): ReturnType<typeof mount> {
  return mount(ExternalTeams, { global: { stubs: { TeamBoardPanel: BoardStub } } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  api.externalTeams.mockResolvedValue(TEAMS)
  api.teamState.mockImplementation(async (id: string) =>
    state(TEAMS.find((t) => t.id === id)!.objective)
  )
  api.teamEnd.mockResolvedValue({ success: true })
})

describe('外部团队页', () => {
  it('列出团队和状态，默认打开最新的那个的任务板', async () => {
    const wrapper = mountPage()
    await flushPromises()
    const items = wrapper.findAll('.team-item')
    expect(items.map((item) => item.find('.item-objective').text())).toEqual([
      '做一个塔防',
      '做一个跑酷'
    ])
    expect(items[0]!.text()).toContain('已过验收')
    expect(items[1]!.text()).toContain('已结束')
    expect(wrapper.find('.board-stub').text()).toBe('做一个塔防')
    expect(api.teamState).toHaveBeenLastCalledWith('ext-2')
  })

  it('点另一个团队就换任务板', async () => {
    const wrapper = mountPage()
    await flushPromises()
    await wrapper.findAll('.team-item')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.board-stub').text()).toBe('做一个跑酷')
  })

  it('结束：按团队 id 调，再重读列表', async () => {
    const wrapper = mountPage()
    await flushPromises()
    wrapper.findComponent(BoardStub).vm.$emit('end')
    await flushPromises()
    expect(api.teamEnd).toHaveBeenCalledWith('ext-2')
    expect(api.externalTeams).toHaveBeenCalledTimes(2)
  })

  it('一个都没有时说清怎么来', async () => {
    api.externalTeams.mockResolvedValue([])
    const wrapper = mountPage()
    await flushPromises()
    expect(wrapper.text()).toContain('uebox-team')
    expect(wrapper.find('.board-stub').exists()).toBe(false)
  })
})
