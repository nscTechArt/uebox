/**
 * 用 CDP 驱动打包产物时的两件小事：挑一个真能绑上的调试端口，留住 Electron 的 stderr 尾部。
 *
 * 背景：Windows 会把一段段 TCP 端口划成系统保留区（Hyper-V / WSL / WinNAT 动态划的，
 * `netsh interface ipv4 show excludedportrange protocol=tcp` 可查，一次往往吞掉 9211-9610
 * 这样几百个端口）。--remote-debugging-port 落进去时 Electron bind() 直接报 0x271D，
 * 窗口照常弹出，只是 /json/list 永远起不来。调用方若只看「没出现可调试页面」，
 * 就会往主进程崩溃的方向排查 —— 所以启动前先探一下，失败时把 stderr 一起打出来。
 *
 * 被 scripts/verify-offline-boot.mjs 和 scripts/capture-docs-shots.mjs 共用。
 */
import { createServer } from 'node:net'

/** Electron 的 remote-debugging-address 固定是 127.0.0.1（见 src/main/index.ts），探测口径要一致。 */
const DEBUG_HOST = '127.0.0.1'

/** 探一个端口能不能 bind；绑上后立刻关掉。 */
function canBind(port) {
  return new Promise((resolveProbe) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolveProbe(false))
    server.listen(port, DEBUG_HOST, () => server.close(() => resolveProbe(true)))
  })
}

/** 让系统分配一个空闲端口。系统不会发保留区里的端口。 */
function osAssignedPort() {
  return new Promise((resolveProbe, rejectProbe) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectProbe)
    server.listen(0, DEBUG_HOST, () => {
      const { port } = server.address()
      server.close(() => resolveProbe(port))
    })
  })
}

/**
 * 从 `start` 起顺延找一个能绑上的端口。
 *
 * 顺延 `attempts` 个都不行（保留区通常是整段的几百个），就退回让系统分配。
 * 返回数字端口；想知道有没有偏离请求值，自行比较。
 */
export async function findFreePort(start, { attempts = 64 } = {}) {
  const from = Number(start)
  if (!Number.isInteger(from) || from < 1 || from > 65535) {
    throw new Error(`调试端口不合法：${start}`)
  }
  for (let port = from; port < from + attempts && port <= 65535; port++) {
    if (await canBind(port)) return port
  }
  return osAssignedPort()
}

/**
 * 只留最后 `max` 行的 stderr 收集器。
 *
 * Electron 的 stderr 可能很长（Chromium 的 GPU、字体告警一堆），全存没意义，
 * bind 失败这类致命错误都在最后几行。
 */
export function stderrTail(max = 20) {
  const lines = []
  let partial = ''
  return {
    push(chunk) {
      partial += chunk.toString()
      const parts = partial.split(/\r?\n/)
      partial = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        lines.push(line)
        if (lines.length > max) lines.shift()
      }
    },
    lines() {
      const all = partial.trim() ? [...lines, partial] : [...lines]
      return all.slice(-max)
    }
  }
}

/**
 * 把「没等到可调试页面」解释清楚：进程还活着还是已退出、stderr 最后说了什么。
 * 返回多行字符串，直接拼进失败信息。
 */
export function describeLaunchFailure({ exit, tail }) {
  const out = []
  if (exit) {
    out.push(
      `应用进程已退出（code ${exit.code ?? 'null'}${exit.signal ? `，signal ${exit.signal}` : ''}）`
    )
  } else {
    out.push('应用进程仍在运行，但调试端口上没有可用页面')
  }
  const lines = tail.lines()
  if (lines.length > 0) {
    out.push('Electron stderr 最后几行：')
    for (const line of lines) out.push(`  | ${line}`)
  } else {
    out.push('Electron 没有输出任何 stderr')
  }
  return out.join('\n')
}
