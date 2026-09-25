/**
 * 重开编辑器之前，把「恢复未保存的包」那一步挪开。
 *
 * ## 那个窗口是怎么来的
 *
 * 编辑器定时把改过没存的包自动存一份到 `Saved/Autosaves/`，并在
 * `Saved/Autosaves/PackageRestoreData.json` 里记下哪些可以恢复。正常退出时这份
 * 记录被改成 `RestoreEnabled: false`；崩了就留着。下次启动，`FUnrealEdMisc::OnInit`
 * 看到它就在加载地图之前弹一个模态的「Restore Packages」窗口，**编辑器停在那里等人点**
 * —— 插件还没起来，盒子什么也做不了。
 *
 * ## 为什么不替用户点「恢复」
 *
 * 引擎的「恢复」是**拿自动存档覆盖磁盘上的原资产文件**（`PackageRestore.cpp`：
 * `IFileManager::Copy(包文件, 自动存档)`）。而这次崩溃多半就是 agent 做到一半的那一步
 * 弄出来的 —— 自动替用户把这份半成品写进工程，是替他做了一个撤不回来的决定。
 * 点「不恢复」也不行：引擎会把记录清掉，存档随后被新的自动保存轮换覆盖。
 *
 * 所以两边都不点：把记录和它指向的存档文件原样复制到
 * `Saved/UEBoxCrashRecovery/<时间>/Autosaves/`，再把原记录挪走。编辑器找不到记录就不弹，
 * 东西一样不丢。想恢复的时候把备份里的 `Autosaves` 拷回 `Saved/` 再开编辑器，
 * 引擎会照常弹出那个窗口，由用户自己挑。
 *
 * ## 编码
 *
 * 这个文件是 `TJsonWriter<TCHAR>` 直接写进 `FArchive` 的，每个字符两字节、**不带 BOM**
 * 的 UTF-16LE（真机文件开头是 `7b 00 0d 00`）。`decodeUeText` 只认带 BOM 的 UTF-16，
 * 所以这里先自己认一下。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { decodeUeText } from '../../utils/ueTextFile'

export interface StashedRestoreData {
  /** 备份所在目录（里面是一份 `Autosaves/` 的子集） */
  backupDir: string
  /** 记录里有几个包可以恢复 */
  packageCount: number
  /** 记录里有、但存档文件已经不在的那几个 */
  missingFiles: string[]
}

interface RestoreEntry {
  PackagePathName?: string
  AutoSavePath?: string
}

/** 首字符是 ASCII、第二个字节是 0 → 不带 BOM 的 UTF-16LE */
export function decodeRestoreJson(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] !== 0 && buffer[1] === 0) {
    return buffer.subarray(0, buffer.length - (buffer.length % 2)).toString('utf16le')
  }
  return decodeUeText(buffer)
}

/** 记录里可恢复的存档（相对 `Saved/Autosaves` 的路径）。记录关着、坏了、空的都返回空表 */
export function restorablePaths(json: string): string[] {
  let root: { RestoreEnabled?: unknown; Packages?: unknown }
  try {
    root = JSON.parse(json)
  } catch {
    return []
  }
  if (root.RestoreEnabled !== true || !Array.isArray(root.Packages)) return []
  return (root.Packages as RestoreEntry[])
    .map((entry) => (typeof entry?.AutoSavePath === 'string' ? entry.AutoSavePath : ''))
    .filter(Boolean)
}

function timestamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 有可恢复的包就备份并挪走记录；没有就什么都不做，返回 null。
 *
 * 存档路径来自引擎写的文件，照样防一手 `..`：只复制落在 `Autosaves` 里面的。
 */
export async function stashPackageRestoreData(
  projectDir: string,
  now: Date = new Date()
): Promise<StashedRestoreData | null> {
  const autosaveDir = path.join(projectDir, 'Saved', 'Autosaves')
  const recordPath = path.join(autosaveDir, 'PackageRestoreData.json')
  const raw = await fs.readFile(recordPath).catch(() => null)
  if (!raw) return null

  const entries = restorablePaths(decodeRestoreJson(raw))
  if (entries.length === 0) return null

  const backupDir = path.join(projectDir, 'Saved', 'UEBoxCrashRecovery', timestamp(now))
  const backupAutosaves = path.join(backupDir, 'Autosaves')
  await fs.mkdir(backupAutosaves, { recursive: true })

  const missingFiles: string[] = []
  for (const relative of entries) {
    const source = path.resolve(autosaveDir, relative)
    if (!source.startsWith(autosaveDir + path.sep)) continue
    const target = path.join(backupAutosaves, path.relative(autosaveDir, source))
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.copyFile(source, target)
    } catch {
      missingFiles.push(relative)
    }
  }

  // 记录最后挪：前面任何一步抛了，原记录还在，编辑器照旧弹窗 —— 退回到没有这个功能的样子
  await fs.copyFile(recordPath, path.join(backupAutosaves, 'PackageRestoreData.json'))
  await fs.rm(recordPath)

  return { backupDir, packageCount: entries.length, missingFiles }
}

/** 把备份的记录放回原位。存档文件本来就没动，只缺这一份记录 */
export async function unstashPackageRestoreData(
  projectDir: string,
  stashed: StashedRestoreData
): Promise<void> {
  await fs.copyFile(
    path.join(stashed.backupDir, 'Autosaves', 'PackageRestoreData.json'),
    path.join(projectDir, 'Saved', 'Autosaves', 'PackageRestoreData.json')
  )
}
