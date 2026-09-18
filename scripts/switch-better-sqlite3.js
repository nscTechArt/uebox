/* eslint-disable */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const target = process.argv[2]
const projectRoot = path.resolve(__dirname, '..')
const isWindows = process.platform === 'win32'
const betterSqlite3GypPath = path.join(
  projectRoot,
  'node_modules',
  'better-sqlite3',
  'deps',
  'sqlite3.gyp'
)
const normalizedProjectRoot = normalizePath(projectRoot)

function patchBetterSqlite3GypForWindows() {
  if (!isWindows) return
  if (!fs.existsSync(betterSqlite3GypPath)) return

  const original = fs.readFileSync(betterSqlite3GypPath, 'utf8')
  if (original.includes("'msbuild_use_call': 0")) return

  const patched = original.replace(
    /('action': \['node', 'copy\.js', [^\n]+\],\r?\n)/g,
    "$1            'msbuild_use_call': 0,\n"
  )

  if (patched === original) {
    console.warn('Warning: failed to patch better-sqlite3 sqlite3.gyp for Windows rebuild.')
    return
  }

  fs.writeFileSync(betterSqlite3GypPath, patched, 'utf8')
  console.log(
    'Patched better-sqlite3 sqlite3.gyp to avoid duplicate MSBuild call wrapping on Windows.'
  )
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: isWindows
  })
  if (result.error) throw result.error
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }
}

function normalizePath(input) {
  if (!input || typeof input !== 'string') return ''
  return path
    .normalize(input)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function isPathInsideProject(input) {
  const normalized = normalizePath(input)
  return normalized === normalizedProjectRoot || normalized.startsWith(`${normalizedProjectRoot}\\`)
}

function getRunningElectronProcesses() {
  if (!isWindows) return []
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Get-CimInstance Win32_Process',
    "| Where-Object { $_.Name -in @('electron.exe', 'unreal-agent.exe') }",
    '| Select-Object Name, ProcessId, ExecutablePath, CommandLine',
    '| ConvertTo-Json -Compress'
  ].join(' ')

  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: projectRoot,
    encoding: 'utf8'
  })
  if (result.error || result.status !== 0 || !result.stdout.trim()) return []

  try {
    const parsed = JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    console.warn('Warning: failed to inspect running Electron processes:', error.message)
    return []
  }
}

function getBlockingProcesses() {
  return getRunningElectronProcesses().filter((processInfo) => {
    const executablePath = processInfo.ExecutablePath || ''
    const commandLine = (processInfo.CommandLine || '').toLowerCase()

    return isPathInsideProject(executablePath) || commandLine.includes(normalizedProjectRoot)
  })
}

if (!target || !['node', 'electron'].includes(target)) {
  console.error('Usage: node scripts/switch-better-sqlite3.js <node|electron>')
  process.exit(1)
}

const blockingProcesses = getBlockingProcesses()
if (blockingProcesses.length > 0) {
  console.error(
    'Detected running Electron processes. Please close the app and development server before rebuilding.'
  )
  for (const processInfo of blockingProcesses) {
    const processId = processInfo.ProcessId || 'unknown'
    const executablePath = processInfo.ExecutablePath || '(path unavailable)'
    console.error(`- PID ${processId}: ${executablePath}`)
  }
  process.exit(1)
}

if (target === 'node') {
  console.log('Rebuilding better-sqlite3 for system Node...')
  patchBetterSqlite3GypForWindows()
  run(isWindows ? 'npm.cmd' : 'npm', ['rebuild', 'better-sqlite3'])
  console.log('better-sqlite3 is now built for system Node.')
  process.exit(0)
}

console.log('Rebuilding better-sqlite3 for Electron...')
patchBetterSqlite3GypForWindows()
run(isWindows ? 'npx.cmd' : 'npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'])
console.log('better-sqlite3 is now built for Electron.')
