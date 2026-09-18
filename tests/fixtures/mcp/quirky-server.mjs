#!/usr/bin/env node
/**
 * 一个**故意写得不像我们自己写的** MCP server。
 *
 * `echo-server.mjs` 证明的是「协议能跑通」，但它是我们自己写的 ——
 * 它的 schema 长得就是我们习惯的样子，自然不会踩到我们的坑。
 *
 * 真实的第三方 server 不会照顾我们。这个 fixture 把常见的"合法但难缠"
 * 的写法都摆出来，用来验我们的适配层扛不扛得住：
 *
 *   - `$defs` + `$ref`：JSON Schema 完全合法，但很多厂商的 function calling
 *     接口不收，一旦透传过去**整个请求被拒，所有工具一起失效**，
 *     而不只是这一个工具不可用。
 *   - `oneOf` / `anyOf`：同上。
 *   - 名字带点、斜杠、大写：MCP 规范不限制，厂商限制 `^[a-zA-Z0-9_-]{1,64}$`。
 *   - 完全没有 `inputSchema`，或者 schema 里没有 `type`。
 *   - 超长名字。
 *
 * 这些不是假想。官方 reference server 和社区 server 里都能找到实例。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const TOOLS = [
  {
    // 点号在 MCP 里合法，在厂商的工具名正则里不合法
    name: 'files.read_text',
    description: '读一个文本文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    // $defs + $ref：JSON Schema 标准写法，厂商普遍不收
    name: 'db/query',
    description: '执行一次查询',
    inputSchema: {
      type: 'object',
      $defs: {
        filter: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            op: { type: 'string', enum: ['eq', 'gt', 'lt'] },
            value: {}
          }
        }
      },
      properties: {
        table: { type: 'string' },
        filters: { type: 'array', items: { $ref: '#/$defs/filter' } }
      },
      required: ['table']
    }
  },
  {
    // oneOf：同样合法、同样常被拒
    name: 'notify',
    description: '发一条通知',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { type: 'string' },
            { type: 'object', properties: { id: { type: 'number' } } }
          ]
        }
      }
    }
  },
  {
    // 空 properties —— 无参工具的常见写法
    name: 'ping',
    description: '心跳',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // 深层嵌套 + 数组里再套对象
    name: 'Batch.Import',
    description: '批量导入',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              options: {
                type: 'object',
                properties: { overwrite: { type: 'boolean' } }
              }
            }
          }
        }
      }
    }
  },
  {
    // 超长名字，加上 serverId 前缀后必然超过 64
    name: 'this_is_a_very_long_tool_name_that_some_server_authors_actually_ship_in_the_wild',
    description: '名字很长的工具',
    inputSchema: { type: 'object', properties: {} }
  }
]

const server = new Server(
  { name: 'quirky-third-party', version: '2.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'db/query') {
    return { content: [{ type: 'text', text: `queried ${args?.table}` }] }
  }

  if (name === 'ping') {
    return { content: [{ type: 'text', text: 'pong' }] }
  }

  // 第三方 server 报错的标准姿势：isError 而不是抛 JSON-RPC error
  return {
    isError: true,
    content: [{ type: 'text', text: `tool ${name} is not implemented` }]
  }
})

await server.connect(new StdioServerTransport())
