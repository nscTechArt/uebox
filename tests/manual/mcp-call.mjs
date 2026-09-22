/**
 * 通过盒子自己的 MCP 服务调 UE 工具 —— 给手动验证脚本当传输层用。
 *
 * ## 为什么走这条路
 *
 * 手动验证要真引擎，而拿到引擎的路只有三条：
 *
 *   1. `/api/debug/agent`（`skill-routing-probe.mjs` 走的那条）—— 要
 *      `pnpm dev:ue-verify` 才会监听，会打断用户正在跑的那个盒子；
 *   2. 直连 WS 服务（17860）—— 那是**给插件连的**，不是给命令方连的；
 *   3. **对外 MCP 服务（17861）** —— 它本来就是为「外部程序调 UE 工具」
 *      存在的，默认开，端口和 token 都是固定持久的。
 *
 * 第三条既不用改用户的运行方式，也不用新开进程。
 *
 * ## token
 *
 * 从 `userData/mcp-server.json` 自己读，**不打印、不落盘、不进命令行参数**。
 * 那是本机回环服务的凭据（文件自己的注释也说了不值得加密），但没有理由
 * 让它出现在终端回滚和 shell 历史里。
 *
 * ## 用法
 *
 *   node tests/manual/mcp-call.mjs --list
 *   node tests/manual/mcp-call.mjs --tool=ue_get_project_info --args='{}'
 *
 * 也可以 `import { callTool } from './mcp-call.mjs'` 当库用。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SETTINGS = join(process.env.APPDATA || '', 'unreal-box', 'mcp-server.json')

function loadHost() {
  let raw
  try {
    raw = JSON.parse(readFileSync(SETTINGS, 'utf-8'))
  } catch {
    throw new Error(
      `读不到 ${SETTINGS} —— 盒子没跑过，或者 MCP 服务从没开过。` + '去 设置 → MCP 打开开关。'
    )
  }
  if (!raw?.token) throw new Error('mcp-server.json 里没有 token')
  return {
    port: raw.port || 17861,
    token: raw.token,
    includeMutating: raw.includeMutating === true
  }
}

const host = loadHost()
const ENDPOINT = `http://127.0.0.1:${host.port}/`

/** 会话 id 由服务端在 initialize 的响应头里给，之后每次请求都要带 */
let sessionId = null
let nextId = 1

/**
 * 发一条 JSON-RPC。
 *
 * Accept 两种都要写：StreamableHTTP 的响应可能是 `application/json`，
 * 也可能是 `text/event-stream`，少写一种会被 406 顶回来。
 */
async function rpc(method, params) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${host.token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal: AbortSignal.timeout(300_000)
  })

  const incoming = response.headers.get('mcp-session-id')
  if (incoming) sessionId = incoming

  const body = await response.text()
  if (!response.ok) throw new Error(`${method} 失败：HTTP ${response.status} ${body.slice(0, 200)}`)

  // SSE 帧：取最后一条 data: 行。普通 JSON 就直接解
  const payload = body.includes('data:')
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .pop()
    : body

  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new Error(`${method} 的响应解不开：${String(payload).slice(0, 200)}`)
  }
  if (parsed.error)
    throw new Error(`${method} 出错：${parsed.error.message || JSON.stringify(parsed.error)}`)
  return parsed.result
}

let ready = null

/** 握手。只做一次 —— 会话 id 拿到之后后面的请求复用它 */
export async function connect() {
  if (ready) return ready
  ready = (async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'uebox-manual-verify', version: '0' }
    })
    // 协议要求握手后发这条通知，服务端才认为会话可用
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${host.token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    }).catch(() => {})
    return true
  })()
  return ready
}

export async function listTools() {
  await connect()
  const tools = []
  let cursor
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {})
    tools.push(...(page.tools ?? []))
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

/** 调一个工具，返回它的文本输出（拼起来的） */
export async function callTool(name, args = {}) {
  await connect()
  const result = await rpc('tools/call', { name, arguments: args })
  const text = (result.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return { text, isError: result.isError === true, raw: result }
}

export const hostInfo = { port: host.port, includeMutating: host.includeMutating }

// ==================== 命令行 ====================

const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
) {
  if (process.argv.includes('--list')) {
    const tools = await listTools()
    console.log(`MCP 端口 ${host.port}，暴露写操作工具：${host.includeMutating ? '是' : '否'}`)
    console.log(`${tools.length} 个工具\n`)
    const wanted = arg('grep')
    for (const tool of tools) {
      if (wanted && !tool.name.includes(wanted)) continue
      console.log(`  ${tool.name}`)
    }
  } else if (arg('tool')) {
    const result = await callTool(arg('tool'), JSON.parse(arg('args') || '{}'))
    console.log(result.isError ? '✖ 工具报错：' : '✓')
    console.log(result.text.slice(0, Number(arg('max') || 4000)))
  } else {
    console.log("用法：--list [--grep=xxx] 或 --tool=名字 --args='{}'")
  }
}
