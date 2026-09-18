import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'

import {
  buildImageHtml,
  buildVideoHtml,
  createMediaPreviewRule,
  findImageRefsInText,
  isPreviewableImageRef,
  isPreviewableVideoRef
} from './markdownMediaPreview'

function createRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true })
  md.core.ruler.push(
    'inline_media_preview',
    createMediaPreviewRule({
      image: (src) =>
        buildImageHtml({ src, preview: true, copyLabel: '复制图片', downloadLabel: '下载图片' }),
      video: (src) => buildVideoHtml({ src, preview: true })
    })
  )
  return md
}

function countPreviews(html: string): number {
  return html.match(/markdown-image--preview/g)?.length ?? 0
}

function countVideos(html: string): number {
  return html.match(/markdown-video-preview/g)?.length ?? 0
}

describe('isPreviewableImageRef', () => {
  it('接受绝对路径与可加载协议下的图片', () => {
    expect(isPreviewableImageRef('I:/UnrealAgent/Saved/UAShot_20260828_114521.png')).toBe(true)
    expect(isPreviewableImageRef('I:\\UnrealAgent\\Saved\\UAShot.PNG')).toBe(true)
    expect(isPreviewableImageRef('file:///I:/a/b.jpg')).toBe(true)
    expect(isPreviewableImageRef('local-resource://I:/a/b.webp')).toBe(true)
    expect(isPreviewableImageRef('https://example.com/a.png?v=2')).toBe(true)
    expect(isPreviewableImageRef('/home/user/a.gif')).toBe(true)
  })

  it('拒绝相对路径、非图片和空值', () => {
    expect(isPreviewableImageRef('assets/a.png')).toBe(false)
    expect(isPreviewableImageRef('I:/a/b.txt')).toBe(false)
    expect(isPreviewableImageRef('I:/a/b.exe')).toBe(false)
    expect(isPreviewableImageRef('')).toBe(false)
    expect(isPreviewableImageRef('   ')).toBe(false)
  })
})

describe('findImageRefsInText', () => {
  it('从正文里取出图片路径', () => {
    expect(findImageRefsInText('图已存到 I:/Saved/a.png，可以直接看')).toEqual(['I:/Saved/a.png'])
  })

  it('不把相对路径的一段当成绝对路径', () => {
    expect(findImageRefsInText('见 assets/img/a.png')).toEqual([])
  })

  it('剥掉结尾的中文标点', () => {
    expect(findImageRefsInText('保存位置：I:/Saved/a.png。')).toEqual(['I:/Saved/a.png'])
  })
})

describe('isPreviewableVideoRef', () => {
  it('接受能直接播的几种视频，拒绝图片和播不了的格式', () => {
    expect(isPreviewableVideoRef('C:/vault/AIGC/视频/烛影临渊.mp4')).toBe(true)
    expect(isPreviewableVideoRef('local-resource://C:/a/b.webm')).toBe(true)
    expect(isPreviewableVideoRef('https://cdn.example/a.MOV?token=1')).toBe(true)
    // 播不了的容器不给播放器，否则用户点开的是个黑框
    expect(isPreviewableVideoRef('C:/a/b.mkv')).toBe(false)
    expect(isPreviewableVideoRef('C:/a/b.png')).toBe(false)
    expect(isPreviewableVideoRef('videos/a.mp4')).toBe(false)
  })
})

/**
 * 视频这一半是这次补的：过程日志里早就能播，正文里却只有一行路径 ——
 * 用户把过程日志一收，几分钟出来的片子就什么也看不见了。
 */
describe('正文里的视频', () => {
  it('给出路径的段落后面补一个播放器', () => {
    const html = createRenderer().render('已存进素材库：`C:/vault/AIGC/视频/烛影临渊.mp4`')

    expect(countVideos(html)).toBe(1)
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html.indexOf('markdown-video-preview')).toBeGreaterThan(html.indexOf('</p>'))
  })

  it('写成链接的视频同样能播', () => {
    const html = createRenderer().render('[烛影临渊.mp4](local-resource://C:/vault/a.mp4)')
    expect(countVideos(html)).toBe(1)
  })

  it('裸写在正文里的路径也认', () => {
    const html = createRenderer().render('视频在 C:/vault/AIGC/视频/a.mp4，可以直接播放。')
    expect(countVideos(html)).toBe(1)
  })

  it('同一段视频只补一个播放器', () => {
    const html = createRenderer().render('`C:/a.mp4` 和 `C:/a.mp4`')
    expect(countVideos(html)).toBe(1)
  })

  it('图和视频同时出现时两个都补上', () => {
    const html = createRenderer().render('封面 `C:/a.png`，视频 `C:/a.mp4`')
    expect(countPreviews(html)).toBe(1)
    expect(countVideos(html)).toBe(1)
  })
})

describe('createMediaPreviewRule', () => {
  it('在含行内代码路径的段落之后插入预览图', () => {
    const html = createRenderer().render(
      '**保存位置:** `I:/UnrealAgent/Saved/UAShot_20260828_114521.png` (1920×1080)'
    )

    // 预览块必须在段落闭合之后，否则 <div> 会把 <p> 截断
    expect(html.indexOf('markdown-image-preview')).toBeGreaterThan(html.indexOf('</p>'))
    expect(html).toContain('src="local-resource://I:/UnrealAgent/Saved/UAShot_20260828_114521.png"')
    expect(countPreviews(html)).toBe(1)
  })

  it('同一张图只预览一次', () => {
    const html = createRenderer().render('`I:/Saved/a.png` 和 `I:/Saved/a.png`')
    expect(countPreviews(html)).toBe(1)
  })

  it('已经用 markdown 图片语法渲染过的不再重复预览', () => {
    const html = createRenderer().render('![](I:/Saved/a.png)\n\n路径是 `I:/Saved/a.png`')
    expect(countPreviews(html)).toBe(0)
  })

  it('代码块里的路径不预览', () => {
    const html = createRenderer().render('```\nI:/Saved/a.png\n```')
    expect(countPreviews(html)).toBe(0)
  })

  it('非图片路径不预览', () => {
    expect(countPreviews(createRenderer().render('日志在 `I:/Saved/a.log`'))).toBe(0)
  })

  it('单条消息最多插 8 张', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- \`I:/Saved/a${i}.png\``).join('\n')
    expect(countPreviews(createRenderer().render(lines))).toBe(8)
  })

  it('中文路径编码后仍指向同一个文件', () => {
    const html = createRenderer().render('`H:/截图/场景.png`')
    expect(html).toContain('src="local-resource://H:/%E6%88%AA%E5%9B%BE/%E5%9C%BA%E6%99%AF.png"')
  })
})

describe('buildImageHtml', () => {
  it('转义属性值，避免 alt 截断属性注入', () => {
    const html = buildImageHtml({
      src: 'local-resource://I:/a.png',
      alt: '" onerror="alert(1)',
      copyLabel: '复制图片',
      downloadLabel: '下载图片'
    })
    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).toContain('&quot; onerror=&quot;alert(1)')
  })

  it('非预览模式不加尺寸限制的类名', () => {
    const html = buildImageHtml({
      src: 'https://example.com/a.png',
      copyLabel: 'Copy image',
      downloadLabel: 'Download image'
    })
    expect(html).toContain('class="markdown-image"')
    expect(html).not.toContain('markdown-image--preview')
  })
})
