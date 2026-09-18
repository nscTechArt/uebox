/**
 * 蓝图包 / 材质包的格式与命名规则（纯逻辑，不碰文件系统）。
 *
 * 一个条目 = 保管库里的一个**目录**，目录名自带扩展名，像 macOS 的 `.app`：
 *
 *   跳跃逻辑.ueblueprint/
 *     blueprint.json     ← 清单：元信息 + 领域数据
 *     cover.png          ← 封面（可选）
 *     README.md          ← 说明（可选）
 *
 *   苔藓石头.uematerial/
 *     material.json
 *     cover.png
 *     textures/          ← 以后引用贴图放这儿
 *
 * 为什么名字带扩展名：扫描器看一眼目录名就知道「这是一个包，不要递归进去」，
 * 不必先读里面的东西；用户在资源管理器里也一眼认得出这不是普通文件夹。
 *
 * 为什么清单里的领域数据是不透明的 `payload`：这一层只管「包长什么样」，
 * 不该知道蓝图节点或材质节点长什么样。领域模型换了，这层不用改。
 *
 * 对应硬规则第 9 条：用户创作的东西，唯一真相源是磁盘上的文件，
 * 数据库只是能删掉重建的索引。
 */

// 类型定义在 src/shared/ —— 渲染进程也要用同一份，各写一份迟早会漂
import type { LibraryKind, LibraryPackageManifest } from '../../shared/libraryPackage'

export type { LibraryKind, LibraryPackageManifest }

export const LIBRARY_KINDS: readonly LibraryKind[] = ['blueprint', 'material']

/** 包目录的扩展名。改这里就是改用户磁盘上的东西，动之前先想清楚迁移。 */
const PACKAGE_SUFFIX: Record<LibraryKind, string> = {
  blueprint: '.ueblueprint',
  material: '.uematerial'
}

/** 包里那份清单的文件名 */
const MANIFEST_FILE: Record<LibraryKind, string> = {
  blueprint: 'blueprint.json',
  material: 'material.json'
}

/** 清单里 `format` 字段的取值，用来挡住「扩展名对但内容是别的东西」 */
const FORMAT_TAG: Record<LibraryKind, string> = {
  blueprint: 'unreal-box-blueprint',
  material: 'unreal-box-material'
}

/** 当前清单格式版本。将来加字段不用升；改变已有字段含义才升。 */
export const MANIFEST_FORMAT_VERSION = 1

/** 名字被清洗到一个字符都不剩时用它兜底 */
const FALLBACK_BASE_NAME = 'untitled'

/**
 * 目录名里 base name 的长度上限。
 *
 * Windows 的 MAX_PATH 是 260，而包目录名后面还要接 `\textures\xxx.png` 这种。
 * 留出余量，80 个字符足够放一个说得清的中文名。
 */
const MAX_BASE_NAME_LENGTH = 80

export function getPackageSuffix(library: LibraryKind): string {
  return PACKAGE_SUFFIX[library]
}

export function getManifestFileName(library: LibraryKind): string {
  return MANIFEST_FILE[library]
}

export function getFormatTag(library: LibraryKind): string {
  return FORMAT_TAG[library]
}

/**
 * Windows 上不能出现在文件名里的字符。
 *
 * `\0` 到 `\x1f` 也一并挡掉 —— 它们在 Linux 上合法，但一个带换行的目录名
 * 会让后面每一处日志和路径拼接都变成惊喜。
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

/**
 * Windows 保留设备名。叫 `CON` 的目录建不出来，报的错还跟名字毫无关系。
 * 带扩展名也一样中招（`CON.ueblueprint`），所以是拿 base name 比。
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)
])

/**
 * 把用户起的名字洗成一个能当目录名的 base name。
 *
 * 中文原样保留 —— 用户看得懂的名字才对得起「拷得走、备份得到」这句承诺，
 * 洗成拼音或 ID 就等于把资源管理器里那份可读性丢了。
 */
export function sanitizeBaseName(rawName: string): string {
  let name = String(rawName ?? '')
    .replace(ILLEGAL_NAME_CHARS, ' ')
    // `..` 和单个 `.` 是路径语义，不是名字
    .replace(/\.+/g, '.')
    .trim()

  // Windows 会把结尾的点和空格默默吃掉：`foo.` 建出来是 `foo`，
  // 于是「写进去的名字」和「磁盘上的名字」对不上，删的时候就找不着了。
  name = name.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '')

  if (name.length > MAX_BASE_NAME_LENGTH) {
    name = name.slice(0, MAX_BASE_NAME_LENGTH).replace(/[. ]+$/g, '')
  }

  if (!name) return FALLBACK_BASE_NAME
  if (RESERVED_DEVICE_NAMES.has(name.toLowerCase())) return `${name}_`

  return name
}

