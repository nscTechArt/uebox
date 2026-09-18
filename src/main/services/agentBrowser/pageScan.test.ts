import { beforeEach, describe, expect, it } from 'vitest'

import {
  AGENT_BROWSER_WORLD_ID,
  buildPageAgentScript,
  formatSnapshot,
  pageAgent,
  type PageScanResult
} from './pageScan'

/**
 * 页面侧逻辑的单测。
 *
 * 之所以能这么测，是因为 `pageAgent` 被写成了自包含函数：注入页面时用它的源码，
 * 测试时直接调它本身。判断错了会点错东西的那几条 —— 标签匹配、敏感字段、
 * 遮挡校验 —— 全部在这里锁住。
 */

function setBody(html: string): void {
  document.body.innerHTML = html
}

function scan(): PageScanResult {
  const result = pageAgent({ kind: 'scan' })
  if (!result.ok) throw new Error('扫描不该失败：' + result.message)
  return result.data as PageScanResult
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { __unrealBoxBrowserRefs?: unknown }).__unrealBoxBrowserRefs
  // happy-dom 没有实现命中测试，按需在用例里替身
  delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint
})

describe('隔离世界编号', () => {
  it('既不是主世界 0，也不是 Electron 占用的 999', () => {
    expect(AGENT_BROWSER_WORLD_ID).toBeGreaterThan(0)
    expect(AGENT_BROWSER_WORLD_ID).not.toBe(999)
  })
})

describe('scan', () => {
  it('给链接、按钮和输入框编号，并按优先级取标签', () => {
    setBody(`
      <a href="/docs">快速开始</a>
      <button aria-label="打开导航">≡</button>
      <label for="q">搜索</label><input id="q" type="text">
      <input type="text" placeholder="邮箱">
      <select><option value="a">甲</option></select>
    `)

    const result = scan()

    expect(result.elements.map((e) => e.role)).toEqual([
      'link',
      'button',
      'textbox',
      'textbox',
      'combobox'
    ])
    // aria-label 优先于可见文本；关联 label 优先于 placeholder
    expect(result.elements[1].label).toBe('打开导航')
    expect(result.elements[2].label).toBe('搜索')
    expect(result.elements[3].label).toBe('邮箱')
    expect(result.elements[0].href).toBe('http://localhost:3000/docs')
  })

  it('隐藏、aria-hidden 和 inert 区域里的元素不进快照', () => {
    setBody(`
      <button style="display:none">隐藏</button>
      <button style="visibility:hidden">不可见</button>
      <button aria-hidden="true">辅助隐藏</button>
      <div inert><button>惰性区域</button></div>
      <button>真按钮</button>
    `)

    const labels = scan().elements.map((e) => e.label)

    expect(labels).toEqual(['真按钮'])
  })

  it('文件选择框连快照都不进 —— 这一版不做上传', () => {
    setBody('<input type="file"><button>提交</button>')

    expect(scan().elements.map((e) => e.role)).toEqual(['button'])
  })

  it('密码和支付字段进快照但标为敏感，禁用元素也标出来', () => {
    setBody(`
      <input type="password" name="password">
      <input type="text" name="cardNumber">
      <button disabled>不可点</button>
    `)

    const elements = scan().elements

    expect(elements[0].sensitive).toBe(true)
    expect(elements[1].sensitive).toBe(true)
    expect(elements[2].disabled).toBe(true)
  })

  it('非 http 链接不给 href，避免模型去跟随 javascript: 之类的地址', () => {
    setBody('<a href="javascript:alert(1)">点我</a>')

    expect(scan().elements[0].href).toBeUndefined()
  })

  it('页面里有 iframe 时如实上报', () => {
    // 不给 src：happy-dom 会真去加载它，而单测不发网络请求
    setBody('<iframe></iframe><button>确定</button>')

    expect(scan().hasIframe).toBe(true)
  })

  it('重新扫描会重建 ref 表，旧编号指向新元素', () => {
    setBody('<button>第一版</button>')
    scan()
    setBody('<button>第二版</button>')
    scan()

    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '第一版' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PAGE_CHANGED')
  })
})

describe('prepareClick', () => {
  it('标签对不上就拒绝 —— 用户批准的和要点的必须是同一个东西', () => {
    setBody('<button>下一页</button>')
    scan()
    setBody('<button>删除账号</button>')
    // 故意不重扫：ref 表还指着旧节点的位置，但节点已经换了
    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '下一页' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PAGE_CHANGED')
  })

  it('目标被浮层遮挡时拒绝，而不是点到遮挡物上', () => {
    setBody('<button>下一页</button><div id="banner">接受所有 Cookie</div>')
    scan()
    const banner = document.querySelector('#banner') as Element
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => banner

    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '下一页' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAGE_CHANGED')
      expect(result.message).toContain('遮挡')
    }
  })

  it('命中目标自身或其后代时放行，并给出中心点坐标', () => {
    setBody('<button><span id="inner">下一页</span></button>')
    scan()
    const inner = document.querySelector('#inner') as Element
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => inner

    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '下一页' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const data = result.data as { x: number; y: number; label: string }
      expect(data.label).toBe('下一页')
      expect(typeof data.x).toBe('number')
    }
  })

  it('链接要走 follow，不走点击', () => {
    setBody('<a href="https://example.com">文档</a>')
    scan()

    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '文档' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_ELEMENT')
  })

  it('禁用元素拒绝', () => {
    setBody('<button disabled>提交</button>')
    scan()

    const result = pageAgent({ kind: 'prepareClick', ref: 1, label: '提交' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_ELEMENT')
  })
})

