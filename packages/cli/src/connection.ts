/**
 * 连到盒子的 MCP 服务。
 *
 * ## 一条命令一条会话
 *
 * 每个 CLI 进程建立自己的会话，跑完主动结束它、关掉传输。不复用、不留后台。
 * 结束会话这件事要**显式做**（`terminateSession()`）—— 只关传输的话，服务端
 * 那条会话要等空闲超时才回收，连着跑十条命令就在盒子里留十条残骸。
 *
 * ## 先读契约再干活
 *
 * 旧盒子没有 `capabilities.experimental.unrealBox`。这时候连通性是好的，
 * 但 `--project` 发过去会被**静默忽略** —— 命令看起来成功了，只是发给了
 * 另一个工程。所以除了纯连通性检查（doctor 的第一段），任何要干活的命令
 * 都必须先确认契约在。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { HostConnection } from './config.js'
import { UeboxError } from './errors.js'

/** 本 CLI 实现的契约版本。和服务端 `externalTarget.ts` 的常量必须一致 */
export const CLI_CONTRACT_VERSION = 1

/** 连接阶段的期限。本机回环连不上就是连不上，等再久也一样 */
export const CONNECT_TIMEOUT_MS = 5_000

/** 整条命令的默认期限（秒）。`--timeout` 覆盖它 */
export const DEFAULT_TIMEOUT_SECONDS = 120

export interface UnrealBoxCapability {
  cliContractVersion: number
  projectTargeting: boolean
  publicResults: boolean
}

export interface Session {
  client: Client
  /** 服务端声明的能力。旧盒子上是 undefined */
  capability?: UnrealBoxCapability
  close(): Promise<void>
}

/**
 * 连上去。
 *
 * 失败一律翻成带码的 `UeboxError`：调用方要靠退出码区分「服务没开」和
 * 「令牌不对」，这两件事的下一步完全不同。
 */
export async function connect(host: HostConnection): Promise<Session> {
  const client = new Client({ name: 'uebox-cli', version: '0.1.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(host.url), {
    requestInit: { headers: { Authorization: `Bearer ${host.token}` } }
  })

  try {
    await withDeadline(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      () =>
        new UeboxError(
          'SERVICE_UNAVAILABLE',
          `连接虚幻盒子超时（${host.url}）。`,
          '确认虚幻盒子正在运行。对外服务默认开着，' +
            '只有你自己在「MCP → 对外暴露虚幻引擎能力」里关过才需要重新打开。'
        )
    )
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw describeConnectError(error, host)
  }

  const raw = client.getServerCapabilities()?.experimental?.unrealBox
  const capability = parseCapability(raw)

  return {
    client,
    ...(capability ? { capability } : {}),
    close: async () => {
      // 先主动结束服务端那条会话，再关传输。反过来的话 DELETE 发不出去。
      await transport.terminateSession().catch(() => undefined)
      await client.close().catch(() => undefined)
    }
  }
}

/**
 * 干活之前确认契约在。
 *
 * @throws {UeboxError} `INCOMPATIBLE_SERVER` —— 旧盒子，或者版本对不上
 */
export function requireContract(session: Session): UnrealBoxCapability {
  if (!session.capability) {
    throw new UeboxError(
      'INCOMPATIBLE_SERVER',
      '这个虚幻盒子还不支持 CLI 契约（没有声明 unrealBox 能力）。',
      '升级虚幻盒子。当前版本能连上，但它会忽略 --project —— 命令会看起来成功，' +
        '实际可能发给了别的工程。'
    )
  }

  if (session.capability.cliContractVersion !== CLI_CONTRACT_VERSION) {
    throw new UeboxError(
      'INCOMPATIBLE_SERVER',
      `契约版本不匹配：盒子是 ${session.capability.cliContractVersion}，本 CLI 是 ${CLI_CONTRACT_VERSION}。`,
      '把虚幻盒子和 uebox 升到同一批版本。'
    )
  }

  return session.capability
}

function parseCapability(raw: unknown): UnrealBoxCapability | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.cliContractVersion !== 'number') return undefined

  return {
    cliContractVersion: value.cliContractVersion,
    projectTargeting: value.projectTargeting === true,
    publicResults: value.publicResults === true
  }
}

/**
 * 把底层的连接错误翻成用户能照着做的一句话。
 *
 * 401 和「端口没人监听」都会以 `Error` 的形式冒出来，但它们是两件事：
 * 前者要去盒子里重置令牌再 `uebox setup`，后者要去把服务打开。
 */
function describeConnectError(error: unknown, host: HostConnection): UeboxError {
  if (error instanceof UeboxError) return error

  const message = error instanceof Error ? error.message : String(error)

  if (/\b401\b|unauthorized/i.test(message)) {
    return new UeboxError(
      'AUTH_FAILED',
      `虚幻盒子拒绝了这个访问令牌（${host.url}）。`,
      '令牌可能已经在盒子里被重置过。重新运行 uebox setup 关联一次即可 —— ' +
        'CLI 不存令牌副本，它每次都去读盒子那份配置。'
    )
  }

  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed|socket hang up/i.test(message)) {
    return new UeboxError(
      'SERVICE_UNAVAILABLE',
      `连不上虚幻盒子（${host.url}）：${message}`,
      '确认虚幻盒子正在运行。对外服务默认开着，' +
        '只有你自己在「MCP → 对外暴露虚幻引擎能力」里关过才需要重新打开。'
    )
  }

  return new UeboxError('SERVICE_UNAVAILABLE', `连接虚幻盒子失败：${message}`)
}

/**
 * 给一个 promise 加期限。
 *
 * 超时**不取消**底层请求 —— 底层不一定支持取消，而假装取消了比超时更糟：
 * 调用方会以为引擎那边什么都没发生。执行状态由调用点保守报成 `unknown`。
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => UeboxError
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
