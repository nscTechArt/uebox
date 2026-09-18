/**
 * 启动路径重依赖门禁。
 *
 * 主进程被打成**一个** CJS bundle：任何一处顶层 `import 'xxx'`，都会让 xxx 在
 * 应用启动、主窗口出现之前被完整加载一次 —— 哪怕这个功能用户这辈子都不会点。
 * 这类回归无声无息：加一行 import 谁都看不出代价，直到冷启动肉眼可见地变慢。
 *
 * 这条测试盯住那批「体积大 + 使用频率低」的包，要求它们只能懒加载：
 *   · `await import('xxx')`（异步上下文，首选）
 *   · 函数体内的 `require('xxx')`（必须保持同步签名时）
 *   · `import type ... from 'xxx'`（只有类型，编译后不留痕迹）
 *
 * 名单要加要减都行，但请连同理由一起写在 HEAVY_MODULES 里。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const MAIN_DIR = __dirname

/** 不许出现在启动路径上的重依赖：包名（可带子路径） -> 为什么 */
const HEAVY_MODULES: Record<string, string> = {
  '@firecrawl/anydoc': '文档解析原生模块，约 8MB 的 .node，只有上传文档时才用到',
  xlsx: 'Excel 解析，约 8MB，只有往笔记里拖 Excel 时才用到',
  elkjs: '图布局引擎，约 8MB，只有蓝图自动布局走 fallback 时才用到',
  '@aws-sdk/client-s3': '约 4MB，且 getS3Client 在打包环境一律返回 null',
  webdav: '约 2MB，只有配置了 WebDAV 同步的用户才会触发',
  'pinyin-pro': '约 1MB，只有导入含中文名的资产时才用到',
  '@gltf-transform/core': '只有处理 .glb/.gltf 时才用到',
  '@gltf-transform/extensions': '同上',
  turndown: 'HTML→Markdown，只有抓网页/采集文章时才用到',
  express: '光加载就要几百毫秒，而本地 HTTP 服务默认关闭',
  multer: '随 express 一起，只有本地 HTTP 服务开启时才需要',
  'electron-updater': '开发环境根本不检查更新，正式环境也只在检查那一刻才需要'
}

/**
 * 「懒岛」：这些文件自身只经由 `await import()` 被拉起来，所以允许在文件顶部
 * 正常 import 重依赖 —— 代价不会落到启动路径上。
 *
 * 往这里加文件前请先确认：**没有任何**静态 import 链能从 src/main/index.ts 走到它。
 */
const LAZY_ISLANDS = new Set(['services/http/server.ts'])

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
      continue
    }
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue
    if (/\.(test|spec)\.ts$/.test(name)) continue
    out.push(full)
  }
  return out
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 匹配「会在模块加载时就执行」的三种引入写法 */
function buildEagerPatterns(moduleName: string): RegExp[] {
  // 允许子路径：elkjs 要能匹配到 elkjs/lib/elk.bundled.js
  const specifier = `${escapeForRegExp(moduleName)}(?:/[^'"]*)?`
  return [
    // import x from 'mod' / import * as x from 'mod'（import type 不算，编译后会消失）
    new RegExp(`^import\\s+(?!type\\b)[^\\n]*?from\\s+['"]${specifier}['"]`, 'm'),
    // import 'mod'（只为副作用）
    new RegExp(`^import\\s+['"]${specifier}['"]`, 'm'),
    // 顶层 const x = require('mod')（函数体内的 require 有缩进，不会被匹配到）
    new RegExp(`^(?:const|let|var)\\s+[^\\n]*=\\s*require\\(['"]${specifier}['"]\\)`, 'm')
  ]
}

describe('主进程启动路径', () => {
  it('不静态引入重依赖（只能懒加载）', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(MAIN_DIR)) {
      const relativePath = relative(MAIN_DIR, file).split('\\').join('/')
      if (LAZY_ISLANDS.has(relativePath)) continue

      const source = readFileSync(file, 'utf8')

      for (const [moduleName, reason] of Object.entries(HEAVY_MODULES)) {
        const isEager = buildEagerPatterns(moduleName).some((pattern) => pattern.test(source))
        if (isEager) {
          offenders.push(`src/main/${relativePath} 顶层引入了 ${moduleName}（${reason}）`)
        }
      }
    }

    expect(
      offenders,
      [
        '这些引入会在应用启动、主窗口出现之前被执行：',
        ...offenders.map((line) => `  · ${line}`),
        '',
        '改成懒加载：异步上下文用 await import(...)，必须同步就把 require(...) 挪进函数体，',
        '只用到类型就写 import type。确认某个文件只经由 await import 加载，可加进 LAZY_ISLANDS。'
      ].join('\n')
    ).toEqual([])
  })
})
