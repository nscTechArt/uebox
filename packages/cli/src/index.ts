#!/usr/bin/env node
/**
 * `uebox` 的入口。
 *
 * 这一层只做三件事：把 argv 交给 `cli.run`、把结果写到真实的流上、退出。
 * 逻辑全在 `cli.ts` 里，那边返回字符串而不是直接写流 —— 于是测试能断言
 * 「stdout 一定能 JSON.parse」，不用去劫持全局对象。
 */

import { writeSync } from 'node:fs'

import { run } from './cli.js'
import { isSettled } from './interrupt.js'

/**
 * Ctrl+C。
 *
 * 退出码 130 是 Unix 惯例（128 + SIGINT）。**它不代表引擎已经撤销了操作**：
 * 我们只是不再等，已经发出去的请求在引擎那边照跑（§6.2）。所以这里说的是
 * 「结果无法确认」，不是「已取消」。
 *
 * 两个真机上抓到的细节：
 *
 * 1. **结果已经定下来时不许改判。** 一条截图命令把图交付完、成功结果也打出去了，
 *    SIGINT 在收尾那一刻到达，原来照样 `exit(130)` —— 一次完全成功的操作对外
 *    报成「中断，结局不明」。脚本据此会去重做一遍。见 `interrupt.ts`。
 * 2. **提示必须同步写。** `process.stderr.write` 到管道是异步的，紧跟着
 *    `process.exit()` 会把它整段截掉 —— 实测这条提示一个字都没出来，
 *    于是只剩一个 130 在那儿，而 130 的全部意义就在这句话里。
 *    `writeSync(2, …)` 直接落到 fd 2，不经过那层缓冲。
 */
function onInterrupt(): void {
  // 结果已定：让退出码保持它本来的样子，中断只是让收尾早点结束
  if (isSettled()) return

  try {
    writeSync(
      2,
      '\n已中断等待。注意：已经发出去的请求可能仍在引擎里执行，结果无法确认 —— ' +
        '请去现场核实，不要直接重发。\n'
    )
  } catch {
    // 连 stderr 都写不了就算了，别让善后本身把进程搞崩
  }
  process.exit(130)
}

async function main(): Promise<void> {
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  const result = await run(process.argv.slice(2))

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  process.exitCode = result.exitCode
}

main().catch((error) => {
  // 走到这里说明 `run` 自己漏了一个异常 —— 它本该把所有异常都变成信封。
  // 兜底也要给个非零退出码，不能让一次崩溃看起来像成功。
  process.stderr.write(`uebox 内部错误：${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 8
})
