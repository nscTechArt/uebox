import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AgentStepGroup from './AgentStepGroup.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'
import type { StepPart } from './agentSteps'

/**
 * 两段正文之间的那一组步骤。
 *
 * 默认只有一行灰字；点开是一列「动作 · 对象 — 结果」，再点开一行才是参数和返回原文。
 * 产出的图不跟着收起来，失败只标一个小点。
 */

vi.mock('@renderer/services/imageViewer', () => ({
  openImageViewer: vi.fn()
}))

function call(name: string, args: unknown, timestamp: number, id: string): AgentProcessItem {
  return {
    type: 'tool-call',
    data: { id, function: { name, arguments: JSON.stringify(args) } },
    timestamp
  }
}

function result(name: string, value: unknown, timestamp: number, id: string): AgentProcessItem {
  return { type: 'tool-result', data: { toolName: name, toolCallId: id, result: value }, timestamp }
}

function mountGroup(
  parts: StepPart[],
  props: Record<string, unknown> = {}
): ReturnType<typeof mount> {
  return mount(AgentStepGroup, {
    props: { parts, ...props },
    global: { stubs: { MarkdownRenderer: true, FileChangeCard: true } }
  })
}

const searchTwice: StepPart[] = [
  { kind: 'thinking', key: 't1', text: '先看看资产库', at: 1000 },
  {
    kind: 'process',
    key: 'p1',
    items: [
      call('search_assets', { folder: '/Game/Blueprints' }, 1000, 'a'),
      result('search_assets', { success: false, error: '没有这个文件夹' }, 1200, 'a'),
      call('library_overview', { vault: 'AI' }, 1300, 'b'),
      result('library_overview', { success: true, message: '共 823 个资产' }, 1500, 'b'),
      call('search_assets', { query: 'CBP' }, 1600, 'c'),
      result('search_assets', { success: true, count: 12 }, 2200, 'c')
    ]
  }
]

