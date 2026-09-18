import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const options = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 10 * 1024 * 1024 }

export interface MacEditorProcess {
  pid: number
  executable: string
  processName: string
}

/** comm identifies the executable, not a shell or helper merely mentioning the editor. */
export function parseMacEditorProcesses(output: string): MacEditorProcess[] {
  const result: MacEditorProcess[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const executable = match[2].trim()
    const processName = path.posix.basename(executable)
    if (!['UnrealEditor', 'UE4Editor'].includes(processName)) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    result.push({ pid, executable, processName })
  }
  return result
}

export async function listMacEditorProcesses(): Promise<MacEditorProcess[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,comm='], options)
  return parseMacEditorProcesses(stdout)
}

/**
 * ps flattens argv without restoring quotes. Strip the known executable first, then
 * retain spaces up to the project extension instead of splitting on whitespace.
 * Only a leading project argument or explicit -project= is accepted.
 */
export function extractMacProjectArgument(command: string, executable: string): string | null {
  let args = command.trim()
  const prefix = args.startsWith(`"${executable}"`) ? `"${executable}"` : executable
  if (
    !args.startsWith(prefix) ||
    (args.length > prefix.length && !/\s/.test(args[prefix.length]))
  ) {
    return null
  }
  args = args.slice(prefix.length).trim()
  const explicit = /(?:^|\s)-project=/i.exec(args)
  if (explicit) args = args.slice(explicit.index + explicit[0].length)
  else if (args.startsWith('-')) return null
  const quoted = /^(["'])(.*?)\1(?:\s|$)/.exec(args)
  if (quoted) return /\.uproject$/i.test(quoted[2]) ? quoted[2] : null
  return /^(.*?\.uproject)(?=\s|$)/i.exec(args)?.[1] ?? null
}

export async function getMacEditorProjects(): Promise<
  Array<MacEditorProcess & { projectPath: string }>
> {
  const projects: Array<MacEditorProcess & { projectPath: string }> = []
  for (const editor of await listMacEditorProcesses()) {
    try {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-ww', '-p', String(editor.pid), '-o', 'command='],
        options
      )
      const argument = extractMacProjectArgument(stdout, editor.executable)
      if (!argument) continue
      let projectPath = argument
      if (!path.posix.isAbsolute(projectPath)) {
        // Resolve relative arguments against the editor's cwd, never the box's cwd.
        const cwdResult = await execFileAsync(
          '/usr/sbin/lsof',
          ['-a', '-p', String(editor.pid), '-d', 'cwd', '-Fn'],
          options
        )
        const cwd = cwdResult.stdout
          .split('\n')
          .find((line) => line.startsWith('n/'))
          ?.slice(1)
        if (!cwd) continue
        projectPath = path.posix.resolve(cwd, projectPath)
      }
      if (!(await fs.stat(projectPath)).isFile()) continue
      projects.push({ ...editor, projectPath: path.posix.normalize(projectPath) })
    } catch {
      // A process may exit between ps and lsof; other editors must still be reported.
    }
  }
  return projects
}
