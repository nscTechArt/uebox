import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import AskUserCard from './AskUserCard.vue'
import type { AgentQuestionItem } from '@core/shared/agentQuestion'
import zhCN from '@renderer/i18n/locales/zh-CN'

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })

function item(overrides: Partial<AgentQuestionItem> = {}): AgentQuestionItem {
  return {
    toolCallId: 'call-1',
    sessionId: 's1',
    questions: [
      {
        header: '用在哪',
        question: 'TTS 接上之后先给谁用？',
        multiSelect: false,
        options: [
          { label: '补适配层（推荐）', description: '只加能力位，不改现有行为' },
          { label: '顺带改音频概览', description: '改动面更大' }
        ]
      }
    ],
    ...overrides
  }
}

type Wrapper = ReturnType<typeof mount<typeof AskUserCard>>

function render(question: AgentQuestionItem): Wrapper {
  return mount(AskUserCard, {
    props: { question },
    global: { plugins: [i18n] }
  })
}

const optionButtons = (wrapper: Wrapper): ReturnType<Wrapper['findAll']> =>
  wrapper.findAll('button.ask-user-option')

describe('AskUserCard', () => {
  it('把每一问的标签、正文和选项都画出来', () => {
    const wrapper = render(item())

    expect(wrapper.text()).toContain('用在哪')
    expect(wrapper.text()).toContain('TTS 接上之后先给谁用？')
    expect(wrapper.text()).toContain('补适配层（推荐）')
    // 描述不能省 —— 「选了会发生什么」正是用户做决定要看的东西
    expect(wrapper.text()).toContain('只加能力位，不改现有行为')
  })

  it('选中一个之后提交，答案与提问同序', async () => {
    const wrapper = render(item())

    await optionButtons(wrapper)[0].trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['补适配层（推荐）']])
  })

  /** 单选再点一次要能退回「什么都没选」，否则选错了没法改回来 */
  it('单选时再点一次取消选中', async () => {
    const wrapper = render(item())

    await optionButtons(wrapper)[0].trigger('click')
    await optionButtons(wrapper)[0].trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['']])
  })

  it('单选时换一个选项，前一个自动取消', async () => {
    const wrapper = render(item())

    await optionButtons(wrapper)[0].trigger('click')
    await optionButtons(wrapper)[1].trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['顺带改音频概览']])
  })

  it('多选时能同时选中好几个', async () => {
    const multi = item()
    multi.questions[0].multiSelect = true
    const wrapper = render(multi)

    await optionButtons(wrapper)[0].trigger('click')
    await optionButtons(wrapper)[1].trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['补适配层（推荐）、顺带改音频概览']])
  })

  /**
   * 「其他」是恒定出口，不由模型放进选项里。
   *
   * 写进 schema 的话模型会忘了给，而选项列全了也不代表用户想要的就在里面。
   */
  it('「其他」里填的字直接当答案', async () => {
    const wrapper = render(item())

    await wrapper.find('input.ask-user-other-input').setValue('先只做朗读按钮')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['先只做朗读按钮']])
  })

  it('选项和「其他」可以同时给，拼在一起送出去', async () => {
    const wrapper = render(item())

    await optionButtons(wrapper)[0].trigger('click')
    await wrapper.find('input.ask-user-other-input').setValue('但别动音频概览')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['补适配层（推荐）、但别动音频概览']])
  })

  /** 「你自己定」不带答案 —— 主进程据此让模型带着假设继续 */
  it('点「你自己定」发 decline，不带答案', async () => {
    const wrapper = render(item())

    await wrapper.find('button.ghost').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['decline'])
  })

  /**
   * 答完之后卡片**留在原地**变只读。
   *
   * 消失的话，用户回头看不到自己当初选了什么 —— 而那正是他后来想确认
   * 「为什么做成这样」时唯一的凭据。
   */
  it('答过之后变成只读，显示选了什么', () => {
    const wrapper = render(item({ action: 'accept', answers: ['补适配层（推荐）'] }))

    expect(optionButtons(wrapper)).toHaveLength(0)
    expect(wrapper.find('button.primary').exists()).toBe(false)
    expect(wrapper.text()).toContain('补适配层（推荐）')
    expect(wrapper.text()).toContain('已回答')
  })

  it('只读态下没选的那一问明说没选，不留空白', () => {
    const wrapper = render(item({ action: 'accept', answers: [''] }))
    expect(wrapper.text()).toContain('这一问没选')
  })

  /** 被取消的（超时 / 停止 / 关掉）也要留痕，且不能再点 */
  it('被取消的卡片显示「没有回答」且不可点', () => {
    const wrapper = render(item({ action: 'cancel' }))

    expect(wrapper.text()).toContain('没有回答')
    expect(optionButtons(wrapper)).toHaveLength(0)
  })

  it('还没答时显示「等你回答」', () => {
    expect(render(item()).text()).toContain('等你回答')
  })
})

/**
 * 一次只画一问。
 *
 * 真机上第一次触发时模型一口气问了三问，九个选项加三个输入框铺满整屏 ——
 * 用户面对的是一堵墙而不是一个问题，而这个功能的全部意义就是让他快速定一件事。
 */
