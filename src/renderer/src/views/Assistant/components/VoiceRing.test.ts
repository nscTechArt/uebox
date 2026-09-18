import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VoiceRing from './VoiceRing.vue'
import { shapeVoiceLevel, voiceRingVisual } from './voiceRing'

describe('shapeVoiceLevel', () => {
  it('静音和底噪都算 0 —— 没人说话时圆环不许抖', () => {
    expect(shapeVoiceLevel(0)).toBe(0)
    expect(shapeVoiceLevel(0.02)).toBe(0)
    expect(shapeVoiceLevel(0.04)).toBe(0)
  })

  it('把常见语速的响度抬到看得见的幅度', () => {
    // 原始 0.16 直接用只有 16% 的动静，开方后接近一半
    expect(shapeVoiceLevel(0.16)).toBeCloseTo(0.4, 5)
    expect(shapeVoiceLevel(1)).toBe(1)
  })

  it('超范围和脏数据都夹回 0–1', () => {
    expect(shapeVoiceLevel(4)).toBe(1)
    expect(shapeVoiceLevel(Number.NaN)).toBe(0)
    expect(shapeVoiceLevel(-1)).toBe(0)
  })
})

describe('voiceRingVisual', () => {
  it('会话没开就没有圆环，而不是画一个透明的', () => {
    expect(voiceRingVisual('idle', 0.5)).toBeNull()
  })

  it('稳定态用整圈，进行中留缺口', () => {
    expect(voiceRingVisual('listening', 0)?.arc).toBe(1)
    expect(voiceRingVisual('speaking', 0)?.arc).toBe(1)
    expect(voiceRingVisual('connecting', 0)?.arc).toBeLessThan(1)
    expect(voiceRingVisual('thinking', 0)?.arc).toBeLessThan(1)
  })

  it('只有模型自己在忙的两个阶段画反向副弧', () => {
    expect(voiceRingVisual('thinking', 0)?.counterArc).toBeGreaterThan(0)
    expect(voiceRingVisual('executing', 0)?.counterArc).toBeGreaterThan(0)
    expect(voiceRingVisual('listening', 0)?.counterArc).toBe(0)
    expect(voiceRingVisual('connecting', 0)?.counterArc).toBe(0)
  })

  it('响度只在模型出声时驱动动效 —— 在听时的响度是模型的回声，不该传给圆环', () => {
    expect(voiceRingVisual('speaking', 0.25)?.level).toBeCloseTo(0.5, 5)
    expect(voiceRingVisual('listening', 0.25)?.level).toBe(0)
    expect(voiceRingVisual('executing', 0.25)?.level).toBe(0)
  })
})

describe('VoiceRing 组件', () => {
  it('idle 时不渲染任何节点', () => {
    const wrapper = mount(VoiceRing, { props: { phase: 'idle', level: 0 } })
    expect(wrapper.find('.voice-ring').exists()).toBe(false)
  })

  it('阶段写进 class，动效全靠它切', () => {
    const wrapper = mount(VoiceRing, { props: { phase: 'listening', level: 0 } })
    expect(wrapper.find('.voice-ring').classes()).toContain('is-listening')
  })

  it('整圈的 dasharray 就是整条周长，缺口态明显更短', () => {
    const full = mount(VoiceRing, { props: { phase: 'listening', level: 0 } })
    const partial = mount(VoiceRing, { props: { phase: 'connecting', level: 0 } })
    const dashOf = (w: typeof full): number =>
      Number(w.find('.voice-ring-arc').attributes('stroke-dasharray')?.split(' ')[0])

    expect(dashOf(full)).toBeCloseTo(125.66, 1)
    expect(dashOf(partial)).toBeLessThan(dashOf(full) / 2)
  })

  it('响度以 CSS 变量下发，缩放和辉光都从它算', async () => {
    const wrapper = mount(VoiceRing, { props: { phase: 'speaking', level: 0.36 } })
    expect(wrapper.find('.voice-ring-body').attributes('style')).toContain('--voice-level: 0.6')

    await wrapper.setProps({ level: 0 })
    expect(wrapper.find('.voice-ring-body').attributes('style')).toContain('--voice-level: 0')
  })

  it('副弧只在需要时进 DOM，不做常驻的隐藏元素', () => {
    expect(
      mount(VoiceRing, { props: { phase: 'thinking', level: 0 } })
        .find('.voice-ring-arc.is-counter')
        .exists()
    ).toBe(true)
    expect(
      mount(VoiceRing, { props: { phase: 'listening', level: 0 } })
        .find('.voice-ring-arc.is-counter')
        .exists()
    ).toBe(false)
  })

  it('对辅助技术隐藏 —— 状态由按钮的 aria-label 播报，圆环只是画面', () => {
    const wrapper = mount(VoiceRing, { props: { phase: 'speaking', level: 0.5 } })
    expect(wrapper.find('.voice-ring').attributes('aria-hidden')).toBe('true')
  })
})
