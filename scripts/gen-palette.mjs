#!/usr/bin/env node
/**
 * 调色板生成器 / Palette generator.
 *
 * ## 为什么颜色要用生成的，而不是手挑
 *
 * 一条合格的色阶有四个性质，靠眼睛挑一辈子也凑不出来：
 *
 *   1. 每一档在**人眼感知**上等距变亮 —— 不是 HSL 里那个叫 lightness 的数字，
 *      那个数字等距递增的结果是浅色端挤成一团、深色端拉得老开。
 *   2. 色相全程恒定。色相中途拐弯，人眼会读成两种颜色混在一起。
 *      （这个仓库以前就是：brand-50~300 是紫的 286°，brand-400~900 是蓝的 247°。）
 *   3. 彩度中段最高、两端收敛。两端硬撑着彩度，50 档会发光、950 档像泼了墨。
 *   4. 不同色相的同一档要**一样亮**，否则红按钮看着比蓝按钮沉。
 *      但彩度不能抄同一个数字 —— 黄色和蓝色能达到的最高彩度差一倍多，
 *      抄数字的结果是警告色比危险色发虚。要按「各自上限的百分之几」给。
 *
 * 所以这里全程在 OKLCH 里算（那是个感知均匀的色彩空间），最后才转成 sRGB 十六进制。
 * 超出 sRGB 色域的组合会二分搜索把彩度收到边界内 —— 这一步不做的话，
 * 高彩度的深色会被浏览器随便截断，色相当场跑掉。
 *
 * ## 深色为什么是纯灰底 + 克制的状态色
 *
 * 底色一旦自己带上色（哪怕只有 0.015 的彩度），彩色元素就失去了参照物，
 * 整个界面糊成一片 —— 每样东西都有点颜色，又没有一样是真的有颜色。
 * 死中性的底让层级只靠明度建立，这是 Codex 一类开发工具的商务感来源。
 *
 * 另一半是位置：彩色元素坐在 60~67% 亮度，那里 sRGB 允许的最高彩度约 0.20；
 * 放到 77% 亮度上，物理上最多只能到 0.11 —— 颜色发灰不是调淡的，是位置放错了。
 * 黄色是例外，它天生就该亮（80%+），压暗会变成橄榄绿。
 *
 * ## 改了颜色怎么办
 *
 *   pnpm palette          重新生成 src/renderer/src/assets/styles/palette.generated.css
 *
 * 生成结果是提交进仓库的，跟 catalog.generated.ts 一个路子：
 * 运行时不依赖这个脚本，但颜色怎么来的有据可查、能一键重算。
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/renderer/src/assets/styles/palette.generated.css')
const OUT_TS = join(ROOT, 'src/renderer/src/assets/styles/palette.generated.ts')

/* ---------- OKLCH ⇄ sRGB ---------- */

const gammaEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const gammaDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

function oklchToLinear(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

const inGamut = (L, C, H) => oklchToLinear(L, C, H).every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** 该亮度/色相下 sRGB 还容得下的最高彩度。二分搜索，40 次足够收敛到小数点后 10 位。 */
function maxChroma(L, H) {
  let lo = 0
  let hi = 0.45
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(L, mid, H)) lo = mid
    else hi = mid
  }
  return lo
}

