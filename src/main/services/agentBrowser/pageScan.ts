/**
 * 在网页里跑的那段代码。
 *
 * ## 为什么写成一个自包含函数
 *
 * 它要通过 `executeJavaScriptInIsolatedWorld()` 注入进远程页面，注入的形式是
 * **源码字符串** —— 所以这个函数不能引用模块作用域里的任何常量或工具函数，
 * 否则注进去就是一堆 `undefined`。代价是里面的选择器、敏感字段判据全部内联。
 *
 * 换来的是：同一个函数在 vitest（happy-dom）里能直接调用。页面扫描、标签提取、
 * 敏感字段判定、遮挡校验这些「判断错了会点错东西」的逻辑，因此全部可测 ——
 * 如果写成拼接字符串的脚本，这些分支一条都测不到。
 *
 * ## 只扫主框架
 *
 * `executeJavaScriptInIsolatedWorld` 作用于主框架，iframe（同源或跨域）都不扫。
 * 扫描结果里会带 `hasIframe`，让模型知道「这块要用户自己来」，而不是以为页面
 * 上就这些元素。
 */

/**
 * 隔离世界编号。
 *
 * 不能用 0（主世界，会和页面自己的脚本共享 `globalThis`，ref 表可能被页面读到
 * 甚至篡改），也不能用 999（Electron contextIsolation 自己占着）。
 */
export const AGENT_BROWSER_WORLD_ID = 1001

/** 快照里一个可交互元素 */
export interface ScannedElement {
  ref: number
  /** link / button / textbox / checkbox / radio / combobox / editable */
  role: string
  label: string
  /** 只有链接有，且一定是 http/https 绝对地址 */
  href?: string
  /** 密码、支付这类字段：进快照让模型知道有，但交互会被拒 */
  sensitive?: boolean
  disabled?: boolean
}

export interface PageScanResult {
  title: string
  url: string
  elements: ScannedElement[]
  /** 页面里有 iframe —— 那部分内容和元素这一版看不见 */
  hasIframe: boolean
}

export type PageAgentCommand =
  | { kind: 'scan' }
  | { kind: 'html' }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount: number }
  | { kind: 'prepareClick'; ref: number; label: string }
  | { kind: 'prepareType'; ref: number; label: string }
  | { kind: 'select'; ref: number; label: string; value: string }
  | { kind: 'linkHref'; ref: number; label?: string }

/** 页面侧错误码。与 `index.ts` 的工具错误码同名，直接透出去 */
export type PageAgentErrorCode =
  | 'PAGE_CHANGED'
  | 'UNSUPPORTED_ELEMENT'
  | 'SENSITIVE_FIELD'
  | 'CONTENT_EMPTY'

export type PageAgentResult =
  | { ok: true; data: unknown }
  | { ok: false; code: PageAgentErrorCode; message: string }

/**
 * 注入到页面里执行的主体。
 *
 * **改这个函数时记住：它不能引用外面的任何东西。** 所有常量都必须写在函数体内。
 */
