/**
 * 引擎自带的工程模板 —— 列出来，以及照 UE 自己的规矩实例化一份。
 *
 * ## 为什么要有这个模块
 *
 * `project_manage` 的 `create_project` 原先只认 `userData/templates` 下的 zip
 * 模板包。那个目录默认是空的（安装包不带模板，得用户自己下或自己打包），
 * 于是「建一个 UE 5.5 空白工程」这句最普通的请求，走工具是一条死路 ——
 * `list_templates` 返回空数组，模型只能绕开工具自己去拷引擎目录。
 *
 * 真机上就是这么发生的：模型把 `Templates/TP_BlankBP` 整个拷到用户指定的目录，
 * 工程确实建出来了，但它**绕过了所有该走的东西** —— 没有风险确认、没有登记进
 * 项目库、没有装 UnrealAgentLink、EngineAssociation 还是模板里那个空字符串。
 * 用户回到首页，「我的项目」里什么都没多出来。
 *
 * 堵这个洞的正确做法不是禁止模型拷目录，是**让工具真的能干这件事**。规则要
 * 先有能力兜着，否则只是把一次成功换成一次失败。
 *
 * ## 模板长什么样
 *
 * `<引擎根目录>/Templates/TP_XXX/`，每个目录里：
 *
 *   - `<模板名>.uproject` —— 注意 `EngineAssociation` 是空串，得我们填
 *   - `Config/TemplateDefs.ini` —— 拷贝规则（忽略哪些、改哪些名、替换哪些字符串）
 *   - `Media/<模板名>.png` —— 缩略图，同时也是拷出来之后的工程封面
 *   - `Content/`、`Source/` —— 有没有看模板类型
 *
 * `TemplateDefs.ini` 不是装饰品：照着它拷才和 UE 项目浏览器建出来的一致。
 * 不理它的话，新工程里会留下 `Config/TemplateDefs.ini` 和 `Media/`，
 * C++ 模板的模块名也不会跟着工程名改。
 *
 * ## 共享内容包这件事必须做
 *
 * 第三人称之类的模板在 `SharedContentPacks` 里声明依赖，实际文件在
 * `Templates/TemplateResources/<档次>/<包名>/Content/`。真机验证过：
 * `TP_ThirdPersonBP/Content/ThirdPerson/Blueprints/BP_ThirdPersonCharacter.uasset`
 * 里直接引着 `/Game/Characters/Mannequins/Meshes/SKM_Quinn_Simple` ——
 * 只拷模板目录不拷共享包，建出来的工程一打开就是一堆丢失引用。
 *
 * 落点由包自己的 `FeaturePack/manifest.json` 的 `DestinationFilesFolder` 决定
 * （`Characters` → `Content/Characters/`），正好对上上面那个 `/Game/Characters/`。
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { readUeJsonFile, readUeTextFile } from '../../utils/ueTextFile'

/** 一条字符串替换规则。`from` / `to` 里还带着 `%TEMPLATENAME%` 这类占位符 */
export interface TemplateReplacement {
  /** 只对这些扩展名生效（不带点），空数组表示没限制 */
  extensions: string[]
  from: string
  to: string
  caseSensitive: boolean
}

/** `Config/TemplateDefs.ini` 解析出来的东西 */
export interface TemplateDefs {
  /** 本地化显示名，中文优先 */
  displayName?: string
  /** 本地化描述，中文优先 */
  description?: string
  /** 模板自称是不是「空白」 */
  isBlank: boolean
  /** 排序键，UE 项目浏览器用它排；空白模板通常是 `_1` */
  sortKey: string
  foldersToIgnore: string[]
  filesToIgnore: string[]
  folderRenames: Array<{ from: string; to: string }>
  filenameReplacements: TemplateReplacement[]
  replacementsInFiles: TemplateReplacement[]
  /** 依赖的共享内容包：包名 + 档次（High / Standard） */
  sharedContentPacks: Array<{ mountName: string; detailLevels: string[] }>
}