function hex(L, C, H) {
  return (
    '#' +
    oklchToLinear(L, C, H)
      .map((v) =>
        Math.round(Math.min(1, Math.max(0, gammaEncode(v))) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

const relLuminance = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => gammaDecode(parseInt(h.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度。算的是**实际叠在一起**的那两个颜色，不是页面底色。 */
export function contrast(a, b) {
  const x = relLuminance(a)
  const y = relLuminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/* ---------- 色阶定义 ---------- */

/**
 * 中性色：纯灰，彩度恒为 0。
 *
 * 档位不是均匀铺满 0~100% 的 —— 两端密、中段疏。因为两端才是表面色住的地方：
 * 亮色主题的页面/卡片挤在 89~100%，深色主题的页面/卡片挤在 13~33%，
 * 那里差 4% 就是肉眼能分辨的两个面；中段只用来放文字，差 9% 也无所谓。
 */
const NEUTRAL_STEPS = {
  50: 0.975,
  // 70 / 90 是选项卡片的精细交互档：浅色下分别输出 #f3f3f3 / #efefef。
  // 它们不替换全局 hover / selected，避免一个局部视觉要求改变整套界面。
  70: 0.964,
  // 75 是专门为「白卡片上的 hover」加的一档（#f2f2f2，Codex 的取值）。
  // 原来那里用 100（#ededed）——白底上一下暗 18 个色阶值，鼠标划过整行像被按黑了。
  // 加这一档还顺手把 hover 和 sunken 拆开了：以前两者同指 100，
  // 「浮起来的悬停行」和「凹下去的槽」在浅色主题下是同一个灰。
  75: 0.961,
  90: 0.952,
  100: 0.945,
  200: 0.895,
  300: 0.8,
  400: 0.72,
  500: 0.665,
  600: 0.58,
  700: 0.525,
  800: 0.43,
  850: 0.325,
  // 865 / 880 / 910 是选项卡片的深色状态档，分别输出 #2f2f2f / #2a2a2a / #222222。
  // 和浅色的 70 / 90 一样，只服务这个独立交互层级，不改全局表面色。
  865: 0.305,
  // 875 是深色的选中底（#2b2b2b）。深色底上「更显眼」的方向是变亮，
  // 所以它比悬停底（900）亮一档，不是暗一档 —— 浅色那边正好反过来，越选越暗。
  // 不能直接用 850：那一档太亮，弱化文字压上去只剩 4.10:1，读不动。
  875: 0.2891,
  880: 0.285,
  900: 0.272,
  910: 0.252,
  925: 0.228,
  950: 0.178,
  975: 0.135
}

/**
 * 有色色阶：11 档，亮 → 深。亮色主题直接用这条。
 * 彩度按「该亮度下上限的百分之几」给，峰值在 600 档，两端收敛。
 */
const CHROMA_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const CHROMA_L = [0.975, 0.95, 0.905, 0.845, 0.77, 0.685, 0.6, 0.51, 0.42, 0.325, 0.22]
const CHROMA_F = [0.07, 0.14, 0.28, 0.46, 0.66, 0.86, 1.0, 0.88, 0.72, 0.52, 0.3]

/**
 * 强调色不是状态色：它只表达「可交互 / 当前焦点」，不需要靠蓝色抢注意力。
 * 这一条使用 Codex 风格的中性灰阶，50 档从 #fcfcfc 起，深浅主题靠明度反相。
 */
const ACCENT_L = [0.991, 0.975, 0.945, 0.895, 0.8, 0.72, 0.665, 0.58, 0.43, 0.325, 0.178]

/**
 * 色相。全部经过实测校验：
 *   - 危险 27°  ≈ Codex diffRemoved 的 27.7°
 *   - 成功 150° ≈ Codex diffAdded 的 148°
 *   - 文件夹 85° ≈ Win11 文件夹图标的琥珀色
 * 警告 75° 和文件夹 85° 只差 10°，低于「15° 内算同一种颜色」的经验值，
 * 但两者亮度差 4%、实测 OKLab 色差 0.0511（可分辨门槛约 0.02），够用。
 */
const HUES = { success: 150, warning: 75, danger: 27, folder: 85 }

/**
 * 文件类型分类色。
 *
 * 这不是状态色 —— 它只回答「这是哪一类文件」，所以要求也不一样：
 * 图标是大色块，按 WCAG 1.4.11 只需 3:1，不是正文那条 4.5:1。
 * 以前这一组是写死在 AssetFileList.vue 里的 rgba(...)，按深色底调的，
 * 亮色模式下兜底色是 rgba(255,255,255,0.9) —— 白底白图标，等于没有图标。
 *
 * 选色约束：彼此至少差 20°（低于 15° 人眼会读成同一种颜色），
 * 强调色现在是中性灰，不再跟任何文件类型争色相。
 * 彩度只给到上限的 62%（状态色是 92%）：分类是背景信息，
 * 不该比「危险」「成功」更抢眼，这也是「专业冷静」的那一半。
 * 代码/未知类型不给色相，走中性 —— 不是每个扩展名都值得一个颜色。
 */
const FILETYPE_HUES = { image: 225, doc: 185, video: 340, audio: 50, model: 305, archive: 120 }
const FILETYPE_F = 0.62

/**
 * UE 资产类型色。
 *
 * 跟上面那组的区别：这些**色相不是我们挑的**，是 UE 编辑器自己的资产配色 ——
 * 蓝图是蓝的、纹理是红的、关卡是橙的，用户在 UE 里已经认了这套。
 * 所以只保留色相（从原来写死的 hex 里量出来的 OKLCH 色相），
 * 亮度和彩度按主题重新算：原值全是按 UE 深色编辑器调的，
 * 比如静态网格体 #00ffff 在白底上只有 1.3:1，亮色模式下那条色条等于没画。
 *
 * 蓝图 269° 是 UE 自己的蓝，改了就不是蓝图色了，所以保留；
 * 它只表达资产类型，不参与界面强调。
 * 粒子系统原值彩度只有 0.009（基本是灰），照旧走中性，不硬给它一个色相。
 */
const UETYPE_HUES = {
  staticMesh: 195,
  skeletalMesh: 327,
  texture: 24,
  material: 166,
  blueprint: 269,
  world: 52,
  skeleton: 206,
  niagara: 224,
  animSequence: 144,
  animBlueprint: 43,
  sound: 327
}
const UETYPE_F = 0.62

/**
 * 语音球光谱 —— 极光。
 *
 * 整套体系里唯一一处**自发光**的颜色：球里那三团不是界面元素，
 * 它们就是「里面有个活的东西在听你说话」这件事本身。所以**色相**三套主题共用一份 ——
 * 跟着主题降彩度的话，剩下的只是一个灰球，而那正是改造前的样子。
 * （玻璃底是另一回事，它必须分深浅两套，见下面 --sphere-base-* 那段。）
 *
 * 色相取的是极光：翡翠绿、电蓝、靛紫。刻意避开品红 / 青那一组 ——
 * 那是 Siri 的配色，用了就是在扮演别人家的语音助手。
 * 三个色相隔开 85° 和 44°：它们会以 screen 叠在一起，靠得太近叠完就是一团白，
 * 隔太远又不像同一道光里的东西。
 *
 * 彩度给到上限的 95%（比状态色还高）—— 这是唯一允许它这么艳的地方，
 * 因为它不承载任何可读性责任：没有文字压在上面，也不表示状态。
 */
const SPHERE_HUES = { emerald: 155, azure: 240, indigo: 284 }
/*
 * 亮度一团一个值，不是统一一档。
 *
 * sRGB 在紫那一段容得下的彩度本来就窄，跟绿蓝同一个亮度算出来是**淡紫**——
 * 而它还要被下面那两团 screen 一叠，叠完就是粉的，观感直接滑回 Siri。
 * 所以紫压暗一档换彩度，才站得住「靛」这个字。
 */
const SPHERE_L = { emerald: 0.72, azure: 0.7, indigo: 0.56 }
const SPHERE_F = 0.95

/** camelCase 的键转成 CSS 里的 kebab-case：staticMesh → static-mesh。 */
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

const neutral = Object.fromEntries(Object.entries(NEUTRAL_STEPS).map(([k, L]) => [k, hex(L, 0, 0)]))
const accent = Object.fromEntries(
  CHROMA_STEPS.map((step, index) => [step, hex(ACCENT_L[index], 0, 0)])
)

function chromaRamp(H) {
  const peak = maxChroma(0.6, H)
  return Object.fromEntries(
    CHROMA_STEPS.map((step, i) => {
      const L = CHROMA_L[i]
      return [step, hex(L, Math.min(peak * CHROMA_F[i], maxChroma(L, H) * 0.97), H)]
    })
  )
}

/**
 * 深色主题专用的有色锚点。
 *
 * 不能直接从上面那条色阶里挑 —— 那条是给亮色主题的，同一档在深色底上要么发灰
 * （亮度太高、色域容不下彩度），要么撑不起对比度。所以每个色相单独定亮度：
 * 冷色坐 64~67%，黄色坐 80~84%，彩度一律给到该亮度上限的 92%。
 */
const DARK_ANCHORS = {
  success: [150, 0.645],
  warning: [75, 0.8],
  danger: [27, 0.67],
  folder: [85, 0.84]
}

const darkVivid = {
  accent: accent[50],
  ...Object.fromEntries(
    Object.entries(DARK_ANCHORS).map(([n, [H, L]]) => [n, hex(L, maxChroma(L, H) * 0.92, H)])
  )
}

/** 深色下的浅色底（状态徽标那种「浅底 + 同色文字」）。压得很低，只留一丝色相。 */
const darkTint = {
  accent: neutral[875],
  ...Object.fromEntries(
    Object.entries(HUES).map(([n, H]) => [n, hex(0.265, maxChroma(0.265, H) * 0.45, H)])
  )
}
const darkEdge = {
  accent: neutral[700],
  ...Object.fromEntries(
    Object.entries(HUES).map(([n, H]) => [n, hex(0.4, maxChroma(0.4, H) * 0.55, H)])
  )
}

/**
 * 浅色主题的有色文字：取「还能过 4.5:1 的最亮那一档」。
 *
 * 不是拍一个固定亮度。固定在 51% 的后果是浅色模式比深色模式沉闷 ——
 * 这一段只处理成功 / 警告 / 危险等有色状态；中性强调色直接使用固定灰阶。
 * 有色文字往暗走，第一个过 4.5 的就是答案。
 *
 * 「合规」要同时对白卡片和浅底徽标成立 —— 同一个 --color-success-text
 * 既出现在白卡片上，也出现在浅绿徽标上。浅底更难，按它算就两边都够。
 */
function textOnLight(H, backgrounds) {
  for (let L = 0.72; L >= 0.35; L -= 0.005) {
    const c = hex(L, maxChroma(L, H) * 0.92, H)
    if (backgrounds.every((bg) => contrast(c, bg) >= 4.5)) return c
  }
  throw new Error(`找不到能放在浅色底上的文字色: H=${H}`)
}

/**
 * 浅色主题的有色**图形**：取「还能过 3:1 的最亮那一档」。
 *
 * 跟 textOnLight 是两个角色，别合并。文件夹图标、文件类型图标是大色块，
 * WCAG 1.4.11 对它们的要求是 3:1，不是正文的 4.5:1。
 * 以前文件夹在亮色下复用了 textOnLight，被压到 #866617 —— 那不是琥珀色，
 * 是橄榄褐，看着像脏了。按 3:1 算出来是 #b18822，色相还在，也依旧达标。
 *
 * 两个底都要过：白卡片和 #f7f7f7 页面底，文件夹两处都会出现。
 */
function objectOnLight(H, f = 0.92) {
  for (let L = 0.85; L >= 0.35; L -= 0.005) {
    const c = hex(L, maxChroma(L, H) * f, H)
    if (contrast(c, '#ffffff') >= 3 && contrast(c, neutral[50]) >= 3) return c
  }
  throw new Error(`找不到能放在浅色底上的图形色: H=${H}`)
}

/** 普通实心按钮：白字要过 4.5:1，所以从亮往暗找第一个够格的 —— 尽量保住彩度。 */
function solidForWhiteText(H) {
  for (let L = 0.72; L >= 0.4; L -= 0.005) {
    const c = hex(L, maxChroma(L, H) * 0.92, H)
    if (contrast('#ffffff', c) >= 4.5) return c
  }
  throw new Error(`找不到能配白字的实心色: H=${H}`)
}

function solidHoverForWhiteText(H, base) {
  for (let L = 0.7; L >= 0.3; L -= 0.005) {
    const c = hex(L, maxChroma(L, H) * 0.92, H)
    if (relLuminance(c) < relLuminance(base) * 0.78) return c
  }
  return base
}

// 黑白灰负责表面；系统蓝只用于强动作和当前位置指示（生成按钮、TAB 下划线等）。
const INTERACTIVE_HUE = 257
const whiteTextHues = Object.entries(HUES).filter(([name]) => name !== 'warning')
const solid = {
  accent: solidForWhiteText(INTERACTIVE_HUE),
  ...Object.fromEntries(whiteTextHues.map(([n, H]) => [n, solidForWhiteText(H)])),
  // 警告黄不再为了迁就白字压成褐色；保留亮琥珀，改配深色字。
  warning: darkVivid.warning
}

/**
 * 普通实心按钮的悬停态：**压暗**，不是提亮。警告黄另走下方的明亮琥珀配色。
 *
 * 提亮走不通。solid 已经是「白字还能过 4.5:1 的最亮那一档」——
 * 按定义再亮一点白字就掉下去了。之前这里往亮走 25% 亮度，
 * 结果五个色相的悬停态全部只剩 3.8:1：鼠标一放上去，按钮上的字就开始糊。
 *
 * 往暗走两头都对：白字对比度只增不减，而且「按下去变深」本来就是
 * GitHub / Bootstrap 一路的主按钮惯例，两个主题下都读得懂。
 */
const solidHover = {
  accent: solidHoverForWhiteText(INTERACTIVE_HUE, solid.accent),
  ...Object.fromEntries(whiteTextHues.map(([n, H]) => [n, solidHoverForWhiteText(H, solid[n])])),
  warning: hex(0.74, maxChroma(0.74, HUES.warning) * 0.92, HUES.warning)
}

/* Switch 与强动作共用系统蓝：蓝轨明确表达「已开启」，避免中灰开启态和禁用态混在一起。 */
const switchChecked = solid.accent
const switchCheckedHover = solidHover.accent

/**
 * 反相底（主按钮）。四个都是纯灰，彩度 0。
 *
 * 没有复用中性色阶里的档位 —— 那条色阶的档位是按「表面色」和「文字色」定的，
 * 最暗的 975 是 #080808、950 是 #111111，都不是这里想要的 #0d0d0d；
 * 硬塞进色阶等于为一个按钮再加四档，中性色阶会被撑成一条没人看得懂的梯子。
 * 所以单列成锚点，跟 --dk-* / *-solid 一个待遇。
 */
const INVERSE_L = {
  light: 0.1591, // #0d0d0d 浅色主题的主按钮底
  'light-hover': 0.3484, // #3a3a3a 悬停时提亮，因为底是暗的
  dark: 0.991, // #fcfcfc 深色主题的主按钮底
  'dark-hover': 0.895 // #dcdcdc 悬停时压暗，因为底是亮的
}
const inverseAnchors = Object.fromEntries(
  Object.entries(INVERSE_L).map(([k, L]) => [k, hex(L, 0, 0)])
)

const ramps = {
  accent,
  ...Object.fromEntries(Object.entries(HUES).map(([n, H]) => [n, chromaRamp(H)]))
}

const lightText = {
  accent: accent[900],
  ...Object.fromEntries(
    Object.entries(HUES).map(([n, H]) => [n, textOnLight(H, ['#ffffff', ramps[n][100]])])
  )
}

/**
 * 文件夹图标，浅色主题。
 *
 * 这里**不套** objectOnLight 的 3:1。1.4.11 管的是「理解内容所必需的图形」——
 * 文件夹图标下面永远压着文件夹名，分组标题还写着「文件夹 (n)」，
 * 颜色不承担任何信息，是冗余装饰。硬套 3:1 的结果是 #b18822：
 * 黄色在那个对比度上只剩橄榄褐，看着像脏了。
 *
 * 所以按「文件管理器里的文件夹该长什么样」定亮度：
 * L=0.76 → #dba92c，对白底 2.16 —— 跟 macOS 那个蓝文件夹（2.37）一个量级。
 * 文件类型 / UE 类型的色块不走这条路：它们**用颜色编码类别**，继续按 3:1 验。
 */
const FOLDER_LIGHT_L = 0.76
const folderObjectLight = hex(
  FOLDER_LIGHT_L,
  maxChroma(FOLDER_LIGHT_L, HUES.folder) * 0.92,
  HUES.folder
)

/** 文件类型分类色：深色底上提亮保彩度，浅色底上压暗保对比度，跟 --dk-* / *-text-light 一个路子。 */
const filetypeDark = Object.fromEntries(
  Object.entries(FILETYPE_HUES).map(([n, H]) => {
    // 暖色（黄橙）天生就该亮，压到冷色那个位置会变成橄榄绿 —— 跟 DARK_ANCHORS 同一条理由。
    const L = H > 20 && H < 110 ? 0.76 : 0.7
    return [n, hex(L, maxChroma(L, H) * FILETYPE_F, H)]
  })
)
const filetypeLight = Object.fromEntries(
  Object.entries(FILETYPE_HUES).map(([n, H]) => [n, objectOnLight(H, FILETYPE_F)])
)

const uetypeDark = Object.fromEntries(
  Object.entries(UETYPE_HUES).map(([n, H]) => {
    const L = H > 20 && H < 110 ? 0.76 : 0.7
    return [n, hex(L, maxChroma(L, H) * UETYPE_F, H)]
  })
)
const uetypeLight = Object.fromEntries(
  Object.entries(UETYPE_HUES).map(([n, H]) => [n, objectOnLight(H, UETYPE_F)])
)

const sphere = Object.fromEntries(
  Object.entries(SPHERE_HUES).map(([n, H]) => {
    const L = SPHERE_L[n]
    return [n, hex(L, maxChroma(L, H) * SPHERE_F, H)]
  })
)

/* ---------- 输出 ---------- */

const P = (name, map) =>
  Object.entries(map)
    .map(([k, v]) => `  --${name}-${k}: ${v};`)
    .join('\n')

const css = `/* 本文件由 scripts/gen-palette.mjs 生成，不要手改。改色请改脚本再跑 pnpm palette。 */
/* This file is generated by scripts/gen-palette.mjs. Do not edit by hand. */

/* ==========================================================================
 * 第一层：原色（primitives）
 *
 * 只描述「这是什么颜色」，不描述「用在哪」。组件**永远不要**直接用这一层 ——
 * 一旦组件里出现 --accent-500，主题切换就没有接缝了，
 * 以后想改主题得挨个翻用法，猜哪个是「强调色」、哪个只是碰巧想要灰的。
 * ========================================================================== */
:root {
  /* 中性：纯灰，彩度 0。两端密、中段疏 —— 表面色住两端，文字住中段。 */
${P('n', neutral)}

  /* 强调：Codex 风格中性灰阶。交互靠明度、形状和位置，不靠蓝色色相。 */
${P('accent', ramps.accent)}

  /* 成功 150° */
${P('success', ramps.success)}

  /* 警告 75° */
${P('warning', ramps.warning)}

  /* 危险 27° */
${P('danger', ramps.danger)}

  /* 文件夹 85°（Win11 文件夹琥珀）—— 只生成实际用得到的两档 */
  --folder-500: ${ramps.folder[500]};
  --folder-700: ${ramps.folder[700]};

  /* 深色主题专用锚点：坐在色域最宽的亮度上，彩度给到 92% 上限。
     不是上面色阶的某一档 —— 那条给亮色主题用的档位放到深色底上会发灰。 */
${Object.entries(darkVivid)
  .map(([k, v]) => `  --dk-${k}: ${v};`)
  .join('\n')}
${Object.entries(darkTint)
  .map(([k, v]) => `  --dk-${k}-tint: ${v};`)
  .join('\n')}
${Object.entries(darkEdge)
  .map(([k, v]) => `  --dk-${k}-edge: ${v};`)
  .join('\n')}

  /* 浅色主题专用锚点：压暗到在白底**和**自己那档浅色底（*-100）上都过 4.5:1。
     跟 --dk-* 是对称的一组 —— 深色底上要提亮保彩度，浅色底上要压暗保对比度。
     这一组以前算出来了却忘了输出，第二层的 --color-accent-text 等五个
     全部指向未定义的变量：浅色模式下强调文字、成功、警告、危险、文件夹
     的 color 声明整条作废，颜色退回继承正文的黑色。 */
${Object.entries(lightText)
  .map(([k, v]) => `  --${k}-text-light: ${v};`)
  .join('\n')}

  /* 文件夹图标（浅色）。有文字标签兜底，所以按「像个文件夹」定色，
     不按对比度硬压 —— 详见 gen-palette.mjs 里的 folderObjectLight。 */
  --folder-object-light: ${folderObjectLight};

  /* 文件类型分类色（图片 / 文档 / 视频 / 音频 / 模型 / 压缩包）。
     深色深浅两套各一份，图标是大色块，两边都按 3:1 验。 */
${Object.entries(filetypeDark)
  .map(([k, v]) => `  --filetype-${k}-dark: ${v};`)
  .join('\n')}
${Object.entries(filetypeLight)
  .map(([k, v]) => `  --filetype-${k}-light: ${v};`)
  .join('\n')}

  /* 语音球光谱：自发光，色相不随主题变。详见脚本里 SPHERE_HUES 那段。

     玻璃底**分两套**，因为「玻璃」在深浅两个环境里是两种东西：
     深色下它是一颗**发光的黑玻璃球**，里面三团光靠 screen 叠加往外透；
     浅色下它是一块**磨砂白玻璃**，里面三团是被磨砂糊开的颜料 ——
     后者要是照搬前者，白底上 screen 叠加等于不叠，得到的是一个洗白的圆饼。 */
${P('sphere', sphere)}
  --sphere-base-dark: ${neutral[950]};
  --sphere-base-light: ${neutral[75]};

  /* UE 资产类型色：色相沿用 UE 编辑器，亮度彩度按主题重算。 */
${Object.entries(uetypeDark)
  .map(([k, v]) => `  --uetype-${kebab(k)}-dark: ${v};`)
  .join('\n')}
${Object.entries(uetypeLight)
  .map(([k, v]) => `  --uetype-${kebab(k)}-light: ${v};`)
  .join('\n')}

  /* 实心按钮底色：普通状态配白字；警告黄保留明亮琥珀，配专用深色字。 */
${Object.entries(solid)
  .map(([k, v]) => `  --${k}-solid: ${v};`)
  .join('\n')}
${Object.entries(solidHover)
  .map(([k, v]) => `  --${k}-solid-hover: ${v};`)
  .join('\n')}

  /* Switch 开启态：商务灰界面里保留蓝轨，和禁用灰明确分开。 */
  --switch-checked-solid: ${switchChecked};
  --switch-checked-solid-hover: ${switchCheckedHover};

  /* 反相底：主按钮用的那块「跟页面反过来」的纯灰。
     浅色主题下是近黑，深色主题下是近白 —— 不是蓝色实心。
     主按钮的作用是「这一屏就点这个」，靠的是**明度反差**，不是颜色。
     蓝色实心在这里帮倒忙：界面上已经有蓝色链接、蓝色徽标，
     主按钮再用同一个蓝，它就只是「又一块蓝的」，跳不出来。
     配的字色直接用现成的 --color-text-inverse（浅色下是白、深色下是近黑）。 */
${Object.entries(inverseAnchors)
  .map(([k, v]) => `  --inverse-${k}: ${v};`)
  .join('\n')}
}

/* ==========================================================================
 * 第二层：语义色（semantics）
 *
 * 只描述「用在哪」，值指向第一层。组件只准用这一层。
 * 换主题 = 把这一层重新指一遍，第一层和所有组件一个字都不用动。
 *
 * 命名法则：--color-{角色}-{变体}-{状态}，一个概念只用一个词
 *   前景一律 text（不用 fg/foreground/content）
 *   背景一律 bg（不用 background/surface 当同义词）
 *   描边一律 border（不用 stroke/outline/line）
 *   品牌色一律 accent（不用 primary/brand/theme 混着叫）
 * primary 只保留一个意思：「同组里最显眼的那个」，比如 text-primary 是正文。
 * ========================================================================== */
:root,
[data-theme='dark'] {
  color-scheme: dark;

  /* 表面 */
  --color-bg-page: var(--n-950);
  --color-bg-surface: var(--n-925);
  --color-bg-surface-hover: var(--n-900);
  --color-bg-option: var(--n-910);
  --color-bg-option-hover: var(--n-880);
  --color-bg-option-selected: var(--n-865);
  --color-bg-raised: var(--n-900);
  --color-bg-sunken: var(--n-925);
  /* 「软按钮」的底：填了色但不描边、不抢戏的那一档动作按钮（AppButton
     variant="soft"）。设置页里那些「复制路径」「打开目录」「添加」用它。
     必须自成一对，不能借 --color-bg-surface-hover 当底再拿它自己当 hover ——
     那正是原来各页手搓的写法，底色和悬停色同一个值，鼠标划过去毫无反应。
     方向跟着主题走：深色越浮越亮，浅色越按越暗。 */
  --color-bg-soft: var(--n-900);
  --color-bg-soft-hover: var(--n-865);
  /* 模态框背后压暗整屏的黑纱。全应用只有十来个模态框会用到它。 */
  --color-bg-scrim: rgb(0 0 0 / 60%);
  /* 浮在**图片 / 画布 / 视频**上的小控件和徽标：关闭按钮、页码、缩略图条那一类。
     它跟主题无关 —— 底下是用户的图，图是什么样跟深浅色没关系 ——
     所以两个主题同一个值，配 --color-text-on-solid（白字）在纯白图上也有 7:1。
     别拿它当「凹下去一块」用，那是 --color-bg-sunken。 */
  --color-bg-overlay: rgb(0 0 0 / 65%);
  /* 反相底：主按钮那块「跟页面反过来」的纯灰，深色主题下是近白。
     字色配 --color-text-inverse。这不是表面层级的一档，别拿它当卡片底。 */
  --color-bg-inverse: var(--inverse-dark);
  --color-bg-inverse-hover: var(--inverse-dark-hover);

  /* 文字 */
  --color-text-primary: #fcfcfc;
  --color-text-secondary: var(--n-300);
  --color-text-muted: var(--n-500);
  --color-text-disabled: var(--n-600);
  --color-text-inverse: var(--n-950);
  /* 普通实心填充上的文字。警告黄例外，使用 --color-warning-on-solid。 */
  --color-text-on-solid: #ffffff;

  /* 描边。分隔线只是装饰，控件边界要过 3:1（WCAG 1.4.11），两者不是一个角色。 */
  --color-separator: var(--n-850);
  --color-border-subtle: var(--n-850);
  --color-border: var(--n-800);
  --color-border-option: var(--n-865);
  --color-border-strong: var(--n-700);
  --color-border-focus: var(--dk-accent);

  /* 强调 */
  --color-accent-text: var(--dk-accent);
  --color-accent-bg: var(--dk-accent-tint);
  --color-accent-bg-hover: var(--dk-accent-edge);
  --color-accent-border: var(--dk-accent-edge);
  --color-accent-solid: var(--accent-solid);
  --color-accent-solid-hover: var(--accent-solid-hover);

  /* Switch 是交互状态，不复用全局中性 accent。 */
  --color-switch-checked-solid: var(--switch-checked-solid);
  --color-switch-checked-solid-hover: var(--switch-checked-solid-hover);

  /* 文本选区是短暂反馈，用蓝底白字与中性表面拉开距离。 */
  --color-selection-bg: var(--switch-checked-solid);
  --color-selection-text: var(--color-text-on-solid);

  /* 选中态。这是「这一项被选中了，而且会一直选中」——侧边栏当前页、
     筛选器里勾上的那一条、列表里被点开的那一行。
     它跟 hover 不是一个角色：hover 是鼠标路过，手一挪就没了；
     选中是状态，鼠标挪走了还在。以前有十几处拿 --color-bg-surface-hover
     当选中底色，结果「选中的那条」和「鼠标正在划过的那条」长得一模一样，
     用户根本分不出自己选的是哪个。
     选中底是中性灰；选中只表达「这一项被挑中了」，所以只改灰度，
     不改色相，也不加描边 —— 描边是「这是个可点的边界」，跟选没选中无关。
     注意跟 CSS 的 :active（按下去的那一瞬间）区分开，那是按压，不是选中。 */
  --color-bg-selected: var(--n-875);
  --color-bg-selected-hover: var(--n-850);
  --color-text-selected: var(--color-text-primary);

  /* 状态 */
  --color-success-text: var(--dk-success);
  --color-success-bg: var(--dk-success-tint);
  --color-success-border: var(--dk-success-edge);
  --color-success-solid: var(--success-solid);
  --color-warning-text: var(--dk-warning);
  --color-warning-bg: var(--dk-warning-tint);
  --color-warning-border: var(--dk-warning-edge);
  --color-warning-solid: var(--warning-solid);
  --color-warning-solid-hover: var(--warning-solid-hover);
  --color-warning-on-solid: var(--n-950);
  --color-danger-text: var(--dk-danger);
  --color-danger-bg: var(--dk-danger-tint);
  --color-danger-border: var(--dk-danger-edge);
  --color-danger-solid: var(--danger-solid);

  /* 具体物件的颜色。文件夹是「文件夹本来就是黄的」，不是状态。 */
  --color-folder: var(--dk-folder);

  /* 文件类型分类色。这是「这是哪一类文件」，不是状态，也不是强调 ——
     所以彩度比状态色低一档，别拿它当徽标底或按钮色用。
     代码文件和认不出的类型不给色相：不是每个扩展名都值得一个颜色。 */
  --color-filetype-image: var(--filetype-image-dark);
  --color-filetype-doc: var(--filetype-doc-dark);
  --color-filetype-video: var(--filetype-video-dark);
  --color-filetype-audio: var(--filetype-audio-dark);
  --color-filetype-model: var(--filetype-model-dark);
  --color-filetype-archive: var(--filetype-archive-dark);
  --color-filetype-code: var(--n-400);
  --color-filetype-unknown: var(--n-500);

  /* UE 资产类型色。色相是 UE 编辑器的，别拿它当强调或状态用。 */
${Object.keys(UETYPE_HUES)
  .map((k) => `  --color-uetype-${kebab(k)}: var(--uetype-${kebab(k)}-dark);`)
  .join('\n')}
  --color-uetype-particle: var(--n-300);
  --color-uetype-code: var(--n-400);
  --color-uetype-unknown: var(--n-500);

  /* 语音球光谱。两套主题同值 —— 它是自发光的，不是界面表面。 */
${Object.keys(SPHERE_HUES)
  .map((k) => `  --color-sphere-${k}: var(--sphere-${k});`)
  .join('\n')}
  --color-sphere-base: var(--sphere-base-dark);

  /* 玻璃材质。语音球那块「液态玻璃」用的就是这一组。

     它们必须是**半透明的白和黑**，不能换成不透明的语义色 —— 玻璃的道理就是
     让背后的东西透过来，一旦给它一个实色，那就不是玻璃是塑料片了。
     深色下靠顶部提亮撑出厚度；浅色那一组方向相反，见下面。 */
  --color-glass-tint: rgb(255 255 255 / 7%);
  --color-glass-tint-edge: rgb(255 255 255 / 2%);
  --color-glass-hairline: rgb(255 255 255 / 34%);
  --color-glass-top-light: rgb(255 255 255 / 22%);
  --color-glass-bottom-shade: rgb(0 0 0 / 45%);
  --color-glass-drop: rgb(0 0 0 / 45%);
}

[data-theme='light'] {
  color-scheme: light;

  /* 浅色模式的层级方向跟深色是**反的**：深色靠「越浮越亮」，浅色靠「越浮越白、
     交互态越按越暗」。所以 hover 比卡片暗，不是比卡片亮。
     以前这里 page 和 surface-hover 都指向 n-50，是同一个值 ——
     结果所有「浮起来一档」的小面（徽标、悬停行）在页面上完全看不见。 */
  --color-bg-page: var(--n-50);
  --color-bg-surface: #ffffff;
  --color-bg-surface-hover: var(--n-75);
  --color-bg-option: #ffffff;
  --color-bg-option-hover: var(--n-70);
  --color-bg-option-selected: var(--n-90);
  --color-bg-raised: #ffffff;
  --color-bg-sunken: var(--n-100);
  /* 软按钮的底（角色说明见深色那一段）。浅色这边 hover 往暗走 */
  --color-bg-soft: var(--n-75);
  --color-bg-soft-hover: var(--n-100);
  /* 模态框背后压暗整屏的黑纱。全应用只有十来个模态框会用到它。 */
  --color-bg-scrim: rgb(0 0 0 / 45%);
  /* 浮在**图片 / 画布 / 视频**上的小控件和徽标：关闭按钮、页码、缩略图条那一类。
     它跟主题无关 —— 底下是用户的图，图是什么样跟深浅色没关系 ——
     所以两个主题同一个值，配 --color-text-on-solid（白字）在纯白图上也有 7:1。
     别拿它当「凹下去一块」用，那是 --color-bg-sunken。 */
  --color-bg-overlay: rgb(0 0 0 / 65%);
  /* 反相底（角色说明见深色那一段），浅色主题下是近黑。
     悬停方向跟深色相反：暗底往亮里走，亮底往暗里走 —— 都是「离页面更远一步」。 */
  --color-bg-inverse: var(--inverse-light);
  --color-bg-inverse-hover: var(--inverse-light-hover);

  --color-text-primary: var(--n-950);
  --color-text-secondary: var(--n-800);
  --color-text-muted: var(--n-700);
  --color-text-disabled: var(--n-500);
  --color-text-inverse: #ffffff;
  /* 普通实心填充上的文字。警告黄例外，使用 --color-warning-on-solid。 */
  --color-text-on-solid: #ffffff;

  --color-separator: var(--n-200);
  --color-border-subtle: var(--n-200);
  --color-border: var(--n-300);
  --color-border-option: var(--n-90);
  --color-border-strong: var(--n-600);
  --color-border-focus: var(--accent-600);

  --color-accent-text: var(--accent-text-light);
  --color-accent-bg: var(--accent-100);
  --color-accent-bg-hover: var(--accent-200);
  --color-accent-border: var(--accent-600);
  --color-accent-solid: var(--accent-solid);
  --color-accent-solid-hover: var(--accent-solid-hover);

  --color-switch-checked-solid: var(--switch-checked-solid);
  --color-switch-checked-solid-hover: var(--switch-checked-solid-hover);

  --color-selection-bg: var(--switch-checked-solid);
  --color-selection-text: var(--color-text-on-solid);

  /* 选中态（角色说明见深色那一段）。浅色这边方向是反的：越选越暗。
     选中底比悬停底暗一档就够了 —— 中性灰没有色相帮忙，全靠这点灰度差，
     再近一档（#efefef，只差 3 个色阶值）实测 1.027，两个面就分不出来了。 */
  --color-bg-selected: var(--n-100);
  --color-bg-selected-hover: var(--n-200);
  --color-text-selected: var(--color-text-primary);

  --color-success-text: var(--success-text-light);
  --color-success-bg: var(--success-100);
  --color-success-border: var(--success-300);
  --color-success-solid: var(--success-solid);
  --color-warning-text: var(--warning-text-light);
  --color-warning-bg: var(--warning-100);
  --color-warning-border: var(--warning-300);
  --color-warning-solid: var(--warning-solid);
  --color-warning-solid-hover: var(--warning-solid-hover);
  --color-warning-on-solid: var(--n-950);
  --color-danger-text: var(--danger-text-light);
  --color-danger-bg: var(--danger-100);
  --color-danger-border: var(--danger-300);
  --color-danger-solid: var(--danger-solid);

  --color-folder: var(--folder-object-light);

  --color-filetype-image: var(--filetype-image-light);
  --color-filetype-doc: var(--filetype-doc-light);
  --color-filetype-video: var(--filetype-video-light);
  --color-filetype-audio: var(--filetype-audio-light);
  --color-filetype-model: var(--filetype-model-light);
  --color-filetype-archive: var(--filetype-archive-light);
  --color-filetype-code: var(--n-600);
  --color-filetype-unknown: var(--n-500);

${Object.keys(UETYPE_HUES)
  .map((k) => `  --color-uetype-${kebab(k)}: var(--uetype-${kebab(k)}-light);`)
  .join('\n')}
  --color-uetype-particle: var(--n-500);
  --color-uetype-code: var(--n-600);
  --color-uetype-unknown: var(--n-500);

  /* 语音球光谱。两套主题同值 —— 它是自发光的，不是界面表面。 */
${Object.keys(SPHERE_HUES)
  .map((k) => `  --color-sphere-${k}: var(--sphere-${k});`)
  .join('\n')}
  --color-sphere-base: var(--sphere-base-light);

  /* 玻璃材质（浅色）。方向跟深色是反的：那边靠顶部提亮，这边靠底部压暗。
     磨砂本身要够白才盖得住背后的颜色，投影则要收到很轻 —— 白底上一坨黑是脏。 */
  --color-glass-tint: rgb(255 255 255 / 40%);
  --color-glass-tint-edge: rgb(255 255 255 / 18%);
  --color-glass-hairline: rgb(255 255 255 / 85%);
  --color-glass-top-light: rgb(255 255 255 / 70%);
  --color-glass-bottom-shade: rgb(0 0 0 / 12%);
  --color-glass-drop: rgb(0 0 0 / 14%);
}
`

writeFileSync(OUT, css, 'utf8')

/* ---------- 同一套值再吐一份 TS ----------
 *
 * ant-design-vue 的主题配置只吃 JS 对象，吃不了 CSS 变量。以前的做法是在
 * useTheme.ts 里再手抄一遍颜色 —— 于是抄错了：亮色主题的 colorText 抄成了 #FFFFFF，
 * 白底白字，亮色模式等于是坏的。所以两边共用这一份生成结果，抄不了就不会抄错。
 */

const roles = {
  dark: {
    bgPage: neutral[950],
    bgSurface: neutral[925],
    bgSurfaceHover: neutral[900],
    bgOption: neutral[910],
    bgOptionHover: neutral[880],
    bgOptionSelected: neutral[865],
    bgRaised: neutral[900],
    bgSunken: neutral[925],
    scrim: 'rgba(0, 0, 0, 0.6)',
    overlay: 'rgba(0, 0, 0, 0.65)',
    bgInverse: inverseAnchors['dark'],
    bgInverseHover: inverseAnchors['dark-hover'],
    textPrimary: '#fcfcfc',
    textSecondary: neutral[300],
    textMuted: neutral[500],
    textDisabled: neutral[600],
    separator: neutral[850],
    borderSubtle: neutral[850],
    border: neutral[800],
    borderOption: neutral[865],
    borderStrong: neutral[700],
    accentText: darkVivid.accent,
    accentBg: darkTint.accent,
    accentBorder: darkEdge.accent,
    accentSolid: solid.accent,
    accentSolidHover: solidHover.accent,
    switchChecked,
    switchCheckedHover,
    selectionBg: switchChecked,
    selectionText: '#ffffff',
    successText: darkVivid.success,
    successBg: darkTint.success,
    successBorder: darkEdge.success,
    warningText: darkVivid.warning,
    warningBg: darkTint.warning,
    warningBorder: darkEdge.warning,
    dangerText: darkVivid.danger,
    dangerBg: darkTint.danger,
    dangerBorder: darkEdge.danger,
    folder: darkVivid.folder
  },
  light: {
    bgPage: neutral[50],
    bgSurface: '#ffffff',
    bgSurfaceHover: neutral[75],
    bgOption: '#ffffff',
    bgOptionHover: neutral[70],
    bgOptionSelected: neutral[90],
    bgRaised: '#ffffff',
    bgSunken: neutral[100],
    scrim: 'rgba(0, 0, 0, 0.45)',
    overlay: 'rgba(0, 0, 0, 0.65)',
    bgInverse: inverseAnchors['light'],
    bgInverseHover: inverseAnchors['light-hover'],
    textPrimary: neutral[950],
    textSecondary: neutral[800],
    textMuted: neutral[700],
    textDisabled: neutral[500],
    separator: neutral[200],
    borderSubtle: neutral[200],
    border: neutral[300],
    borderOption: neutral[90],
    borderStrong: neutral[600],
    accentText: lightText.accent,
    accentBg: ramps.accent[100],
    accentBorder: ramps.accent[600],
    accentSolid: solid.accent,
    accentSolidHover: solidHover.accent,
    switchChecked,
    switchCheckedHover,
    selectionBg: switchChecked,
    selectionText: '#ffffff',
    successText: lightText.success,
    successBg: ramps.success[100],
    successBorder: ramps.success[300],
    warningText: lightText.warning,
    warningBg: ramps.warning[100],
    warningBorder: ramps.warning[300],
    dangerText: lightText.danger,
    dangerBg: ramps.danger[100],
    dangerBorder: ramps.danger[300],
    folder: folderObjectLight
  }
}

const ts = `/* 本文件由 scripts/gen-palette.mjs 生成，不要手改。 */
/* This file is generated by scripts/gen-palette.mjs. Do not edit by hand. */

/**
 * 语义色的运行时副本，值与 palette.generated.css 第二层逐条对应。
 *
 * 只给吃不了 CSS 变量的地方用 —— 目前是 ant-design-vue 的 ThemeConfig。
 * 组件写样式请用 CSS 变量（var(--color-text-secondary) 这种），别 import 这里。
 */
export const palette = ${JSON.stringify(roles, null, 2)
  .replace(/"([a-zA-Z]+)":/g, '$1:')
  .replace(/"/g, "'")} as const

export type ThemeRoles = (typeof palette)['dark']
`

writeFileSync(OUT_TS, ts, 'utf8')

/* ---------- 自检：每一对实际会叠在一起的前景/背景都量一遍 ---------- */

const dark = {
  page: neutral[950],
  surface: neutral[925],
  raised: neutral[900],
  sunken: neutral[925]
}
const light = { page: neutral[50], surface: '#ffffff', hover: neutral[75], sunken: neutral[100] }

/**
 * 相邻表面必须能分辨。
 *
 * 这条不是无障碍要求，是「hover 到底有没有反应」的要求 ——
 * 之前浅色模式的 page 和 surface-hover 指向同一个值，所有悬停态在页面上是全无反应的。
 * 1.04 大约对应 4% 的亮度差，是描边配合下肉眼能看出两个面的下限。
 */
const surfacePairs = [
  ['深 页面 ↔ 卡片', dark.page, dark.surface],
  ['深 卡片 ↔ 悬停', dark.surface, neutral[900]],
  ['深 页面 ↔ 凹陷', dark.page, dark.sunken],
  ['亮 页面 ↔ 卡片', light.page, light.surface],
  ['亮 卡片 ↔ 悬停', light.surface, light.hover],
  ['亮 页面 ↔ 悬停', light.page, light.hover],
  ['亮 卡片 ↔ 凹陷', light.surface, light.sunken],
  // 选中底必须跟卡片分得开，否则「选中了」这件事在页面上是隐形的。
  ['深 卡片 ↔ 选中', dark.surface, neutral[875]],
  ['亮 卡片 ↔ 选中', light.surface, neutral[100]],
  // 选中态既然是中性灰，就没有色相帮忙了，全靠这点灰度差撑着。
  // 这两对不达标的直接后果：选中的那条和鼠标正划过的那条，肉眼分不出来。
  ['深 悬停 ↔ 选中', neutral[900], neutral[875]],
  ['亮 悬停 ↔ 选中', neutral[75], neutral[100]]
]

const checks = [
  ['深 正文 / 页面', '#fcfcfc', dark.page, 4.5],
  ['深 正文 / 卡片', '#fcfcfc', dark.surface, 4.5],
  ['深 次要 / 页面', neutral[300], dark.page, 4.5],
  ['深 次要 / 卡片', neutral[300], dark.surface, 4.5],
  ['深 弱化 / 卡片', neutral[500], dark.surface, 4.5],
  ['深 禁用 / 卡片', neutral[600], dark.surface, 1.8],
  ['深 控件描边 / 卡片', neutral[700], dark.surface, 3],
  ['深 强调文字 / 卡片', darkVivid.accent, dark.surface, 4.5],
  ['深 强调文字 / 浅底', darkVivid.accent, darkTint.accent, 4.5],
  ['深 成功文字 / 卡片', darkVivid.success, dark.surface, 4.5],
  ['深 成功文字 / 浅底', darkVivid.success, darkTint.success, 4.5],
  ['深 警告文字 / 卡片', darkVivid.warning, dark.surface, 4.5],
  ['深 警告文字 / 浅底', darkVivid.warning, darkTint.warning, 4.5],
  ['深 危险文字 / 卡片', darkVivid.danger, dark.surface, 4.5],
  ['深 危险文字 / 浅底', darkVivid.danger, darkTint.danger, 4.5],
  ['深 文件夹 / 卡片', darkVivid.folder, dark.surface, 3],
  // 普通实心填充配白字；警告黄为了保持明亮，单独配深色字。
  ...Object.keys(solid)
    .filter((n) => n !== 'warning')
    .map((n) => [`白字 / ${n} 实心`, '#ffffff', solid[n], 4.5]),
  ...Object.keys(solidHover)
    .filter((n) => n !== 'warning')
    .map((n) => [`白字 / ${n} 实心悬停`, '#ffffff', solidHover[n], 4.5]),
  ['深字 / warning 实心', neutral[950], solid.warning, 4.5],
  ['深字 / warning 实心悬停', neutral[950], solidHover.warning, 4.5],
  ['白钮 / Switch 开启', '#ffffff', switchChecked, 4.5],
  ['白钮 / Switch 开启悬停', '#ffffff', switchCheckedHover, 4.5],
  ['深 Switch 开启轨道 / 卡片', switchChecked, dark.surface, 3],
  ['亮 Switch 开启轨道 / 卡片', switchChecked, light.surface, 3],
  ['选区白字 / 蓝底', '#ffffff', switchChecked, 4.5],
  ['深色选区 / 卡片', switchChecked, dark.surface, 3],
  ['浅色选区 / 卡片', switchChecked, light.surface, 3],
  // 主按钮的字压在反相底上。四个状态都得单独量 ——
  // 常态过了不代表悬停过，悬停那一档是往对比度低的方向走的。
  ['深 反相底字 / 常态', neutral[950], inverseAnchors['dark'], 4.5],
  ['深 反相底字 / 悬停', neutral[950], inverseAnchors['dark-hover'], 4.5],
  ['亮 反相底字 / 常态', '#ffffff', inverseAnchors['light'], 4.5],
  ['亮 反相底字 / 悬停', '#ffffff', inverseAnchors['light-hover'], 4.5],
  ['亮 正文 / 页面', neutral[950], light.page, 4.5],
  ['亮 正文 / 卡片', neutral[950], light.surface, 4.5],
  ['亮 次要 / 页面', neutral[800], light.page, 4.5],
  ['亮 弱化 / 页面', neutral[700], light.page, 4.5],
  ['亮 正文 / 悬停底', neutral[950], light.hover, 4.5],
  ['亮 弱化 / 悬停底', neutral[700], light.hover, 4.5],
  ['亮 正文 / 凹陷底', neutral[950], light.sunken, 4.5],
  ['亮 弱化 / 凹陷底', neutral[700], light.sunken, 4.5],
  ['亮 弱化 / 卡片', neutral[700], light.surface, 4.5],
  ['亮 禁用 / 卡片', neutral[500], light.surface, 1.8],
  ['亮 控件描边 / 卡片', neutral[600], light.surface, 3],
  ['亮 强调文字 / 卡片', lightText.accent, light.surface, 4.5],
  ['亮 强调文字 / 浅底', lightText.accent, ramps.accent[100], 4.5],
  ['亮 成功文字 / 浅底', lightText.success, ramps.success[100], 4.5],
  ['亮 警告文字 / 浅底', lightText.warning, ramps.warning[100], 4.5],
  ['亮 危险文字 / 浅底', lightText.danger, ramps.danger[100], 4.5],
  // 文件夹是有文字标签的装饰图形，不按 1.4.11 验（见 folderObjectLight）。
  // 这两条只是防止它哪天被改到跟白底糊在一起。
  ['亮 文件夹 / 卡片', folderObjectLight, light.surface, 1.9],
  ['亮 文件夹 / 页面', folderObjectLight, light.page, 1.8],
  ['亮 正文 / 悬停底2', neutral[950], light.hover, 4.5],
  // 文件类型图标是大色块，两个主题都按 1.4.11 的 3:1 验，卡片和页面底各一遍
  ...Object.keys(filetypeDark).flatMap((n) => [
    [`深 ${n} 图标 / 卡片`, filetypeDark[n], dark.surface, 3],
    [`深 ${n} 图标 / 页面`, filetypeDark[n], dark.page, 3]
  ]),
  ...Object.keys(filetypeLight).flatMap((n) => [
    [`亮 ${n} 图标 / 卡片`, filetypeLight[n], light.surface, 3],
    [`亮 ${n} 图标 / 页面`, filetypeLight[n], light.page, 3]
  ]),
  ['深 code 图标 / 卡片', neutral[400], dark.surface, 3],
  ['深 unknown 图标 / 卡片', neutral[500], dark.surface, 3],
  ['亮 code 图标 / 卡片', neutral[600], light.surface, 3],
  ['亮 unknown 图标 / 卡片', neutral[500], light.surface, 3],
  // UE 资产类型色同样是色块（图标 + 缩略图下的色条），两个主题各验一遍
  ...Object.keys(uetypeDark).flatMap((n) => [
    [`深 UE ${n} / 卡片`, uetypeDark[n], dark.surface, 3],
    [`深 UE ${n} / 页面`, uetypeDark[n], dark.page, 3]
  ]),
  ...Object.keys(uetypeLight).flatMap((n) => [
    [`亮 UE ${n} / 卡片`, uetypeLight[n], light.surface, 3],
    [`亮 UE ${n} / 页面`, uetypeLight[n], light.page, 3]
  ]),
  ['深 UE 粒子 / 卡片', neutral[300], dark.surface, 3],
  ['亮 UE 粒子 / 卡片', neutral[500], light.surface, 3]
]

let failed = 0
for (const [label, fg, bg, need] of checks) {
  const value = contrast(fg, bg)
  const ok = value >= need
  if (!ok) failed++
  console.log(
    `  ${ok ? '✓' : '✗'} ${value.toFixed(2).padStart(6)} (需 ${need})  ${label}  ${fg} / ${bg}`
  )
}

console.log('')
for (const [label, a, b] of surfacePairs) {
  const value = contrast(a, b)
  const ok = value >= 1.04
  if (!ok) failed++
  console.log(
    `  ${ok ? '✓' : '✗'} ${value.toFixed(3).padStart(6)} (需 1.040)  ${label}  ${a} / ${b}`
  )
}

/* 第二层每一条 var(...) 引用的第一层变量必须真的存在。
   CSS 里引用未定义的变量不会报错，只会让整条声明「计算时失效」——
   color 悄悄退回继承正文色，看着像是没上色，翻代码却怎么也找不出哪儿写错了。
   --accent-text-light 那五个就是这么漏了很久的。 */
const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
const dangling = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter(
  (v) => !declared.has(v)
)
console.log(`\n写入 ${OUT}`)
if (dangling.length > 0) {
  console.error(`\n引用了未定义的变量：${dangling.join('、')}`)
}
if (failed > 0) {
  console.error(`\n${failed} 对配色未达标。`)
}
if (failed > 0 || dangling.length > 0) {
  console.error('调色板未通过自检。')
  process.exit(1)
}
console.log('全部对比度达标。')
