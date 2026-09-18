#!/usr/bin/env node
/**
 * 颜色门禁 / Color system gate.
 *
 * ## 这道门禁守的是什么
 *
 * 一套色彩体系不是一次调好就完事的，它是**每天都在被稀释**的东西。
 * 稀释的方式永远是同一种：某个组件需要一个「稍微亮一点的蓝」，
 * 顺手写了个十六进制。一次没事，一千次之后就是这个仓库改造前的样子 ——
 *
 *   571 种十六进制 + 916 种 rgba 散在 174 个文件里，而 token 只有 174 个；
 *   品牌色一半是紫的一半是蓝的；三个变量都自称「主色」，值互不相干；
 *   60 个颜色变量被引用但从没定义过，那些声明在浏览器里直接作废。
 *
 * 所以这里守六条：
 *
 *   1. **每个 var(--color-*) 都必须有定义。**
 *      引用一个不存在的变量，CSS 不会报错，它会静静地让整条声明失效，
 *      文字掉回继承色。这类 bug 没人会在 code review 里看出来。
 *
 *   2. **裸写的颜色只准变少。**
 *      逐文件记数的棘轮 —— 存量允许存在（几千处不可能一次清完），
 *      但只准降不准升。新代码要加颜色，就得先在 palette 里给它一个角色。
 *
 *   3. **--color-text-disabled 只准用在真的禁用态上。**
 *      它是整套体系里唯一**故意不达标**的文字色（浅色底上 3.03:1）——
 *      WCAG 把禁用控件排除在外，所以它可以这么淡。
 *      拿它去写提示语、计数、空状态、时间戳，等于把「这行字读不清」
 *      写进了设计。曾经 120 处里有 87 处是这么用的。
 *
 *   4. **禁用态不准用 opacity 表达。**
 *      opacity 把整个元素往**它背后的东西**上拖，而背后是什么随主题、
 *      随所在面变，结果算不出来。实测：主按钮 #1a73e2 白字压在白页上，
 *      opacity 0.5 之后底色被冲淡、白字还是白字，对比度 4.57 → 1.96，
 *      字直接消失；同一行代码在深色主题下只是「看着淡一点」。
 *      用颜色 token 就没这个问题 —— 值是量过的，跟背后是什么无关。
 *
 *   5. **同一条规则里的文字色和底色，两个主题都要过 3:1。**
 *      这是唯一能纯静态算准的一类配对 —— 文字和它的底写在一起，
 *      不用猜祖先是谁。抓到过：确认按钮把禁用灰写在了警告黄上（1.06:1）、
 *      浮在图片上的关闭按钮在浅色主题下变成白底白字。
 *      禁用态豁免（WCAG 1.4.3 明确把禁用控件排除在外）。
 *
 *   6. **提示气泡的配色只准在一个地方定义。**
 *      底色和文字色是成对的：只 !important 掉背景、不管文字色，
 *      浅色主题下就是一个白底白字的空方块。定义在 useTheme.ts 的
 *      components.Tooltip（只有那里能单独改 Tooltip 的文字色而不波及主按钮），
 *      外观补充在 antd-override.css。组件里不要再各写一份。
 *
 * ## 什么不算违规
 *
 *   投影里的半透明黑（box-shadow / text-shadow）—— 投影本来就该是
 *   半透明黑叠在未知背景上，换成不透明的语义变量反而是错的。
 *   渐变、滤镜同理，多个色标需要人判断。
 *   src/renderer/public/ueblueprint 是外部资产，不归本设计系统管。
 *
 * ## 怎么改
 *
 *   pnpm verify:colors              查（CI 和 pnpm verify 会跑）
 *   pnpm verify:colors --update     清完一批之后收紧基线
 *   pnpm palette                    改色阶本身（改 scripts/gen-palette.mjs 再跑这个）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/colors.baseline.json')
const UPDATE = process.argv.includes('--update')

const IGNORED = [/public\/ueblueprint\//, /palette\.generated\./]
/**
 * 投影和渐变里的颜色不数：那里本来就该是半透明色叠在未知背景上。
 * `--shadow-*` 是这些颜色的**定义点**（theme.css 里那几档），同样豁免 ——
 * 不豁免的话，把投影色收进 token 反而会让门禁数字变大，等于惩罚做对的事。
 */
const EXEMPT_PROP = /(shadow$|^--shadow-|^filter$|^backdrop-filter$|gradient)/

