/**
 * 百度网盘的失败不走 HTTP 状态码，走响应体里的错误码。
 *
 * 也就是说「HTTP 200 + errno: -6」是一次**失败**的调用。原来只看 HTTP，
 * 于是 token 过期之后：列目录返回 errno -6、list 为空 → 界面显示「这个文件夹是空的」；
 * 删除返回 errno 111 → 界面弹「删除成功」而网盘上什么都没变。用户看不出自己
 * 需要重新授权，只觉得网盘功能坏了。
 *
 * 常见码：0 成功；-6 鉴权失效；-9 文件不存在；2 参数错误；31034 请求过频。
 *
 * **111 要看是哪个接口**：在 list / uinfo 这些读接口上它表示 token 有问题，而在
 * `method=filemanager`（删除 / 移动 / 重命名，服务端是异步任务）上它的含义是
 * 「有其他异步任务正在执行」—— 一个**可重试的并发冲突**，不是鉴权失效。
 * 不分档的话，用户连着删两批文件就会被引去重新授权，授权完再删还是 111，
 * 他只会认为网盘功能坏了。见 `assertBaiduOk` 的 `asyncTask` 参数。
 *
 * **两套字段**：网盘开放接口（`pan.baidu.com/rest/2.0/xpan/*`）用 `errno`/`errmsg`，
 * 而 PCS 那几条（`d.pcs.baidu.com/rest/2.0/pcs/*`，分片上传的 locateupload 走这条）
 * 用的是 `error_code`/`error_msg`。只认 `errno` 的话，上传这条路仍旧是
 * 「HTTP 200 即成功」—— token 过期时照样回 success，正是这里要根除的那个形状。
 *
 * ## 为什么单独一个文件
 *
 * 它是个纯函数，但 `baiduyun.ts` 一进来就要拉起 electron 的 ipcMain。
 * 放在这里，测试直接 import 就能跑，不用从源码文本里把函数抠出来跑
 * —— 那种测法挂在代码的排版上，换个格式就红，跟行为对不对没关系。
 */

/** 两套字段都认：xpan 用 errno/errmsg，PCS 用 error_code/error_msg */
export interface BaiduResponseShape {
  errno?: number
  errmsg?: string
  /** PCS 接口的失败码，与 errno 等价 */
  error_code?: number
  /** PCS 接口的失败原文，与 errmsg 等价 */
  error_msg?: string
}

/** 服务端异步任务还没跑完，等一会重试即可 —— 不是鉴权失效，别去重新授权 */
export const BAIDU_ASYNC_TASK_BUSY = 'BAIDU_ASYNC_TASK_BUSY'

export interface AssertBaiduOptions {
  /**
   * 这是 `method=filemanager` 这类**服务端异步任务**接口吗（删除 / 移动 / 重命名）。
   *
   * 是的话 errno 111 判成「上一批还在跑」而不是鉴权失效。默认 false：
   * 读接口（list / uinfo / 分片上传）上 111 仍然按 token 失效处理，
   * 与改动之前一致。
   */
  asyncTask?: boolean
}

/**
 * 非 0 的错误码一律抛异常。
 *
 * @throws {Error} `TOKEN_EXPIRED`（鉴权失效，界面据此引导重新授权）、
 *   `BAIDU_ASYNC_TASK_BUSY`（可重试）或 `BAIDU_ERRNO_<码>[: 原文]`
 */
export function assertBaiduOk<T extends BaiduResponseShape>(
  data: T,
  options: AssertBaiduOptions = {}
): T {
  const code = typeof data?.errno === 'number' ? data.errno : data?.error_code
  if (typeof code !== 'number' || code === 0) return data
  if (code === -6) throw new Error('TOKEN_EXPIRED')
  if (code === 111) {
    throw new Error(options.asyncTask ? BAIDU_ASYNC_TASK_BUSY : 'TOKEN_EXPIRED')
  }
  const reason = data?.errmsg || data?.error_msg
  throw new Error(`BAIDU_ERRNO_${code}${reason ? `: ${reason}` : ''}`)
}
