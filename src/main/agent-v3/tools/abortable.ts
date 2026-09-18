/**
 * 让「停止」在工具还没跑完的时候就能生效。
 *
 * ## 用户看到的现象
 *
 * 点了停止按钮，界面转圈十几秒才停下来 —— 有时候久到用户以为按钮坏了，
 * 又连点几下。真机上最慢的一次是 `ue_screenshot` 带 `show_ui=true`：
 * 抬编辑器窗口最多 4 秒，插件那边等视口重绘 2 秒 × 15 次，我们这边再留
 * 8 秒余量让插件先说话 —— 加起来接近 40 秒，这 40 秒里停止按钮**完全没有反应**。
 *
 * ## 为什么会这样
 *
 * `agent.abort()` 只是把中止意图递给 pi 的循环，而 pi 检查这个意图的时机在
 * **当前工具返回之后**：`agent-loop.js` 的 `executeToolCallsSequential` 是
 * 先 `await tool.execute(...)`，再 `if (signal?.aborted) break`。所以「停得
 * 有多快」完全取决于工具自己肯不肯提前返回。
 *
 * 而工具基本上都不肯：`defineTool` 一直把 signal 放进了 `ctx`，但工具体里
 * 读它的只有个位数，其余全是「等引擎回话为止」；`adaptV2Tool` 更彻底，
 * 它连 signal 都没往下传，直接 `await` 存量工具跑完。
 *
 * 再往上一层，主进程的 `agent-v3:stop` 会**等会话真的收尾**才回话
 * （`activeRuns.drain`，上限 15 秒），界面又在等这个 IPC —— 于是工具卡多久，
 * 按钮就僵多久。
 *
 * ## 这里做的事
 *
 * 让「等工具」和「等中止」赛跑，谁先到算谁的。中止先到就当场抛
 * {@link ToolAbortedError}，pi 收下这个异常、紧接着看见 `signal.aborted`，
 * 循环立刻退出。停止从「等工具跑完」变成「下一个事件循环」。
 *
 * ## 赢了赛跑不等于把活撤了 —— 这是有意的
 *
 * 引擎已经开始渲的那一帧、已经发出去的 RPC，谁也收不回来。能撤的那一层
 * 各自撤（UE 的 RPC 走 `callRequest` 的 signal，会把暂存池里那条请求当场
 * 作废，后续步骤也就不会再发出去），撤不掉的就让它自己跑完，结果丢掉。
 *
 * 所以这条 tool result 写的是**「不知道做没做成」**，不是「已取消」。它会
 * 留在 transcript 里，用户下次接着聊时模型看得见 —— 写成「已取消」会让它
 * 以为那一步根本没发生，然后去重做一遍。那正是 `engineErrors.ts` 开头记的
 * 那类事故：超时的时候 Actor 可能已经生成了，按「失败」重试就会多出第二个。
 */

/**
 * 用户在这个工具跑完之前按了停止。
 *
 * 单独一个类型，好让调用方用 `instanceof` 把它和真正的失败分开 ——
 * 按错误文本判断是「今天能跑、改一个标点就静默失效」的接口。
 */
export class ToolAbortedError extends Error {
  constructor(toolName: string) {
    super(
      `用户停止了这一轮，${toolName} 没有等到结果。` +
        '这**不代表它没执行** —— 命令可能已经发到引擎并且生效了。' +
        '接着往下做之前先回读现场状态确认，不要直接当作没发生重做一遍。'
    )
    this.name = 'ToolAbortedError'
  }
}

/**
 * 跑一次工具，同时盯着中止信号。
 *
 * @param toolName 出现在错误信息里，用户和模型都看得见
 * @param signal pi 传给 `execute` 的那个信号；没有就退化成直接 await
 * @param run 真正干活的那段。已经中止时**根本不会被调用**
 */
export async function runAbortable<T>(
  toolName: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!signal) return run()
  // 已经停了就别再发一条命令出去。pi 通常会在下一个工具开始前自己退出循环，
  // 但同一批里并发派发的工具不走那条检查，只能在这里挡。
  if (signal.aborted) throw new ToolAbortedError(toolName)

  const work = run()

  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = (): void => reject(new ToolAbortedError(toolName))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    // 输掉赛跑的那个 promise 不需要再补 `.catch()`：`Promise.race` 已经给
    // 两边都挂上了处理函数，工具稍后失败也算「已处理」，不会变成主进程里的
    // unhandledRejection。
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
