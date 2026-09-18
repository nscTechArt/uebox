#!/usr/bin/env node
/**
 * 文档站截图用的示例数据。
 *
 * 手册的截图不能拿维护者的真机数据拍 —— 那会把他的工程路径、素材名甚至
 * 服务商配置一起拍进公开文档。所以造一份示例数据。
 *
 * ## 两层，边界很重要
 *
 * 1. **磁盘夹具**（这个文件的前半段）：`.uproject` 文件、贴图、音频这些
 *    「用户本来就有的文件」由 Node 直接写到工作区。这一层等价于「用户硬盘上
 *    躺着一堆素材」，不是应用状态。
 *
 * 2. **应用状态**（后半段的 `SEED_STEPS`）：工程登记、保管库、文件夹、资产入库、
 *    标签、会话列表 —— 全部走 `window.api.*`，也就是**应用自己的那条路**。
 *    不直接改数据库，也不往渲染层塞假数据。
 *
 * 第二层必须走应用 API 的理由：schema 一变，播种会跟着失败而不是悄悄写出
 * 一份对不上的数据；而且拍出来的界面不会出现「界面上有但功能里没有」的东西。
 *
 * ## 路径里不能有用户名
 *
 * 工作区路径会出现在截图里（工程卡片、资产详情的本地路径）。默认落在
 * 当前盘符根下的 `UEBoxDemo`，不用系统临时目录 —— 后者在 Windows 上是
 * `C:\Users\<用户名>\AppData\Local\Temp\...`，用户名会进图。
 * `assertNoUsername()` 会在跑之前拦一道。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, parse } from 'node:path'
import { userInfo } from 'node:os'

// ─────────────────────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────────────────────

/** 默认工作区：当前盘符根下的 UEBoxDemo。POSIX 上退到 /tmp（同样不带用户名） */
export function defaultWorkspace(cwd = process.cwd()) {
  if (process.platform === 'win32') {
    const { root } = parse(cwd)
    return join(root, 'UEBoxDemo')
  }
  return '/tmp/UEBoxDemo'
}

/**
 * 工作区路径里不许出现当前用户名 —— 它会跟着截图进公开文档。
 * 这条是硬性的：拦不住就别拍，重拍一次比撤回一张图便宜得多。
 */
export function assertNoUsername(workspace) {
  let name = ''
  try {
    name = userInfo().username || ''
  } catch {
    return
  }
  if (name && workspace.toLowerCase().includes(name.toLowerCase())) {
    throw new Error(
      `工作区路径里有当前用户名（${name}）：${workspace}\n` +
        `截图里会出现它。换一个中性路径，例如 --workspace D:\\UEBoxDemo`
    )
  }
}

// ─────────────────────────────────────────────────────────────
// 最小 PNG 编码器
// ─────────────────────────────────────────────────────────────
//
// 不引依赖。示例贴图必须是**真的能解码的图片**：资产库要读它的尺寸、
// 生成缩略图，喂一个改了扩展名的文本文件进去，拍出来是一格格的破图标。

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * 画一张 size×size 的 RGB 图。`shade(x, y)` 返回 [r, g, b]。
 * 用渐变而不是纯色：纯色缩略图在网格里看起来像加载失败。
 */
export function makePng(size, shade) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = shade(x / (size - 1), y / (size - 1))
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 一个 OBJ 网格。
 *
 * OBJ 是纯文本，不引依赖就能写出**真的能加载**的模型 —— 3D 查看器的支持列表里
 * 有它（`Model3DViewer/index.vue` 的 `validExtensions`）。示例模型必须能真的打开：
 * 查看器那一页要拍线框、白模、法线几种显示模式，喂个假文件进去只能拍到报错。
 */
