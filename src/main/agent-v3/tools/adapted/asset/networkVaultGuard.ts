/**
 * 网络库上的文件夹改名/删除，agent 不做。
 *
 * 界面上那两条路除了改数据库，还会**动网络路径上的真实目录**（重命名目录、
 * 删除目录），那段逻辑长在 IPC 处理器里，主进程这边的工具够不着。只改库不动目录
 * 的话，两边当场对不上：库里叫新名字、盘上还是旧目录；库里没了、盘上还在。
 *
 * 与其做一半，不如说清楚这件事得在界面里做 —— 半套操作留下的不一致，
 * 用户下一次扫描时才会发现，而那时已经说不清是谁弄的。
 */

import { getDatabaseManager } from '../../../../sqliteDataBase'
import { VaultType } from '../../../../sqliteDataBase/VaultManager'
import { getCurrentRemoteHttpVaultContext } from '../../../../networkV2/currentRemoteHttpVault'

/**
 * @returns 不能做时给出原因（直接回给模型），能做时 undefined
 */
export function folderWriteBlockReason(action: string): string | undefined {
  if (getCurrentRemoteHttpVaultContext()) {
    return `当前连的是远程资产服务器，${action}请在界面里操作 —— 服务端那边还要同步目录，这个工具只能改本地库。`
  }
  try {
    const vault = getDatabaseManager().getCurrentVault()
    if (vault?.vaultType === VaultType.NETWORK) {
      return `当前是网络保管库，${action}还要同时动网络路径上的真实目录，这个工具做不了 —— 请在界面里操作。`
    }
  } catch {
    // 取不到保管库信息时不拦：本地库是默认情况，拦了反而把正常场景挡在门外
  }
  return undefined
}
