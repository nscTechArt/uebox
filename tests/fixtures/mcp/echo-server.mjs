/**
 * 最小 MCP server，供 `McpClientManager.e2e.test.ts` 做端到端验证。
 *
 * 放在 tests/fixtures 而不是 .test/ —— 后者在 .gitignore 里，
 * 测试会在 CI 和新克隆上直接失败。
 *
 * 刻意提供两个工具：一个正常回显，一个总是返回 isError，
 * 用来验证「MCP 的失败必须转成异常」这条语义。
 * 工具名 `echo.text` 带点号是故意的：厂商要求 ^[a-zA-Z0-9_-]+$，
 * 用它验证名字清洗。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo-test', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo.text',
      description: '回显传入的文本',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: '要回显的内容' } },
        required: ['message']
      }
    },
    {
      name: 'always_fails',
      description: '总是失败，用来验证失败语义',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'always_fails') {
    return { content: [{ type: 'text', text: '故意失败' }], isError: true }
  }
  return { content: [{ type: 'text', text: `echo: ${req.params.arguments?.message}` }] }
})

await server.connect(new StdioServerTransport())
