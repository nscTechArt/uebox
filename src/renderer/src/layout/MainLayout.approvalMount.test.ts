import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 审批框必须挂在应用级布局上，不能回到助手页里。
 *
 * 它以前挂在 `Assistant/components/ChatLog.vue`，注释还写着「全局单例」——
 * 但助手页没有 keepAlive，切走就卸载。于是从库详情页点「放进当前工程」
 * 发起的操作，审批框根本不会出现，用户在
 * `agent-v3/host/approvalChannel.ts` 的 `APPROVAL_TIMEOUT_MS`（5 分钟）之后
 * 收到一句「失败」，而且不知道自己曾被问过。
 *
 * 这条测试盯的是「挪回去不会有任何别的东西变红」—— 组件渲染测试测不到
 * 「它挂在哪一层」，只有直接看挂载点才行。
 */
const ROOT = resolve(__dirname, '../../../..')

function read(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8')
}

describe('敏感操作确认框的挂载位置', () => {
  it('挂在 MainLayout 上', () => {
    const layout = read('src/renderer/src/layout/MainLayout.vue')
    expect(layout).toContain('<SensitiveActionConfirm />')
    expect(layout).toContain(
      "import SensitiveActionConfirm from '@renderer/components/SensitiveActionConfirm.vue'"
    )
  })

  it('不在助手页的 ChatLog 里 —— 那里没有 keepAlive', () => {
    const chatLog = read('src/renderer/src/views/Assistant/components/ChatLog.vue')
    expect(chatLog).not.toContain('<SensitiveActionConfirm />')
    expect(chatLog).not.toContain("from '@renderer/components/SensitiveActionConfirm.vue'")
  })

  it('全仓只有一处挂载 —— 两处会弹出两个框', () => {
    const layout = read('src/renderer/src/layout/MainLayout.vue')
    const occurrences = layout.match(/<SensitiveActionConfirm\s*\/>/g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  /**
   * 内容必须 Teleport 出去，不能就地渲染在 `MainLayout` 的模板里。
   *
   * `.main-layout` 是 `display: flex`。第一版挪过来时样式没跟着改，那个
   * `width: 100%; max-width: 900px` 的裸 `div` 就成了最后一个 flex 子项 ——
   * 横向占掉 900px，把侧边栏和整个内容区挤到窗口左边一条。
   * jsdom 不排版，渲染测试看不出这个，只能盯住模板根节点是 `<Teleport>`。
   */
  it('内容 Teleport 出去 —— 就地渲染会把 flex 布局挤扁', () => {
    const confirm = read('src/renderer/src/components/SensitiveActionConfirm.vue')
    expect(confirm).toMatch(/<template>\s*(<!--[\s\S]*?-->\s*)*<Teleport/)
  })

  /**
   * 位置跟着对话走：助手页在，就顶在输入框上方（用户刚打完字的地方）；
   * 助手页不在（比如从库页面发起的操作），才退回窗口底部的浮层。
   *
   * 两头都要有人：停靠位没人登记，框就永远浮在角上；框不读停靠位，
   * 登记了也没用。
   */
  it('停靠位两头都接上：助手页登记，审批框读取', () => {
    const confirm = read('src/renderer/src/components/SensitiveActionConfirm.vue')
    expect(confirm).toContain(
      "import { useApprovalDock } from '@renderer/components/useApprovalDock'"
    )

    const assistant = read('src/renderer/src/views/Assistant/Welcome.vue')
    expect(assistant).toContain(
      "import { provideApprovalDock } from '@renderer/components/useApprovalDock'"
    )
    expect(assistant).toContain(':ref="setApprovalDock"')
  })
})
