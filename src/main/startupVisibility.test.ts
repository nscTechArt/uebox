import { describe, expect, it } from 'vitest'
import { shouldStartHiddenAtLaunch, START_HIDDEN_ARG } from './startupVisibility'

describe('startup visibility', () => {
  it('does not hide a normal manual launch', () => {
    expect(shouldStartHiddenAtLaunch({ argv: ['unreal-agent.exe'] })).toBe(false)
  })

  it('hides when Electron reports a login launch', () => {
    expect(shouldStartHiddenAtLaunch({ argv: ['unreal-agent.exe'], wasOpenedAtLogin: true })).toBe(
      true
    )
  })

  it('hides when the launch contains the direct hidden arg', () => {
    expect(shouldStartHiddenAtLaunch({ argv: ['unreal-agent.exe', START_HIDDEN_ARG] })).toBe(true)
  })

  it('hides when the launch wraps the hidden arg in process-start-args', () => {
    expect(
      shouldStartHiddenAtLaunch({
        argv: ['Update.exe', '--process-start-args', `"${START_HIDDEN_ARG}"`]
      })
    ).toBe(true)

    expect(
      shouldStartHiddenAtLaunch({
        argv: ['Update.exe', `--process-start-args=${START_HIDDEN_ARG}`]
      })
    ).toBe(true)
  })
})
