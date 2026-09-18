// compare-manifest.js
// 用法：node compare-manifest.js "\\\\nas.example.lan\\网络资产库" "FPS"

const fs = require('fs')
const path = require('path')

if (process.argv.length < 4) {
  console.error('用法: node compare-manifest.js <networkRoot> <subDir>')
  console.error('示例: node compare-manifest.js "\\\\nas.example.lan\\网络资产库" "FPS"')
  process.exit(1)
}

const networkRoot = process.argv[2] // 如 \\nas.example.lan\网络资产库
const subDir = process.argv[3] // 如 FPS
const manifestPath = path.join(networkRoot, 'index.json')
const baseDir = path.join(networkRoot, subDir)

// 与程序中保持一致的排除规则
const EXCLUDE_DIRS = new Set([
  '.thumbnails',
  '.git',
  'node_modules',
  'Binaries',
  'Intermediate',
  '_journal',
  'DerivedDataCache'
])

const EXCLUDE_FILES = new Set(['index.json', 'index.lock'])

function readManifestAssets(manifestFile) {
  const raw = fs.readFileSync(manifestFile, 'utf8')
  const json = JSON.parse(raw)
  const assets = json.assets || []

  const manifestPaths = new Set()
  for (const a of assets) {
    if (!a || !a.path) continue
    const p = a.path.replace(/\\/g, '/')
    if (p === subDir || p.startsWith(subDir + '/')) {
      manifestPaths.add(p)
    }
  }
  return manifestPaths
}

function walkDir(rootDir, relPrefix = '', stats) {
  const results = []
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) {
        stats.skippedDirs.push(path.join(rootDir, entry.name))
        continue
      }
      results.push(...walkDir(fullPath, relPath, stats))
    } else if (entry.isFile()) {
      // 记录所有文件（包括被排除的），用于总数比对
      stats.totalFiles++

      if (
        EXCLUDE_FILES.has(entry.name) ||
        entry.name.endsWith('.tmp') ||
        entry.name.endsWith('.lock')
      ) {
        stats.skippedFiles.push(path.join(rootDir, entry.name))
        continue
      }

      const relFromRoot = `${subDir}/${relPath}`.replace(/\\/g, '/')
      results.push(relFromRoot)
    }
  }

  return results
}

function main() {
  if (!fs.existsSync(manifestPath)) {
    console.error('找不到 manifest 文件:', manifestPath)
    process.exit(1)
  }
  if (!fs.existsSync(baseDir)) {
    console.error('找不到目录:', baseDir)
    process.exit(1)
  }

  console.log('读取 manifest:', manifestPath)
  const manifestPaths = readManifestAssets(manifestPath)
  console.log('Manifest 中该子目录资产数量:', manifestPaths.size)

  console.log('扫描物理目录:', baseDir)

  const stats = {
    totalFiles: 0,
    skippedDirs: [],
    skippedFiles: []
  }

  const diskPaths = walkDir(baseDir, '', stats)
  const diskPathSet = new Set(diskPaths)

  console.log('物理目录下文件总数(含被排除的):', stats.totalFiles)
  console.log('物理目录下文件数量(排除系统/临时文件后):', diskPaths.length)
  console.log('排除的目录数:', stats.skippedDirs.length)
  console.log('排除的文件数(系统/临时):', stats.skippedFiles.length)

  // 磁盘有但 manifest 没有
  const onlyOnDisk = diskPaths.filter((p) => !manifestPaths.has(p))

  // manifest 有但磁盘没有
  const onlyInManifest = Array.from(manifestPaths).filter((p) => !diskPathSet.has(p))

  console.log('\n=== 磁盘有但清单没有的文件 (onlyOnDisk) ===')
  console.log('数量:', onlyOnDisk.length)
  for (const p of onlyOnDisk.slice(0, 50)) {
    console.log(p)
  }
  if (onlyOnDisk.length > 50) {
    console.log(`... 共 ${onlyOnDisk.length} 个，仅显示前 50 条`)
  }

  console.log('\n=== 清单有但磁盘没有的文件 (onlyInManifest) ===')
  console.log('数量:', onlyInManifest.length)
  for (const p of onlyInManifest.slice(0, 50)) {
    console.log(p)
  }
  if (onlyInManifest.length > 50) {
    console.log(`... 共 ${onlyInManifest.length} 个，仅显示前 50 条`)
  }

  console.log('\n=== 被排除的目录 (EXCLUDE_DIRS) ===')
  console.log('数量:', stats.skippedDirs.length)
  for (const p of stats.skippedDirs.slice(0, 50)) {
    console.log(p)
  }
  if (stats.skippedDirs.length > 50) {
    console.log(`... 共 ${stats.skippedDirs.length} 个，仅显示前 50 条`)
  }

  console.log('\n=== 被排除的文件 (系统/临时: index.json/index.lock/*.tmp/*.lock) ===')
  console.log('数量:', stats.skippedFiles.length)
  for (const p of stats.skippedFiles.slice(0, 50)) {
    console.log(p)
  }
  if (stats.skippedFiles.length > 50) {
    console.log(`... 共 ${stats.skippedFiles.length} 个，仅显示前 50 条`)
  }
}

main()
