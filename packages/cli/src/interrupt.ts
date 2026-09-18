/**
 * Ctrl+C 的边界：这一次到底还有没有「未知结局」。
 *
 * ## 为什么需要这么一个标记
 *
 * 真机上抓到的：一条 `viewport screenshot` 已经把图交付完、成功结果也打到
 * stdout 了，SIGINT 在收尾（关会话）那一刻到达，处理函数照样 `exit(130)` ——
 * 于是一次**完全成功**的操作对外报的是「用户中断，引擎结局不明」。
 *
 * 脚本和 Agent 只看退出码，它们会据此认定这活没干成，然后去重做一遍。
 * 而 130 的含义（见 §6.2）恰恰是「结局无法确认」—— 明明结局已经确认了，
 * 还说不确认，这是在制造一个不存在的不确定性。
 *
 * 所以：**结果一旦定下来，中断就不再改判**。此后的 Ctrl+C 只是让进程早点
 * 结束收尾工作，退出码沿用真实结果。
 *
 * 反过来，结果还没定下来时中断仍然报 130，并且必须说清楚「请求可能已经发到
 * 引擎了」—— 那种情况下的不确定性是真的。
 */

let settled = false

/**
 * 结果已经定下来了（信封已生成、退出码已知）。
 *
 * 由 `cli.ts` 的 `output()` 调用 —— 那是所有出口唯一的收口处，
 * 放在别处早晚会漏掉某条命令。
 */
export function markSettled(): void {
  settled = true
}

export function isSettled(): boolean {
  return settled
}

/** 测试用：把标记复位 */
export function resetSettledForTest(): void {
  settled = false
}
