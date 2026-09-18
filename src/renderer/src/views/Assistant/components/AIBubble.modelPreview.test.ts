import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AIBubble from './AIBubble.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

/**
 * 生成的 3D 模型要在气泡里能转着看。
 *
 * 这个预览器一直都在模板里，但一次都没显示出来过：它只认会话结束事件还原出来的
 * `toolResults`，而那是 V2 的形状 —— V3 的完成事件只带一个 sessionId，那条路上
 * `toolResults` 恒为空。一次几十秒到几分钟、还扣额度的产出，用户只能看到一行路径。
 */

function modelResult(path: string, timestamp: number): AgentProcessItem {
  return {
    type: 'tool-result',
    data: { toolName: 'generate_3d_model', result: { success: true, model_path: path } },
    timestamp
  }
}

function mountBubble(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(AIBubble, {
    props: {
      id: 'msg-1',
      content: '底模出来了。',
      status: 'done' as const,
      ...props
    },
    global: {
      stubs: {
        MarkdownRenderer: true,
        AgentProcessLog: true,
        ThinkingProcess: true,
        // 真组件会起 WebGL，测试环境里没有
        ChatModelViewer: {
          props: ['filePath', 'defaultCollapsed'],
          template:
            '<div class="model-viewer" :data-path="filePath" :data-collapsed="String(!!defaultCollapsed)" />'
        },
        AssetList: true,
        MessageSources: true,
        NavigationButton: true,
        'a-button': true,
        'a-tooltip': true
      }
    }
  })
}

describe('AIBubble 的 3D 预览', () => {
  it('过程日志里有生成结果就挂上预览器', () => {
    const wrapper = mountBubble({
      agentProcess: [modelResult('H:/素材库/AIGC/模型/柯基屋.glb', 1)]
    })

    expect(wrapper.find('.model-viewer').attributes('data-path')).toBe(
      'local-resource://H:/%E7%B4%A0%E6%9D%90%E5%BA%93/AIGC/' +
        '%E6%A8%A1%E5%9E%8B/%E6%9F%AF%E5%9F%BA%E5%B1%8B.glb'
    )
  })

  /**
   * 一个模型一个框。以前是把最后一个递给同一个预览器 —— 用户只能看到最后那个，
   * 而且换 filePath 时上一个模型的异步回调会把自己加回同一个场景，两个模型套在一起。
   *
   * 每个预览器占一个 WebGL 上下文、浏览器给的数量有限，所以只有最新的那个默认展开，
   * 其余的收起来（收起 = 卸载 loader = 把上下文还回去）。
   */
  it('一轮生成了多个就摆多个框，只有最新的默认展开', () => {
    const wrapper = mountBubble({
      agentProcess: [modelResult('H:/a.glb', 1), modelResult('H:/b.glb', 2)]
    })

    const viewers = wrapper.findAll('.model-viewer')
    expect(viewers).toHaveLength(2)
    expect(viewers.map((v) => v.attributes('data-path'))).toEqual([
      'local-resource://H:/a.glb',
      'local-resource://H:/b.glb'
    ])
    expect(viewers.map((v) => v.attributes('data-collapsed'))).toEqual(['true', 'false'])
  })

  it('没生成过模型就不挂预览器', () => {
    const wrapper = mountBubble({
      agentProcess: [
        {
          type: 'tool-result',
          data: { toolName: 'ue_screenshot', result: { success: true, path: 'H:/shot.png' } },
          timestamp: 1
        } as AgentProcessItem
      ]
    })

    expect(wrapper.find('.model-viewer').exists()).toBe(false)
  })
})
