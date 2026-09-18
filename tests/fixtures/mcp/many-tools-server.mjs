/**
 * 一个工具多到该被拒绝的 MCP server，供 `McpClientManager.e2e.test.ts`
 * 验证 `MAX_TOOLS_PER_SERVER` 这道闸。
 *
 * 现实原型是 UE 5.8 官方的 ModelContextProtocol 插件：把 `bEnableToolSearch`
 * 关掉之后，它会一次性铺开约 900 个工具（见 epicToolsets.ts）。那既会撑爆
 * 上下文，也会撞上工具名 64 字符上限 —— 症状是「模型突然变笨」，
 * 比一条明确的连接失败难查得多。
 *
 * 工具名刻意用深命名空间的长名字，和 Epic 的真实形态一致。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const TOOL_COUNT = 200

const server = new Server({ name: 'many-tools', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from({ length: TOOL_COUNT }, (_, i) => ({
    name: `toolset_registry.toolsets.core.generated.GeneratedTools.tool_number_${i}`,
    description: `生成的第 ${i} 个工具`,
    inputSchema: { type: 'object', properties: {} }
  }))
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `called ${req.params.name}` }]
}))

await server.connect(new StdioServerTransport())
