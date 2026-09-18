import DOMPurify from 'dompurify'

/**
 * Markdown 渲染产物的消毒。
 *
 * ## 为什么需要
 *
 * 两个 markdown 渲染器都开着 `html: true`（原生 HTML 直通），而喂进去的内容
 * **来源本来就不可信**：Jina 抓回来的网页、模型生成的文本、导入的笔记。
 *
 * 严重程度要说准：`index.html` 的 CSP 是认真写的，`script-src 'self'` 且没有
 * `unsafe-inline`，`<script>` 和 `onerror=` 这类都执行不了。所以这不是一个能
 * 打穿的洞，是纵深不够 —— `style-src` 带着 `unsafe-inline`、`img-src` 放开了
 * http/https，靠 CSS 选择器配 `background-image` 或者一个 `<img>` 仍然能做静默回传。
 *
 * ## 为什么是消毒产物，而不是把 html 关掉
 *
 * `html: false` 会改变用户可见行为：手写在笔记里的 HTML 会失效。消毒只摘掉
 * 危险构造，其余照常渲染。
 *
 * dompurify 本来就已经在包里（经 mermaid 传递依赖），`THIRD-PARTY-NOTICES.md`
 * 也登记过它的许可证，所以这一步不新增依赖、不改许可证声明。
 */

/**
 * 本地资源协议要放行，否则**所有本地图片都显示不出来**。
 *
 * DOMPurify 只认自己那份 scheme 白名单（http/https/mailto/tel/…），
 * 碰上不认识的协议不是报错，是**静默摘掉整个 `src` 属性** —— 于是页面上留下
 * 一个 `<img class="markdown-image" loading="lazy">`，没有 src，什么也不显示。
 * 真机上就是这么表现的：AI 出的概念图、视口截图，正文里那一张全是空的，
 * 而旁边复制/下载按钮上的 `data-src` 好好的（data-* 不过 URI 检查），
 * 看起来像「图没生成」，其实图在磁盘上躺得好好的。
 *
 * 只加这两个自定义协议，**不加 `file:`**：渲染进程的 CSP（index.html）
 * `img-src` 放行的正是 `local-resource:` 和 `uebox-asset:`，两处保持一致 ——
 * 在这里放行一个 CSP 会挡的协议，换来的只是另一种形式的空图。
 *
 * 安全上的取舍：这确实让不可信内容（抓回来的网页、模型写的笔记）能引用本机
 * 任意路径的图片。代价有限 —— `<img>` 只是把图画在本地，读不走内容
 * （CSP `script-src 'self'` 且无 unsafe-inline，脚本跑不起来，也就没有 canvas
 * 那条回传路径）；而不放行的代价是这个应用的核心功能之一直接不可用。
 */
const LOCAL_RESOURCE_SCHEMES =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|local-resource|uebox-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i

/**
 * 渲染器自己生成的结构要留住：
 * 代码块的复制按钮靠 `data-target` 定位，图片预览靠 `class` 命中。
 * DOMPurify 默认就保留 `class` 和 `data-*`，这里显式把用到的标签补进白名单。
 *
 * `referrerpolicy` 也要显式补 —— 图片 HTML 上带的 `no-referrer` 本来就是
 * 一条隐私措施，被消毒摘掉的话它只是看起来在那儿。
 */
const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ADD_TAGS: ['button'],
  ADD_ATTR: ['target', 'data-target', 'data-lang', 'referrerpolicy'],
  ALLOWED_URI_REGEXP: LOCAL_RESOURCE_SCHEMES,
  // 外链一律不带 referrer，也不给新窗口 opener
  FORBID_ATTR: ['formaction', 'ping']
}

/** 消毒一段 HTML，返回可以安全塞进 DOM 的字符串 */
export function sanitizeRenderedHtml(html: string): string {
  return String(DOMPurify.sanitize(html, CONFIG))
}
