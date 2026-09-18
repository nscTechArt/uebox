/**
 * 百度网盘的失败走响应体里的错误码，不走 HTTP 状态码。
 *
 * 红灯用例：token 过期之后，列目录返回 `HTTP 200 + errno -6 + 空 list`，
 * 原来的代码只看 HTTP → 一路 `return { success: true }` → 界面显示「这个文件夹是空的」；
 * 删除返回 errno 111 → 界面弹「删除成功」而网盘上什么都没变。用户看不出自己需要
 * 重新授权，只觉得网盘功能坏了。
 *
 * 这里锁的是「哪些响应必须被判成失败」，以及 token 类错误要单独可识别
 * （界面据此把人引到重新授权，而不是笼统报个错）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { assertBaiduOk, BAIDU_ASYNC_TASK_BUSY } from './baiduyunErrno'

describe('assertBaiduOk', () => {
  it('errno 0 或没有错误码都算成功', () => {
    expect(assertBaiduOk({ errno: 0 })).toEqual({ errno: 0 })
    expect(assertBaiduOk({})).toEqual({})
  })

  it('鉴权失效单独可识别 —— 界面要据此引导重新授权', () => {
    expect(() => assertBaiduOk({ errno: -6 })).toThrow('TOKEN_EXPIRED')
    // 读接口上的 111 仍按 token 失效处理，和改动之前一致
    expect(() => assertBaiduOk({ errno: 111 })).toThrow('TOKEN_EXPIRED')
  })

  /*
   * 111 在 `method=filemanager`（删除 / 移动 / 重命名，服务端异步任务）上的含义是
   * 「有其他异步任务正在执行」，是可重试的并发冲突。
   *
   * 一律判成鉴权失效的话：用户删一批文件，第一批的异步任务还没跑完就删第二批 →
   * 界面把他引去重新授权 → 授权完再删还是 111 → 他只会认为网盘功能坏了。
   * 而正确的下一步是等一会重试。
   */
  it('异步任务接口上的 111 是「上一批还在跑」，不是鉴权失效', () => {
    expect(() => assertBaiduOk({ errno: 111 }, { asyncTask: true })).toThrow(BAIDU_ASYNC_TASK_BUSY)
    // -6 不分档：那一条在哪个接口上都是 token 失效
    expect(() => assertBaiduOk({ errno: -6 }, { asyncTask: true })).toThrow('TOKEN_EXPIRED')
  })

  it('删除/移动/重命名那个出口传了 asyncTask', () => {
    const source = readFileSync(join(__dirname, 'baiduyun.ts'), 'utf8')
    // filemanager 是唯一一个异步任务接口；漏传的话症状不会抛异常，
    // 只会在真机上把并发冲突说成「请重新授权」
    expect(source).toMatch(
      /assertBaiduOk\(await postForm\(url, formParams\.toString\(\)\), \{\s*asyncTask: true\s*\}\)/
    )
  })

  it('其它业务错误码带上码和原文', () => {
    expect(() => assertBaiduOk({ errno: -9 })).toThrow('BAIDU_ERRNO_-9')
    expect(() => assertBaiduOk({ errno: 31034, errmsg: 'hit rate limit' })).toThrow(
      'BAIDU_ERRNO_31034: hit rate limit'
    )
  })

  /*
   * PCS 那几条接口（分片上传的 locateupload）用的是另一套字段名。
   * 只认 errno 的话，上传这条路仍旧是「HTTP 200 即成功」——
   * token 过期时照样回 success，而这正是整条改动要根除的形状。
   */
  it('PCS 接口的 error_code / error_msg 同样算失败', () => {
    expect(() => assertBaiduOk({ error_code: -6 })).toThrow('TOKEN_EXPIRED')
    expect(() => assertBaiduOk({ error_code: 31023, error_msg: 'invalid param' })).toThrow(
      'BAIDU_ERRNO_31023: invalid param'
    )
    expect(assertBaiduOk({ error_code: 0 })).toEqual({ error_code: 0 })
  })
})

describe('调用点', () => {
  const source = readFileSync(join(__dirname, 'baiduyun.ts'), 'utf8')

  /*
   * 判据只有挂在每一个出口上才有意义。少挂一个，那条接口就退回「HTTP 200 即成功」，
   * 而症状（空文件夹、假的删除成功）不会抛任何异常。
   */
  it('每个返回网盘数据的出口都过了 assertBaiduOk', () => {
    const rawReturns = source.match(/const data = await (getJson|postForm)\(/g) ?? []
    expect(rawReturns).toEqual([])

    const guarded = source.match(/assertBaiduOk\(await (getJson|postForm)\(/g) ?? []
    expect(guarded.length).toBeGreaterThanOrEqual(8)
  })
})
