import { describe, expect, it } from 'vitest'
import {
  AGENT_EMPTY_RESPONSE_TEXT,
  isEchoedAgentFallbackInput
} from '../../src/shared/agentFastPath'

describe('isEchoedAgentFallbackInput', () => {
  it('detects echoed fallback text as invalid user input', () => {
    expect(isEchoedAgentFallbackInput(AGENT_EMPTY_RESPONSE_TEXT)).toBe(true)
    expect(isEchoedAgentFallbackInput(` ${AGENT_EMPTY_RESPONSE_TEXT} `)).toBe(true)
    expect(
      isEchoedAgentFallbackInput('\u89e3\u91ca\u4e00\u4e0b Actor \u548c Component \u533a\u522b')
    ).toBe(false)
  })
})
