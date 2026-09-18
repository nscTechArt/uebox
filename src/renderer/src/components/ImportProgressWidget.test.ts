import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ImportProgressWidget from './ImportProgressWidget.vue'

const translations: Record<string, string> = {
  'importProgressWidget.title': '后台导入任务 ({count})',
  'importProgressWidget.inProgress': '进行中...',
  'importProgressWidget.cancel': '中止导入',
  'importProgressWidget.detecting': '检测中',
  'importProgressWidget.dismiss': '知道了，收起',
  'importProgressWidget.viewDetail': '查看详情',
  'importProgressWidget.titleFailed': '导入没导全 ({count})'
}

const $t = (key: string, params?: Record<string, unknown>): string => {
  const template = translations[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
}

type TaskProp = InstanceType<typeof ImportProgressWidget>['$props']['tasks'][number]

const makeTask = (overrides: Partial<TaskProp> = {}): TaskProp =>
  ({
    id: 't1',
    name: '导入 500 个资产',
    progress: 40,
    stageText: '正在导入 210/500',
    status: 'running',
    ...overrides
  }) as TaskProp

const mountWidget = (tasks: TaskProp[]): ReturnType<typeof mount> =>
  mount(ImportProgressWidget, {
    props: { tasks },
    global: { mocks: { $t } }
  })

describe('ImportProgressWidget', () => {
  it('没有任务时整个不渲染，不在界面上留一个空壳', () => {
    expect(mountWidget([]).find('.import-progress-widget').exists()).toBe(false)
  })

  it('每个任务四行各管一件事：名字、去向、进度条、状态', () => {
    const wrapper = mountWidget([
      makeTask({ taskType: 'project-import', projectName: 'BIKEOUT', progress: 42 })
    ])

    expect(wrapper.get('.task-name').text()).toBe('导入 500 个资产')
    expect(wrapper.get('.task-percent').text()).toBe('42%')
    expect(wrapper.get('.meta-target').text()).toBe('BIKEOUT')
    expect(wrapper.get('.task-stage').text()).toBe('正在导入 210/500')
    // 进度条是 AppProgress，带 role=progressbar，读屏软件念得出来
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42')
  })

  it('资产库导入报目标文件夹，工程导入报工程名', () => {
    const vault = mountWidget([makeTask({ taskType: 'vault-import', folderName: '树木' })])
    expect(vault.get('.meta-target').text()).toBe('树木')

    const project = mountWidget([makeTask({ taskType: 'project-import', projectName: 'TQYS' })])
    expect(project.get('.meta-target').text()).toBe('TQYS')
  })

  it('没有去向也没有徽标时不留一条空的 meta 行', () => {
    const wrapper = mountWidget([makeTask({})])
    expect(wrapper.find('.task-meta').exists()).toBe(false)
  })

  it('只有能叫停的任务才给中止按钮，点它冒出 cancel 而不是导航', () => {
    const plain = mountWidget([makeTask()])
    expect(plain.find('.cancel-button').exists()).toBe(false)

    const wrapper = mountWidget([makeTask({ cancellable: true, folderKey: 'folder_a' })])
    wrapper.get('.cancel-button').trigger('click')

    expect(wrapper.emitted('cancel')?.[0]).toEqual(['t1'])
    // @click.stop：中止不该顺带把人跳走
    expect(wrapper.emitted('navigate')).toBeUndefined()
  })

  it('点卡片跳到任务所在文件夹；没有 folderKey 就不给点', () => {
    const wrapper = mountWidget([makeTask({ folderKey: 'folder_a' })])
    wrapper.get('.task-item').trigger('click')
    expect(wrapper.emitted('navigate')?.[0]).toEqual(['folder_a'])

    const noFolder = mountWidget([makeTask()])
    noFolder.get('.task-item').trigger('click')
    expect(noFolder.emitted('navigate')).toBeUndefined()
    expect(noFolder.get('.task-item').classes()).not.toContain('clickable')
  })

  it('折叠只收起列表，标题栏还在 —— 收起来了也得知道有活在跑', async () => {
    const wrapper = mountWidget([makeTask()])
    expect(wrapper.get('.widget-header').attributes('aria-expanded')).toBe('true')

    await wrapper.get('.widget-header').trigger('click')

    expect(wrapper.get('.widget-header').attributes('aria-expanded')).toBe('false')
    // v-show 收起来的是内联 display，节点还在
    expect(wrapper.get('.task-list').attributes('style')).toContain('display: none')
    expect(wrapper.get('.widget-header').text()).toContain('后台导入任务 (1)')
  })

  it('出错的任务用异常态标出来，不能和正常跑的长一样', () => {
    const wrapper = mountWidget([makeTask({ status: 'error' })])
    expect(wrapper.get('.task-percent').classes()).toContain('is-error')
    expect(wrapper.get('[role="progressbar"]').classes()).toContain('app-progress--exception')
  })

  it('检测中的模式徽标走译文，不显示原始枚举值', () => {
    const wrapper = mountWidget([makeTask({ importMode: 'detecting' })])
    expect(wrapper.get('.mode-badge').text()).toBe('检测中')

    const v2 = mountWidget([makeTask({ importMode: 'v2-session' })])
    expect(v2.get('.mode-badge').text()).toBe('V2')
  })

  it('失败的任务要给得着的下一层：查看详情 + 自己关掉', async () => {
    // 没有这两个入口的时候，用户拿到的最深信息就是一句「导入完成，N 条警告」——
    // 缺什么、该干什么一概不知道
    const wrapper = mountWidget([
      makeTask({
        status: 'error',
        // cancellable 必须给 true：真实的失败任务就是带着它的
        //（ImportToProjectModal 建任务时设的，转 error 时没人清掉）。
        // 不给的话第一个 v-if 光凭 cancellable 就挂了，这条断言测不出
        // 「error 时不该显示中止」这件事
        cancellable: true,
        report: {
          planErrors: [],
          missingDependencies: [
            {
              softPath: '/Game/Textures/T_Wood',
              name: 'T_Wood',
              state: 'not-in-vault',
              affectedCount: 32,
              affectedSample: ['A_Run']
            }
          ],
          fileFailures: [],
          conflicts: [],
          unconfirmed: [],
          orphanFileFailures: 0,
          unattributedMissing: 0,
          truncated: {
            planErrors: 0,
            missingDependencies: 0,
            fileFailures: 0,
            conflicts: 0,
            unconfirmed: 0
          }
        }
      })
    ])

    await wrapper.get('.detail-button').trigger('click')
    expect(wrapper.emitted('inspect')?.[0]).toEqual(['t1'])

    // 失败的任务不该再给「中止」——没什么可停的了，但这条得留到用户看过为止
    await wrapper.get('.cancel-button').trigger('click')
    expect(wrapper.emitted('dismiss')?.[0]).toEqual(['t1'])
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })

  it('全是失败任务时标题和图标都改口 —— 什么都没在跑就别转圈', () => {
    const failed = mountWidget([makeTask({ status: 'error' })])
    expect(failed.get('.loading-icon').classes()).not.toContain('spinning')
    expect(failed.get('.title').text()).toBe('导入没导全 (1)')

    // 只要还有一条在跑，就还是「进行中」的样子
    const mixed = mountWidget([makeTask({ id: 'a', status: 'error' }), makeTask({ id: 'b' })])
    expect(mixed.get('.loading-icon').classes()).toContain('spinning')
    expect(mixed.get('.title').text()).toBe('后台导入任务 (2)')
  })

  it('还在跑的任务没有「查看详情」—— 那会引人去点一个还不存在的结论', () => {
    const wrapper = mountWidget([makeTask({ status: 'running', cancellable: true })])
    expect(wrapper.find('.detail-button').exists()).toBe(false)
    expect(wrapper.find('.cancel-button').exists()).toBe(true)
  })
})
