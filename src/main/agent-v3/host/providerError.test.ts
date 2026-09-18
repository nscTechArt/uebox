/**
 * 模型报错要能被分类，否则那串 JSON 就直接糊到用户脸上。
 *
 * 红灯用例：密钥填错 → 界面显示
 * `错误: 401: {"error":{"message":"Incorrect API key provided: sk-xxx…","code":"invalid_api_key"}}`，
 * 下面还挂一个「接着跑」按钮 —— 点一次报一次，因为密钥不会自己变对。
 *
 * 渲染层按 `statusCode` 分类的友好文案早就写好了，缺的只是这几个字段。
 * 这里锁的是「三种形状都要抠得出来」和「抠不出来时宁可不填」。
 */
import { describe, expect, it } from 'vitest'

import { classifyProviderError } from './providerError'

describe('classifyProviderError', () => {
  it('pi 拼的「状态码: 体」', () => {
    const facts = classifyProviderError(
      '401: {"error":{"message":"Incorrect API key provided: sk-abc***","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}'
    )
    expect(facts.statusCode).toBe(401)
    expect(facts.code).toBe('invalid_api_key')
    expect(facts.detail).toBe('Incorrect API key provided: sk-abc***')
  })

  it('pi 拼的「前缀 (状态码): 体」', () => {
    const facts = classifyProviderError(
      'OpenRouter (429): {"error":{"message":"Rate limit exceeded","code":"rate_limit_exceeded"}}'
    )
    expect(facts.statusCode).toBe(429)
    expect(facts.code).toBe('rate_limit_exceeded')
  })

  it('SDK 自己折进 message 的「状态码 体」', () => {
    const facts = classifyProviderError(
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    )
    expect(facts.statusCode).toBe(529)
    // Anthropic 那层没有 code，退回 type —— 它同样是可分类的标识
    expect(facts.code).toBe('overloaded_error')
    expect(facts.detail).toBe('Overloaded')
  })

  it('平铺的体也认', () => {
    const facts = classifyProviderError('402: {"message":"余额不足","code":"INSUFFICIENT_BALANCE"}')
    expect(facts).toEqual({ statusCode: 402, code: 'INSUFFICIENT_BALANCE', detail: '余额不足' })
  })

  it('抠不出来就什么都不填 —— 猜一个错的状态码比不猜更糟', () => {
    // 网络层的错没有 HTTP 状态码；渲染层另有一套按文案匹配的判断接着它
    expect(classifyProviderError('connect ECONNREFUSED 127.0.0.1:11434')).toEqual({})
    expect(classifyProviderError('Stream ended without finish_reason')).toEqual({})
    expect(classifyProviderError('')).toEqual({})
  })

  it('不把正文里碰巧出现的三位数当状态码', () => {
    // 「200」在开头但不是状态码形状（没有冒号、后面不是 JSON）
    expect(classifyProviderError('200 tokens exceeded the limit').statusCode).toBeUndefined()
    // 2xx/3xx 不是错误状态码
    expect(classifyProviderError('204: {"error":{"message":"x"}}').statusCode).toBeUndefined()
  })

  it('体是 HTML 时给出状态码，并剥成一句人话', () => {
    const facts = classifyProviderError('502: <html><body>Bad Gateway</body></html>')
    expect(facts.statusCode).toBe(502)
    expect(facts.detail).toBe('Bad Gateway')
  })

  /**
   * 网关直吐的那种：**状态码后面既没有冒号也没有 JSON**。
   *
   * 真机上撞到过 —— openresty 的 413。原来三条形状一个都匹配不上，状态码抠
   * 不出来，渲染层那套按状态码分类的文案全部落空，而 `detail` 为空又会退回
   * 原文，于是聊天框里**渲染出了半张网页**：一个大标题、一条横线、一行
   * `openresty` 落款。用户完全看不出发生了什么。
   */
  it('网关直吐的 413 也认，且不把整页 HTML 甩给界面', () => {
    const facts = classifyProviderError(
      '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
        '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
        '<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n'
    )

    expect(facts.statusCode).toBe(413)
    expect(facts.detail).toBe('413 Request Entity Too Large')
    expect(facts.detail).not.toContain('<')
  })

  it('HTML 里没有 title 时退回第一行可读文本', () => {
    const facts = classifyProviderError(
      '503 <html><body><h1>Service Unavailable</h1></body></html>'
    )

    expect(facts.statusCode).toBe(503)
    expect(facts.detail).toBe('Service Unavailable')
  })

  // JSON 解得出来就以它为准，别被正文里碰巧出现的尖括号带跑
  it('JSON 体优先于 HTML 兜底', () => {
    const facts = classifyProviderError('400: {"error":{"message":"bad <tag> here"}}')

    expect(facts.detail).toBe('bad <tag> here')
  })

  /**
   * 体解得出 JSON 就只认它。解得出来却没有 message，那是这家没给人话，
   * 不是「可以退回去当 HTML 读」—— 退的话会从 JSON 里那个尖括号开始乱剥，
   * 聊天框里显示「错误: "}」。
   */
  it('JSON 体里出现 HTML 标签也不当网页读', () => {
    const facts = classifyProviderError('502: {"code":"upstream_error","detail":"<html>"}')

    expect(facts.statusCode).toBe(502)
    expect(facts.detail).toBeUndefined()
  })

  /**
   * 状态码后面必须真的跟着 HTML。写成「跟着任何非空白」的话，
   * `500 tokens remaining…` 会被读成一次 HTTP 500，而 `413 …` 开头的任意一句
   * 还会被出口闸当成真 413，把那家厂商的预算永久调低。
   */
  it('开头的三位数不是状态码时不认', () => {
    expect(classifyProviderError('500 tokens remaining in your quota').statusCode).toBeUndefined()
    expect(
      classifyProviderError('413 characters is over the field limit').statusCode
    ).toBeUndefined()
  })

  /**
   * 网关把 413 的体丢了，或者只回一句纯文本 —— SDK 这时自己拼一句。
   * 认不出来的话界面退回通用文案，出口闸也再学不到这家的上限
   * （它只在状态码等于 413 时才记）。
   */
  it.each([
    ['413 status code (no body)'],
    ['413 Payload Too Large'],
    ['413 Request Entity Too Large']
  ])('没有体的 413 也认得出来：%s', (text) => {
    expect(classifyProviderError(text).statusCode).toBe(413)
  })

  /**
   * pi 给一部分厂商的错误加前缀（`OpenAI API error (413): …`，见文件头第二种形状）。
   * 只认裸状态码的话这些厂商的 HTML 体一个都剥不出来，detail 为空，
   * 渲染层退回原文 —— 聊天框里又是半张网页。
   */
  it('带厂商前缀的 HTML 体照样剥成一句话', () => {
    const facts = classifyProviderError(
      'OpenAI API error (413): <html><head><title>413 Request Entity Too Large</title></head></html>'
    )

    expect(facts.statusCode).toBe(413)
    expect(facts.detail).toBe('413 Request Entity Too Large')
  })

  // 换行会在第一个内联标签处把话截断，而数字和单位正是唯一有用的部分
  it('内联标签不截断那句话', () => {
    const facts = classifyProviderError(
      '502 <html><body>Request body too large: <b>4700000</b> bytes</body></html>'
    )

    expect(facts.detail).toBe('Request body too large: 4700000 bytes')
  })

  // 没有 title 的网关页退回可读文本时，不能把 <style> 里的 CSS 当成那句人话
  it('不把 CSS 当成错误说明', () => {
    const facts = classifyProviderError(
      '502 <html><head><style>body{font-family:Arial;color:#111}</style></head>' +
        '<body><h1>Bad gateway</h1></body></html>'
    )

    expect(facts.detail).toBe('Bad gateway')
  })
})
