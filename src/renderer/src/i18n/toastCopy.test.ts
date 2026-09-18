import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => {
    if (value && typeof value === 'object' && part in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[part]
    }
    return undefined
  }, obj)
}

const bilingualToastKeys = [
  'page.home.engine.startSuccess',
  'assetLib.contextMenu.useAsReferenceSuccess',
  'assetLib.baiduyun.upload.error.api',
  'notebook.list.renameEmpty',
  'notebook.list.createWithNoteSuccess',
  'serverManagement.toast.vaultCreated',
  'assetManagement.dialog.apiUnavailable'
]

/**
 * 中文被当成 GBK 解码后的样子。
 *
 * ## 这是什么
 *
 * 源文件是 UTF-8，但某些工具（会把文件按系统代码页写回去的编辑器、批改脚本）
 * 会把它当 GBK 读写一遍。「重命名成功」这六个字的 UTF-8 字节被当成 GBK 解释，
 * 就变成了 `閲嶅懡鍚嶆垚鍔?` —— 代码照常编译、测试照常通过，只有用户会在界面上
 * 看到一串鬼画符。真机上已经发生过一次（`NotebookDetail.vue` 的重命名提示）。
 *
 * ## 为什么是一张字面量表，不是通用检测器
 *
 * 试过两种通用做法，都不成立：
 *
 *   - **按码位范围判**：乱码有 51% 落在 U+9000 以上，而正常中文也有 9.7%，
 *     分不开；
 *   - **按「语言包里没出现过的字」判**：全仓扫出 74 个误报，全是正常的中文注释
 *     （毛玻璃、防闪烁、磨砂玻璃、伤害倍率…）—— 注释用字本来就比 UI 文案宽。
 *
 * 真正可靠的判据是 GBK 往返（把疑似乱码按 GBK 编码回去、再按 UTF-8 解，
 * 能还原成通顺中文就是乱码），但 GBK 编解码要 `iconv-lite`，而它在本仓库只是
 * **传递依赖** —— 拿一条门禁去赌一个不归我们管的包，哪天别的依赖换版本就炸。
 *
 * 所以退回一张表：下面这些是本应用 toast 里最常出现的词被 GBK 解出来的**确切**
 * 样子（用 iconv-lite 离线生成，要重算就把这些词再跑一遍）。每条至少 3 个字符，
 * 在正常中文里不可能出现，误报为零。覆盖不全是它的代价 —— 但它盯的是真实的
 * 故障形态：一个写坏的提示文案。
 */
const MOJIBAKE = [
  '鎴愬姛', // 成功
  '澶辫触', // 失败
  '鍒犻櫎', // 删除
  '淇濆瓨', // 保存
  '鍔犺浇', // 加载
  '鍙栨秷', // 取消
  '閲嶅懡鍚', // 重命名
  '閿欒', // 错误
  '璇疯緭鍏', // 请输入
  '宸插鍒', // 已复制
  '宸叉坊鍔', // 已添加
  '宸叉洿鏂', // 已更新
  '涓嶈兘涓虹┖', // 不能为空
  '姝ｅ湪', // 正在
  '璇风◢鍊', // 请稍候
  '鏈壘鍒', // 未找到
  '宸插彇娑', // 已取消
  '澶嶅埗', // 复制
  '瀵煎叆', // 导入
  '瀵煎嚭', // 导出
  '涓婁紶', // 上传
  '涓嬭浇', // 下载
  '鍒涘缓', // 创建
  '璁剧疆', // 设置
  '鐭ヨ瘑', // 知识
  '璧勪骇', // 资产
  '椤圭洰', // 项目
  '宸ョ▼', // 工程
  '鏂囦欢', // 文件
  '鎻掍欢', // 插件
  '寮曟搸', // 引擎
  '妯″瀷', // 模型
  '浼氳瘽', // 会话
  '钃濆浘', // 蓝图
  '鏉愯川' // 材质
]

/** 全仓的源文件 */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|vue|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('Toast 文案', () => {
  it('关键提示在中英文语言包中都存在', () => {
    for (const key of bilingualToastKeys) {
      expect(get(zhCN, key), key).toBeTypeOf('string')
      expect(get(enUS, key), key).toBeTypeOf('string')
    }
  })

  it('中文反馈使用简短、面向用户的表达', () => {
    expect(zhCN.assetLib.baiduyun.upload.error.api).toBe('系统文件选择器不可用')
    expect(zhCN.assetLib.contextMenu.useAsReferenceSuccess).toBe('已添加为 AI 创作参考图')
    expect(zhCN.assetManagement.import.doneFallbackV1).toBe('远端同步已完成')
    expect(zhCN.vaultSwitcher.messages.adminKeySaved).toBe('管理员密钥已保存')
  })

  /*
   * 扫全仓，不是扫一张手写的文件清单。
   *
   * 原来这里列了 5 个文件 + 3 条字面量 —— 而真实的那次乱码就发生在**清单里的
   * 第一个文件**（`NotebookDetail.vue`），只因为它的乱码词不在那 3 条里，
   * 一路活到了评审。按文件列清单挡不住下一次，因为下一次一定在别的文件里。
   */
  it('全仓没有 GBK 乱码文案', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(resolve('src'))) {
      /*
       * **语言包必须扫。**
       *
       * 这里一度写着 `file.includes('locales') ||`，理由是「这张表就写在它旁边」——
       * 那句话是错的：表在 `i18n/toastCopy.test.ts`，后面那个 `endsWith` 已经把它
       * 排掉了。而 `locales/zh-CN.ts` 现在装着全应用五千条中文，是这类事故
       * 价值最高的目标：它被按系统代码页重写一次，界面上每一条提示都变成乱码，
       * 而门禁全绿。排除它挡住的误报是零条（这张表跑过两个语言包，0 命中）。
       */
      if (file.endsWith('toastCopy.test.ts')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        const hit = MOJIBAKE.find((pattern) => line.includes(pattern))
        if (hit) offenders.push(`${file}:${index + 1}  ${line.trim().slice(0, 80)}`)
      })
    }
    expect(offenders.join('\n'), offenders.join('\n')).toBe('')
  })

  it('不再硬编码英文 Toast', () => {
    const source = [
      'src/renderer/src/views/Notebook/NotebookDetail.vue',
      'src/renderer/src/views/AssetManagement/Baiduyun.vue',
      'src/renderer/src/views/AssetManagement/components/AssetFileList.vue',
      'src/renderer/src/views/Assistant/composables/agentStreamHandlers.ts',
      'src/renderer/src/views/Home/components/EngineSection.vue'
    ]
      .map((file) => readFileSync(resolve(file), 'utf8'))
      .join('\n')

    for (const obsoleteCopy of [
      'Added to AI Creation as reference',
      'Failed to open folder selection dialog'
    ]) {
      expect(source).not.toContain(obsoleteCopy)
    }
  })
})