describe('AskUserCard —— 多问分步', () => {
  const multi = (): AgentQuestionItem =>
    item({
      questions: [
        {
          header: '游戏类型',
          question: '你想做哪种玩法的游戏？',
          multiSelect: false,
          options: [
            { label: '3D 探索/冒险', description: '主打探索感和氛围' },
            { label: '动作/战斗', description: '重点是手感和数值' }
          ]
        },
        {
          header: '做到哪一步',
          question: '这次想让我陪你做到哪一层？',
          multiSelect: false,
          options: [
            { label: '能玩的原型', description: '验证核心乐趣' },
            { label: '完整小成品', description: '工作量更大' }
          ]
        },
        {
          header: '你自己还是团队',
          question: '个人项目还是团队项目？',
          multiSelect: false,
          options: [
            { label: '一个人做', description: '控制在一个人扛得住的范畴' },
            { label: '有团队', description: '可以铺得更开' }
          ]
        }
      ]
    })

  it('一次只显示当前那一问，后面的不铺出来', () => {
    const wrapper = render(multi())

    expect(wrapper.text()).toContain('你想做哪种玩法的游戏？')
    expect(wrapper.text()).not.toContain('这次想让我陪你做到哪一层？')
    expect(wrapper.text()).not.toContain('个人项目还是团队项目？')
    // 三问共六个选项，屏幕上只该有当前这一问的两个
    expect(optionButtons(wrapper)).toHaveLength(2)
  })

  it('多问时显示进度', () => {
    expect(render(multi()).text()).toContain('1 / 3')
  })

  /** 只有一问还标个「1 / 1」是在制造不存在的步骤感 */
  it('只有一问时不显示进度', () => {
    expect(render(item()).text()).not.toContain('1 / 1')
  })

  it('走完三步一起提交，答案与提问同序', async () => {
    const wrapper = render(multi())

    // 单选选中即自动翻页，不需要再点一次「下一步」
    await optionButtons(wrapper)[0].trigger('click')
    expect(wrapper.text()).toContain('2 / 3')
    // 中间几步只是换页，不该产生 IPC 往返
    expect(wrapper.emitted('answer')).toBeUndefined()

    await optionButtons(wrapper)[1].trigger('click')
    expect(wrapper.text()).toContain('3 / 3')

    // 最后一问选中不自动提交，得显式点「提交」
    await optionButtons(wrapper)[0].trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual([
      'accept',
      ['3D 探索/冒险', '完整小成品', '一个人做']
    ])
  })

  /** 什么都不选直接点下一步 = 跳过这一问，不需要单独的跳过按钮 */
  it('不选直接下一步就是跳过这一问', async () => {
    const wrapper = render(multi())

    await wrapper.find('button.primary').trigger('click')
    await wrapper.find('button.primary').trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['accept', ['', '', '']])
  })

  it('第一问没有「上一步」，往后才有', async () => {
    const wrapper = render(multi())
    expect(wrapper.text()).not.toContain('上一步')

    await wrapper.find('button.primary').trigger('click')
    expect(wrapper.text()).toContain('上一步')
  })

  /** 退回去要看得见自己刚才选的是哪个，否则等于让人重选一遍 */
  it('退回上一问时保留已经选中的选项', async () => {
    const wrapper = render(multi())

    // 选中即自动翻页，这里不需要再点「下一步」
    await optionButtons(wrapper)[1].trigger('click')
    await wrapper.findAll('button.ghost')[1].trigger('click')

    expect(wrapper.text()).toContain('你想做哪种玩法的游戏？')
    expect(optionButtons(wrapper)[1].classes()).toContain('selected')
  })

  /** 中间几步选中就该直接翻页，不用再点一次「下一步」 */
  it('单选时选中自动进入下一问', async () => {
    const wrapper = render(multi())

    await optionButtons(wrapper)[0].trigger('click')

    expect(wrapper.text()).toContain('2 / 3')
    expect(wrapper.text()).toContain('这次想让我陪你做到哪一层？')
  })

  /** 提交是不可逆的一步，最后一问选中不该替用户点掉「提交」 */
  it('最后一问选中不自动提交', async () => {
    const wrapper = render(multi())

    await optionButtons(wrapper)[0].trigger('click')
    await optionButtons(wrapper)[0].trigger('click')
    await optionButtons(wrapper)[0].trigger('click')

    expect(wrapper.text()).toContain('3 / 3')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  /** 多选没有「选完」这个信号，选中不该替用户翻页 */
  it('多选时选中不自动翻页', async () => {
    const question = multi()
    question.questions[0].multiSelect = true
    const wrapper = render(question)

    await optionButtons(wrapper)[0].trigger('click')

    expect(wrapper.text()).toContain('你想做哪种玩法的游戏？')
    expect(wrapper.text()).not.toContain('2 / 3')
  })

  it('最后一问的按钮写「提交」，前面的写「下一步」', async () => {
    const wrapper = render(multi())
    expect(wrapper.find('button.primary').text()).toBe('下一步')

    await wrapper.find('button.primary').trigger('click')
    await wrapper.find('button.primary').trigger('click')

    expect(wrapper.find('button.primary').text()).toBe('提交')
  })

  /** 「你自己定」在任何一步都能点 —— 用户随时可以放弃整轮提问 */
  it('中途也能点「你自己定」', async () => {
    const wrapper = render(multi())

    await wrapper.find('button.primary').trigger('click')
    await wrapper.findAll('button.ghost')[0].trigger('click')

    expect(wrapper.emitted('answer')?.[0]).toEqual(['decline'])
  })
})
