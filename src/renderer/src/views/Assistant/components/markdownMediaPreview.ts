import type { StateCore, Token } from 'markdown-it'

import { toLocalResourceUrl } from '@renderer/utils/localResource'

/**
 * 聊天正文里的图片 / 视频内联预览。
 *
 * AI 回复经常只给出一条路径（「保存位置: `I:/.../UAShot.png`」），
 * 用户还得自己去文件管理器里打开。这里在识别到路径 / URL 之后，
 * 紧跟着那一段落插入预览：图片是缩略图（点击走 PhotoSwipe 看大图），
 * 视频是一个带控件的播放器。
 *
 * **视频这一半是补上来的**：过程日志里早就能播了，正文里却只有一行路径 ——
 * 于是「AI 出了个视频」这件事，在用户折叠过程日志之后就什么也看不见。
 * 花几分钟、按秒计费出来的东西，不该藏在一个默认可以收起来的框里。
 *
 * 只做「识别 + 生成 HTML」，加载失败后的隐藏由 MarkdownRenderer 绑定 error 事件完成
 * （渲染进程 CSP 是 `script-src 'self'`，内联 onerror 会被拦掉）。
 */

/** 允许内联预览的图片扩展名 */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i

/**
 * 允许内联播放的视频扩展名。
 *
 * 只列 `<video>` 能直接解的那几种，与过程日志里那份保持一致 ——
 * 多列一个（如 .avi）换来的是一个点不开的黑框。
 */
const VIDEO_EXTENSION = /\.(?:mp4|webm|mov|m4v)$/i

/** 绝对路径 / 可直接加载的协议前缀 —— 相对路径没法定位到真实文件，不预览 */
const RESOURCE_PREFIX =
  /^(?:https?:\/\/|file:\/{2,}|local-resource:\/{2,}|uebox-asset:\/{2,}|[A-Za-z]:[\\/]|\\\\|\/)/