describe('prepareType', () => {
  it('聚焦并清空原有内容，清空走原生 setter + input 事件', () => {
    setBody('<input id="q" type="text" placeholder="搜索" value="旧内容">')
    scan()
    const input = document.querySelector('#q') as HTMLInputElement
    let inputEvents = 0
    input.addEventListener('input', () => (inputEvents += 1))

    const result = pageAgent({ kind: 'prepareType', ref: 1, label: '搜索' })

    expect(result.ok).toBe(true)
    expect(input.value).toBe('')
    expect(inputEvents).toBe(1)
    expect(document.activeElement).toBe(input)
  })

  it('密码字段拒绝输入', () => {
    setBody('<input type="password" placeholder="密码">')
    scan()

    const result = pageAgent({ kind: 'prepareType', ref: 1, label: '密码' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SENSITIVE_FIELD')
  })

  it('按钮不能当输入框用', () => {
    setBody('<button>提交</button>')
    scan()

    const result = pageAgent({ kind: 'prepareType', ref: 1, label: '提交' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_ELEMENT')
  })
})

describe('select', () => {
  it('按 value 或可见文本选中，并派发 input/change', () => {
    setBody(`
      <select aria-label="版本">
        <option value="55">5.5</option>
        <option value="56">5.6</option>
      </select>`)
    scan()
    const select = document.querySelector('select') as HTMLSelectElement
    let changes = 0
    select.addEventListener('change', () => (changes += 1))

    const result = pageAgent({ kind: 'select', ref: 1, label: '版本', value: '5.6' })

    expect(result.ok).toBe(true)
    expect(select.value).toBe('56')
    expect(changes).toBe(1)
  })

  it('没有这个选项时明确报错', () => {
    setBody('<select aria-label="版本"><option value="55">5.5</option></select>')
    scan()

    const result = pageAgent({ kind: 'select', ref: 1, label: '版本', value: '6.0' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_ELEMENT')
  })
})

describe('linkHref', () => {
  it('返回绝对地址', () => {
    setBody('<a href="/docs/latest">文档</a>')
    scan()

    const result = pageAgent({ kind: 'linkHref', ref: 1, label: '文档' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data as { href: string }).href).toBe('http://localhost:3000/docs/latest')
    }
  })

  it('非链接引用拒绝跟随', () => {
    setBody('<button>确定</button>')
    scan()

    const result = pageAgent({ kind: 'linkHref', ref: 1, label: '确定' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_ELEMENT')
  })
})

describe('buildPageAgentScript', () => {
  it('注入的是完整函数体，不引用任何外部标识符', () => {
    const script = buildPageAgentScript({ kind: 'scan' })

    expect(script.startsWith('(function')).toBe(true)
    expect(script).toContain('"kind":"scan"')
    // 引用了模块作用域的常量就等于注入后必然 undefined，这里锁死几个典型名字
    expect(script).not.toContain('AGENT_BROWSER_WORLD_ID')
    expect(script).not.toContain('formatSnapshot')
  })

  /**
   * 真正把源码当成注入脚本跑一遍。
   *
   * 上面那条只是查了几个名字，而「不小心引用了模块作用域的东西」有无数种写法。
   * 这里用 `new Function` 在没有模块作用域的环境里执行它 —— 只要函数体里漏了
   * 一个外部标识符，这条就会以 ReferenceError 失败，和注入真实网页时的表现一致。
   */
  it('脱离模块作用域也能跑 —— 注入进网页时就是这个环境', () => {
    setBody('<button aria-label="确定">OK</button>')

    const run = new Function(`return ${buildPageAgentScript({ kind: 'scan' })}`) as () => {
      ok: boolean
      data: PageScanResult
    }
    const result = run()

    expect(result.ok).toBe(true)
    expect(result.data.elements[0].label).toBe('确定')
  })
})

describe('formatSnapshot', () => {
  it('把快照排成模型读得懂的几行，并提示 iframe', () => {
    const text = formatSnapshot({
      title: 'Electron 文档',
      url: 'https://www.electronjs.org/',
      hasIframe: true,
      elements: [
        { ref: 1, role: 'link', label: '快速开始', href: 'https://www.electronjs.org/docs' },
        { ref: 2, role: 'textbox', label: '密码', sensitive: true }
      ]
    })

    expect(text).toContain('Page: Electron 文档')
    expect(text).toContain('[ref=1] link "快速开始" → https://www.electronjs.org/docs')
    expect(text).toContain('敏感字段')
    expect(text).toContain('iframe')
  })
})