/** 一个可用的引擎自带模板 */
export interface EngineTemplate {
  /** 稳定标识，形如 `5.5/TP_BlankBP` —— 同名模板在多个引擎版本里都有，光靠名字选不准 */
  key: string
  /** 目录名，如 `TP_BlankBP` */
  templateName: string
  /** 给人看的名字，如「空白」 */
  displayName: string
  description?: string
  engineVersion: string
  engineRoot: string
  /** 模板目录绝对路径 */
  dir: string
  /** 模板自带的 .uproject 绝对路径 */
  uprojectPath: string
  /** 有 Source/ —— 建出来是 C++ 工程，第一次打开要编译 */
  needsCode: boolean
  isBlank: boolean
  sortKey: string
  /** 依赖的共享内容包名 */
  sharedContentPacks: string[]
  defs: TemplateDefs
}

/** 这个模块只需要引擎的版本号和根目录，不必拖进整个 UnrealPathManager */
export interface EngineLocation {
  version: string
  rootPath: string
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateDefs.ini 解析
//
// 不用通用 ini 解析器：这份文件里同一个键会重复出现（每条 FilesToIgnore 一行），
// 值又是 UE 自己的结构体字面量 `(From="a", To="b")`。通用解析器会把重复键
// 后面的覆盖前面的 —— 那恰恰把忽略清单毁掉了。
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉两边的引号和空白 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 取某个键的所有取值（这份文件里键会重复，所以返回数组） */
function collectValues(raw: string, key: string): string[] {
  const values: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith(';')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim() !== key) continue
    values.push(trimmed.slice(eq + 1).trim())
  }
  return values
}

/** 从 `(A="x", B=("y","z"))` 这样的结构体字面量里取一个字段 */
function structField(struct: string, field: string): string | undefined {
  const match = new RegExp(
    `\\b${field}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\\([^)]*\\)|[^,)]*)`,
    'i'
  ).exec(struct)
  return match ? match[1].trim() : undefined
}

/** 把 `("cpp","h")` 拆成 `['cpp', 'h']` */
function structList(value: string | undefined): string[] {
  if (!value) return []
  const inner = value.trim().replace(/^\(/, '').replace(/\)$/, '')
  return inner
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item.length > 0)
}

function parseReplacements(raw: string, key: string): TemplateReplacement[] {
  return collectValues(raw, key).map((value) => ({
    extensions: structList(structField(value, 'Extensions')).map((ext) => ext.toLowerCase()),
    from: unquote(structField(value, 'From') ?? ''),
    to: unquote(structField(value, 'To') ?? ''),
    caseSensitive: /true/i.test(structField(value, 'bCaseSensitive') ?? '')
  }))
}

/**
 * 取本地化文本，中文优先。
 *
 * 界面是中文的，模板名却给英文，用户对不上 UE 项目浏览器里看到的那一栏。
 * 中文没有时退回英文，再没有就退回第一条。
 */
function localized(raw: string, key: string): string | undefined {
  const entries = collectValues(raw, key).map((value) => ({
    language: unquote(structField(value, 'Language') ?? ''),
    text: unquote(structField(value, 'Text') ?? '')
  }))
  const zh = entries.find((entry) => entry.language.toLowerCase().startsWith('zh'))
  const en = entries.find((entry) => entry.language.toLowerCase().startsWith('en'))
  return (zh ?? en ?? entries[0])?.text || undefined
}

