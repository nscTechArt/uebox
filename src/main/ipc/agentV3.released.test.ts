/**
 * 「会话真的空出来了」这条事件必须一路走到渲染层。
 *
 * 排队的跟进消息等的就是它。断在任何一环都**不会报错**：主进程照常跑完，
 * 界面照常收尾，只是用户排的那句话再也发不出去，静静躺在输入框上方。
 * 所以这三处对齐要有测试盯着。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

const agentV3Ipc = read('src/main/ipc/agentV3.ts')
const preload = read('src/preload/index.ts')
const rendererApi = read('src/renderer/src/api/agentV3.ts')

describe('agent-v3:released 的三段管道', () => {
  it('主进程在 execute 和 continue 两条路上都发它', () => {
    // 旁路广播（给语音任务表）和发给界面的那份是两回事，各自都得有
    const emitted = agentV3Ipc.match(/'agent-v3:released'/g) ?? []
    expect(emitted.length).toBe(2)
  })

  it('发的位置在 finally 里，和摘掉登记表、放锁同一处', () => {
    // 提前发（比如放在 done 之后）等于回到老问题：那会儿 prompt() 还没返回，
    // 界面收到之后立刻派下一轮，撞上「会话正在执行中」
    const finallyBlocks = agentV3Ipc.split('} finally {').slice(1)
    const blocksWithRelease = finallyBlocks.filter((block) =>
      block.slice(0, 600).includes("'agent-v3:released'")
    )
    expect(blocksWithRelease.length).toBe(2)
    for (const block of blocksWithRelease) {
      expect(block.slice(0, 600)).toContain('releaseAll')
    }
  })

  it('preload 放行这条通道', () => {
    // 不在白名单里的话 window.api.on 收不到任何东西，而且不报错
    expect(preload).toContain("'agent-v3:released'")
  })

  it('渲染层的事件清单里有它', () => {
    expect(rendererApi).toContain("'released'")
    expect(rendererApi).toContain("type: 'released'")
  })
})
