import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import {
  getMacEditorProjects,
  listMacEditorProcesses,
  type MacEditorProcess
} from './macUnrealProcesses'

const run = promisify(execFile)

export async function selectMacEditor(targetPath?: string): Promise<MacEditorProcess | null> {
  if (!targetPath) {
    const editors = await listMacEditorProcesses()
    return editors.length === 1 ? editors[0] : null
  }
  const target = await fs.realpath(targetPath).catch(() => null)
  if (!target) return null
  const matches: MacEditorProcess[] = []
  for (const editor of await getMacEditorProjects()) {
    const project = await fs.realpath(editor.projectPath).catch(() => null)
    if (project && (project === target || dirname(project) === target)) matches.push(editor)
  }
  return matches.length === 1 ? matches[0] : null
}

/** AppKit targets a PID directly and does not ask System Events to control the UI. */
export function macActivationScript(editor: MacEditorProcess): string {
  if (!Number.isSafeInteger(editor.pid) || editor.pid <= 0) throw new Error('Invalid editor PID')
  return [
    'ObjC.import("AppKit");',
    `var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${editor.pid});`,
    // Do not activate a different app if this PID was reused after process discovery.
    `var expected = ${JSON.stringify(editor.executable)};`,
    'if (app.isNil() || ObjC.unwrap(app.executableURL.path) !== expected) { false; }',
    'else { app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps); }'
  ].join('\n')
}

export async function activateMacEditor(targetPath?: string): Promise<boolean> {
  const editor = await selectMacEditor(targetPath)
  if (!editor) return false
  const { stdout } = await run(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', macActivationScript(editor)],
    {
      timeout: 2000,
      encoding: 'utf8'
    }
  )
  return stdout.trim() === 'true'
}
