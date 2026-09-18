import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `LibraryAIPanel` 的**嵌入契约**。
 *
 * ## 为什么是读源码，不是挂组件
 *
 * 这个面板里嵌的是主助手本身。挂起来会把 agent 内核、语音、审批那一整套拖进来，
 * 而真正要守的三件事**全都是 jsdom 看不见的**：布局撑没撑破、颜色走没走变量、
 * 事件在哪个阶段触发。同一批改动里已经栽过一次（`SensitiveActionConfirm`
 * 挪到 `MainLayout` 之后横向占掉 900px，单测全绿而屏幕是坏的）。
 *
 * 所以这里盯的是「源码里那几条写没写对」，和 `SnippetDetail.mount.test.ts` 同一路数。
 * 这不能替代真机验收，只能保证已经想明白的那几条不被顺手删掉。
 */
const ROOT = resolve(__dirname, '../../../../../..')
const PANEL = 'src/renderer/src/views/library-common/components/LibraryAIPanel.vue'

const source = readFileSync(resolve(ROOT, PANEL), 'utf-8')
const styleBlock = /<style scoped lang="less">([\s\S]*)<\/style>/.exec(source)?.[1] ?? ''

describe('LibraryAIPanel 的嵌入契约', () => {
  it('把助手那条按整页写的 min-height 覆盖掉', () => {
    /*
     * 助手根上挂着 `min-height: calc(100vh - 64px)`（填满窗口）。不覆盖的话，
     * 它在一块比窗口矮的面板里会被顶得比面板还高，底下的输入框被挤出可视区 ——
     * 用户看得见对话却打不了字。
     */
    expect(styleBlock).toContain(':deep(.assistant-shell)')
    expect(styleBlock).toContain(':deep(.assistant-welcome)')

    const override = /:deep\(\.assistant-welcome\)\s*\{([^}]*)\}/.exec(styleBlock)?.[1] ?? ''
    expect(override).toMatch(/min-height:\s*0/)
    expect(override).toMatch(/height:\s*100%/)
  })

  it('面板体自己不滚，滚动归助手内部', () => {
    const body = /\.panel-body\s*\{([^}]*)\}/.exec(styleBlock)?.[1] ?? ''
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  it('样式全走 theme 变量，没有裸写色值', () => {
    // 硬规则第 1 条。裸色值会在浅色和高对比主题下变成脏的一块
    expect(styleBlock.length).toBeGreaterThan(0)
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styleBlock).not.toMatch(/\brgba?\(/)
  })

  it('选中快照走 mousedown 捕获阶段，而且只认输入类元素', () => {
    /*
     * 用户框选几个节点再去输入框打字 —— 焦点一转移画布选中态就没了，
     * 冒泡阶段才拍就晚了，必须是捕获。
     *
     * 但不能无差别拍：点一下工具日志、滚一下列表也会触发的话，
     * 每次都要重新序列化一遍选中节点，而那和焦点转移根本没关系。
     */
    expect(source).toContain('@mousedown.capture="handleBodyMouseDown"')
    expect(source).toMatch(/textarea,\s*input,\s*\[contenteditable="true"\]/)
  })

  it('会话 id 由调用方给，且约定用 library-chat- 打头', () => {
    // 这个前缀是「别把它列进侧边栏会话列表」的依据（chatSessions 的 listableSessions），
    // 也是通知点回来时认路的依据（notificationActivation）
    expect(source).toContain('library-chat-')
  })
})