/** 从纯文本里扫路径时用的模式，结尾必须是图片扩展名 */
const IMAGE_REF_IN_TEXT =
  /(?:https?:\/\/|file:\/{2,}|local-resource:\/{2,}|uebox-asset:\/{2,}|[A-Za-z]:[\\/]|\/)[^\s"'`<>()（）【】「」，,。；;]*\.(?:png|jpe?g|gif|bmp|webp|svg|ico|avif)/gi

/** 同上，视频那一份 */
const VIDEO_REF_IN_TEXT =
  /(?:https?:\/\/|file:\/{2,}|local-resource:\/{2,}|uebox-asset:\/{2,}|[A-Za-z]:[\\/]|\/)[^\s"'`<>()（）【】「」，,。；;]*\.(?:mp4|webm|mov|m4v)/gi

/** 路径左边界：只有前面是空白或这些标点时才当成一条独立路径，避免把 `assets/a.png` 截成 `/a.png` */
const LEFT_BOUNDARY = /[\s("'（「【[:：=>,，]/

/** 单条消息最多插几张预览图，防止「列出目录下所有 PNG」这类回复把聊天框撑爆 */
const MAX_PREVIEWS_PER_MESSAGE = 8

/**
 * 转义 HTML 属性值，避免 alt / src 里的引号截断属性
 */
function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 去掉 query / hash，扩展名判断只看路径部分 */
function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, '')
}

/**
 * 判断一个字符串是否是「能直接预览的图片路径 / URL」
 * @param value 候选字符串
 */
export function isPreviewableImageRef(value: string): boolean {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  if (!RESOURCE_PREFIX.test(trimmed)) return false
  return IMAGE_EXTENSION.test(stripQuery(trimmed))
}

/**
 * 判断一个字符串是否是「能直接内联播放的视频路径 / URL」
 * @param value 候选字符串
 */
export function isPreviewableVideoRef(value: string): boolean {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  if (!RESOURCE_PREFIX.test(trimmed)) return false
  return VIDEO_EXTENSION.test(stripQuery(trimmed))
}

/** 一次扫描里认出来的媒体引用 */
type MediaRef = { ref: string; kind: 'image' | 'video' }

/** 路径左边界判断：只有前面是空白或标点时才当成一条独立路径 */
function scanRefs(source: string, pattern: RegExp): string[] {
  const found: string[] = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const prev = match.index > 0 ? source[match.index - 1] : ''
    if (prev && !LEFT_BOUNDARY.test(prev)) continue
    found.push(match[0])
  }
  return found
}

/**
 * 从一段纯文本里找出所有图片路径 / URL
 * @param text 文本内容
 */
export function findImageRefsInText(text: string): string[] {
  return scanRefs(String(text ?? ''), IMAGE_REF_IN_TEXT).filter(isPreviewableImageRef)
}

/**
 * 从一段纯文本里找出所有视频路径 / URL
 * @param text 文本内容
 */
export function findVideoRefsInText(text: string): string[] {
  return scanRefs(String(text ?? ''), VIDEO_REF_IN_TEXT).filter(isPreviewableVideoRef)
}

/** 一段文本里的图片和视频，按出现顺序 */
function findMediaRefsInText(text: string): MediaRef[] {
  const source = String(text ?? '')
  if (!source) return []
  const refs: MediaRef[] = [
    ...findImageRefsInText(source).map((ref) => ({ ref, kind: 'image' as const })),
    ...findVideoRefsInText(source).map((ref) => ({ ref, kind: 'video' as const }))
  ]
  // 一段里同时出现图和视频时，按它们在原文里的先后排，预览顺序才对得上正文
  return refs.sort((a, b) => source.indexOf(a.ref) - source.indexOf(b.ref))
}

/** 一条引用是图还是视频；两者都不是时返回 null */
function classifyRef(value: string): MediaRef | null {
  if (isPreviewableImageRef(value)) return { ref: value, kind: 'image' }
  if (isPreviewableVideoRef(value)) return { ref: value, kind: 'video' }
  return null
}

export type ImageHtmlOptions = {
  /** 图片地址（已经是渲染进程能直接加载的 URL） */
  src: string
  /** alt 文本 */
  alt?: string
  /** 是否是内联预览（额外限制尺寸，并允许加载失败后隐藏） */
  preview?: boolean
  /** 复制按钮的 title */
  copyLabel: string
  /** 下载按钮的 title */
  downloadLabel: string
}

/**
 * 生成带复制 / 下载按钮的图片 HTML
 * @param options 图片地址与按钮文案
 */
export function buildImageHtml(options: ImageHtmlOptions): string {
  const src = escapeAttr(options.src)
  const alt = escapeAttr(options.alt ?? '')
  const wrapperClass = options.preview
    ? 'markdown-image-wrapper markdown-image-preview'
    : 'markdown-image-wrapper'
  const imgClass = options.preview ? 'markdown-image markdown-image--preview' : 'markdown-image'

  return `<div class="${wrapperClass}">
    <img src="${src}" alt="${alt}" class="${imgClass}" loading="lazy" referrerpolicy="no-referrer" />
    <div class="image-actions">
      <button class="image-action-btn copy-image-btn" data-src="${src}" title="${escapeAttr(
        options.copyLabel
      )}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
      </button>
      <button class="image-action-btn download-image-btn" data-src="${src}" title="${escapeAttr(
        options.downloadLabel
      )}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
      </button>
    </div>
  </div>`
}

/**
 * 生成内联视频播放器的 HTML。
 *
 * 只给一个原生 `<video controls>`：下载、全屏、逐帧都在浏览器自带的控件里，
 * 再套一层自己的按钮既要接事件又要重做一遍这些功能。
 *
 * `preload="metadata"` 而不是 `auto`：一条聊天记录里可能有好几段视频，
 * 全预加载会把几百兆读进内存，而用户多半只点其中一条。
 */
export function buildVideoHtml(options: { src: string; preview?: boolean }): string {
  const src = escapeAttr(options.src)
  const wrapperClass = options.preview
    ? 'markdown-video-wrapper markdown-video-preview'
    : 'markdown-video-wrapper'

  return `<div class="${wrapperClass}">
    <video src="${src}" class="markdown-video" controls preload="metadata" playsinline></video>
  </div>`
}

/**
 * 从一个 inline token 的子节点里收集媒体路径
 * - `code_inline`：整段内容就是路径（「保存位置: `I:/...png`」走这条）
 * - `link_open`：linkify 之后的 http(s) 链接，或正文里写成 `[名字](路径)` 的视频
 * - `text`：裸写在正文里的本地路径
 */
function collectRefsFromInline(inline: Token): MediaRef[] {
  const refs: MediaRef[] = []
  for (const child of inline.children ?? []) {
    if (child.type === 'code_inline') {
      const classified = classifyRef(child.content.trim())
      if (classified) refs.push(classified)
      continue
    }
    if (child.type === 'link_open') {
      const classified = classifyRef(String(child.attrGet('href') ?? ''))
      if (classified) refs.push(classified)
      continue
    }
    if (child.type === 'text') {
      refs.push(...findMediaRefsInText(child.content))
    }
  }
  return refs
}

/**
 * 收集全文里已经用 `![]()` 渲染出来的图片，避免同一张图连着出现两次
 */
function collectAlreadyRenderedImages(tokens: Token[]): Set<string> {
  const rendered = new Set<string>()
  for (const token of tokens) {
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type !== 'image') continue
      const url = toLocalResourceUrl(String(child.attrGet('src') ?? ''))
      if (url) rendered.add(url)
    }
  }
  return rendered
}

/**
 * 创建 markdown-it 的 core 规则：在含媒体路径的段落后面插入预览
 * @param render 图片 / 视频各自的 HTML 渲染函数
 */
export function createMediaPreviewRule(render: {
  image: (src: string) => string
  video: (src: string) => string
}): (state: StateCore) => void {
  return (state: StateCore): void => {
    const tokens = state.tokens
    const seen = collectAlreadyRenderedImages(tokens)
    const insertions: { at: number; html: string }[] = []
    let budget = MAX_PREVIEWS_PER_MESSAGE

    for (let i = 0; i < tokens.length && budget > 0; i++) {
      const token = tokens[i]
      if (token.type !== 'inline') continue

      const previews: string[] = []
      for (const { ref, kind } of collectRefsFromInline(token)) {
        if (budget <= 0) break
        const url = toLocalResourceUrl(ref)
        if (!url || seen.has(url)) continue
        seen.add(url)
        previews.push(kind === 'video' ? render.video(url) : render.image(url))
        budget -= 1
      }
      if (previews.length === 0) continue

      // 插到所属块级元素的闭合标签之后 —— div 不能塞进 <p> 里，浏览器会把段落截断
      const next = tokens[i + 1]
      const at = next && next.nesting === -1 ? i + 2 : i + 1
      insertions.push({ at, html: previews.join('\n') })
    }

    // 倒序插入，前面的下标才不会被后面的插入挤偏
    for (let i = insertions.length - 1; i >= 0; i--) {
      const { at, html } = insertions[i]
      const previewToken = new state.Token('html_block', '', 0)
      previewToken.content = html
      previewToken.block = true
      tokens.splice(at, 0, previewToken)
    }
  }
}