export function makeObj(kind) {
  const lines = ['# 虚幻盒子文档站示例模型', `o ${kind}`]
  const vertices = []
  const faces = []

  if (kind === 'Cube') {
    for (const x of [-1, 1])
      for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push([x, y, z])
    // 顶点顺序是 x 外、y 中、z 内，索引从 1 开始
    const quads = [
      [1, 2, 4, 3],
      [5, 7, 8, 6],
      [1, 5, 6, 2],
      [3, 4, 8, 7],
      [1, 3, 7, 5],
      [2, 6, 8, 4]
    ]
    faces.push(...quads)
  } else {
    // UV 球。段数取小一点，线框模式下看得出结构而不是糊成一团
    const seg = 16
    const ring = 12
    for (let i = 1; i < ring; i++) {
      const phi = (Math.PI * i) / ring
      for (let j = 0; j < seg; j++) {
        const theta = (2 * Math.PI * j) / seg
        vertices.push([
          Number((Math.sin(phi) * Math.cos(theta)).toFixed(5)),
          Number(Math.cos(phi).toFixed(5)),
          Number((Math.sin(phi) * Math.sin(theta)).toFixed(5))
        ])
      }
    }
    vertices.push([0, 1, 0])
    vertices.push([0, -1, 0])
    const top = vertices.length - 1
    const bottom = vertices.length
    const at = (i, j) => i * seg + (j % seg) + 1
    for (let i = 0; i < ring - 2; i++) {
      for (let j = 0; j < seg; j++) {
        faces.push([at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)])
      }
    }
    for (let j = 0; j < seg; j++) faces.push([top, at(0, j + 1), at(0, j)])
    for (let j = 0; j < seg; j++) faces.push([bottom, at(ring - 2, j), at(ring - 2, j + 1)])
  }

  for (const [x, y, z] of vertices) lines.push(`v ${x} ${y} ${z}`)
  for (const face of faces) lines.push(`f ${face.join(' ')}`)
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

