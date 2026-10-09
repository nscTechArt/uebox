import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * prop 连线测试：SideMenu.vue 一千多行，不挂载，照 `Welcome.events.test.ts`
 * 的方式读源码，断言传给 ChatSessionList 的对话 id 走的是 `activeChatSid`。
 * `tsconfig.web.json` 没开 `strictTemplates`，prop 名改漏一边只会表现为
 * 高亮跟不上当前对话，这里兜住。
 */
const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/layout/components/SideMenu.vue'),
  'utf8'
)

function openTag(component: string): string {
  return source.match(new RegExp(`<${component}\\b[^>]*>`))?.[0] ?? ''
}

describe('SideMenu prop 连线', () => {
  it('<ChatSessionList> 的当前对话走 :active-chat-sid', () => {
    expect(openTag('ChatSessionList')).toContain(':active-chat-sid=')
    expect(openTag('ChatSessionList')).not.toContain(':active-session-id')
  })
})
