import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 事件连线测试的页面一段：Welcome.vue 近 3000 行，不挂载，照
 * `ChatLog.style.test.ts` 的方式读源码，断言子组件事件真的接到了处理函数。
 * `tsconfig.web.json` 没开 `strictTemplates`，监听一个子组件没声明的事件
 * 不报类型错误 —— 改漏一处只会表现为点按钮没反应，这里兜住。
 */
const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/Welcome.vue'),
  'utf8'
)

function openTag(component: string): string {
  return source.match(new RegExp(`<${component}\\b[^>]*>`))?.[0] ?? ''
}

describe('Welcome 事件连线', () => {
  it('<ChatLog> 的 branch 接到 handleBubbleBranch', () => {
    expect(openTag('ChatLog')).toContain('@branch="handleBubbleBranch"')
  })

  it('<TopNav> 的 side-question 接到 handleSideQuestion', () => {
    expect(openTag('TopNav')).toContain('@side-question="handleSideQuestion"')
  })
})
