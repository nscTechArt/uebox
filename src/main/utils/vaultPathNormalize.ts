/**
 * normalizeVaultRelativePath — 路径归一化 helper
 *
 * 把不同来源存储的路径统一映射为"相对于 vault 根目录的规范化路径"。
 *
 * 真实库中 originPath/filePath 至少存在 4 种格式：
 *   1. 相对路径: "FolderA/model.uasset"
 *   2. vault 下绝对路径(Linux/NAS): "/nas/vault/FolderA/model.uasset"
 *   3. vault 下绝对路径(Windows UNC): "\\\\NAS\\share\\vault\\FolderA\\model.uasset"
 *   4. 客户端本地绝对路径: "D:\\Projects\\Content\\FolderA\\model.uasset" (与 vault 无关)
 *
 * 规范化规则：
 *   - 统一 \ 和 / 为 /
 *   - 转小写（用于对比）
 *   - 如果是 networkPath 下的绝对路径 → 提取相对部分
 *   - 如果是看起来就像相对路径（不含 volume/UNC 前缀） → 直接规范化
 *   - 无法映射到当前 vault → 返回 null
 */

/**
 * 把一条路径字符串统一为 "/" 分隔 + 小写
 */
function normSlashes(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * 是否像一个绝对路径（Windows 盘符 / UNC / Linux 根）
 */
function looksAbsolute(p: string): boolean {
  // Windows: C:\ or C:/
  if (/^[a-z]:[/\\]/i.test(p)) return true
  // UNC: \\server\share or //server/share
  if (/^[/\\]{2}/.test(p)) return true
  // Linux/Mac absolute
  if (p.startsWith('/')) return true
  return false
}

/**
 * 核心 API：把任意路径映射成 vault-relative 规范化路径。
 * 返回 null 表示"此路径无法被映射到当前 vault"。
 *
 * @param rawPath     原始路径（可能来自 filePath / originPath）
 * @param networkPath 当前 vault 根目录的绝对路径（如 /nas/vault 或 \\\\NAS\\share）
 */
export function normalizeVaultRelativePath(
  rawPath: string | null | undefined,
  networkPath: string
): string | null {
  if (!rawPath) return null
  const normed = normSlashes(rawPath.trim())
  if (!normed) return null

  const normedBase = normSlashes(networkPath)
  // 去掉末尾 /
  const base = normedBase.endsWith('/') ? normedBase.slice(0, -1) : normedBase

  if (!looksAbsolute(rawPath)) {
    // 已经是相对路径 → 直接用
    // 去掉可能的开头 ./
    const cleaned = normed.startsWith('./') ? normed.slice(2) : normed
    return cleaned || null
  }

  // 是绝对路径 → 尝试从 networkPath 前缀提取
  if (normed.startsWith(base + '/')) {
    const rel = normed.slice(base.length + 1) // +1 for the "/"
    return rel || null
  }

  // networkPath 本身可能完全等于 normed（没有子路径）
  if (normed === base) {
    return null // 指向 vault 根本身，没有实际文件
  }

  // 绝对路径但不在 networkPath 下 → 无法映射
  return null
}

/**
 * 从一个 assetData 行中提取最佳的 vault-relative path。
 * 优先使用 filePath → 再尝试 originPath → 都不行返回 null。
 *
 * @param row         DB 行（至少含 filePath / originPath）
 * @param networkPath vault 根目录绝对路径
 */
export function extractVaultRelativePath(
  row: { filePath?: string | null; originPath?: string | null },
  networkPath: string
): string | null {
  // 优先 filePath（通常是相对路径，最可靠）
  const fromFilePath = normalizeVaultRelativePath(row.filePath, networkPath)
  if (fromFilePath) return fromFilePath

  // 其次 originPath（可能是绝对路径，尝试提取相对部分）
  const fromOriginPath = normalizeVaultRelativePath(row.originPath, networkPath)
  if (fromOriginPath) return fromOriginPath

  return null
}

/**
 * ScannerFilter — 保管库扫描过滤器
 *
 * Option B（逻辑分类与物理目录解耦）语义核心落实：
 * 1. 文件夹 = 逻辑分类，不等于真正的物理存放路径。
 * 2. 扫描器 `performServerScan` 和 FileWatcher 只负责察觉物理文件的增、少、改。
 * 3. 扫描器绝对不能擅自根据物理分布重建已存在逻辑资产的父级文件夹归属。
 * 4. 用户如果在 UI 软删除逻辑树，遗留在物理根盘的老文件绝不能因为物理发现而复活到 `ALL`。
 *
 * 此类收集所有 `assetData`，依靠 `extractVaultRelativePath` 完美提炼真实物理相对路径。
 * 只要匹配上了提炼的路径，就意味着此物理文件已经受控（或被主观抛弃），严禁当成新文件导入！
 */
export class ScannerFilter {
  // Option B：通过提取真实相对路径来确认哪些物理文件已经是受控的
  private knownRelPaths = new Set<string>()
  // 记录出哪些已受控的文件实际上是被挂了 isDelete=1 打入冷宫的
  private softDeletedRelPaths = new Set<string>()

  /**
   * @param rows 所有存库的资产（无论 isDelete = 0 还是 1 的都要拿来提取物理身份）。
   * @param networkPath 当前系统分配的物理 Vault 绝对入口盘符
   */
  constructor(
    rows: { filePath?: string | null; originPath?: string | null; isDelete?: number }[],
    private networkPath: string
  ) {
    for (const row of rows) {
      const normed = extractVaultRelativePath(row, this.networkPath)
      if (normed) {
        this.knownRelPaths.add(normed)
        if (row.isDelete === 1) {
          this.softDeletedRelPaths.add(normed)
        }
      }
    }
  }

  /**
   * 阶段 2 去重防御机制：过滤出真正的毫无履历的“全新”物理文件
   * 必须严格将已知文件筛除。被筛除者，即表示：
   * - 它们曾经入库且仍活在某逻辑文件夹里（应走单文件更新 fileSize/uptime，保全原逻辑 folderKey）。
   * - 或是已经被主观软删，但物理残留，绝不能将他们重投胎到根目录。
   */
  public filterNewFiles<T extends { relativePath: string }>(scannedFiles: T[]): T[] {
    return scannedFiles.filter(
      (f) => !this.knownRelPaths.has(f.relativePath.replace(/\\/g, '/').toLowerCase())
    )
  }

  /**
   * 阶段 4 最终兜底拦截阀：针对单个物理文件是否应作为不可名状的禁忌文件。
   * 此方法多供部分漏到环节后端或 fileWatcher 的点射查询场景。
   */
  public isSoftDeleted(relativePath: string): boolean {
    const scanRelNormed = relativePath.replace(/\\/g, '/').toLowerCase()
    return this.softDeletedRelPaths.has(scanRelNormed)
  }

  public getKnownCount(): number {
    return this.knownRelPaths.size
  }
  public getSoftDeletedCount(): number {
    return this.softDeletedRelPaths.size
  }
}