/** 解析 `Config/TemplateDefs.ini` */
export function parseTemplateDefs(raw: string): TemplateDefs {
  // 这些文件带 UTF-8 BOM，不去掉的话第一行的键名前面会多一个不可见字符。
  // 写成转义序列而不是把 BOM 直接贴进源码 —— 贴进来的话它在编辑器里完全看不见，
  // 下一个人只会以为这里在删一个空字符串
  const text = raw.replace(/^\uFEFF/, '')

  return {
    displayName: localized(text, 'LocalizedDisplayNames'),
    description: localized(text, 'LocalizedDescriptions'),
    isBlank: /true/i.test(collectValues(text, 'bIsBlank')[0] ?? ''),
    sortKey: unquote(collectValues(text, 'SortKey')[0] ?? ''),
    foldersToIgnore: collectValues(text, 'FoldersToIgnore').map(unquote),
    filesToIgnore: collectValues(text, 'FilesToIgnore').map(unquote),
    folderRenames: collectValues(text, 'FolderRenames').map((value) => ({
      from: unquote(structField(value, 'From') ?? ''),
      to: unquote(structField(value, 'To') ?? '')
    })),
    filenameReplacements: parseReplacements(text, 'FilenameReplacements'),
    replacementsInFiles: parseReplacements(text, 'ReplacementsInFiles'),
    sharedContentPacks: collectValues(text, 'SharedContentPacks').map((value) => ({
      mountName: unquote(structField(value, 'MountName') ?? ''),
      detailLevels: structList(structField(value, 'DetailLevels'))
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 占位符
// ─────────────────────────────────────────────────────────────────────────────

/** 模板规则里的占位符换成真名。UE 认这六个 */
export function expandPlaceholders(
  value: string,
  templateName: string,
  projectName: string
): string {
  return value
    .replace(/%TEMPLATENAME_UPPERCASE%/g, templateName.toUpperCase())
    .replace(/%TEMPLATENAME_LOWERCASE%/g, templateName.toLowerCase())
    .replace(/%TEMPLATENAME%/g, templateName)
    .replace(/%PROJECTNAME_UPPERCASE%/g, projectName.toUpperCase())
    .replace(/%PROJECTNAME_LOWERCASE%/g, projectName.toLowerCase())
    .replace(/%PROJECTNAME%/g, projectName)
}

/** 正斜杠、去掉首尾斜杠 —— 忽略清单里写的是 `Config/TemplateDefs.ini` 这种相对路径 */
function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * 这个相对路径要不要跳过。
 *
 * 目录按「自己或任一层祖先命中」判：`FoldersToIgnore=Media` 要连同
 * `Media/` 底下所有文件一起跳过，只比对目录本身的话文件还是会被拷进去。
 */
export function shouldSkip(
  relativePath: string,
  defs: TemplateDefs,
  templateName: string,
  projectName: string
): boolean {
  const normalized = normalizeRelative(relativePath).toLowerCase()
  const segments = normalized.split('/')

  const folders = defs.foldersToIgnore.map((item) =>
    normalizeRelative(expandPlaceholders(item, templateName, projectName)).toLowerCase()
  )
  for (const folder of folders) {
    if (!folder) continue
    if (normalized === folder || normalized.startsWith(`${folder}/`)) return true
    // 无路径的写法（`Media`、`Binaries`）在任意层级都算
    if (!folder.includes('/') && segments.slice(0, -1).includes(folder)) return true
  }

  const files = defs.filesToIgnore.map((item) =>
    normalizeRelative(expandPlaceholders(item, templateName, projectName)).toLowerCase()
  )
  return files.includes(normalized)
}

/** 套用 FolderRenames + FilenameReplacements，算出这个文件在新工程里的相对路径 */
export function rewriteRelativePath(
  relativePath: string,
  defs: TemplateDefs,
  templateName: string,
  projectName: string
): string {
  let result = normalizeRelative(relativePath)

  for (const rename of defs.folderRenames) {
    const from = normalizeRelative(expandPlaceholders(rename.from, templateName, projectName))
    const to = normalizeRelative(expandPlaceholders(rename.to, templateName, projectName))
    if (!from || from === to) continue
    if (result === from || result.startsWith(`${from}/`)) {
      result = `${to}${result.slice(from.length)}`
    }
  }

  const extension = path.extname(result).replace(/^\./, '').toLowerCase()
  const dir = path.posix.dirname(result)
  let base = path.posix.basename(result)

  for (const rule of defs.filenameReplacements) {
    if (rule.extensions.length > 0 && !rule.extensions.includes(extension)) continue
    base = applyReplacement(base, rule, templateName, projectName)
  }

  return dir === '.' ? base : `${dir}/${base}`
}

/** 单条替换规则作用在一段文本上 */
export function applyReplacement(
  text: string,
  rule: TemplateReplacement,
  templateName: string,
  projectName: string
): string {
  const from = expandPlaceholders(rule.from, templateName, projectName)
  const to = expandPlaceholders(rule.to, templateName, projectName)
  if (!from || from === to) return text

  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, rule.caseSensitive ? 'g' : 'gi'), to)
}

/** 文件内容替换。只对规则声明的扩展名生效 —— 别去改 .uasset 那种二进制 */
export function rewriteFileContent(
  content: string,
  relativePath: string,
  defs: TemplateDefs,
  templateName: string,
  projectName: string
): string {
  const extension = path.extname(relativePath).replace(/^\./, '').toLowerCase()
  let result = content
  for (const rule of defs.replacementsInFiles) {
    if (rule.extensions.length > 0 && !rule.extensions.includes(extension)) continue
    result = applyReplacement(result, rule, templateName, projectName)
  }
  return result
}

/** 需要按文本改写的扩展名的并集 —— 不在这里面的一律按二进制原样拷 */
function textExtensions(defs: TemplateDefs): Set<string> {
  const set = new Set<string>()
  for (const rule of defs.replacementsInFiles) {
    for (const ext of rule.extensions) set.add(ext)
  }
  return set
}

// ─────────────────────────────────────────────────────────────────────────────
// 工程名校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UE 对工程名的限制，照抄项目浏览器那一套。
 *
 * 提前挡下来而不是等 UE 打开时报错：拷完几百兆再告诉用户名字不合法，
 * 那份垃圾还得他自己去删。
 */
export function validateProjectName(name: string): string | undefined {
  if (!name) return '工程名不能为空。'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return `工程名 "${name}" 不合法：只能用英文字母、数字和下划线，且不能以数字开头（UE 自己的限制，中文名会让编译和打包出问题）。`
  }
  if (name.length > 20) {
    return `工程名 "${name}" 太长（${name.length} 个字符）：UE 建议不超过 20 个字符，超了容易撞上 Windows 的路径长度上限。`
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 列模板
// ─────────────────────────────────────────────────────────────────────────────

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** 读一个模板目录。不是模板（没有 .uproject）返回 null */
async function readTemplate(
  engine: EngineLocation,
  templateDir: string
): Promise<EngineTemplate | null> {
  const templateName = path.basename(templateDir)
  const uprojectPath = path.join(templateDir, `${templateName}.uproject`)
  if (!(await exists(uprojectPath))) return null

  let defs: TemplateDefs
  try {
    defs = parseTemplateDefs(
      await readUeTextFile(path.join(templateDir, 'Config', 'TemplateDefs.ini'))
    )
  } catch {
    // 没有 TemplateDefs.ini 也还是个能用的模板，按最保守的规则拷
    defs = {
      isBlank: false,
      sortKey: '',
      foldersToIgnore: ['Binaries', 'Build', 'Intermediate', 'Saved', 'Media'],
      filesToIgnore: [`${templateName}.uproject`, 'Config/TemplateDefs.ini'],
      folderRenames: [],
      filenameReplacements: [],
      replacementsInFiles: [],
      sharedContentPacks: []
    }
  }

  return {
    key: `${engine.version}/${templateName}`,
    templateName,
    displayName: defs.displayName || templateName,
    description: defs.description,
    engineVersion: engine.version,
    engineRoot: engine.rootPath,
    dir: templateDir,
    uprojectPath,
    needsCode: await exists(path.join(templateDir, 'Source')),
    isBlank: defs.isBlank,
    sortKey: defs.sortKey,
    sharedContentPacks: defs.sharedContentPacks.map((pack) => pack.mountName).filter(Boolean),
    defs
  }
}

/** 列出这些引擎自带的全部工程模板 */
export async function listEngineTemplates(engines: EngineLocation[]): Promise<EngineTemplate[]> {
  const templates: EngineTemplate[] = []

  for (const engine of engines) {
    const templatesRoot = path.join(engine.rootPath, 'Templates')
    let entries: string[]
    try {
      entries = (await fs.readdir(templatesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }

    for (const name of entries) {
      // TemplateResources 是共享内容包的家，不是模板本身
      if (name === 'TemplateResources' || name === 'Media') continue
      const template = await readTemplate(engine, path.join(templatesRoot, name))
      if (template) templates.push(template)
    }
  }

  return templates.sort(
    (a, b) =>
      a.engineVersion.localeCompare(b.engineVersion) ||
      a.sortKey.localeCompare(b.sortKey) ||
      a.templateName.localeCompare(b.templateName)
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 实例化
// ─────────────────────────────────────────────────────────────────────────────

export interface InstantiateResult {
  projectDir: string
  uprojectPath: string
  /** 一起拷进来的共享内容包名 */
  sharedPacks: string[]
  /** 值得让用户知道、但没到失败程度的事 */
  warnings: string[]
}

/** 递归拷贝模板目录，边拷边套用忽略 / 改名 / 替换规则 */
async function copyTemplateTree(
  template: EngineTemplate,
  projectDir: string,
  projectName: string
): Promise<void> {
  const texts = textExtensions(template.defs)

  const walk = async (relative: string): Promise<void> => {
    const source = relative ? path.join(template.dir, relative) : template.dir
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (shouldSkip(childRelative, template.defs, template.templateName, projectName)) continue

      if (entry.isDirectory()) {
        await walk(childRelative)
        continue
      }
      if (!entry.isFile()) continue

      const targetRelative = rewriteRelativePath(
        childRelative,
        template.defs,
        template.templateName,
        projectName
      )
      const target = path.join(projectDir, targetRelative)
      await fs.mkdir(path.dirname(target), { recursive: true })

      const extension = path.extname(childRelative).replace(/^\./, '').toLowerCase()
      if (texts.has(extension)) {
        const content = await fs.readFile(path.join(template.dir, childRelative), 'utf-8')
        await fs.writeFile(
          target,
          rewriteFileContent(
            content,
            childRelative,
            template.defs,
            template.templateName,
            projectName
          ),
          'utf-8'
        )
      } else {
        await fs.copyFile(path.join(template.dir, childRelative), target)
      }
    }
  }

  await walk('')
}

/**
 * 共享内容包的落点。
 *
 * 由包自己的 `FeaturePack/manifest.json` 说了算 —— `DestinationFilesFolder`
 * 是 `Characters`，就落到 `Content/Characters/`，这样模板资产里那句
 * `/Game/Characters/...` 才对得上。读不到 manifest 时退回包名，UE 的命名
 * 惯例本来就是两者同名。
 */
async function resolvePackDestination(packDir: string, mountName: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(packDir, 'FeaturePack', 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(raw) as {
      AdditionalFiles?: { DestinationFilesFolder?: string }
    }
    return manifest.AdditionalFiles?.DestinationFilesFolder || mountName
  } catch {
    return mountName
  }
}

/** 把一个共享内容包拷进工程的 Content 下 */
async function copySharedPack(
  engineRoot: string,
  mountName: string,
  detailLevels: string[],
  projectDir: string
): Promise<string | undefined> {
  // 模板声明的档次优先，没声明就按 UE 的默认顺序找
  const levels = [...detailLevels, 'High', 'Standard']

  for (const level of levels) {
    const packDir = path.join(engineRoot, 'Templates', 'TemplateResources', level, mountName)
    const contentDir = path.join(packDir, 'Content')
    if (!(await exists(contentDir))) continue

    const destination = await resolvePackDestination(packDir, mountName)
    await fs.cp(contentDir, path.join(projectDir, 'Content', destination), { recursive: true })
    return mountName
  }

  return undefined
}

/**
 * 生成新工程的 `.uproject`。
 *
 * 模板里那份**不能直接拷**（`FilesToIgnore` 里也明确排除了它）：
 * `EngineAssociation` 是空字符串，照抄的话 Windows 上双击 .uproject 会弹
 * 「选择引擎版本」，而盒子的项目库那一列也会是空的 —— 首页卡片上的
 * 「5.5」角标正是读这个字段。
 */
async function writeUproject(
  template: EngineTemplate,
  projectDir: string,
  projectName: string
): Promise<string> {
  const raw = await readUeTextFile(template.uprojectPath)
  const rewritten = rewriteFileContent(
    raw,
    'x.ini', // uproject 是 JSON，但模块名替换规则挂在 ini 上，借它的扩展名过一遍
    template.defs,
    template.templateName,
    projectName
  )

  const descriptor = JSON.parse(rewritten) as Record<string, unknown>
  descriptor.EngineAssociation = template.engineVersion

  const target = path.join(projectDir, `${projectName}.uproject`)
  await fs.writeFile(target, `${JSON.stringify(descriptor, null, '\t')}\n`, 'utf-8')
  return target
}

/**
 * 把模板缩略图拷成工程封面。
 *
 * `<工程目录>/<工程名>.png` 是 UE 认的工程图标位置，也正是盒子导入工程时找封面
 * 的第一个候选（`UnrealAssetProcessor.getProjectThumbnailCandidates`）。不拷的话，
 * 新建的工程在首页是一张空白卡片，和手动导入的工程长得不一样。
 */
async function copyThumbnail(
  template: EngineTemplate,
  projectDir: string,
  projectName: string
): Promise<void> {
  const source = path.join(template.dir, 'Media', `${template.templateName}.png`)
  if (!(await exists(source))) return
  await fs.copyFile(source, path.join(projectDir, `${projectName}.png`))
}

/**
 * 从引擎自带模板实例化一个工程。
 *
 * 只负责把文件铺到磁盘上并回读校验，**不管登记进项目库** —— 那是调用方的事，
 * 它要和手动导入走同一条登记路径，否则同一个工程从两个入口进来会长得不一样。
 */
export async function instantiateEngineTemplate(options: {
  template: EngineTemplate
  projectName: string
  /** 工程的父目录，工程会建在 `<targetDir>/<projectName>` */
  targetDir: string
}): Promise<InstantiateResult> {
  const { template, projectName, targetDir } = options

  const nameError = validateProjectName(projectName)
  if (nameError) throw new Error(nameError)

  const projectDir = path.join(targetDir, projectName)

  // 已经有东西就不动它。这个工具是 destructive 的，但「确认建工程」不等于
  // 「确认覆盖你现有的工程」
  if (await exists(projectDir)) {
    const entries = await fs.readdir(projectDir).catch(() => [] as string[])
    if (entries.length > 0) {
      throw new Error(`目标目录已存在且不是空的：${projectDir}。请换一个工程名或换一个目录。`)
    }
  }

  await fs.mkdir(projectDir, { recursive: true })
  await copyTemplateTree(template, projectDir, projectName)

  const warnings: string[] = []
  const sharedPacks: string[] = []
  for (const pack of template.defs.sharedContentPacks) {
    if (!pack.mountName) continue
    const copied = await copySharedPack(
      template.engineRoot,
      pack.mountName,
      pack.detailLevels,
      projectDir
    ).catch(() => undefined)
    if (copied) {
      sharedPacks.push(copied)
    } else {
      warnings.push(
        `共享内容包 "${pack.mountName}" 在引擎里没找到，模板里引用它的资产会显示为丢失引用。`
      )
    }
  }

  const uprojectPath = await writeUproject(template, projectDir, projectName)
  await copyThumbnail(template, projectDir, projectName)

  // 回读校验：写完不读一遍就报成功，等于把「文件真的落盘了吗」这个问题
  // 留给用户去发现
  const written = await readUeJsonFile<{ EngineAssociation?: string }>(uprojectPath)
  if (written.EngineAssociation !== template.engineVersion) {
    throw new Error(
      `工程建好了但回读校验没过：${uprojectPath} 里的 EngineAssociation 是 ` +
        `"${written.EngineAssociation}"，应该是 "${template.engineVersion}"。`
    )
  }

  if (template.needsCode) {
    warnings.push(
      '这是 C++ 模板，第一次打开时 UE 会要求编译模块 —— 用户机器上需要装 Visual Studio。'
    )
  }

  return { projectDir, uprojectPath, sharedPacks, warnings }
}
