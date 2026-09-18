import { describe, expect, it } from 'vitest'

import { judgeResults, tokenizeQuery } from './searchRelevance'

/**
 * 判据只在一个方向上是硬的：**整批零命中才判失败**。
 *
 * 所以这里的用例分两类 —— 真实抓到过的垃圾必须被判出来，正常结果绝不能误伤。
 */

const item = (
  title: string,
  url: string,
  snippet = ''
): { title: string; url: string; snippet: string } => ({
  title,
  url,
  snippet
})

describe('tokenizeQuery', () => {
  it('英文按词切，去掉停用词', () => {
    const tokens = tokenizeQuery('What is the tallest mountain in the world')
    expect(tokens).toContain('tallest')
    expect(tokens).toContain('mountain')
    // world 看起来普通，但能定位内容，故意不收进停用词表
    expect(tokens).toContain('world')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('is')
  })

  it('中文按 2-gram 切 —— 单字太容易撞上无关内容', () => {
    const tokens = tokenizeQuery('事件分发器')
    expect(tokens).toContain('事件')
    expect(tokens).toContain('分发')
    expect(tokens).toContain('发器')
  })

  /**
   * `site:` 要留域名丢前缀：域名恰恰是最该出现在结果网址里的信号，
   * 整段扔掉等于把最强的判据丢了。
   */
  it('site: 保留域名，filetype: 整个丢掉', () => {
    expect(tokenizeQuery('site:dev.epicgames.com nanite')).toContain('dev.epicgames.com')
    expect(tokenizeQuery('lumen filetype:pdf')).not.toContain('pdf')
  })

  it('减号排除项不参与命中判断', () => {
    expect(tokenizeQuery('nanite -fortnite')).not.toContain('fortnite')
  })

  it('技术标识里的下划线和双冒号不会被切碎', () => {
    const tokens = tokenizeQuery('ConstructorHelpers::FObjectFinder')
    expect(tokens).toContain('constructorhelpers')
    expect(tokens).toContain('fobjectfinder')
  })
})

describe('judgeResults', () => {
  it('真实抓到过的垃圾：查 UE C++ API 回来银行和桌宠，整批判为对不上', () => {
    const report = judgeResults('"FObjectFinder" "ConstructorHelpers" Unreal C++', [
      item('Login Page for BambooHR Users', 'https://www.bamboohr.com/login'),
      item('Releases · ayangweb/BongoCat - GitHub', 'https://github.com/ayangweb/BongoCat'),
      item('신한은행 기업인터넷뱅킹', 'https://bizbank.shinhan.com/main.html')
    ])

    expect(report.allUnclear).toBe(true)
    expect(report.matched).toBe(0)
  })

  it('真实抓到过的正常结果不会被误伤', () => {
    const report = judgeResults('虚幻引擎 蓝图 事件分发器 教程', [
      item(
        '虚幻引擎事件分发器 | 虚幻引擎 5.8 文档',
        'https://dev.epicgames.com/documentation/zh-cn/unreal-engine/event-dispatchers'
      ),
      item('UE4蓝图通信-事件分发器', 'https://blog.csdn.net/Motarookie/article/details/121635692')
    ])

    expect(report.allUnclear).toBe(false)
    expect(report.matched).toBe(2)
  })

  it('对照组：高频词查询的真实结果全部命中', () => {
    const report = judgeResults('Python programming language official website', [
      item('Welcome to Python.org', 'https://www.python.org/'),
      item('Download Python | Python.org', 'https://www.python.org/downloads/')
    ])

    expect(report.matched).toBe(2)
  })

  it('命中可以来自网址 —— site: 查询的结果标题里常常没有域名', () => {
    const report = judgeResults('site:dev.epicgames.com nanite', [
      item('Nanite 虚拟化几何体', 'https://dev.epicgames.com/documentation/unreal-engine/nanite')
    ])

    expect(report.matched).toBe(1)
  })

  it('逐条标注，好坏混在一起时只标坏的那条', () => {
    const report = judgeResults('虚幻引擎 事件分发器', [
      item('虚幻引擎事件分发器', 'https://dev.epicgames.com/doc'),
      item('Login Page for BambooHR Users', 'https://www.bamboohr.com/login')
    ])

    expect(report.items[0].relevance).toBe('ok')
    expect(report.items[1].relevance).toBe('unclear')
    expect(report.allUnclear).toBe(false)
  })

  /**
   * 空结果是「没有结果」，和「一批对不上的结果」是两回事，
   * 由调用方分别处理 —— 混在一起会让错误信息误导人。
   */
  it('空结果不算「整批对不上」', () => {
    expect(judgeResults('任何词', []).allUnclear).toBe(false)
  })

  /** 判据用不上的时候不许下判断，否则会把正常结果全标成存疑 */
  it('查询切不出任何词时一律放行', () => {
    const report = judgeResults('!!! ???', [item('随便什么', 'https://example.com')])

    expect(report.items[0].relevance).toBe('ok')
    expect(report.allUnclear).toBe(false)
  })
})
