/**
 * 一次同步写入该写多少行 —— 按上一片「写 + 提交」的实际耗时自适应。
 *
 * 只按时间截断行循环不够：提交（把这一片弄脏的页写进 WAL）发生在循环之后，而几十万行、
 * 二十几个索引的库上每插一行要弄脏二十几页，每页一次系统调用（Windows 上还要过杀毒软件的
 * 过滤驱动）。实测循环 40 ms、提交再要 100~250 ms —— 卡顿上限其实是提交说了算。
 *
 * 所以按「上一片总共花了多久」反推这一片写几行，把写 + 提交一起压在目标时长附近。
 * 机器快慢、库大小、杀毒软件都不用猜，测出来是多少就按多少调。
 */
export class AdaptiveSliceSizer {
  private current: number

  constructor(
    private readonly targetMs: number,
    private readonly min: number,
    private readonly max: number,
    initial: number
  ) {
    this.current = Math.min(max, Math.max(min, initial))
  }

  /** 下一片最多写几行 */
  get size(): number {
    return this.current
  }

  /** 记下一片的实际情况：写了几行、写 + 提交一共多少毫秒 */
  record(rows: number, elapsedMs: number): void {
    if (rows <= 0 || elapsedMs <= 0) return
    const ideal = (rows * this.targetMs) / elapsedMs
    // 一次最多放大一倍，免得一片偶然很快就把下一片放得过大
    const next = Math.min(ideal, this.current * 2)
    this.current = Math.round(Math.min(this.max, Math.max(this.min, next)))
  }
}
