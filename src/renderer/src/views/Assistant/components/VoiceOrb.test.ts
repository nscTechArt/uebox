import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VoiceOrb from './VoiceOrb.vue'
import { voiceOrbVisual } from './voiceOrb'

describe('voiceOrbVisual', () => {
  it('会话没开就没有球', () => {
    expect(voiceOrbVisual('idle', 0.5, 0.5)).toBeNull()
  })

  it('麦克风有声就是你在说', () => {
    const visual = voiceOrbVisual('listening', 0.36, 0)
    expect(visual?.speaker).toBe('user')
    expect(visual?.level).toBeCloseTo(0.6, 5)
  })

  it('播放有声就是它在说', () => {
    const visual = voiceOrbVisual('speaking', 0, 0.25)
    expect(visual?.speaker).toBe('assistant')
    expect(visual?.level).toBeCloseTo(0.5, 5)
  })

  it('回声漏进麦克风时算它在说 —— 不能把它自己的声音认成你插话', () => {
    expect(voiceOrbVisual('speaking', 0.2, 0.5)?.speaker).toBe('assistant')
  })

  it('你的声音盖过播放时立刻翻成你在说 —— 打断要马上有反馈', () => {
    expect(voiceOrbVisual('speaking', 0.6, 0.1)?.speaker).toBe('user')
  })

  it('底噪不算说话，两边都静就是间隙', () => {
    const visual = voiceOrbVisual('listening', 0.02, 0.01)
    expect(visual?.speaker).toBe('idle')
    expect(visual?.level).toBe(0)
  })

  it('间隙里分得清是在等你开口还是它在忙', () => {
    expect(voiceOrbVisual('listening', 0, 0)?.resting).toBe('listening')
    expect(voiceOrbVisual('connecting', 0, 0)?.resting).toBe('listening')
    expect(voiceOrbVisual('thinking', 0, 0)?.resting).toBe('busy')
    expect(voiceOrbVisual('executing', 0, 0)?.resting).toBe('busy')
  })
})

describe('VoiceOrb 组件', () => {
  it('idle 时不渲染任何节点', () => {
    const wrapper = mount(VoiceOrb, { props: { phase: 'idle' } })
    expect(wrapper.find('.voice-orb').exists()).toBe(false)
  })

  it('说话人和间隙状态都写进 class，方向与配色靠它切', () => {
    const speaking = mount(VoiceOrb, { props: { phase: 'speaking', outputLevel: 0.4 } })
    expect(speaking.find('.voice-orb').classes()).toContain('is-assistant')

    const talking = mount(VoiceOrb, { props: { phase: 'listening', inputLevel: 0.4 } })
    expect(talking.find('.voice-orb').classes()).toContain('is-user')

    const waiting = mount(VoiceOrb, { props: { phase: 'thinking' } })
    expect(waiting.find('.voice-orb').classes()).toEqual(
      expect.arrayContaining(['is-idle', 'rest-busy'])
    )
  })

  it('响度以 CSS 变量下发，缩放、底光、波纹都从它算', async () => {
    const wrapper = mount(VoiceOrb, { props: { phase: 'speaking', outputLevel: 0.36 } })
    expect(wrapper.find('.voice-orb').attributes('style')).toContain('--orb-level: 0.6')

    await wrapper.setProps({ outputLevel: 0 })
    expect(wrapper.find('.voice-orb').attributes('style')).toContain('--orb-level: 0')
  })

  it('外面不套任何扩散的圈 —— 动效全在球里面', () => {
    const wrapper = mount(VoiceOrb, { props: { phase: 'speaking', outputLevel: 0.4 } })
    expect(wrapper.findAll('.voice-orb-wave')).toHaveLength(0)
  })

  it('响度和说话人原样交给球体，动效由它自己演', () => {
    const wrapper = mount(VoiceOrb, { props: { phase: 'speaking', outputLevel: 0.36 } })
    const sphere = wrapper.findComponent({ name: 'BrandSphere' })

    expect(sphere.props('speaker')).toBe('assistant')
    expect(sphere.props('level')).toBeCloseTo(0.6, 5)
  })

  it('对辅助技术隐藏 —— 会话状态由 aria-live 的文字播报，球只是画面', () => {
    const wrapper = mount(VoiceOrb, { props: { phase: 'listening' } })
    expect(wrapper.find('.voice-orb').attributes('aria-hidden')).toBe('true')
  })
})
