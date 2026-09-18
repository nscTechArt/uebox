import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function requireNotarizationCredentials(env) {
  const present = (key) => typeof env[key] === 'string' && env[key].trim().length > 0
  const fields =
    present('APPLE_ID') || present('APPLE_APP_SPECIFIC_PASSWORD')
      ? ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
      : ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].some(present)
        ? ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
        : ['APPLE_KEYCHAIN_PROFILE']
  const missing = fields.filter((key) => !present(key))
  if (missing.length) throw new Error(`Mac notarization requires: ${missing.join(', ')}`)
}

/** Match Windows feed selection, without changing its installer or NSIS handling. */
export function macInstallerArgs(metadata, env = process.env) {
  const override = env.UEBOX_UPDATE_GITHUB_REPO
  const raw = typeof override === 'string' && override.trim() ? override : metadata.updateGithubRepo
  const repo = typeof raw === 'string' ? raw.trim() : ''
  const args = ['--mac', '--publish', 'never']
  if (env.UEBOX_MAC_NOTARIZE === '1') {
    requireNotarizationCredentials(env)
    args.push('-c.mac.notarize=true', '-c.mac.forceCodeSigning=true')
  }
  if (!repo) return args
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(repo)
  if (!match) throw new Error(`updateGithubRepo must look like owner/repo, got: ${repo}`)
  return [
    ...args,
    '-c.mac.publish.provider=github',
    `-c.mac.publish.owner=${match[1]}`,
    `-c.mac.publish.repo=${match[2]}`,
    `-c.extraMetadata.updateGithubRepo=${repo}`
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Build the Mac installer on macOS.')
  const require = createRequire(import.meta.url)
  const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const result = spawnSync(
    process.execPath,
    [require.resolve('electron-builder/cli.js'), ...macInstallerArgs(metadata)],
    { cwd: root, env: process.env, stdio: 'inherit' }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