/** 一段能播的 16-bit 单声道 WAV，用正弦波。时长很短，只是为了让音频条目是真的 */
export function makeWav(seconds = 1.5, freq = 440, rate = 22050) {
  const samples = Math.floor(seconds * rate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    // 末尾淡出，免得听起来像爆音
    const fade = Math.min(1, ((samples - i) / rate) * 4)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000 * fade), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// ─────────────────────────────────────────────────────────────
// 示例内容清单
// ─────────────────────────────────────────────────────────────

/**
 * 示例工程。
 *
 * 引擎版本刻意分散：项目库那一页要拍「按引擎版本筛选」，全是 5.5 就看不出来。
 * 名字用通用的英文工程名 —— 中文名在卡片上会换行，而且看起来像真项目。
 */
export const PROJECTS = Object.freeze([
  { name: 'ArcadeRacer', engine: '5.5', collection: '在做的' },
  { name: 'NordicVillage', engine: '5.4', collection: '在做的' },
  { name: 'ArchVizLoft', engine: '5.6' },
  { name: 'CombatSandbox', engine: '5.3' }
])

/** 示例分组。工程库那一页要拍分组条 */
export const COLLECTIONS = Object.freeze([{ name: '在做的' }])

/**
 * 示例资产文件夹。
 *
 * `key` 是库里的主键，`dir` 是磁盘上的目录名。两者刻意分开：详情面板会显示
 * 「本地路径」，里面出现 `demo_textures` 这种内部键名会让截图看起来像调试产物。
 */
export const ASSET_FOLDERS = Object.freeze([
  { key: 'demo_textures', name: '贴图', dir: 'Textures' },
  { key: 'demo_meshes', name: '模型', dir: 'Meshes' },
  { key: 'demo_audio', name: '音效', dir: 'Audio' },
  { key: 'demo_refs', name: '参考图', dir: 'References' }
])

const FOLDER_DIR = Object.fromEntries(ASSET_FOLDERS.map((f) => [f.key, f.dir]))

const GRAD = (a, b) => (u, v) => [
  Math.round(a[0] + (b[0] - a[0]) * ((u + v) / 2)),
  Math.round(a[1] + (b[1] - a[1]) * ((u + v) / 2)),
  Math.round(a[2] + (b[2] - a[2]) * ((u + v) / 2))
]

/** 噪点质感，给「Albedo」这类贴图用，免得四张图看上去一模一样 */
const NOISE = (base, amp) => (u, v) => {
  const n = Math.sin(u * 37.1 + v * 91.7) * Math.sin(u * 13.3 - v * 51.9)
  return base.map((c) => Math.max(0, Math.min(255, Math.round(c + n * amp))))
}

/**
 * 示例素材。
 *
 * 按 UE 的命名前缀起名（`T_` 贴图、`SM_` 静态网格、`S_` 音效）—— 手册里
 * 「命名规则」那一页讲的就是这套前缀，截图里得对得上。资产库的智能分类
 * 也是照名字认的（`T_Metal_Roughness` 会被打上 Roughness / Metallic / Texture），
 * 名字起错的话那一栏拍出来是空的。
 */
export const ASSET_FILES = Object.freeze([
  { folder: 'demo_textures', file: 'T_Rock_Albedo.png', png: NOISE([122, 116, 108], 28) },
  {
    folder: 'demo_textures',
    file: 'T_Rock_Normal.png',
    png: GRAD([128, 128, 255], [150, 140, 255])
  },
  { folder: 'demo_textures', file: 'T_Sand_Albedo.png', png: NOISE([198, 176, 132], 22) },
  {
    folder: 'demo_textures',
    file: 'T_Metal_Roughness.png',
    png: GRAD([40, 40, 44], [190, 190, 196])
  },
  { folder: 'demo_refs', file: 'Ref_Cliffside_Mood.png', png: GRAD([28, 42, 74], [214, 132, 76]) },
  {
    folder: 'demo_refs',
    file: 'Ref_Interior_Lighting.png',
    png: GRAD([22, 22, 28], [236, 198, 140])
  },
  { folder: 'demo_audio', file: 'S_Ambient_Wind.wav', wav: { seconds: 2, freq: 180 } },
  { folder: 'demo_audio', file: 'S_UI_Confirm.wav', wav: { seconds: 0.6, freq: 880 } },
  { folder: 'demo_meshes', file: 'SM_Boulder_01.obj', obj: 'Sphere' },
  { folder: 'demo_meshes', file: 'SM_Crate_01.obj', obj: 'Cube' }
])

/** 示例标签。分组名对应标签库里的「分类筛选」 */
export const TAGS = Object.freeze([
  { name: '待整理', group: '项目状态', color: '#E0A33E' },
  { name: '已验收', group: '项目状态', color: '#4CAF7D' },
  { name: '大世界', group: '用途', color: '#5B8DEF' },
  { name: '室内', group: '用途', color: '#A473E8' }
])

/**
 * 示例会话。
 *
 * **只造会话列表，不造对话正文。** 侧边栏那一栏是真实的数据结构，造出来没问题；
 * 而正文一旦是编的，截图里就会出现这个应用根本不会产出的回答 —— 那比空着更糟。
 * AI 会话正文的截图另想办法。
 */
export const SESSIONS = Object.freeze([
  {
    title: '给悬崖做一套岩石材质',
    project: 'ArcadeRacer',
    engine: '5.5',
    pinned: true,
    minutesAgo: 12
  },
  { title: '批量重命名导入的贴图', project: 'ArcadeRacer', engine: '5.5', minutesAgo: 90 },
  { title: '村庄关卡的大纲整理', project: 'NordicVillage', engine: '5.4', minutesAgo: 260 },
  { title: '打包体积为什么这么大', project: 'ArchVizLoft', engine: '5.6', minutesAgo: 1500 },
  // 最后一条不挂工程 —— 侧边栏的「对话」区（没有关联 UE 工程的）要有东西可看
  { title: 'Lumen 和 SSGI 的取舍', minutesAgo: 2600 }
])

// ─────────────────────────────────────────────────────────────
// 第一层：磁盘夹具
// ─────────────────────────────────────────────────────────────

/** `.uproject` 的最小可用内容。字段照 UE 的格式写，应用那边要解析它 */
function uprojectJson(engine) {
  return JSON.stringify(
    {
      FileVersion: 3,
      EngineAssociation: engine,
      Category: '',
      Description: '虚幻盒子文档站的示例工程',
      Modules: [{ Name: 'DemoGame', Type: 'Runtime', LoadingPhase: 'Default' }]
    },
    null,
    '\t'
  )
}

/**
 * 在工作区里铺好夹具文件。返回给播种脚本用的绝对路径清单。
 *
 * `fresh` 为真时先清空 —— 重复跑不该让资产库里出现两份同名文件。
 */
export function buildWorkspace(workspace, { fresh = true, repoRoot = null } = {}) {
  assertNoUsername(workspace)
  if (fresh && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })

  const projects = []
  for (const project of PROJECTS) {
    const dir = join(workspace, 'Projects', project.name)
    mkdirSync(join(dir, 'Content'), { recursive: true })
    const uproject = join(dir, `${project.name}.uproject`)
    writeFileSync(uproject, uprojectJson(project.engine), 'utf8')
    projects.push({ ...project, dir, uproject })
  }

  const assetsRoot = join(workspace, 'Assets')
  const assets = []
  for (const asset of ASSET_FILES) {
    const dir = join(assetsRoot, FOLDER_DIR[asset.folder] ?? asset.folder)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, asset.file)
    let bytes
    if (asset.png) bytes = makePng(512, asset.png)
    else if (asset.obj) bytes = makeObj(asset.obj)
    else bytes = makeWav(asset.wav.seconds, asset.wav.freq)
    writeFileSync(path, bytes)
    // 真实字节数要带给播种脚本：不给的话详情面板上写的是「0 B」
    assets.push({ folder: asset.folder, name: asset.file, path, size: bytes.length })
  }

  // 保管库自己的目录。建库时作为 customPath 传给应用
  const vaultParent = join(workspace, 'Vaults')
  mkdirSync(vaultParent, { recursive: true })

  // 引擎试验工程。只有 --with-engine 那一批用得上，但必须在这里铺 ——
  // 工作区每次重建都会清空，放外面下一次就没了（第一次就栽在这儿）
  let probe = null
  if (repoRoot) {
    const editor = detectUnrealEditor(repoRoot, { existsSync, join })
    if (editor) {
      probe = {
        ...buildProbeProject(workspace, editor, {
          mkdirSync,
          writeFileSync,
          existsSync,
          join,
          execFileSync
        }),
        editor
      }
    }
  }

  return { workspace, projects, assets, vaultParent, probe }
}

