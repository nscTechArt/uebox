import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ChatWindow → Welcome 的 prop 连线断言。
 *
 * `tsconfig.web.json` 没开 `strictTemplates`，prop 改名类型检查看不见 ——
 * 挂起 ChatWindow 又会把 agent 运行器那一整套拖进来，所以照
 * `Welcome.events.test.ts` 的路数读源码、断言开标签。
 */
const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/ChatWindow/ChatWindow.vue'),
  'utf8'
)

describe('ChatWindow prop 连线', () => {
  it('<Welcome> 的对话 id 走 :chat-sid', () => {
    const tag = source.match(/<Welcome\b[^>]*>/)?.[0] ?? ''
    expect(tag).toContain(':chat-sid="sid"')
    expect(tag).not.toContain(':session-id')
  })
})
