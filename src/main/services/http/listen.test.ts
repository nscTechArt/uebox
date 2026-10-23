/** @vitest-environment node */
import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo, type Server } from 'node:net'
import type { Server as HttpServer } from 'node:http'

import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeHttpListenError, listenOnce, type Listenable } from './listen'

const opened: Array<Server | HttpServer> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))))
})

/** 先占住一个端口，返回它的端口号 */
async function occupyPort(): Promise<number> {
  const blocker = createServer()
  opened.push(blocker)
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
  return (blocker.address() as AddressInfo).port
}

describe('listenOnce', () => {
  /*
   * 钉的是 Express 5 的那条契约：listen 失败时 callback 也会被调用、错误是第一个参数。
   * 原来在 callback 里无条件报成功，这条用例在旧写法下会 resolve
   */
  it('端口被占时 reject，不报成功', async () => {
    const port = await occupyPort()
    await expect(listenOnce(express(), port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE'
    })
  })

  it('端口空着时给出正在监听的 server', async () => {
    const port = await occupyPort()
    // 释放占位，拿一个刚刚确认能绑的端口
    await new Promise((r) => opened.pop()!.close(() => r(undefined)))
    const server = await listenOnce(express(), port, '127.0.0.1')
    opened.push(server)
    expect(server.listening).toBe(true)
    expect((server.address() as AddressInfo).port).toBe(port)
  })

  it('系统保留端口（EACCES）走 callback 的错误参数：reject，并把半开的 server 关掉', async () => {
    const close = vi.fn((cb?: () => void) => cb?.())
    const fake: Listenable = {
      listen: (_port, _host, callback) => {
        const server = Object.assign(new EventEmitter(), { close }) as unknown as HttpServer
        const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1:8766'), {
          code: 'EACCES'
        })
        // 和 Express 5 一样：callback 和 error 事件都会收到这个错误
        setImmediate(() => {
          callback(error)
          server.emit('error', error)
        })
        return server
      }
    }

    const onLateError = vi.fn()
    await expect(listenOnce(fake, 8766, '127.0.0.1', onLateError)).rejects.toMatchObject({
      code: 'EACCES'
    })
    expect(close).toHaveBeenCalledTimes(1)
    // 同一个启动错误从 error 事件再来一次，不算「运行中出错」
    await new Promise((r) => setImmediate(r))
    expect(onLateError).not.toHaveBeenCalled()
  })

  it('监听成功之后的错误交给 onLateError，不悄悄吞掉', async () => {
    const onLateError = vi.fn()
    const server = await listenOnce(express(), 0, '127.0.0.1', onLateError)
    opened.push(server)
    const late = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    server.emit('error', late)
    expect(onLateError).toHaveBeenCalledWith(late)
  })
})

describe('describeHttpListenError', () => {
  it('EACCES 说出保留端口段、怎么查、改哪个变量', () => {
    const message = describeHttpListenError({ code: 'EACCES' }, 8766)
    expect(message).toContain('8766')
    expect(message).toContain('保留')
    expect(message).toContain('excludedportrange')
    expect(message).toContain('HTTP_PORT')
  })

  it('EADDRINUSE 说是被占，同样给出 HTTP_PORT', () => {
    const message = describeHttpListenError({ code: 'EADDRINUSE' }, 18766)
    expect(message).toContain('被别的程序占着')
    expect(message).toContain('HTTP_PORT')
  })

  it('别的错误带上原始信息', () => {
    expect(describeHttpListenError(new Error('boom'), 1)).toContain('boom')
  })
})
