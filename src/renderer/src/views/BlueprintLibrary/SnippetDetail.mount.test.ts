import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `SnippetDetail` 顶替 `.bp-editor-page` 时的**布局契约**。
 *
 * ## 为什么要有这么一条
 *
 * 同一批改动里已经栽过一次：把 `SensitiveActionConfirm` 从 `ChatLog` 挪到
 * `MainLayout` 之后，它那个没定位的根 `div` 成了 `.main-layout`（flex 容器）
 * 的最后一个子项，横向占掉 900px，把侧边栏和内容区挤到窗口左边一条。
 * 修法是 `<Teleport>` 出去（见 `MainLayout.approvalMount.test.ts`）。
 *
 * **jsdom 不排版，渲染测试看不见这类问题** —— 组件挂载成功、断言全过，
 * 而屏幕上是坏的。所以只能盯住「根节点的形状对不对」这一层。
 *
 * `SnippetDetail` 是 `BlueprintEditor` 模板里 `.bp-editor-page` 的 `v-if`
 * 兄弟：同一个父容器、二选一渲染。它的根必须和 `.bp-editor-page` 撑开方式
 * 一致，否则片段条目的详情页会比老条目的矮一截或者撑不满。
 */
const ROOT = resolve(__dirname, '../../../../..')

function read(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8')
}

const SNIPPET = 'src/renderer/src/views/BlueprintLibrary/SnippetDetail.vue'
const EDITOR = 'src/renderer/src/views/BlueprintLibrary/BlueprintEditor.vue'

describe('SnippetDetail 的布局契约', () => {
  it('根节点撑开方式和它顶替的 .bp-editor-page 一致', () => {
    const snippet = read(SNIPPET)
    const editor = read(EDITOR)

    // .bp-editor-page: height:100% + flex column。缺哪一条都会导致
    // 两种条目的详情页高度对不上
    const editorRule = /\.bp-editor-page\s*\{([^}]*)\}/.exec(editor)?.[1] ?? ''
    expect(editorRule).toMatch(/height:\s*100%/)
    expect(editorRule).toMatch(/display:\s*flex/)
    expect(editorRule).toMatch(/flex-direction:\s*column/)

    const snippetRule = /\.snippet-detail\s*\{([^}]*)\}/.exec(snippet)?.[1] ?? ''
    expect(snippetRule).toMatch(/height:\s*100%/)
    expect(snippetRule).toMatch(/display:\s*flex/)
    expect(snippetRule).toMatch(/flex-direction:\s*column/)
  })

  it('两者是同一层的 v-if / v-else-if 兄弟 —— 不能同时渲染', () => {
    const editor = read(EDITOR)
    // 同时渲染会出现两个滚动容器叠在一起
    expect(editor).toMatch(/<SnippetDetail\b[\s\S]*?v-if="snippetPayload"/)
    expect(editor).toMatch(/<div v-else-if="blueprint" class="bp-editor-page">/)
  })

  it('样式全走 theme 变量，没有裸写色值', () => {
    // 硬规则第 4 条。裸色值在浅色主题下会变成脏的一块
    const styleBlock = /<style scoped>([\s\S]*)<\/style>/.exec(read(SNIPPET))?.[1] ?? ''
    expect(styleBlock.length).toBeGreaterThan(0)
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styleBlock).not.toMatch(/\brgba?\(/)
  })
})