export function pageAgent(command: PageAgentCommand): PageAgentResult {
  const SELECTOR =
    'a[href], button, input:not([type="hidden"]), textarea, select,' +
    ' [role="button"], [role="link"], [contenteditable="true"]'
  const MAX_LABEL = 80
  const SENSITIVE_PATTERN =
    /pass(word|wd)?|pwd|secret|token|otp|one-?time|verif|captcha|card(number|no)?|credit|cvv|cvc|iban|swift|ssn|密码|口令|验证码|银行卡|信用卡|身份证/i
  const SENSITIVE_AUTOCOMPLETE = /cc-|current-password|new-password|one-time-code/i
  const TEXT_INPUT_TYPES = [
    'text',
    'search',
    'email',
    'url',
    'tel',
    'number',
    'date',
    'time',
    'datetime-local',
    'month',
    'week',
    ''
  ]

  const store = globalThis as unknown as {
    __unrealBoxBrowserRefs?: Map<number, Element>
  }

  function normalize(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LABEL)
  }

  function attr(element: Element, name: string): string {
    const value = element.getAttribute(name)
    return value ? value : ''
  }

  function labelOf(element: Element): string {
    const aria = normalize(attr(element, 'aria-label'))
    if (aria) return aria

    const id = element.getAttribute('id')
    if (id) {
      // CSS.escape 在老页面里未必有，用属性选择器的引号写法自己兜
      const labelled = element.ownerDocument.querySelector('label[for="' + id + '"]')
      if (labelled) {
        const text = normalize(labelled.textContent || '')
        if (text) return text
      }
    }

    const parentLabel = element.closest ? element.closest('label') : null
    if (parentLabel) {
      const text = normalize(parentLabel.textContent || '')
      if (text) return text
    }

    const alt = normalize(attr(element, 'alt'))
    if (alt) return alt

    const placeholder = normalize(attr(element, 'placeholder'))
    if (placeholder) return placeholder

    const title = normalize(attr(element, 'title'))
    if (title) return title

    const text = normalize(element.textContent || '')
    if (text) return text

    return normalize(attr(element, 'name'))
  }

  function roleOf(element: Element): string {
    const tag = element.tagName.toLowerCase()
    const explicit = attr(element, 'role').toLowerCase()

    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = attr(element, 'type').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'file') return 'file'
      if (type === 'password') return 'textbox'
      return 'textbox'
    }
    if (explicit === 'link') return 'link'
    if (explicit === 'button') return 'button'
    if (attr(element, 'contenteditable') === 'true') return 'editable'
    return explicit || tag
  }

  function isSensitive(element: Element): boolean {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input') {
      const type = attr(element, 'type').toLowerCase()
      if (type === 'password' || type === 'file') return true
    }
    if (SENSITIVE_AUTOCOMPLETE.test(attr(element, 'autocomplete'))) return true

    const haystack = [
      attr(element, 'name'),
      attr(element, 'id'),
      attr(element, 'aria-label'),
      attr(element, 'placeholder')
    ].join(' ')
    return SENSITIVE_PATTERN.test(haystack)
  }

  function isDisabled(element: Element): boolean {
    if ((element as HTMLInputElement).disabled === true) return true
    return attr(element, 'aria-disabled') === 'true'
  }

  /**
   * 这个文档有没有真正的排版引擎。
   *
   * 真实 Chromium 里 body 一定有尺寸；单测用的 happy-dom 不做排版，**所有**
   * 矩形都是 0。不区分这两种情况的话，「零尺寸元素要过滤」这条规则会在测试里
   * 把每个元素都滤掉 —— 扫描逻辑等于一条都没测到。
   */
  function hasLayout(): boolean {
    if (!document.body) return false
    const rect = document.body.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  const layoutAvailable = hasLayout()

  function isVisible(element: Element): boolean {
    if (!element.isConnected) return false
    if (attr(element, 'aria-hidden') === 'true') return false
    if (element.closest && element.closest('[inert]')) return false

    const view = element.ownerDocument.defaultView
    if (view && view.getComputedStyle) {
      const style = view.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }

    if (!layoutAvailable) return true

    const rect = element.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  function absoluteHref(element: Element): string {
    const raw = attr(element, 'href')
    if (!raw) return ''
    try {
      const resolved = new URL(raw, element.ownerDocument.baseURI)
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return ''
      return resolved.toString()
    } catch {
      return ''
    }
  }

  function scan(): PageScanResult {
    const refs = new Map<number, Element>()
    const elements: ScannedElement[] = []
    const nodes = document.querySelectorAll(SELECTOR)

    let next = 1
    for (let i = 0; i < nodes.length; i++) {
      const element = nodes[i]
      if (!isVisible(element)) continue

      const role = roleOf(element)
      // 文件选择框连快照都不进：这一版不做上传，让模型看见只会让它反复尝试
      if (role === 'file') continue

      const disabled = isDisabled(element)
      const entry: ScannedElement = {
        ref: next,
        role,
        label: labelOf(element)
      }
      if (role === 'link') {
        const href = absoluteHref(element)
        if (href) entry.href = href
      }
      if (isSensitive(element)) entry.sensitive = true
      if (disabled) entry.disabled = true

      refs.set(next, element)
      elements.push(entry)
      next += 1
    }

    store.__unrealBoxBrowserRefs = refs

    return {
      title: document.title || '',
      url: document.location ? document.location.href : '',
      elements,
      hasIframe: document.querySelectorAll('iframe, frame').length > 0
    }
  }

  function fail(code: PageAgentErrorCode, message: string): PageAgentResult {
    return { ok: false, code, message }
  }

  /** 交互前的公共校验：ref 还在不在、是不是同一个元素、能不能碰 */
  function resolveRef(
    ref: number,
    expectedLabel: string | undefined
  ): { ok: true; element: Element; label: string } | PageAgentResult {
    const refs = store.__unrealBoxBrowserRefs
    if (!refs || !refs.has(ref)) {
      return fail('PAGE_CHANGED', '元素引用已失效，请重新读取交互快照。')
    }

    const element = refs.get(ref) as Element
    if (!element.isConnected) {
      return fail('PAGE_CHANGED', '该元素已经不在页面上，请重新读取交互快照。')
    }
    if (!isVisible(element)) {
      return fail('PAGE_CHANGED', '该元素已经不可见，请重新读取交互快照。')
    }

    const label = labelOf(element)
    if (expectedLabel !== undefined && expectedLabel !== '') {
      const expected = normalize(expectedLabel)
      if (expected !== label) {
        return fail(
          'PAGE_CHANGED',
          '页面已经变了：这个引用现在指向「' + label + '」，不是你要操作的「' + expected + '」。'
        )
      }
    }

    if (isDisabled(element)) {
      return fail('UNSUPPORTED_ELEMENT', '该元素处于禁用状态，无法操作。')
    }

    return { ok: true, element, label }
  }

  function prepareClick(ref: number, expectedLabel: string): PageAgentResult {
    const resolved = resolveRef(ref, expectedLabel)
    if (!('element' in resolved)) return resolved
    const element = resolved.element

    if (isSensitive(element)) {
      return fail('SENSITIVE_FIELD', '这是密码、支付或文件类控件，请让用户自己操作。')
    }
    if (roleOf(element) === 'link') {
      return fail(
        'UNSUPPORTED_ELEMENT',
        '这是链接，请用 browser_navigate 的 follow 跟随，不要用点击。'
      )
    }

    if (element.scrollIntoView) element.scrollIntoView({ block: 'center', inline: 'center' })

    // 滚动之后坐标已经变了，必须重新取
    const rect = element.getBoundingClientRect()
    if (layoutAvailable && (rect.width <= 0 || rect.height <= 0)) {
      return fail('PAGE_CHANGED', '该元素当前没有可点击的区域，请重新读取交互快照。')
    }

    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const view = element.ownerDocument.defaultView
    const viewportWidth = view ? view.innerWidth : 0
    const viewportHeight = view ? view.innerHeight : 0
    if (viewportWidth > 0 && viewportHeight > 0) {
      if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) {
        return fail('PAGE_CHANGED', '该元素滚动后仍不在可视区域内，请重新读取交互快照。')
      }
    }

    // 命中校验：点击是按坐标派发的，而坐标上盖着什么由页面说了算。
    // 不校验的话，审批弹窗写着「点击 下一页」，实际点中的可能是 Cookie 横幅。
    if (document.elementFromPoint) {
      const hit = document.elementFromPoint(x, y)
      if (hit && hit !== element && !element.contains(hit)) {
        return fail(
          'PAGE_CHANGED',
          '该位置被其他元素遮挡（' +
            labelOf(hit) +
            '），没有点击。请重新读取交互快照，或先关掉遮挡它的浮层。'
        )
      }
    }

    return { ok: true, data: { x, y, label: resolved.label } }
  }

  function prepareType(ref: number, expectedLabel: string): PageAgentResult {
    const resolved = resolveRef(ref, expectedLabel)
    if (!('element' in resolved)) return resolved
    const element = resolved.element

    if (isSensitive(element)) {
      return fail('SENSITIVE_FIELD', '这是密码、支付或验证码字段，请让用户自己填写。')
    }

    const tag = element.tagName.toLowerCase()
    const editable = attr(element, 'contenteditable') === 'true'
    const type = attr(element, 'type').toLowerCase()
    const typable =
      tag === 'textarea' || editable || (tag === 'input' && TEXT_INPUT_TYPES.indexOf(type) !== -1)
    if (!typable) {
      return fail('UNSUPPORTED_ELEMENT', '这个控件不能输入文本。')
    }

    if (element.scrollIntoView) element.scrollIntoView({ block: 'center', inline: 'center' })
    ;(element as HTMLElement).focus()

    // 先清空再让 CDP 插入：直接追加会把原有内容和新内容拼在一起。
    // 清空走原生 setter + input 事件，Vue / React 才收得到变化。
    if (tag === 'input' || tag === 'textarea') {
      const proto =
        tag === 'input'
          ? (globalThis as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement
              .prototype
          : (globalThis as unknown as { HTMLTextAreaElement: { prototype: object } })
              .HTMLTextAreaElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, '')
      } else {
        ;(element as HTMLInputElement).value = ''
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (editable) {
      element.textContent = ''
    }

    return { ok: true, data: { label: resolved.label } }
  }

  function applySelect(ref: number, expectedLabel: string, value: string): PageAgentResult {
    const resolved = resolveRef(ref, expectedLabel)
    if (!('element' in resolved)) return resolved
    const element = resolved.element

    if (element.tagName.toLowerCase() !== 'select') {
      return fail('UNSUPPORTED_ELEMENT', '这不是下拉选择框。')
    }

    const select = element as HTMLSelectElement
    const options = select.options
    let matched = -1
    for (let i = 0; i < options.length; i++) {
      const option = options[i]
      if (option.value === value || normalize(option.textContent || '') === normalize(value)) {
        matched = i
        break
      }
    }
    if (matched === -1) {
      return fail('UNSUPPORTED_ELEMENT', '下拉框里没有这个选项：' + value)
    }

    select.selectedIndex = matched
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))

    return { ok: true, data: { label: resolved.label, value: options[matched].value } }
  }

  function linkHref(ref: number, expectedLabel: string | undefined): PageAgentResult {
    const resolved = resolveRef(ref, expectedLabel)
    if (!('element' in resolved)) return resolved

    const href = absoluteHref(resolved.element)
    if (!href) {
      return fail('UNSUPPORTED_ELEMENT', '这个引用不是一个可跟随的普通链接。')
    }
    return { ok: true, data: { href, label: resolved.label } }
  }

  if (command.kind === 'scan') {
    return { ok: true, data: scan() }
  }
  if (command.kind === 'html') {
    const html = document.documentElement ? document.documentElement.outerHTML : ''
    if (!html) return fail('CONTENT_EMPTY', '页面还没有内容。')
    return { ok: true, data: { html: html, url: document.location ? document.location.href : '' } }
  }
  if (command.kind === 'scroll') {
    const view = globalThis as unknown as Window
    const delta = command.direction === 'up' ? -command.amount : command.amount
    if (view.scrollBy) view.scrollBy(0, delta)
    return {
      ok: true,
      data: { scrollY: typeof view.scrollY === 'number' ? view.scrollY : 0 }
    }
  }
  if (command.kind === 'prepareClick') return prepareClick(command.ref, command.label)
  if (command.kind === 'prepareType') return prepareType(command.ref, command.label)
  if (command.kind === 'select') return applySelect(command.ref, command.label, command.value)
  if (command.kind === 'linkHref') return linkHref(command.ref, command.label)

  return fail('UNSUPPORTED_ELEMENT', '不支持的页面操作。')
}

