import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LICENSE_NAME = /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i

/**
 * asar 按 `path.sep` 拆条目名，所以 Windows 上必须传 `\` 分隔的路径。
 *
 * 传 `/` 时它只在两层以内碰巧成立（`dirname` 认得正斜杠，第一层目录名不含分隔符），
 * `node_modules/<包>/package.json` 这种三层往上一律报「不在归档里」—— 也就是每个依赖都炸。
 */
function readArchiveFile(asarPath, entry) {
  return extractFile(asarPath, entry.split('/').join(sep))
}

/** pnpm may hoist a different version into the archive than the workspace root exposes. */
export function findPackagedDependencySource(packageDir, metadata, root = ROOT) {
  const direct = join(root, packageDir)
  if (!metadata.name || !metadata.version) return existsSync(direct) ? direct : null
  const matches = (directory) => {
    try {
      const local = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      return local.name === metadata.name && local.version === metadata.version
    } catch {
      return false
    }
  }
  if (matches(direct)) return direct
  const store = join(root, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    const prefix = `${metadata.name.replace('/', '+')}@${metadata.version}`
    for (const entry of readdirSync(store)) {
      if (entry !== prefix && !entry.startsWith(`${prefix}_`)) continue
      const candidate = join(store, entry, 'node_modules', metadata.name)
      if (matches(candidate)) return candidate
    }
  }
  // electron-builder 会把依赖嵌套进 `node_modules/<父包>/node_modules/<包>`，
  // 而本仓库的 node_modules 是提升过的（`.npmrc` 里 shamefully-hoist），
  // 磁盘上只有顶层那一份。版本对得上就是同一个包，拿它核对许可证。
  const hoisted = join(root, 'node_modules', metadata.name)
  if (matches(hoisted)) return hoisted
  return null
}

/** 对实际产物检查，而不是假设 .gitignore 会影响 electron-builder。 */
export function unexpectedPackagedFiles(entries) {
  return entries.filter((entry) => {
    const name = entry.replace(/\\/g, '/').replace(/^\//, '')
    return !(
      /^(?:out|node_modules|licenses)(?:\/|$)/.test(name) ||
      /^(?:package\.json|LICENSE|THIRD-PARTY-NOTICES\.md|resources|resources\/plugins)$/.test(
        name
      ) ||
      /^resources\/icon[^/]*\.(?:png|ico)$/.test(name) ||
      /^resources\/plugins\/(?:UnrealAgentLink\d+(?:-Mac)?\.zip|ualink-config\.json)$/.test(name)
    )
  })
}

export function checkPackagedContent(asarPath) {
  const entries = listPackage(asarPath).map((name) => name.replace(/\\/g, '/').replace(/^\//, ''))
  const packaged = new Set(entries)
  const errors = unexpectedPackagedFiles(entries).map((name) => `非发行文件进入 app.asar: ${name}`)
  for (const name of [
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'licenses/EPL-2.0.txt',
    'licenses/LGPL-3.0.txt',
    'licenses/GPL-3.0.txt',
    'licenses/MPL-2.0.txt',
    'licenses/LGPL-2.1.txt',
    'licenses/libvips-Windows-NOTICES.md'
  ]) {
    if (!packaged.has(name)) errors.push(`app.asar 缺少发行许可证: ${name}`)
    else if (!readArchiveFile(asarPath, name).length) errors.push(`许可证文件为空: ${name}`)
  }
  for (const entry of entries) {
    if (!entry.startsWith('node_modules/') || !entry.endsWith('/package.json')) continue
    const packageDir = dirname(entry)
    const metadata = JSON.parse(readArchiveFile(asarPath, entry).toString('utf8'))
    const localDir = findPackagedDependencySource(packageDir, metadata)
    if (!localDir) {
      // Nested package.json files can only set module type, rather than define a dependency.
      if (metadata.name && metadata.version) {
        errors.push(`无法核对依赖许可证，缺少对应版本源码: ${packageDir}@${metadata.version}`)
      }
      continue
    }
    for (const name of readdirSync(localDir).filter((file) => LICENSE_NAME.test(file))) {
      if (!packaged.has(`${packageDir.replace(/\\/g, '/')}/${name}`)) {
        errors.push(`app.asar 缺少依赖许可证: ${packageDir}/${name}`)
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('打包内容检查通过（无本机私有目录，已保留发行许可与依赖自带声明）。')
}
