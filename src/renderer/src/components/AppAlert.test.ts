import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppAlert from './AppAlert.vue'
import AppProgress from './AppProgress.vue'
import AppCard from './AppCard.vue'

describe('AppAlert', () => {
  it('按档位给 class，默认 info', () => {
    expect(mount(AppAlert).classes()).toContain('app-alert--info')
    expect(mount(AppAlert, { props: { type: 'error' } }).classes()).toContain('app-alert--error')
  })

  /**
   * 出错要打断当前朗读，成功等这句念完 ——
   * 都用 alert 的话，一句「已保存」会把用户正在听的内容截断。
   */
  it('错误/警告用 role=alert，提示/成功用 role=status', () => {
    expect(mount(AppAlert, { props: { type: 'error' } }).attributes('role')).toBe('alert')
    expect(mount(AppAlert, { props: { type: 'warning' } }).attributes('role')).toBe('alert')
    expect(mount(AppAlert, { props: { type: 'info' } }).attributes('role')).toBe('status')
    expect(mount(AppAlert, { props: { type: 'success' } }).attributes('role')).toBe('status')
  })

  // 只靠颜色的话，红绿色觉障碍用户看到的「出错」和「成功」是同一个东西
  it('show-icon 时每档画自己的图标，不是同一个', () => {
    const err = mount(AppAlert, { props: { type: 'error', showIcon: true } })
    const ok = mount(AppAlert, { props: { type: 'success', showIcon: true } })

    expect(err.find('.app-alert__icon').exists()).toBe(true)
    expect(err.get('.app-alert__icon').html()).not.toBe(ok.get('.app-alert__icon').html())
  })

  it('message / description 渲染出来；没有 description 就不留空行', () => {
    const withDesc = mount(AppAlert, { props: { message: '连不上', description: '检查网络' } })
    expect(withDesc.get('.app-alert__message').text()).toBe('连不上')
    expect(withDesc.get('.app-alert__description').text()).toBe('检查网络')

    const bare = mount(AppAlert, { props: { message: '连不上' } })
    expect(bare.find('.app-alert__description').exists()).toBe(false)
  })

  it('closable 才有关闭叉，点了发 close', async () => {
    expect(mount(AppAlert).find('.app-alert__close').exists()).toBe(false)

    const wrapper = mount(AppAlert, {
      props: { closable: true },
      global: { mocks: { $t: () => '关闭' } }
    })
    await wrapper.get('.app-alert__close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('AppProgress', () => {
  // 不带 aria 的话读屏软件只念到一个空 div，用户不知道传到哪了
  it('带 progressbar 语义和当前进度', () => {
    const wrapper = mount(AppProgress, { props: { percent: 42 } })

    expect(wrapper.attributes('role')).toBe('progressbar')
    expect(wrapper.attributes('aria-valuenow')).toBe('42')
    expect(wrapper.attributes('aria-valuemin')).toBe('0')
    expect(wrapper.attributes('aria-valuemax')).toBe('100')
  })

  it('超出 0–100 的值夹回范围内，小数取整', () => {
    expect(mount(AppProgress, { props: { percent: 150 } }).attributes('aria-valuenow')).toBe('100')
    expect(mount(AppProgress, { props: { percent: -20 } }).attributes('aria-valuenow')).toBe('0')
    expect(mount(AppProgress, { props: { percent: 33.7 } }).attributes('aria-valuenow')).toBe('34')
  })

  it('线形按百分比给宽度', () => {
    const wrapper = mount(AppProgress, { props: { percent: 60 } })
    expect(wrapper.get('.app-progress__fill').attributes('style')).toContain('width: 60%')
  })

  it('环形画 svg，并按百分比算 dashoffset', () => {
    const wrapper = mount(AppProgress, { props: { type: 'circle', percent: 100 } })

    expect(wrapper.find('.app-progress__circle').exists()).toBe(true)
    // 满进度时偏移为 0，圆环闭合
    expect(Number(wrapper.get('.app-progress__circle-fill').attributes('stroke-dashoffset'))).toBe(
      0
    )
  })

  // 数字已经在 aria-valuenow 里，念两遍是噪音
  it('百分比文字对读屏软件隐藏；show-info=false 时不渲染', () => {
    expect(mount(AppProgress).get('.app-progress__info').attributes('aria-hidden')).toBe('true')
    expect(
      mount(AppProgress, { props: { showInfo: false } })
        .find('.app-progress__info')
        .exists()
    ).toBe(false)
  })
})

describe('AppCard', () => {
  /**
   * a-card 的 hoverable 只是加投影，仍然是 div —— 键盘 Tab 到不了。
   * 而那几处卡片是可以点的，所以这里必须是真按钮。
   */
  it('hoverable 时渲染成按钮，否则是 div', () => {
    expect(mount(AppCard, { props: { hoverable: true } }).element.tagName).toBe('BUTTON')
    expect(mount(AppCard).element.tagName).toBe('DIV')
  })

  it('有标题才画标题栏', () => {
    expect(
      mount(AppCard, { props: { title: '上传' } })
        .get('.app-card__header')
        .text()
    ).toBe('上传')
    expect(mount(AppCard).find('.app-card__header').exists()).toBe(false)
  })

  it('#cover 插槽才画封面区', () => {
    expect(mount(AppCard).find('.app-card__cover').exists()).toBe(false)
    expect(
      mount(AppCard, { slots: { cover: '<img src="x" />' } })
        .find('.app-card__cover')
        .exists()
    ).toBe(true)
  })
})
