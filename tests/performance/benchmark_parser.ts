import * as fs from 'fs'
import * as path from 'path'
import { performance } from 'perf_hooks'
import { createHash } from 'crypto'
// @ts-ignore
import ReaderUasset from '../../src/main/utils/uasset-reader.js'

const targetDir = 'H:\\TEST ASSET\\Iceland'

async function calculateFileMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const SAMPLE_SIZE = 64 * 1024 // 每个采样点读取64KB
    const stats = fs.statSync(filePath)
    const fileSize = stats.size

    // 将文件大小加入哈希
    hash.update(Buffer.from(fileSize.toString()))

    // 如果文件很小，直接读取整个文件
    if (fileSize <= SAMPLE_SIZE * 3) {
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => {
        hash.update(chunk)
      })
      stream.on('end', () => {
        resolve(hash.digest('hex'))
      })
      stream.on('error', (err) => {
        reject(err)
      })
      return
    }

    // 对于大文件，只读取开头、中间、结尾
    fs.open(filePath, 'r', (err, fd) => {
      if (err) {
        reject(err)
        return
      }

      const bufferStart = Buffer.alloc(SAMPLE_SIZE)
      const bufferMiddle = Buffer.alloc(SAMPLE_SIZE)
      const bufferEnd = Buffer.alloc(SAMPLE_SIZE)
      let completed = 0
      const totalReads = 3

      const readCallback = (buffer: Buffer) => (readErr: any, bytesRead: number) => {
        if (readErr) {
          fs.close(fd, () => reject(readErr))
          return
        }

        if (bytesRead > 0) {
          hash.update(buffer.subarray(0, bytesRead))
        }

        completed++
        if (completed === totalReads) {
          fs.close(fd, (closeErr) => {
            if (closeErr) {
              reject(closeErr)
            } else {
              resolve(hash.digest('hex'))
            }
          })
        }
      }

      // 读取开头
      fs.read(fd, bufferStart, 0, SAMPLE_SIZE, 0, readCallback(bufferStart))

      // 读取中间
      const middlePos = Math.floor(fileSize / 2) - Math.floor(SAMPLE_SIZE / 2)
      fs.read(fd, bufferMiddle, 0, SAMPLE_SIZE, middlePos, readCallback(bufferMiddle))

      // 读取结尾
      const endPos = Math.max(0, fileSize - SAMPLE_SIZE)
      fs.read(fd, bufferEnd, 0, SAMPLE_SIZE, endPos, readCallback(bufferEnd))
    })
  })
}

async function getFiles(dir: string): Promise<string[]> {
  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      dirents.map((dirent) => {
        const res = path.resolve(dir, dirent.name)
        return dirent.isDirectory() ? getFiles(res) : res
      })
    )
    return Array.prototype.concat(...files)
  } catch (e) {
    console.error(`Error scanning dir ${dir}:`, e)
    return []
  }
}

async function run() {
  console.log(`Scanning ${targetDir}...`)
  if (!fs.existsSync(targetDir)) {
    console.error(`Directory not found: ${targetDir}`)
    process.exit(1)
  }

  const files = await getFiles(targetDir)
  const uassets = files.filter(
    (f: any) => typeof f === 'string' && f.toLowerCase().endsWith('.uasset')
  )
  console.log(`Found ${uassets.length} .uasset files.`)

  if (uassets.length === 0) {
    console.log('No uasset files found. Exiting.')
    return
  }

  let totalParseTime = 0
  let totalMd5Time = 0
  let totalSize = 0
  let successCount = 0
  let failCount = 0
  let maxMem = 0

  const getMem = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  maxMem = getMem()
  console.log(`Initial Memory: ${maxMem} MB`)

  const startTime = performance.now()

  for (const file of uassets) {
    // @ts-ignore
    const currentFile = file as string
    try {
      // Read File
      const readStart = performance.now()
      const buffer = await fs.promises.readFile(currentFile)
      totalSize += buffer.length

      // Optimized MD5 Calculation
      const md5Start = performance.now()
      await calculateFileMd5(currentFile)
      const md5Duration = performance.now() - md5Start
      totalMd5Time += md5Duration

      // Parse
      const parseStart = performance.now()
      const uint8Array = new Uint8Array(buffer)
      // @ts-ignore
      const reader = new ReaderUasset()
      const result = reader.analyze(uint8Array, false)
      const parseDuration = performance.now() - parseStart
      totalParseTime += parseDuration

      if (result instanceof Error) {
        failCount++
      } else {
        successCount++
      }

      // Log slow operations
      if (parseDuration > 200 || md5Duration > 200) {
        console.log(
          `Slow file: ${path.basename(currentFile)} (${(buffer.length / 1024 / 1024).toFixed(2)} MB) - MD5: ${md5Duration.toFixed(0)}ms, Parse: ${parseDuration.toFixed(0)}ms`
        )
      }
    } catch (e) {
      failCount++
      console.error(`Error processing ${path.basename(currentFile)}:`, e)
    }

    const currentMem = getMem()
    if (currentMem > maxMem) maxMem = currentMem

    if ((successCount + failCount) % 50 === 0) {
      console.log(`Processed ${successCount + failCount}/${uassets.length}. Mem: ${currentMem} MB`)
      if (global.gc) global.gc()
    }
  }

  const totalDuration = (performance.now() - startTime) / 1000

  console.log('\n--- Results (Optimized MD5) ---')
  console.log(`Total Files: ${uassets.length}`)
  console.log(`Success: ${successCount}`)
  console.log(`Failed: ${failCount}`)
  console.log(`Total Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Wall Clock Time: ${totalDuration.toFixed(2)} s`)
  console.log(`Throughput: ${(totalSize / 1024 / 1024 / totalDuration).toFixed(2)} MB/s`)

  console.log('\n--- Breakdown ---')
  console.log(`Total Parse Time: ${(totalParseTime / 1000).toFixed(2)} s`)
  console.log(`Total MD5 Time: ${(totalMd5Time / 1000).toFixed(2)} s`)
  console.log(`Avg Parse Time: ${(totalParseTime / uassets.length).toFixed(2)} ms`)
  console.log(`Avg MD5 Time: ${(totalMd5Time / uassets.length).toFixed(2)} ms`)

  console.log(`Max Memory Used: ${maxMem} MB`)
}

run().catch(console.error)
