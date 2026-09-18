import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('InputComposer read-only permission', () => {
  const composer = read('src/renderer/src/views/Assistant/components/InputComposer.vue')
  const welcome = read('src/renderer/src/views/Assistant/Welcome.vue')
  const agentMode = read('src/renderer/src/views/Assistant/composables/useAgentMode.ts')

  it('shows read-only before the three approval modes and reflects its selected state', () => {
    expect(composer.indexOf("value: 'read-only' as const")).toBeLessThan(
      composer.indexOf("value: 'ask' as const")
    )
    expect(composer).toContain("label: t('assistantInputComposer.approval.readOnlyLabel')")
    // 显示哪一档问的是这条会话，不是全局设置 —— 否则切个标签页档位就串了
    expect(composer).toContain('return resolvePermissionMode(props.chatSid)')
    expect(composer).toContain('permissionMode === opt.value')
  })

  it('turns read-only on and turns it off when another permission is selected', () => {
    expect(composer).toContain("emit('toggle-ask-mode', mode === 'read-only')")
    expect(composer).toContain('setPermissionMode(props.chatSid, mode)')
    expect(welcome.match(/@toggle-ask-mode="handleAskModeChange"/g)).toHaveLength(2)
    expect(welcome).toMatch(
      /function handleAskModeChange\(enabled: boolean\): void \{\s+askModeRef\.value = enabled\s+\}/
    )
  })

  /**
   * `/ask` 那条一次性前缀已经删了 —— 只读只剩审批下拉这一条路。
   *
   * 两条通往同一件事的路，会让「我到底是不是只读」变成要靠猜：前缀只管这一轮，
   * 下拉是会话级的，而界面上只显示后者。
   */
  it('drops the one-off /ask prefix so read-only has a single source of truth', () => {
    // 认 import 和调用，不认裸词 —— 文件里那段「为什么删掉」的注释要留着
    expect(agentMode).not.toContain("from './askCommand'")
    expect(agentMode).not.toContain('parseAskCommand(userMessage)')
    expect(agentMode).toContain("permissionMode === 'read-only'")
  })
})