/**
 * 拼出注入用的源码。
 *
 * 每次都注入完整函数体而不是「先安装再调用」：隔离世界的 `globalThis` 在导航后
 * 会重建，安装式的写法要额外判断存不存在，而 ref 表本来就该跟着页面一起失效。
 */
export function buildPageAgentScript(command: PageAgentCommand): string {
  return '(' + pageAgent.toString() + ')(' + JSON.stringify(command) + ')'
}

/** 交互快照的文本形式。模型看到的就是这一段 */
export function formatSnapshot(result: PageScanResult): string {
  const lines = ['Page: ' + (result.title || '(无标题)'), 'URL: ' + result.url, '']

  if (result.elements.length === 0) {
    lines.push('(没有扫描到可交互元素)')
  }

  for (const element of result.elements) {
    const parts = ['[ref=' + element.ref + ']', element.role, '"' + element.label + '"']
    if (element.href) parts.push('→ ' + element.href)
    if (element.sensitive) parts.push('(敏感字段，需用户自己操作)')
    if (element.disabled) parts.push('(已禁用)')
    lines.push(parts.join(' '))
  }

  if (result.hasIframe) {
    lines.push(
      '',
      '注意：页面含 iframe，其中的内容和按钮不在这份快照里，需要用户手动操作或截图查看。'
    )
  }

  return lines.join('\n')
}
