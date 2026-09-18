/* eslint-disable */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const projectRoot = path.resolve(__dirname, '..')
// 从当前项目解析构建工具。
const builderCli = require.resolve('electron-builder/cli.js')
const outputDir = path.join(projectRoot, 'dist')
const githubRepo = resolveGithubRepo()
/** 调用方透传给 electron-builder 的 `-c.xxx=yyy` 覆盖 */
const extraBuilderConfigArgs = process.argv.slice(2).filter((arg) => arg.startsWith('-c.'))
const tempRoot = resolveTempRoot()
const nsisCacheDir = resolveNsisCacheDir()
const updateArtifactMatchers = [/^latest(?:-[\w.-]+)?\.yml$/i, /\.exe$/i, /\.blockmap$/i]

/**
 * 更新源 = 公开的 GitHub Releases，只有一条线，没有渠道。
 *
 * 没配置就**不注入 publish** —— electron-builder 于是不生成 latest.yml，
 * 打出来的包也没有更新源，开机一次请求都不发。这是社区版的默认形态：
 * 别人克隆这个仓库自己编，不会莫名其妙去检查某个陌生仓库的版本。
 *
 * 要发正式包就把 `package.json` 的 `updateGithubRepo` 填成 `owner/repo`
 * （临时验证也可以用环境变量 `UEBOX_UPDATE_GITHUB_REPO` 盖过它）。
 * 运行期由 src/main/services/updater/updateFeed.ts 读同一个字段。
 */
function resolveGithubRepo() {
  const fromEnv = process.env.UEBOX_UPDATE_GITHUB_REPO
  const fromPackage = require(path.join(projectRoot, 'package.json')).updateGithubRepo
  const raw = typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv : fromPackage
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null

  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(value)
  if (!match) {
    throw new Error(`updateGithubRepo must look like owner/repo, got: ${value}`)
  }
  return { owner: match[1], repo: match[2] }
}
const retryablePatterns = [
  /assistedInstaller\.nsh/i,
  /ERR_ELECTRON_BUILDER_CANNOT_EXECUTE/i,
  /could not find:\s*".*\\nst[0-9A-F]+\.tmp"/i
]

function resolveTempRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Temp', 'electron-builder')
  }
  return path.join(os.tmpdir(), 'electron-builder')
}

function resolveNsisCacheDir() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
  }
  return path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function clearPreviousUpdateArtifacts(dir) {
  if (!fs.existsSync(dir)) {
    return
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && updateArtifactMatchers.some((matcher) => matcher.test(entry.name))) {
      fs.rmSync(path.join(dir, entry.name), { force: true })
      console.log(`Removed stale updater artifact: ${entry.name}`)
    }
  }
}

function runBuilder(attempt) {
  ensureDir(tempRoot)

  const env = {
    ...process.env,
    TEMP: tempRoot,
    TMP: tempRoot,
    APP_BUILDER_TMP_DIR: tempRoot
  }

  console.log(`Running electron-builder for Windows (attempt ${attempt})...`)
  console.log(`Using temp directory: ${tempRoot}`)
  console.log(
    githubRepo
      ? `Using update feed: github:${githubRepo.owner}/${githubRepo.repo}`
      : 'No update feed configured; the package will not check for updates.'
  )

  const publishArgs = githubRepo
    ? [
        '-c.publish.provider=github',
        `-c.publish.owner=${githubRepo.owner}`,
        `-c.publish.repo=${githubRepo.repo}`,
        `-c.extraMetadata.updateGithubRepo=${githubRepo.owner}/${githubRepo.repo}`
      ]
    : []

  const result = spawnSync(
    process.execPath,
    [
      builderCli,
      '--win',
      ...publishArgs,
      // 透传调用方提供的打包参数。
      ...extraBuilderConfigArgs
    ],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }
  )

  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }

  return result
}

function isRetryableFailure(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  return retryablePatterns.some((pattern) => pattern.test(output))
}

function clearNsisCache() {
  if (!fs.existsSync(nsisCacheDir)) {
    return
  }
  fs.rmSync(nsisCacheDir, { recursive: true, force: true })
  console.warn(`Cleared NSIS cache: ${nsisCacheDir}`)
}

function exitWithResult(result) {
  if (result.error) {
    throw result.error
  }
  process.exit(typeof result.status === 'number' ? result.status : 1)
}

clearPreviousUpdateArtifacts(outputDir)

const firstResult = runBuilder(1)
if (!firstResult.error && firstResult.status === 0) {
  process.exit(0)
}

if (!isRetryableFailure(firstResult)) {
  exitWithResult(firstResult)
}

console.warn('Detected a retryable NSIS packaging failure. Clearing cache and retrying once...')
clearNsisCache()

const secondResult = runBuilder(2)
if (!secondResult.error && secondResult.status === 0) {
  process.exit(0)
}

exitWithResult(secondResult)
