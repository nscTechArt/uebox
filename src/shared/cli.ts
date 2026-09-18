/**
 * uebox 命令行的状态形状，主进程和渲染层共用一份。
 *
 * CLI 随安装包发、跑在盒子外面，盒子这边只回答
 * 三件事：它在哪、在不在 PATH 里、能不能一键改。
 */

export interface CliStatus {
  /** 这个平台/这次安装到底有没有带 CLI */
  available: boolean
  /** `uebox.cmd` 的完整路径。没带就是 null */
  path: string | null
  /** 它所在的目录 —— 加进 PATH 的就是这个 */
  directory: string | null
  /**
   * 已经在用户 PATH 里了吗。
   *
   * **查不了时是 `null`，不是 `false`。** 把「查不出来」显示成「不在 PATH 里」，
   * 用户点了「加入」再失败一次，而他始终不知道真正的问题是读注册表失败。
   */
  onPath: boolean | null
  /** 为什么用不了 / 查不了，一句给用户看的话 */
  reason?: string
}

export interface CliPathChangeResult {
  ok: boolean
  /** 改完之后的状态，界面直接拿去刷新 */
  status: CliStatus
  /** 失败原因，或者「本来就已经是这样了」 */
  message?: string
}