/** 拼出包目录名。名字会先被 {@link sanitizeBaseName} 洗一遍。 */
export function buildPackageDirName(library: LibraryKind, rawName: string): string {
  return `${sanitizeBaseName(rawName)}${PACKAGE_SUFFIX[library]}`
}

/**
 * 反过来：一个目录名是不是包？是的话它属于哪个库、显示名是什么？
 *
 * @returns 不是包时返回 null
 */
export function parsePackageDirName(
  dirName: string
): { library: LibraryKind; baseName: string } | null {
  const name = String(dirName ?? '')
  if (!name) return null

  for (const library of LIBRARY_KINDS) {
    const suffix = PACKAGE_SUFFIX[library]
    // 扩展名大小写不敏感：用户手动改名、从 macOS 拷过来都可能变成 .UEBlueprint
    if (name.length <= suffix.length) continue
    if (name.slice(-suffix.length).toLowerCase() !== suffix) continue

    const baseName = name.slice(0, -suffix.length)
    // `.ueblueprint` 这种「只有扩展名没有名字」的不算包
    if (!baseName.trim()) return null

    return { library, baseName }
  }

  return null
}

/** 扫描器用的快速判断：这个目录名是不是包（任意库） */
export function isPackageDirName(dirName: string): boolean {
  return parsePackageDirName(dirName) !== null
}

/**
 * 重名时加后缀，跟 Windows 一个脾气：`跳跃逻辑 (2).ueblueprint`。
 *
 * `taken` 传的是同一个父目录下**已经存在的目录名**。比较大小写不敏感 ——
 * Windows 上 `Foo` 和 `foo` 是同一个目录，按大小写敏感去比会撞车。
 */
export function uniquePackageDirName(
  library: LibraryKind,
  rawName: string,
  taken: Iterable<string>
): string {
  const takenLower = new Set<string>()
  for (const item of taken) takenLower.add(String(item).toLowerCase())

  const base = sanitizeBaseName(rawName)
  const suffix = PACKAGE_SUFFIX[library]

  let candidate = `${base}${suffix}`
  for (let n = 2; takenLower.has(candidate.toLowerCase()); n++) {
    candidate = `${base} (${n})${suffix}`
  }

  return candidate
}

/**
 * 解析清单。
 *
 * 一律 fail-closed：坏掉的清单返回 null，让调用方把这个包跳过并报出来，
 * 而不是拿一份缺字段的对象继续跑 —— 那样错误会在很远的地方才炸。
 */
export function parseManifest(text: string, library: LibraryKind): LibraryPackageManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  // 扩展名对不代表内容对：目录可能是用户手动改名改出来的
  if (obj.format !== FORMAT_TAG[library]) return null

  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!id || !name) return null

  const formatVersion = Number(obj.formatVersion)
  if (!Number.isInteger(formatVersion) || formatVersion < 1) return null
  // 未来版本的包在这台机器上读不了。返回 null 而不是硬读，
  // 免得用旧代码解析新格式，再存回去时把不认识的字段抹掉。
  if (formatVersion > MANIFEST_FORMAT_VERSION) return null

  const toTimestamp = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  return {
    format: FORMAT_TAG[library],
    formatVersion,
    id,
    name,
    createdAt: toTimestamp(obj.createdAt),
    updatedAt: toTimestamp(obj.updatedAt),
    cover: typeof obj.cover === 'string' ? obj.cover : '',
    payload: 'payload' in obj ? obj.payload : null
  }
}

/** 写盘用。缩进两格是故意的：用户能用记事本打开看懂、手改、diff。 */
export function serializeManifest(manifest: LibraryPackageManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * 包内相对路径的安全检查。
 *
 * 清单里的 `cover` 字段是数据，不是代码 —— 用户手改过、从别处拷来的包
 * 都可能写成 `../../../etc/passwd`。读它之前必须确认它老老实实待在包里面。
 */
export function isSafeInPackagePath(relPath: string): boolean {
  const value = String(relPath ?? '')
  if (!value) return false
  if (value.includes('\0')) return false
  if (value.includes('\\')) return false
  if (value.startsWith('/')) return false
  // 盘符开头的绝对路径
  if (/^[a-zA-Z]:/.test(value)) return false

  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
