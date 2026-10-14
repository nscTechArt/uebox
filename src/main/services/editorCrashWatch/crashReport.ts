/**
 * 在磁盘上找「刚才那一次」崩溃留下的报告。
 *
 * 编辑器崩溃时写 `<工程>/Saved/Crashes/<GUID>/CrashContext.runtime-xml`
 * （`GenericPlatformCrashContext.cpp`：`ProjectSavedDir()/Crashes/<CrashGUID>`）。
 * 没带工程起来的编辑器、以及部分版本上报卡顿时，会落到
 * `%LOCALAPPDATA%/UnrealEngine/<版本>/Saved/Crashes` —— 那里混着所有工程的，
 * 只认 `GameName` 对得上的。
 *
 * 同一个目录里还有 ensure 和卡顿（Stall）的报告：编辑器照样活着，不算崩溃。
 * `AbnormalShutdown` 是进程没走崩溃处理就没了（任务管理器结束、断电），
 * 那多半是用户自己关的，也不算。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { decodeUeText } from '../../utils/ueTextFile'

export interface CrashSummary {
  /** 崩溃目录的绝对路径 */
  folder: string
  /** `Crash` / `Assert` / `GPUCrash` / `Hang` / `OutOfMemory` …，老版本可能是空的 */
  crashType: string
  errorMessage: string
  /** 调用栈的前几行，够模型认出是哪个模块 */
  callStackHead: string
  /** 崩溃目录的修改时间（毫秒） */
  time: number
}

const CALL_STACK_LINES = 8
const ERROR_MESSAGE_MAX = 600

/** CrashContext 里的 XML 实体还原。`getCrashLogs` 读同一个文件，也用这一份 */
export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&amp;/g, '&')
}

function tag(xml: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  return match ? decodeXml(match[1]).trim() : ''
}

/**
 * 这份报告是哪一类。只有 `fatal` 是编辑器真的崩了；其余三类同一个目录里也有，
 * 但编辑器还活着（ensure、卡顿）或者是被人结束的（abnormal_shutdown）。
 */
export type CrashKind = 'fatal' | 'ensure' | 'stall' | 'abnormal_shutdown'

export function crashKind(xml: string): CrashKind {
  if (tag(xml, 'IsEnsure').toLowerCase() === 'true') return 'ensure'
  switch (tag(xml, 'CrashType').toLowerCase()) {
    case 'ensure':
      return 'ensure'
    case 'stall':
      return 'stall'
    case 'abnormalshutdown':
      return 'abnormal_shutdown'
    default:
      return 'fatal'
  }
}

/** 取 CrashContext 里的一个字段（已还原 XML 实体、去掉首尾空白），没有就是空串 */
export function crashContextField(xml: string, name: string): string {
  return tag(xml, name)
}

/** 解析一份 CrashContext。是 ensure / 卡顿，或者 `GameName` 对不上，返回 null */
export function parseCrashContext(
  xml: string,
  expectGameName?: string
): Omit<CrashSummary, 'folder' | 'time'> | null {
  if (expectGameName && tag(xml, 'GameName').toLowerCase() !== expectGameName.toLowerCase()) {
    return null
  }
  const crashType = tag(xml, 'CrashType')
  if (crashKind(xml) !== 'fatal') return null

  const errorMessage = tag(xml, 'ErrorMessage')
  return {
    crashType,
    errorMessage:
      errorMessage.length > ERROR_MESSAGE_MAX
        ? `${errorMessage.slice(0, ERROR_MESSAGE_MAX)}…`
        : errorMessage,
    callStackHead: tag(xml, 'CallStack')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, CALL_STACK_LINES)
      .join('\n')
  }
}

async function subdirsNewerThan(
  dir: string,
  sinceMs: number
): Promise<Array<{ path: string; mtime: number }>> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const found: Array<{ path: string; mtime: number }> = []
  for (const name of names) {
    const full = path.join(dir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat?.isDirectory() && stat.mtimeMs >= sinceMs)
      found.push({ path: full, mtime: stat.mtimeMs })
  }
  return found
}

/** 引擎级的崩溃目录：`%LOCALAPPDATA%/UnrealEngine/<版本>/Saved/Crashes` */
async function engineLevelCrashDirs(): Promise<string[]> {
  const base = process.env.LOCALAPPDATA
  if (!base) return []
  const root = path.join(base, 'UnrealEngine')
  const versions = await fs.readdir(root).catch(() => [] as string[])
  return versions.map((version) => path.join(root, version, 'Saved', 'Crashes'))
}

/**
 * `sinceMs` 之后出现的、最新的一份致命崩溃报告。没有返回 null。
 *
 * @param projectDir 工程根目录（`.uproject` 所在的文件夹）
 * @param projectName 工程名，用来在引擎级目录里认出这个工程的（`GameName` = `UE-<工程名>`）
 */
export async function findFreshCrash(
  projectDir: string,
  projectName: string,
  sinceMs: number
): Promise<CrashSummary | null> {
  const candidates: Array<{ path: string; mtime: number; gameName?: string }> = []
  for (const entry of await subdirsNewerThan(path.join(projectDir, 'Saved', 'Crashes'), sinceMs)) {
    candidates.push(entry)
  }
  for (const dir of await engineLevelCrashDirs()) {
    for (const entry of await subdirsNewerThan(dir, sinceMs)) {
      candidates.push({ ...entry, gameName: `UE-${projectName}` })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  for (const candidate of candidates) {
    const raw = await fs
      .readFile(path.join(candidate.path, 'CrashContext.runtime-xml'))
      .catch(() => null)
    if (!raw) continue
    const parsed = parseCrashContext(decodeUeText(raw), candidate.gameName)
    if (parsed) return { ...parsed, folder: candidate.path, time: candidate.mtime }
  }
  return null
}
