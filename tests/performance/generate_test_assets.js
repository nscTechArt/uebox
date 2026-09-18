const fs = require('fs')
const path = require('path')
const { promises: fsPromises } = require('fs')

const args = process.argv.slice(2)
const help = `
Usage: node generate_test_assets.js [options]

Options:
  --source <path>      Path to a source .uasset file to copy (optional, will create dummy if not provided)
  --output <dir>       Directory to generate assets in (required)
  --count <number>     Number of assets to generate (default: 100)
  --prefix <string>    Prefix for generated filenames (default: 'TestAsset_')
  --size <number>      Size of dummy file in KB (if source not provided, default: 10)
  --unique             Append random bytes to make file content unique (default: false)
  --depth <number>     Directory depth (default: 0, flat structure)
  --folders <number>   Number of subfolders per level (default: 1)

Example:
  node generate_test_assets.js --output ./test_data --count 1000 --unique
`

function parseArgs(args) {
  const config = {
    count: 100,
    prefix: 'TestAsset_',
    size: 10,
    unique: false,
    depth: 0,
    folders: 1
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        config.source = args[++i]
        break
      case '--output':
        config.output = args[++i]
        break
      case '--count':
        config.count = parseInt(args[++i], 10)
        break
      case '--prefix':
        config.prefix = args[++i]
        break
      case '--size':
        config.size = parseInt(args[++i], 10)
        break
      case '--unique':
        config.unique = true
        break
      case '--depth':
        config.depth = parseInt(args[++i], 10)
        break
      case '--folders':
        config.folders = parseInt(args[++i], 10)
        break
      case '--help':
      case '-h':
        console.log(help)
        process.exit(0)
    }
  }

  if (!config.output) {
    console.error('Error: --output directory is required')
    console.log(help)
    process.exit(1)
  }

  return config
}

async function createDummyFile(filePath, sizeKB) {
  const buffer = Buffer.alloc(sizeKB * 1024)
  // Fill with some pattern
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = i % 256
  }
  await fsPromises.writeFile(filePath, buffer)
}

async function generateAssets() {
  const config = parseArgs(args)
  const startTime = Date.now()

  console.log('Configuration:', config)

  // Prepare source content
  let sourceBuffer
  if (config.source) {
    if (!fs.existsSync(config.source)) {
      console.error(`Source file not found: ${config.source}`)
      process.exit(1)
    }
    sourceBuffer = await fsPromises.readFile(config.source)
  } else {
    sourceBuffer = Buffer.alloc(config.size * 1024)
    sourceBuffer.fill('A') // Dummy content
  }

  // Create output root
  if (!fs.existsSync(config.output)) {
    await fsPromises.mkdir(config.output, { recursive: true })
  }

  // Generate files
  console.log(`Generating ${config.count} assets...`)

  let generatedCount = 0
  const tasks = []

  // Create folder structure first if needed
  const folders = [config.output]
  if (config.depth > 0) {
    let currentLevelFolders = [config.output]
    for (let d = 0; d < config.depth; d++) {
      const nextLevelFolders = []
      for (const parent of currentLevelFolders) {
        for (let f = 0; f < config.folders; f++) {
          const subFolder = path.join(parent, `Folder_${d}_${f}`)
          await fsPromises.mkdir(subFolder, { recursive: true })
          folders.push(subFolder)
          nextLevelFolders.push(subFolder)
        }
      }
      currentLevelFolders = nextLevelFolders
    }
  }

  for (let i = 0; i < config.count; i++) {
    const folderIndex = i % folders.length
    const targetDir = folders[folderIndex]
    const fileName = `${config.prefix}${i}.uasset`
    const filePath = path.join(targetDir, fileName)

    const task = (async () => {
      if (config.unique) {
        const uniqueBuffer = Buffer.concat([sourceBuffer, Buffer.from(Math.random().toString())])
        await fsPromises.writeFile(filePath, uniqueBuffer)
      } else {
        await fsPromises.writeFile(filePath, sourceBuffer)
      }
    })()

    tasks.push(task)
    generatedCount++

    // Limit concurrent writes to avoid OS errors
    if (tasks.length >= 100) {
      await Promise.all(tasks)
      tasks.length = 0
      process.stdout.write(`\rGenerated: ${generatedCount}/${config.count}`)
    }
  }

  await Promise.all(tasks)

  const duration = (Date.now() - startTime) / 1000
  console.log(`\n\nDone! Generated ${generatedCount} assets in ${duration.toFixed(2)}s`)
  console.log(`Output directory: ${path.resolve(config.output)}`)
}

generateAssets().catch(console.error)
