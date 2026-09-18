import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const inputComposerSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/InputComposer.vue'),
  'utf8'
)

describe('InputComposer running state', () => {
  it('drops the banner and the labelled queue button', () => {
    expect(inputComposerSource).not.toContain('assistantInputComposer.steerBanner')
    expect(inputComposerSource).not.toContain('steer-banner')
    expect(inputComposerSource).not.toContain('steer-btn')
  })

  it('swaps the stop button back to send once there is something to send', () => {
    // 跑着 + 输入框有东西 = 发送按钮；空着才是红色停止
    expect(inputComposerSource).toContain('v-if="props.isGenerating && !canSendFollowUp"')
    expect(inputComposerSource).toContain('@click="handlePrimaryAction"')
  })
})