// ─────────────────────────────────────────────────────────────
// 第二层：播种脚本（在渲染进程里跑，全部走 window.api）
// ─────────────────────────────────────────────────────────────

/**
 * 每一步都是一段在页面里 eval 的 JS，返回一个 JSON 字符串。
 *
 * 约定：**每一步都要回读核对**。返回 `{ ok:false, ... }` 的步骤会被采集脚本
 * 原样打出来 —— 播种失败还接着拍，拍出来的是一堆空界面而没人知道为什么。
 */
export function seedSteps(fixtures) {
  const json = (value) => JSON.stringify(value)

  return [
    {
      name: '关掉插件自动安装',
      // 示例工程是空壳，装插件必然失败；而且往夹具目录里写二进制纯属浪费。
      // 这一步顺便把界面钉在确定状态：截图不该受本机设置影响
      script: `(async () => {
        await window.api.appSettings.setAutoEnableUnrealAgentLink(false)
        const value = await window.api.appSettings.getAutoEnableUnrealAgentLink()
        return JSON.stringify({ ok: value === false, value })
      })()`
    },
    {
      name: '登记示例工程',
      script: `(async () => {
        const projects = ${json(fixtures.projects.map((p) => ({ name: p.name, uproject: p.uproject })))}
        const results = []
        for (const p of projects) {
          const res = await window.api.database.project.importByFilePath(p.uproject)
          results.push({ name: p.name, success: !!res?.success, error: res?.error })
        }
        const all = await window.api.database.project.getAll()
        const list = all?.data ?? all ?? []
        const names = list.map((row) => row.projectName || row.project_name)
        return JSON.stringify({
          ok: projects.every((p) => names.includes(p.name)),
          registered: names.length,
          results
        })
      })()`
    },
    {
      name: '建工程分组并归入',
      script: `(async () => {
        const wanted = ${json(PROJECTS.filter((p) => p.collection).map((p) => ({ name: p.name, collection: p.collection })))}
        const all = await window.api.database.project.getAll()
        const list = all?.data ?? all ?? []
        const keyOf = (name) => {
          const row = list.find((r) => (r.projectName || r.project_name) === name)
          return row && (row.projectKey || row.project_key)
        }
        const made = {}
        for (const item of wanted) {
          if (!made[item.collection]) {
            const collectionKey = 'demo_col_' + Object.keys(made).length
            await window.api.database.projectCollection.create({
              collectionKey,
              name: item.collection,
              description: null,
              color: null,
              icon: null,
              sort_order: 0,
              isPinned: 0
            })
            made[item.collection] = collectionKey
          }
          const projectKey = keyOf(item.name)
          if (projectKey) {
            await window.api.database.projectCollection.addProject(projectKey, made[item.collection])
          }
        }
        const cols = await window.api.database.projectCollection.getAll()
        const colList = cols?.data ?? cols ?? []
        return JSON.stringify({ ok: colList.length > 0, collections: colList.length })
      })()`
    },
    {
      name: '建示例保管库并切过去',
      script: `(async () => {
        const created = await window.api.invoke('vault:create', {
          name: '示例素材库',
          description: '文档站截图用',
          vaultType: 'reference',
          customPath: ${json(fixtures.vaultParent)}
        })
        if (!created?.success) return JSON.stringify({ ok: false, error: created?.error })
        const id = created.data?.id
        const switched = await window.api.invoke('vault:switch', id)
        const current = await window.api.invoke('vault:getCurrentPath')
        return JSON.stringify({
          ok: !!switched?.success,
          vaultId: id,
          switchError: switched?.error,
          path: current?.data
        })
      })()`
    },
    {
      name: '建资产文件夹',
      script: `(async () => {
        const folders = ${json(ASSET_FOLDERS)}
        for (const folder of folders) {
          await window.api.database.assetFolder.create({
            folderKey: folder.key,
            fatherKey: 'ALL',
            folderName: folder.name,
            type: 'normal',
            img: ''
          })
        }
        const all = await window.api.database.assetFolder.getAll()
        const list = all?.data ?? all ?? []
        const keys = list.map((row) => row.folderKey || row.folder_key)
        return JSON.stringify({
          ok: folders.every((f) => keys.includes(f.key)),
          folders: keys.length
        })
      })()`
    },
    {
      name: '把素材导入资产库',
      script: `(async () => {
        const assets = ${json(fixtures.assets)}
        const byFolder = {}
        for (const asset of assets) (byFolder[asset.folder] ||= []).push(asset)
        const now = new Date().toISOString()
        for (const [folderKey, items] of Object.entries(byFolder)) {
          const infos = items.map((item) => ({
            name: item.name,
            path: item.path,
            type: 'file',
            size: item.size ?? null,
            modifiedTime: now,
            depth: 0,
            relativePath: item.name
          }))
          await window.api.database.assetData.importFolderStructureWithMetadata(
            infos, 'ALL', folderKey
          )
        }
        // 回读：导入是异步落库的，给它一点时间再数
        await new Promise((r) => setTimeout(r, 2500))
        const counts = {}
        for (const folderKey of Object.keys(byFolder)) {
          const res = await window.api.database.assetData.getCountByFolderKey(folderKey, true)
          counts[folderKey] = res?.data ?? res ?? 0
        }
        const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0)
        return JSON.stringify({ ok: total >= assets.length, expected: assets.length, counts })
      })()`
    },
    {
      name: '建标签',
      script: `(async () => {
        const tags = ${json(TAGS)}
        const groups = {}
        let order = 1
        for (const tag of tags) {
          if (groups[tag.group] === undefined) {
            const res = await window.api.database.tagGroup.create({
              name: tag.group,
              color: tag.color,
              sort_order: order++
            })
            groups[tag.group] = res?.data?.id ?? null
          }
          await window.api.database.tag.create({
            name: tag.name,
            color: tag.color,
            group_id: groups[tag.group]
          })
        }
        const all = await window.api.database.tag.getAll()
        const list = all?.data ?? all ?? []
        const names = list.map((row) => row.name || row.tagName || row.tag_name)
        return JSON.stringify({
          ok: tags.every((t) => names.includes(t.name)),
          tags: names.length
        })
      })()`
    },
    {
      name: '写会话列表',
      /*
       * 只写列表，不写正文 —— 编出来的回答不是这个应用会产出的东西。
       *
       * 存的是 pinia-plugin-persistedstate 的那份快照，所以必须是
       * `{ sessions, permissionModeById, draftsById }` 这个外壳
       * （见 store/modules/chatSessions.ts 的 persist.paths）。
       * 写成裸数组的话 store 读不出来，侧边栏还是「暂无对话」。
       */
      script: `(async () => {
        const seeds = ${json(SESSIONS)}
        const projects = ${json(fixtures.projects.map((p) => ({ name: p.name, dir: p.dir, engine: p.engine })))}
        const now = Date.now()
        const sessions = seeds.map((seed, index) => {
          const at = now - seed.minutesAgo * 60000
          const project = seed.project && projects.find((p) => p.name === seed.project)
          return {
            id: 'demo-session-' + index,
            title: seed.title,
            createdAt: at,
            updatedAt: at,
            agentMode: true,
            pinned: !!seed.pinned,
            pinnedAt: seed.pinned ? at : undefined,
            project: project
              ? { projectName: project.name, projectPath: project.dir, engineVersion: project.engine }
              : null
          }
        })
        const snapshot = { sessions, permissionModeById: {}, draftsById: {} }
        await window.api.chatHistory.write('chat-sessions', JSON.stringify(snapshot))
        const back = await window.api.chatHistory.read()
        const parsed = JSON.parse(back?.['chat-sessions'] || '{}')
        return JSON.stringify({
          ok: Array.isArray(parsed.sessions) && parsed.sessions.length === sessions.length,
          sessions: parsed.sessions?.length ?? 0
        })
      })()`
    },
    {
      name: '写个性化说明',
      script: `(async () => {
        const text = ${json(
          '我是游戏公司的地编，主要做大世界场景搭建和优化。\n我不写 C++，蓝图能看懂但不熟，别默认我会。\n结论先说，过程我需要的时候会问。'
        )}
        const res = await window.api.personalization.setInstructions(text)
        const back = await window.api.personalization.getInstructions()
        return JSON.stringify({ ok: !!res?.success && back?.text === text, length: back?.text?.length })
      })()`
    }
  ]
}