function listFiles() {
  const tracked = execSync('git ls-files src/renderer', { encoding: 'utf8' }).trim().split('\n')
  const untracked = execSync('git ls-files --others --exclude-standard src/renderer', {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
  return [...tracked, ...untracked]
    .filter((f) => /\.(vue|css|ts)$/.test(f))
    .filter((f) => f && existsSync(f))
}

const DECL = /(^[ \t]*|[;{]\s*)((?:-{2})?[-a-zA-Z]+)(\s*:\s*)([^;{}]*)(;)/gm
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/

/** 数一个文件里有多少条「裸写颜色」的声明。 */
function countLiterals(text) {
  let n = 0
  for (const m of text.matchAll(DECL)) {
    const [, , prop, , value] = m
    if (EXEMPT_PROP.test(prop)) continue
    if (LITERAL.test(value)) n++
  }
  return n
}

const files = listFiles()
/** 数裸写颜色时要跳过的：生成的调色板本来就该是十六进制，ueblueprint 是外部资产。 */
const countable = files.filter((f) => !IGNORED.some((re) => re.test(f)))

/* ---- 规则 1：引用了却没定义的颜色变量 ----
 * 定义要从**所有**文件收集，包括生成的调色板 —— 那里正是定义所在。 */

const defined = new Set()
const used = new Map()
for (const f of files) {
  const t = readFileSync(f, 'utf8')
  for (const m of t.matchAll(/--([a-z0-9-]+)\s*:/g)) defined.add(m[1])
  for (const m of t.matchAll(/var\(\s*--([a-z0-9-]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], f)
  }
}
const undefinedColors = [...used].filter(
  ([name]) => name.startsWith('color-') && !defined.has(name)
)

/* ---- 规则 2：裸写颜色的逐文件棘轮 ---- */

const current = {}
for (const f of countable) {
  const n = countLiterals(readFileSync(f, 'utf8'))
  if (n > 0) current[f.replace(/\\/g, '/')] = n
}

/* ---- 规则 3 / 4：禁用色只准用在禁用态，禁用态不准用 opacity ----
 *
 * 「禁用态」按**选择器**认：:disabled / [disabled] / .disabled / .is-disabled，
 * 外加输入框的 placeholder 和 readonly。判不出来的一律算违规 —— 宁可误报，
 * 因为这两条的存量都已经清成 0 了，任何一条新的都是真的新增。
 */

const DISABLED_SEL = /disabled|readonly|::placeholder|:placeholder-shown/i

/** 从声明位置往回找它所属的选择器 */
function selectorAt(text, index) {
  const open = text.lastIndexOf('{', index)
  if (open < 0) return ''
  let s = open - 1
  while (s > 0 && !'{};'.includes(text[s])) s--
  return text
    .slice(s + 1, open)
    .replace(/\s+/g, ' ')
    .trim()
}

const misusedDisabled = []
const opacityDisabled = []
for (const f of countable) {
  // 注释里讲「不要这么写」的例子不算违规，先抹掉
  const text = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const at = (i) => `${f.replace(/\\/g, '/')}:${text.slice(0, i).split('\n').length}`

  for (const m of text.matchAll(/(--[a-z0-9-]+\s*:\s*)?var\(--color-text-disabled\)/g)) {
    // 组件把它转手定义成自己的 --xxx-disabled，这是转发不是滥用
    if (m[1] && /disabled/.test(m[1])) continue
    if (!DISABLED_SEL.test(selectorAt(text, m.index))) {
      misusedDisabled.push([at(m.index), selectorAt(text, m.index).slice(-48)])
    }
  }
  for (const m of text.matchAll(/(?:^|[;{\s])opacity:\s*0?\.\d+\s*;/gm)) {
    const sel = selectorAt(text, m.index)
    if (DISABLED_SEL.test(sel)) opacityDisabled.push([at(m.index), sel.slice(-48)])
  }
}

/* ---- 规则 5：同一条规则里的文字色 / 底色对比度 ---- */

/** 从生成的调色板里把两个主题的 token 解成实际的十六进制 */
function loadPalette() {
  const css = readFileSync(
    join(ROOT, 'src/renderer/src/assets/styles/palette.generated.css'),
    'utf8'
  )
  const cut = css.indexOf("[data-theme='light']")
  const primitives = {}
  for (const m of css.slice(0, css.indexOf('[data-theme')).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
    primitives[m[1]] = m[2].trim()
  const themes = {}
  for (const [name, body] of [
    ['dark', css.slice(0, cut)],
    ['light', css.slice(cut)]
  ]) {
    const map = { ...primitives }
    for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim()
    for (const k of Object.keys(map)) {
      let v = map[k]
      for (let i = 0; i < 10 && typeof v === 'string' && v.startsWith('var('); i++)
        v = map[/var\((--[a-z0-9-]+)/.exec(v)[1]]
      map[k] = v
    }
    themes[name] = map
  }
  return themes
}

function toRgb(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (/^#[0-9a-f]{6}$/i.test(s))
    return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(1)
  if (/^#[0-9a-f]{3}$/i.test(s)) return [1, 2, 3].map((i) => parseInt(s[i] + s[i], 16)).concat(1)
  const m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (!m) return null
  const p = m[1]
    .split(/[,/\s]+/)
    .filter(Boolean)
    .map((x) => (x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x)))
  if (p.slice(0, 3).some(Number.isNaN)) return null
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}

const luminance = ([r, g, b]) => {
  const f = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const composite = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)

/** 去掉规则体里所有嵌套子规则，只留直属声明。要配对大括号，不能用非贪婪正则。 */
function ownDeclarations(body) {
  let out = ''
  let depth = 0
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0) out += ch
  }
  return out
}

const palette = loadPalette()
const resolveColor = (raw, mode) => {
  const v = /var\((--[a-z0-9-]+)/.exec(raw)
  return v ? toRgb(palette[mode][v[1]]) : toRgb(raw)
}

const lowContrast = []
for (const f of countable) {
  const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const stack = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      stack.push(i + 1)
      continue
    }
    if (text[i] !== '}') continue
    const open = stack.pop()
    if (open === undefined) continue

    const own = ownDeclarations(text.slice(open, i))
    const fgDecl = /(?:^|[;{\s])color:\s*([^;!]+)/m.exec(own)
    const bgDecl = /(?:^|[;{\s])background(?:-color)?:\s*([^;!]+)/m.exec(own)
    if (!fgDecl || !bgDecl) continue
    if (/gradient|url\(|transparent|none|inherit|currentColor/i.test(bgDecl[1])) continue

    let s = open - 2
    while (s > 0 && !'{};'.includes(text[s])) s--
    const selector = text
      .slice(s + 1, open - 1)
      .replace(/\s+/g, ' ')
      .trim()
    if (DISABLED_SEL.test(selector)) continue

    for (const mode of ['light', 'dark']) {
      const fg = resolveColor(fgDecl[1], mode)
      const bgRaw = resolveColor(bgDecl[1], mode)
      if (!fg || !bgRaw) continue
      // 半透明底压着的是什么：--color-bg-overlay 压的是用户的图，按最难的纯白算
      const under = /--color-bg-overlay/.test(bgDecl[1])
        ? [255, 255, 255, 1]
        : toRgb(palette[mode]['--color-bg-page'])
      const bg = bgRaw[3] < 1 ? composite(bgRaw, under) : bgRaw
      const value = ratio(fg[3] < 1 ? composite(fg, bg) : fg, bg)
      if (value < 3) {
        const line = text.slice(0, open).split('\n').length
        lowContrast.push([
          `${f.replace(/\\/g, '/')}:${line}`,
          mode === 'light' ? '浅色' : '深色',
          value.toFixed(2),
          `${fgDecl[1].trim()} on ${bgDecl[1].trim()}`
        ])
        break
      }
    }
  }
}

/* ---- 规则 6：提示气泡的配色只准在一个地方定义 ---- */

const TOOLTIP_OWNER = 'src/renderer/src/assets/styles/antd-override.css'
const tooltipOverrides = []
for (const f of countable) {
  const norm = f.replace(/\\/g, '/')
  if (norm === TOOLTIP_OWNER) continue
  const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  for (const m of text.matchAll(/\.ant-tooltip-inner[^{]*\{([^}]*)\}/g)) {
    if (/(^|[;\s])(color|background(-color)?)\s*:/.test(m[1]))
      tooltipOverrides.push(`${norm}:${text.slice(0, m.index).split('\n').length}`)
  }
}

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n', 'utf8')
  const total = Object.values(current).reduce((a, b) => a + b, 0)
  console.log(`基线已更新：${Object.keys(current).length} 个文件 / ${total} 处裸写颜色。`)
  process.exit(0)
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}

const grew = []
const shrank = []
for (const [f, n] of Object.entries(current)) {
  const was = baseline[f] ?? 0
  if (n > was) grew.push([f, was, n])
  else if (n < was) shrank.push([f, was, n])
}
for (const [f, was] of Object.entries(baseline)) {
  if (!(f in current) && was > 0) shrank.push([f, was, 0])
}

let failed = false

if (undefinedColors.length) {
  failed = true
  console.error('✖ 有颜色变量被引用但从未定义 —— 这些 CSS 声明在浏览器里是直接作废的：\n')
  for (const [name, f] of undefinedColors) console.error(`  · --${name}   例如 ${f}`)
  console.error('\n要么在 palette 里给它一个角色，要么改用已有的语义变量。')
  console.error('可用的语义变量看 src/renderer/src/assets/styles/palette.generated.css 第二层。\n')
}

if (grew.length) {
  failed = true
  console.error('✖ 裸写的颜色变多了：\n')
  for (const [f, was, now] of grew) console.error(`  · ${f}: ${was} → ${now}`)
  console.error('\n新代码要用颜色，先想清楚它是什么角色，再用对应的语义变量：')
  console.error('  文字  --color-text-primary / -secondary / -muted / -disabled')
  console.error('  表面  --color-bg-page / -surface / -raised / -sunken')
  console.error('  描边  --color-border-subtle / --color-border / --color-border-strong')
  console.error('  强调  --color-accent-text / -bg / -border / -solid')
  console.error('  状态  --color-{success,warning,danger}-{text,bg,border,solid}')
  console.error('\n找不到合适的角色，说明缺一个角色 —— 去 scripts/gen-palette.mjs 加，别就地写死。')
  console.error('注意：基线只准变小。不要为了让门禁变绿去跑 --update。\n')
}

if (misusedDisabled.length) {
  failed = true
  console.error('✖ --color-text-disabled 用在了非禁用态上：\n')
  for (const [where, sel] of misusedDisabled.slice(0, 30)) console.error(`  · ${where}   ${sel}`)
  if (misusedDisabled.length > 30) console.error(`  · …还有 ${misusedDisabled.length - 30} 处`)
  console.error('\n禁用色是全套体系里唯一故意不达标的文字色（浅底 3.03:1），')
  console.error('因为 WCAG 把禁用控件排除在外。提示语、计数、空状态、时间戳这些')
  console.error('是要读的内容，用 --color-text-muted（浅底 4.62:1）。\n')
}

if (opacityDisabled.length) {
  failed = true
  console.error('✖ 禁用态用 opacity 表达：\n')
  for (const [where, sel] of opacityDisabled) console.error(`  · ${where}   ${sel}`)
  console.error('\nopacity 把元素往它背后的东西上拖，背后是什么随主题变，结果算不出来。')
  console.error('实测主按钮 opacity 0.5 压在白页上，白字对比度 4.57 → 1.96，字直接没了。')
  console.error('改成：color: var(--color-text-disabled)，实心按钮再加')
  console.error('background: var(--color-bg-surface-hover) 和 box-shadow: none。\n')
}

if (lowContrast.length) {
  failed = true
  console.error('✖ 文字压在自己的底色上看不清（同一条规则里写的那一对，阈值 3:1）：\n')
  for (const [where, mode, value, pair] of lowContrast)
    console.error(`  · ${where}  ${mode} ${value}:1   ${pair}`)
  console.error('\n改亮度，别改色相 —— 对比度只吃亮度。常见的三种情况：')
  console.error('  普通实心填充上的字 → var(--color-text-on-solid)')
  console.error('  警告实心填充上的字 → var(--color-warning-on-solid)')
  console.error('  浅色徽标上的字   → 同色系的 -text 档，如 --color-success-text')
  console.error('  浮在图片上的字   → 底用 --color-bg-overlay，字用 --color-text-on-solid\n')
}

if (tooltipOverrides.length) {
  failed = true
  console.error('✖ 组件里又改了一份提示气泡的配色：\n')
  for (const where of tooltipOverrides) console.error(`  · ${where}`)
  console.error('\n底色和文字色是成对的，只改一半就是白底白字。')
  console.error('要改就改 useTheme.ts 的 components.Tooltip（颜色）')
  console.error('和 assets/styles/antd-override.css（描边、投影），全应用共用一份。\n')
}

if (shrank.length && !failed) {
  console.log(
    `✔ 有 ${shrank.length} 个文件的裸写颜色变少了，跑 pnpm verify:colors --update 收紧基线。`
  )
  for (const [f, was, now] of shrank.slice(0, 10)) console.log(`  · ${f}: ${was} → ${now}`)
}

if (failed) process.exit(1)

const total = Object.values(current).reduce((a, b) => a + b, 0)
console.log(
  `颜色门禁通过（${countable.length} 个文件；裸写颜色 ${total} 处，均在基线内；无未定义颜色变量）。`
)
