/**
 * `uebox setup` —— 唯一默认允许交互的命令。
 *
 * 它做的事只有一件：**把 CLI 和本机某一份盒子配置关联起来**，并当场验证这个
 * 关联真的能用。之后 CLI 每次运行都去读那份文件。
 *
 * 三条不做的事：
 *   - 不复制令牌到 CLI 配置里（那会多一个会过期的真相）
 *   - 不修改盒子的任何配置（端口、令牌、开关、写权限都不动）
 *   - 找不到就说找不到，**不挑一个看着像的文件然后报成功**
 */

import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'

import { cliConfigPath, hostConfigCandidates, readHostConfig } from '../config.js'
import { writeCliConfig } from '../config.js'
import { connect } from '../connection.js'
import { UeboxError } from '../errors.js'
import { success, type Envelope } from '../envelope.js'

export interface SetupOptions {
  hostConfigPath?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** 终端可交互时才允许多选一。非交互环境（CI、被 Agent 调用）一律要求显式给路径 */
  interactive: boolean
  /** 多个候选时问用户选哪个。注入进来是为了能测 */
  choose?: (candidates: string[]) => Promise<string>
}

export async function runSetup(options: SetupOptions): Promise<Envelope> {
  const env = options.env ?? process.env
  const target = await pickHostConfig(options, env)

  // 先验证再落盘：连不上就保留之前那份能用的配置（§3.1）
  const host = await readHostConfig(target)
  const session = await connect(host)
  const capability = session.capability
  await session.close()

  const configPath = options.configPath ? resolve(options.configPath) : cliConfigPath(env)
  await writeCliConfig(configPath, { version: 1, hostConfigPath: target })

  return success({
    data: {
      configPath,
      hostConfigPath: target,
      url: host.url,
      // 令牌不打印、不保存。它在盒子那份配置里，CLI 每次去读
      contract: capability
        ? { supported: true, cliContractVersion: capability.cliContractVersion }
        : { supported: false, cliContractVersion: null },
      nextCommand: 'uebox doctor'
    },
    warnings: capability
      ? []
      : [
          '这个虚幻盒子还没有声明 CLI 契约。关联本身是成功的，但需要指定工程的命令用不了 —— 升级盒子即可。'
        ]
  })
}

/**
 * 定下要关联哪份盒子配置。
 *
 * 顺序：显式 `--host-config` → 已知候选位置里真实存在的那些。
 */
async function pickHostConfig(options: SetupOptions, env: NodeJS.ProcessEnv): Promise<string> {
  if (options.hostConfigPath) {
    const path = resolve(options.hostConfigPath)
    if (!(await exists(path))) {
      throw new UeboxError('CONFIG_MISSING', `--host-config 指向的文件不存在：${path}`)
    }
    return path
  }

  const candidates = hostConfigCandidates(env)
  const found: string[] = []
  for (const candidate of candidates) {
    if (await exists(candidate)) found.push(candidate)
  }

  if (found.length === 0) {
    throw new UeboxError(
      'CONFIG_MISSING',
      `在已知位置找不到虚幻盒子的配置。查过这些：\n  ${candidates.join('\n  ')}`,
      // 对外服务默认开着，所以「启动过一次」就足以写下这份配置 —— 别再叫用户
      // 去翻一个多半已经开着的开关，那只会让他在设置页里白找一圈
      '先启动一次虚幻盒子，它会写下这份配置；装在别处就用 ' +
        'uebox setup --host-config <路径> 指定。'
    )
  }

  if (found.length === 1) return found[0]

  // 开发版和正式版同时装着时会走到这里。**不替用户挑** —— 两个是不同的安装，
  // 各自有各自的令牌和端口，挑错了表现是「连上了但工程对不上」。
  if (!options.interactive || !options.choose) {
    throw new UeboxError(
      'CONFIG_INVALID',
      `找到 ${found.length} 份虚幻盒子配置，无法确定用哪一份：\n  ${found.join('\n  ')}`,
      '用 uebox setup --host-config <路径> 明确指定一份。'
    )
  }

  return options.choose(found)
}

async function exists(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}
