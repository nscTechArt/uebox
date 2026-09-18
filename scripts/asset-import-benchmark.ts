/**
 * 资产导入性能诊断脚本
 * 用于测量各环节耗时，找出真正的性能瓶颈
 *
 * 运行方式: npx tsx scripts/asset-import-benchmark.ts <测试文件夹路径>
 */

import { promises as fs, statSync, existsSync, createReadStream, open, close, read } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'

// ============ 配置 ============
const SAMPLE_SIZE = 64 * 1024 // 64KB 采样

// ============ 工具函数 ============

/** 格式化耗时 */
function formatTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(2)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** 格式化大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 快速哈希计算 (采样方式) */
async function calculateFastHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stats = statSync(filePath)
    const fileSize = stats.size

    hash.update(Buffer.from(fileSize.toString()))

    if (fileSize <= SAMPLE_SIZE * 3) {
      const stream = createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
      return
    }

    open(filePath, 'r', (err, fd) => {
      if (err) return reject(err)

      const bufStart = Buffer.alloc(SAMPLE_SIZE)
      const bufMid = Buffer.alloc(SAMPLE_SIZE)
      const bufEnd = Buffer.alloc(SAMPLE_SIZE)
      let completed = 0

      const onRead =
        (buf: Buffer) => (readErr: NodeJS.ErrnoException | null, bytesRead: number) => {
          if (readErr) {
            close(fd, () => reject(readErr))
            return
          }
          if (bytesRead > 0) hash.update(buf.subarray(0, bytesRead))
          if (++completed === 3) {
            close(fd, (closeErr) => (closeErr ? reject(closeErr) : resolve(hash.digest('hex'))))
          }
        }

      read(fd, bufStart, 0, SAMPLE_SIZE, 0, onRead(bufStart))
      read(
        fd,
        bufMid,
        0,
        SAMPLE_SIZE,
        Math.floor(fileSize / 2) - Math.floor(SAMPLE_SIZE / 2),
        onRead(bufMid)
      )
      read(fd, bufEnd, 0, SAMPLE_SIZE, Math.max(0, fileSize - SAMPLE_SIZE), onRead(bufEnd))
    })
  })
}

// ============ 诊断逻辑 ============

interface BenchmarkResult {
  scanTime: number
  hashTime: number
  parseTime: number
  totalFiles: number
  totalSize: number
  filesByExt: Record<string, number>
  errors: string[]
}

async function scanFolder(
  folderPath: string
): Promise<{ files: string[]; folders: string[]; time: number }> {
  const start = performance.now()
  const files: string[] = []
  const folders: string[] = []
  const queue = [folderPath]

  while (queue.length > 0) {
    const current = queue.shift()!
    try {
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          folders.push(fullPath)
          queue.push(fullPath)
        } else {
          files.push(fullPath)
        }
      }
    } catch (e) {
      // 跳过无法访问的目录
    }
  }

  return { files, folders, time: performance.now() - start }
}

async function benchmarkHashing(
  files: string[],
  sampleCount = 100
): Promise<{ avgTime: number; totalTime: number }> {
  const sample = files.slice(0, sampleCount)
  const start = performance.now()

  for (const file of sample) {
    try {
      await calculateFastHash(file)
    } catch {}
  }

  const totalTime = performance.now() - start
  return { avgTime: totalTime / sample.length, totalTime }
}

async function runBenchmark(folderPath: string) {
  console.log('🔍 资产导入性能诊断')
  console.log('='.repeat(50))
  console.log(`📂 目标文件夹: ${folderPath}`)
  console.log('')

  // 1. 扫描阶段
  console.log('📊 阶段1: 文件夹扫描...')
  const scan = await scanFolder(folderPath)
  console.log(`   文件数: ${scan.files.length}`)
  console.log(`   文件夹数: ${scan.folders.length}`)
  console.log(`   扫描耗时: ${formatTime(scan.time)}`)
  console.log('')

  // 统计文件类型分布
  const extCount: Record<string, number> = {}
  const extSize: Record<string, number> = {}
  let totalSize = 0

  for (const file of scan.files) {
    const ext = file.split('.').pop()?.toLowerCase() || 'unknown'
    extCount[ext] = (extCount[ext] || 0) + 1
    try {
      const size = statSync(file).size
      extSize[ext] = (extSize[ext] || 0) + size
      totalSize += size
    } catch {}
  }

  console.log('📊 文件类型分布:')
  const sorted = Object.entries(extCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  for (const [ext, count] of sorted) {
    const size = extSize[ext] || 0
    console.log(`   .${ext}: ${count} 个 (${formatSize(size)})`)
  }
  console.log(`   总大小: ${formatSize(totalSize)}`)
  console.log('')

  // 2. 哈希测试
  console.log('📊 阶段2: 快速哈希性能测试 (采样100个文件)...')
  const hashResult = await benchmarkHashing(scan.files, 100)
  console.log(`   单文件平均耗时: ${formatTime(hashResult.avgTime)}`)
  console.log(`   预估全量耗时: ${formatTime(hashResult.avgTime * scan.files.length)}`)
  console.log('')

  // 3. uasset 文件统计
  const uassetFiles = scan.files.filter((f) => f.endsWith('.uasset') || f.endsWith('.umap'))
  console.log('📊 阶段3: UAsset 文件分析...')
  console.log(`   .uasset/.umap 文件数: ${uassetFiles.length}`)
  if (uassetFiles.length > 0) {
    let uassetTotalSize = 0
    for (const f of uassetFiles) {
      try {
        uassetTotalSize += statSync(f).size
      } catch {}
    }
    console.log(`   .uasset/.umap 总大小: ${formatSize(uassetTotalSize)}`)
    console.log(`   平均单文件大小: ${formatSize(uassetTotalSize / uassetFiles.length)}`)
  }
  console.log('')

  // 4. 性能瓶颈预估
  console.log('📊 性能瓶颈预估:')
  const estimatedHashTime = hashResult.avgTime * scan.files.length
  const estimatedParseTime = uassetFiles.length * 50 // 假设每个uasset解析50ms
  const estimatedDbTime = scan.files.length * 5 // 假设每个文件DB写入5ms

  console.log(
    `   哈希计算: ${formatTime(estimatedHashTime)} (${((estimatedHashTime / (estimatedHashTime + estimatedParseTime + estimatedDbTime)) * 100).toFixed(1)}%)`
  )
  console.log(
    `   UAsset解析: ${formatTime(estimatedParseTime)} (${((estimatedParseTime / (estimatedHashTime + estimatedParseTime + estimatedDbTime)) * 100).toFixed(1)}%)`
  )
  console.log(
    `   数据库写入: ${formatTime(estimatedDbTime)} (${((estimatedDbTime / (estimatedHashTime + estimatedParseTime + estimatedDbTime)) * 100).toFixed(1)}%)`
  )
  console.log('')
  console.log('='.repeat(50))
}

// ============ 入口 ============
const targetPath = process.argv[2]
if (!targetPath) {
  console.log('用法: npx tsx scripts/asset-import-benchmark.ts <文件夹路径>')
  process.exit(1)
}

if (!existsSync(targetPath)) {
  console.log(`错误: 路径不存在 ${targetPath}`)
  process.exit(1)
}

runBenchmark(targetPath).catch(console.error)
