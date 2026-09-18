import { promises as fs } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const START = '\n# >>> Unreal Box CLI >>>\n'
const END = '# <<< Unreal Box CLI <<<\n'

export function macShellProfile(home: string, shell: string): string {
  const name = basename(shell || '/bin/zsh')
  if (name === 'zsh') return join(home, '.zprofile')
  if (name === 'bash') return join(home, '.bash_profile')
  throw new Error(
    `Automatic PATH setup supports zsh and bash; add the CLI directory to ${name} manually.`
  )
}

export function macPathBlock(directory: string): string {
  if (!directory || /[\r\n\0]/.test(directory)) throw new Error('Invalid CLI directory')
  const quoted = `'${directory.replace(/'/g, "'\\''")}'`
  return `${START}export PATH="$PATH":${quoted}\n${END}`
}

function managedBlock(content: string): string | null {
  const start = content.indexOf(START)
  if (start < 0) {
    if (content.includes('# >>> Unreal Box CLI >>>') || content.includes(END.trim())) {
      throw new Error('The Unreal Box PATH block was edited; please review it manually.')
    }
    return null
  }
  const end = content.indexOf(END, start)
  if (end < 0 || content.indexOf(START, start + START.length) >= 0) {
    throw new Error('The Unreal Box PATH block is incomplete or duplicated.')
  }
  const block = content.slice(start, end + END.length)
  if (!/^export PATH="\$PATH":'[^\n]*'\n$/.test(block.slice(START.length, -END.length))) {
    throw new Error('The Unreal Box PATH block was edited; please review it manually.')
  }
  return block
}

async function readProfile(profile: string): Promise<string> {
  try {
    return await fs.readFile(profile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function macPathEnabled(profile: string, directory: string): Promise<boolean> {
  return managedBlock(await readProfile(profile)) === macPathBlock(directory)
}

/** Only replace our marked block; preserve the user's shell configuration and symlink. */
export async function setMacPath(
  profile: string,
  directory: string,
  enabled: boolean
): Promise<void> {
  let target = profile
  try {
    target = await fs.realpath(profile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const link = await fs.lstat(profile).catch(() => null)
    if (link?.isSymbolicLink()) throw new Error('Shell profile is a dangling symlink')
  }
  const before = await readProfile(target)
  const block = managedBlock(before)
  const without = block ? before.replace(block, '') : before
  const after = enabled ? without + macPathBlock(directory) : without
  if (after === before) return
  const mode = (await fs.stat(target).catch(() => null))?.mode ?? 0o600
  const temporary = join(dirname(target), `.uebox-path-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, after, { flag: 'wx', mode })
    if ((await readProfile(target)) !== before)
      throw new Error('Shell profile changed; retry PATH setup.')
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
