import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeDoubaoSttFrame, describeError, resolveDoubaoSttUrl } from './doubaoStt'

/**
 * 这一组守的全是**错了也不报错**的东西。
 *
 * 二进制协议的每一个偏移量、每一个位宽错了，socket 照样连得上、音频照样发得出去，
 * 唯一的症状是「一个字都不出」—— 而那个症状指向厂商、指向密钥、指向麦克风，
 * 唯独不指向这里。
 */

/** 按文档拼一个服务端下行帧，用来验解包 */
function serverFrame(options: {
  messageType: number
  flags: number
  serialization: number
  compression: number
  sequence?: number
  errorCode?: number
  body: Buffer
}): Buffer {
  const header = Buffer.from([
    0b0001_0001,
    (options.messageType << 4) | options.flags,
    (options.serialization << 4) | options.compression,
    0x00
  ])
  const parts: Buffer[] = [header]
  if (options.errorCode !== undefined) {
    const code = Buffer.alloc(4)
    code.writeUInt32BE(options.errorCode, 0)
    parts.push(code)
  } else if (options.sequence !== undefined) {
    const sequence = Buffer.alloc(4)
    sequence.writeUInt32BE(options.sequence, 0)
    parts.push(sequence)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(options.body.length, 0)
  parts.push(size, options.body)
  return Buffer.concat(parts)
}

function jsonFrame(payload: unknown, sequence?: number): Buffer {
  return serverFrame({
    messageType: 0b1001,
    flags: sequence === undefined ? 0b0000 : 0b0001,
    serialization: 0b0001,
    compression: 0b0001,
    sequence,
    body: gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  })
}

describe('豆包语音识别下行帧', () => {
  it('解得出 gzip + JSON 的识别结果', () => {
    const decoded = decodeDoubaoSttFrame(jsonFrame({ result: { text: '你好' } }, 1))
    expect(decoded?.kind).toBe('response')
    expect(decoded?.payload).toEqual({ result: { text: '你好' } })
  })

  /**
   * 带不带序号是**由 flags 那一位决定的**，不是固定的。
   *
   * 按「一定有序号」写死的话，不带序号的那一包会把长度字段读在序号的位置上 ——
   * 得到一个天文数字的长度，`subarray` 截出空 Buffer，gunzip 抛错，
   * 而抛错的那条路把整条会话关掉了。用户看到的是「说一句就断」。
   */
  it('没有序号那一位时不跳过 4 个字节', () => {
    const decoded = decodeDoubaoSttFrame(jsonFrame({ result: { text: '无序号' } }))
    expect(decoded?.payload).toEqual({ result: { text: '无序号' } })
  })

  it('认得出错误帧，并把错误码带出来', () => {
    const frame = serverFrame({
      messageType: 0b1111,
      flags: 0b0000,
      serialization: 0b0001,
      compression: 0b0000,
      errorCode: 45000001,
      body: Buffer.from(JSON.stringify({ message: 'invalid resource id' }), 'utf8')
    })
    const decoded = decodeDoubaoSttFrame(frame)
    expect(decoded?.kind).toBe('error')
    expect(decoded?.code).toBe(45000001)
  })

  /** 不压缩也是协议里的合法取值。当成 gzip 去解会抛，而抛的代价是整条会话 */
  it('负载没压缩时原样读出来', () => {
    const frame = serverFrame({
      messageType: 0b1001,
      flags: 0b0000,
      serialization: 0b0001,
      compression: 0b0000,
      body: Buffer.from(JSON.stringify({ result: { text: '未压缩' } }), 'utf8')
    })
    expect(decodeDoubaoSttFrame(frame)?.payload).toEqual({ result: { text: '未压缩' } })
  })

  it('半包不抛，回 null', () => {
    expect(decodeDoubaoSttFrame(Buffer.from([0x11, 0x90]))).toBeNull()
  })

  /**
   * 最后一包结果是 flags 第二位标的（0b0011 = 有序号 + 最后一包）。认不出它的话，
   * 松手之后只能干等服务端关连接 —— 它不一定关，每次松手就白等两秒兜底
   */
  it('认得出「最后一包」', () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ result: { text: '完' } }), 'utf8'))
    const frame = (flags: number): Buffer =>
      serverFrame({
        messageType: 0b1001,
        flags,
        serialization: 0b0001,
        compression: 0b0001,
        sequence: 3,
        body
      })
    expect(decodeDoubaoSttFrame(frame(0b0011))?.last).toBe(true)
    expect(decodeDoubaoSttFrame(frame(0b0001))?.last).toBe(false)
  })
})

describe('地址归一化', () => {
  it('只填域名时补上识别接口的路径', () => {
    expect(resolveDoubaoSttUrl('https://openspeech.bytedance.com')).toBe(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
    )
  })

  /** 用户粘完整地址是常事，再补一次路径就成了 /sauc/bigmodel/api/v3/sauc/bigmodel */
  it('已经是完整地址就不动它', () => {
    expect(resolveDoubaoSttUrl('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async')).toBe(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
    )
  })
})

describe('错误码翻译', () => {
  /** 翻译过的那句话在文档里搜不到，所以码本身必须留着 */
  it('把码一起交出去', () => {
    expect(describeError(45000001, {})).toContain('45000001')
    expect(describeError(undefined, 'boom')).toContain('boom')
  })
})
