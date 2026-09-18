/**
 * uebox 命令行的安装状态与 PATH 开关。
 *
 * CLI 随安装包发（`electron-builder.yml` 的 `win.extraFiles` / `extraResources`，
 * 决定、§11），所以盒子这边只需要回答三件事：
 * 它在哪、在不在 PATH 里、以及能不能一键加进去。
 *
 * **默认什么都不做。** 装完不动用户的 PATH，界面上给出完整路径就够用了 ——
 * Agent 的配置里填绝对路径本来就是常态。加不加进 PATH 由用户点一下决定，
 * 再点一下能撤销。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { CliPathChangeResult, CliStatus } from '../../../shared/cli'
import { logger } from '../logger'
import { containsDir, readUserPath, withDir, withoutDir, writeUserPath } from './userPath'
import { macShellProfile, macPathEnabled, setMacPath } from './macUserPath'

/** 启动器的文件名，和 `build/uebox.cmd` 打进安装目录后的名字一致 */
const LAUNCHER = 'uebox.cmd'

/**
 * 找 `uebox.cmd`。
 *
 * 它跟 exe 放在同一层（`win.extraFiles`），所以从 exe 的目录去找。
 * 开发模式下这个文件不存在 —— 那是正常的，CLI 只随安装包发。
 */
function launcherPath(): string {
  if (process.platform === 'darwin') return join(process.resourcesPath, 'cli', 'bin', 'uebox')
  return join(dirname(app.getPath('exe')), LAUNCHER)
}

function shellProfile(): string {
  return macShellProfile(app.getPath('home'), process.env.SHELL || '/bin/zsh')
}

/**
 * 现在的状态。
 *
 * `onPath` 用 `null` 表示「没查出来」而不是 `false`：把「查不了」显示成
 * 「不在 PATH 里」，用户点了「加入」之后可能又失败一次，而他始终不知道
 * 真正的问题是读注册表失败。
 */
export async function cliStatus(): Promise<CliStatus> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return {
      available: false,
      path: null,
      directory: null,
      onPath: null,
      reason: 'CLI_UNSUPPORTED_PLATFORM'
    }
  }

  const path = launcherPath()
  if (!existsSync(path)) {
    return {
      available: false,
      path: null,
      directory: null,
      onPath: null,
      // 开发模式下最常见，说清楚免得以为是坏了
      reason: app.isPackaged
        ? '这次安装里没有找到命令行程序，重新安装一次虚幻盒子即可。'
        : '开发模式下没有命令行程序 —— 它只随安装包分发。'
    }
  }

  const directory = dirname(path)
  try {
    return {
      available: true,
      path,
      directory,
      onPath:
        process.platform === 'darwin'
          ? await macPathEnabled(shellProfile(), directory)
          : containsDir(await readUserPath(), directory)
    }
  } catch (error) {
    logger.warn('[CLI] 读取用户 PATH 失败:', error)
    return {
      available: true,
      path,
      directory,
      onPath: null,
      reason: `读不到当前的 PATH 设置：${(error as Error).message}`
    }
  }
}

/**
 * 把 CLI 目录加进用户 PATH。
 *
 * 幂等：已经在里面就什么都不做，也不报错 —— 用户点第二下不该多出一条重复项。
 */
export async function addToUserPath(): Promise<CliPathChangeResult> {
  const status = await cliStatus()
  if (!status.available || !status.directory) {
    return { ok: false, status, message: status.reason ?? '命令行程序不可用。' }
  }

  try {
    if (process.platform === 'darwin') {
      await setMacPath(shellProfile(), status.directory, true)
      return {
        ok: true,
        status: { ...status, onPath: true }
      }
    }
    const current = await readUserPath()
    const { value, changed } = withDir(current, status.directory)
    if (!changed)
      return { ok: true, status: { ...status, onPath: true }, message: '已经在 PATH 里了。' }

    await writeUserPath(value)
    logger.info('[CLI] 已把命令行目录加入用户 PATH')
    return { ok: true, status: { ...status, onPath: true } }
  } catch (error) {
    logger.error('[CLI] 写入用户 PATH 失败:', error)
    return { ok: false, status, message: `修改 PATH 失败：${(error as Error).message}` }
  }
}

/** 从用户 PATH 里摘掉 CLI 目录。只摘我们加的那一条，别的条目一律不动 */
export async function removeFromUserPath(): Promise<CliPathChangeResult> {
  const status = await cliStatus()
  if (!status.directory) {
    return { ok: false, status, message: status.reason ?? '命令行程序不可用。' }
  }

  try {
    if (process.platform === 'darwin') {
      await setMacPath(shellProfile(), status.directory, false)
      return { ok: true, status: { ...status, onPath: false } }
    }
    const current = await readUserPath()
    const { value, changed } = withoutDir(current, status.directory)
    if (!changed)
      return { ok: true, status: { ...status, onPath: false }, message: '本来就不在 PATH 里。' }

    await writeUserPath(value)
    logger.info('[CLI] 已把命令行目录从用户 PATH 移除')
    return { ok: true, status: { ...status, onPath: false } }
  } catch (error) {
    logger.error('[CLI] 移除用户 PATH 失败:', error)
    return { ok: false, status, message: `修改 PATH 失败：${(error as Error).message}` }
  }
}
