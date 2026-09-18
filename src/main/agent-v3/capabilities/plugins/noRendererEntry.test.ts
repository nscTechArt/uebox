/**
 * 插件不许有渲染层入口 —— 直到安装确认做出来为止。
 *
 * 这不是风格洁癖。`registry.ts` 的机制是通的：插件目录里的 `mcp.json` 会在
 * 下次开会话时被 `capabilities/mcp/index.ts` 连上，也就是**照着它写的命令
 * 拉一个子进程**。清单里那组 `permissions` 从来没有被展示过，也没有约束过
 * 任何调用（见 `types.ts` 文件头）。
 *
 * 所以一个「从文件夹安装」按钮，实质是一键执行第三方写的命令行而不作任何
 * 提示；而挂在 `window.api` 上的 `plugins.install(dir)` 即使没人点，也是一条
 * 可以被利用的路径。两样都撤掉了，这里把它钉住 —— 下一个想加回来的人会先
 * 看到这个测试，和它要求的那两件前置工作。
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..', '..')

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8')
}

describe('插件没有渲染层入口', () => {
  it('主进程不注册任何 agent-v3:plugins:* 通道', () => {
    expect(read('src', 'main', 'ipc', 'agentV3.ts')).not.toContain('agent-v3:plugins:')
  })

  it('preload 既不放行这些通道，也不暴露类型化入口', () => {
    // 通道字符串（白名单和 invoke 都会命中）
    expect(read('src', 'preload', 'index.ts')).not.toContain('agent-v3:plugins:')
    // 桥本身。只查 `plugins: {` —— 文件里的说明性注释提到「plugins」是好事，
    // 不该因为写了原因就把测试搞红
    expect(read('src', 'preload', 'index.ts')).not.toContain('plugins: {')
    expect(read('src', 'preload', 'index.d.ts')).not.toContain('plugins: {')
  })

  it('渲染层 API 里没有 plugins', () => {
    expect(read('src', 'renderer', 'src', 'api', 'agentV3.ts')).not.toContain(
      'window.api.agentV3.plugins'
    )
  })

  it('机制本身仍在，只是没有入口 —— 撤的是界面，不是能力', () => {
    const registry = read('src', 'main', 'agent-v3', 'capabilities', 'plugins', 'registry.ts')
    expect(registry).toContain('export async function installFromDirectory')
    expect(registry).toContain('export async function enabledPluginMcpServers')
  })
})