// ─────────────────────────────────────────────────────────────
// 引擎试验工程
// ─────────────────────────────────────────────────────────────

/**
 * 找一个能用的 UE 编辑器。
 *
 * 「本轮改动 / 审查改动 / 让它自证」这三张必须有引擎真连着才拍得到，
 * 而每台机器装的版本不一样。这里扫常见安装位置，挑一个**同时**满足
 * 「引擎装了」和「仓库里有对应版本的随包插件」的 —— 只满足一边等于起了个
 * 连不上来的编辑器，白等十分钟。
 */
export function detectUnrealEditor(repoRoot, { existsSync, join }) {
  const roots = []
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    roots.push(`${drive}:/`, `${drive}:/Program Files/Epic Games/`, `${drive}:/Epic Games/`)
  }
  const found = []
  for (const root of roots) {
    // 5.8 往前找，新的优先
    for (const minor of [8, 7, 6, 5, 4, 3, 2, 1, 0]) {
      const version = `5.${minor}`
      const exe = join(root, `UE_${version}`, 'Engine/Binaries/Win64/UnrealEditor.exe')
      if (!existsSync(exe)) continue
      const zip = join(repoRoot, 'resources/plugins', `UnrealAgentLink5${minor}.zip`)
      if (!existsSync(zip)) continue
      found.push({ version, exe, zip })
    }
  }
  return found[0] ?? null
}