describe('AgentStepGroup', () => {
  it('默认只有一行摘要：做了哪几种事、几次、出错几次、用了多久', () => {
    const wrapper = mountGroup(searchTwice)

    expect(wrapper.find('.step-rows').exists()).toBe(false)
    expect(wrapper.find('.step-summary-text').text()).toBe('搜索资产 ×2、资产库概况')
    expect(wrapper.findAll('.step-stat').map((node) => node.text())).toEqual(['出错 1 次', '1.2s'])
  })

  it('只有推理时摘要就叫「思考过程」', () => {
    const wrapper = mountGroup([{ kind: 'thinking', key: 't', text: '想一想' }])
    expect(wrapper.find('.step-summary-text').text()).toBe('思考过程')
  })

  // 再套一行「思考过程」等于让人点两次看同一个东西
  it('只有推理的组点开就是正文，不再有一行「思考过程」', async () => {
    const wrapper = mountGroup([{ kind: 'thinking', key: 't', text: '想一想' }])
    await wrapper.find('.step-summary').trigger('click')

    expect(wrapper.find('.step-row-head').exists()).toBe(false)
    expect(wrapper.find('.step-thinking').exists()).toBe(true)
  })

  // 一列里隔一行就是一样的四个字，什么也没说
  it('推理那一行后面带着它的第一句，点开后收掉', async () => {
    const wrapper = mountGroup([
      { kind: 'thinking', key: 't', text: '## 先看目录\n\n- **再**决定改名方式' },
      { kind: 'process', key: 'p', items: [call('list_local_dir', { path: 'I:/a' }, 1, 'a')] }
    ])
    await wrapper.find('.step-summary').trigger('click')

    expect(wrapper.find('.step-preview').text()).toBe('先看目录')
    await wrapper.find('.step-row-head').trigger('click')
    expect(wrapper.find('.step-preview').exists()).toBe(false)
  })

  it('点开是一列步骤，推理和工具按顺序排', async () => {
    const wrapper = mountGroup(searchTwice)
    await wrapper.find('.step-summary').trigger('click')

    const rows = wrapper.findAll('.step-row-head').map((node) => node.text())
    expect(rows).toEqual([
      '思考过程先看看资产库',
      '搜索资产/Game/Blueprints— 没有这个文件夹',
      '资产库概况AI',
      '搜索资产CBP— 共 12 项'
    ])
  })

  // 中途试错又自己改过来的事，不值得一块警告色
  it('失败的一步只标一个小点', async () => {
    const wrapper = mountGroup(searchTwice)
    await wrapper.find('.step-summary').trigger('click')

    expect(wrapper.findAll('.step-dot')).toHaveLength(1)
    expect(wrapper.find('.step-row.is-failed .step-dot').exists()).toBe(true)
  })

  // 写给模型的原文不上行，要排查时点开那一步才看
  it('再点开一步才看到参数和返回原文', async () => {
    const wrapper = mountGroup(searchTwice)
    await wrapper.find('.step-summary').trigger('click')
    expect(wrapper.find('.step-raw').exists()).toBe(false)

    await wrapper.findAll('.step-row-head')[2].trigger('click')
    const raw = wrapper.find('.step-raw').text()
    expect(raw).toContain('"vault": "AI"')
    expect(raw).toContain('共 823 个资产')
  })

  it('正在跑时这一行说它此刻在干什么', () => {
    const wrapper = mountGroup(
      [
        {
          kind: 'process',
          key: 'p',
          items: [call('list_local_dir', { path: 'I:/assets' }, 1, 'a')]
        }
      ],
      { live: true, startTime: 1 }
    )
    expect(wrapper.find('.step-live').text()).toBe('查看目录 I:/assets')
  })

  it('最后一段是推理时说正在思考', () => {
    const wrapper = mountGroup([{ kind: 'thinking', key: 't', text: '嗯' }], { live: true })
    expect(wrapper.find('.step-live').text()).toBe('正在思考')
  })

  // 生图的图是交付物，收起过程也要看得见；截图是它自己看的，收在那一步里
  it('产出的图默认就铺开，看过的图点开这一组就在那一步下面，不带返回原文', async () => {
    const wrapper = mountGroup([
      {
        kind: 'process',
        key: 'p',
        items: [
          call('generate_image', { prompt: '拱门' }, 1, 'g'),
          result('generate_image', { success: true, image_paths: ['C:/out/a.png'] }, 2, 'g'),
          call('ue_screenshot', {}, 3, 's'),
          result('ue_screenshot', { success: true, screenshot_path: 'C:/shots/1.png' }, 4, 's')
        ]
      }
    ])

    expect(wrapper.findAll('img')).toHaveLength(1)
    expect(wrapper.findAll('.step-stat').map((node) => node.text())).toContain('查看了 1 张图片')

    await wrapper.find('.step-summary').trigger('click')
    expect(wrapper.findAll('img')).toHaveLength(2)
    // 截图那一行不是按钮，也没有参数和返回原文
    expect(wrapper.findAll('button.step-row-head')).toHaveLength(1)
    expect(wrapper.find('.step-raw').exists()).toBe(false)
  })

  it('超过 4 张只铺 4 张，最后一张叠上剩下的数', () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `C:/out/${name}.png`)
    const wrapper = mountGroup([
      {
        kind: 'process',
        key: 'p',
        items: [result('generate_image', { success: true, image_paths: paths }, 1, 'g')]
      }
    ])

    expect(wrapper.findAll('.step-thumb')).toHaveLength(4)
    expect(wrapper.find('.step-more').text()).toBe('+2')
  })

  it('没回结果的那一步在转圈', async () => {
    const wrapper = mountGroup(
      [{ kind: 'process', key: 'p', items: [call('ue_screenshot', {}, 1, 'a')] }],
      { live: true }
    )
    await wrapper.find('.step-summary').trigger('click')
    expect(wrapper.find('.step-row.is-running .step-spin').exists()).toBe(true)
  })

  /** 真机截图：点开一路子任务只有派出去的任务书，它这十分钟干了什么一概看不到 */
  it('点开一路子任务先看到它走过的每一步，任务书再收一层', async () => {
    const progress = (message: string, timestamp: number): AgentProcessItem => ({
      type: 'notify-users',
      data: { message, notifyType: 'progress', toolCallId: 'sub', toolName: 'task' },
      timestamp
    })
    const wrapper = mountGroup(
      [
        {
          kind: 'process',
          key: 'p1',
          items: [
            call('task', { prompt: '新建追逐序列\n只做车辆，不动灯光' }, 1000, 'sub'),
            progress('子任务：先回读当前关卡里的车辆', 1100),
            progress('子任务：调用 ue_get_actor BP_NightTrafficCar_5', 1200)
          ]
        }
      ],
      { live: true }
    )
    await wrapper.find('.step-summary').trigger('click')
    await wrapper.find('.step-row-head').trigger('click')

    const steps = wrapper.findAll('.lane-step').map((step) => step.text())
    expect(steps).toHaveLength(2)
    expect(steps[0]).toBe('先回读当前关卡里的车辆')
    expect(steps[1]).toContain('BP_NightTrafficCar_5')
    expect(wrapper.text()).not.toContain('只做车辆，不动灯光')
  })
})
