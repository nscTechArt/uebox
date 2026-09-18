import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 窄容器下输入区那排控件要把文字折成图标。
 *
 * ## 为什么要有这条
 *
 * 这个组件嵌进蓝图库 / 材质库详情页那块四百来宽的面板之后
 * （`library-common/components/LibraryAIPanel.vue`），底下那排
 * 「完全访问权限 / max / deepseek-flash」三个带文字的下拉把整行撑爆了 ——
 * 实测要 550px 才塞得下，而那么宽的面板会把蓝图画布挤没。
 *
 * 折叠靠的是纯 CSS（容器查询），**jsdom 不排版、也不解析 `@container`**，
 * 挂起来测不出任何东西。所以只能盯住「那几条规则还在不在」：
 * 容器声明没了、或者折叠规则被顺手删掉，都会让面板悄悄退回撑爆的状态，
 * 而所有单测照样全绿。
 */
const ROOT = resolve(__dirname, '../../../../../..')
const COMPOSER = 'src/renderer/src/views/Assistant/components/InputComposer.vue'

const source = readFileSync(resolve(ROOT, COMPOSER), 'utf-8')

describe('输入区在窄容器下折叠', () => {
  it('容器声明在，否则下面的 @container 一条都不生效', () => {
    expect(source).toMatch(/container:\s*composer\s*\/\s*inline-size/)
  })

  it('先折审批档和思考档', () => {
    const rule = /@container composer \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(rule).toContain('.approval-selector .mode-trigger-label')
    expect(rule).toContain('.thinking-selector .mode-trigger-label')
    expect(rule).toMatch(/display:\s*none/)
  })

  it('模型名最后才折 —— 那是这排里用户最常看的一条', () => {
    const rule = /@container composer \(max-width: 380px\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    expect(rule).toContain('.agent-model-trigger-label')
    expect(rule).toMatch(/display:\s*none/)
  })

  it('三个触发器都带 title / aria-label，折掉的字还能看见', () => {
    // 折成图标之后，「这个盾牌/灯泡是干嘛的」只能靠它回答；
    // aria-label 是给读屏的 —— display:none 的标签不在无障碍树里
    expect(source).toContain(':title="currentApprovalConfig.label"')
    expect(source).toContain(':aria-label="currentApprovalConfig.label"')
    expect(source).toContain(':title="thinkingTriggerTitle"')
    expect(source).toContain(':aria-label="thinkingTriggerTitle"')
    expect(source).toContain(':title="agentModelTriggerTitle"')
  })

  it('工具行的三列都能被压缩', () => {
    // grid 子项默认 min-width:auto，会按内容撑开 —— 窄容器下右边那组
    // 直接溢出到面板外面，折不折叠都救不回来
    const rule = /\.tools-row > \* \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(rule).toMatch(/min-width:\s*0/)
  })
})