/** PowerShell 的路径参数用正斜杠最省事，反斜杠在引号里还要再转一层 */
const toPosix = (p) => p.split(String.fromCharCode(92)).join('/')

/** 试验工程的 `.uproject`：显式启用插件，并给一个能开的启动地图 */
function probeUprojectJson(version) {
  return JSON.stringify(
    {
      FileVersion: 3,
      EngineAssociation: version,
      Category: '',
      Description: '虚幻盒子文档站的引擎连接试验工程（一次性，可随时删）',
      Plugins: [{ Name: 'UnrealAgentLink', Enabled: true }]
    },
    null,
    '\t'
  )
}

/**
 * 在工作区里铺一个能连上桥接的 UE 工程。
 *
 * 插件直接从 `resources/plugins/` 解进去，不等应用自动装 —— 自动装那条路
 * 要先打开工程，而我们正是要靠这个工程把编辑器拉起来，顺序反了。
 */
export function buildProbeProject(
  workspace,
  editor,
  { mkdirSync, writeFileSync, existsSync, join, execFileSync }
) {
  const dir = join(workspace, 'Projects', `DocsProbe${editor.version.replace('.', '')}`)
  const name = `DocsProbe${editor.version.replace('.', '')}`
  mkdirSync(join(dir, 'Content'), { recursive: true })
  mkdirSync(join(dir, 'Config'), { recursive: true })
  const uproject = join(dir, `${name}.uproject`)
  writeFileSync(uproject, probeUprojectJson(editor.version), 'utf8')
  writeFileSync(
    join(dir, 'Config', 'DefaultEngine.ini'),
    '[/Script/EngineSettings.GameMapsSettings]\r\n' +
      'EditorStartupMap=/Engine/Maps/Templates/Template_Default.Template_Default\r\n',
    'utf8'
  )

  // 解压随包插件。zip 里是散装的 Binaries/Source/...，UE 要的是
  // Plugins/UnrealAgentLink/ 这一层，所以先解到临时位置再整体落位
  const pluginDir = join(dir, 'Plugins', 'UnrealAgentLink')
  mkdirSync(pluginDir, { recursive: true })
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${editor.zip}' -DestinationPath '${toPosix(pluginDir)}' -Force`
    ],
    { stdio: 'ignore' }
  )
  const ok = existsSync(join(pluginDir, 'UnrealAgentLink.uplugin'))
  return { dir, uproject, name, version: editor.version, pluginInstalled: ok }
}
