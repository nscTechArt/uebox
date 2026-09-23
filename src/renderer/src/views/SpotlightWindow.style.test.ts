import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/SpotlightWindow.vue'),
  'utf8'
)

describe('SpotlightWindow theme styles', () => {
  it('paints the panel with the current theme surface', () => {
    expect(source).toMatch(/\.spotlight-container\s*{[^}]*background:\s*var\(--color-bg-surface\)/s)
  })
})

/*
 * 听写这一路的几处时序。这个页面没有能挂起来跑的测试骨架（依赖 IPC、Web Audio、
 * 全局热键），先钉住源码里那几处「改回去就会出事」的写法。
 */
describe('SpotlightWindow 听写时序', () => {
  const slice = (from: string, to: string): string =>
    source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))

  // 「没听清」「出错」的提示会盖住倒计时那句话：倒计时不停，前半句会在用户重说时自己发出去
  it('没听清 / 出错时停掉自动提交的倒计时', () => {
    expect(slice('onUnheard:', 'onError:')).toContain('clearSubmitCountdown()')
    expect(slice('onError:', 'onClosed:')).toContain('clearSubmitCountdown()')
  })

  // 收不到 keyup 时按最后一次「还按着」算按了多久，不然一次轻点会被当成按住说话
  it('兜底松手按最后一次「还按着」的时刻算时长', () => {
    expect(source).toContain(
      'setTimeout(() => releaseHold(lastHoldSignalAt), HOLD_RELEASE_GRACE_MS)'
    )
    expect(slice('function handleHold', '\n}\n')).toContain('lastHoldSignalAt = Date.now()')
  })

  // 松手之后在等终稿：终稿到了不能再点一个倒计时（那一路自己会发，会发两遍）
  it('收尾期间不起自动提交的倒计时', () => {
    expect(slice('function startSubmitCountdown', '\n}\n')).toContain(
      "dictation.state.value === 'finishing'"
    )
  })
})
