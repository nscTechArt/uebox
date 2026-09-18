import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zh from '../renderer/src/i18n/locales/zh-CN'
import en from '../renderer/src/i18n/locales/en-US'

const root = join(__dirname, '../..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

/**
 * 只留代码行，整行注释丢掉。
 *
 * 这个仓库的风格是**把删掉的东西记在原地**：`router/index.ts` 的注释里写着
 * 曾经的 `requiresAuth`，`ImportDiagnosticsService.ts` 的注释里写着被删掉的
 * `platformUserId` 上报。那些注释正是「这条已经没了」的证据 —— 把它们算成引用，
 * 等于「一写清楚就顶红」，会逼着后来的人删注释来过测试。
 *
 * 只认整行注释，不做完整词法分析：代码行里带 `//` 的多半是 URL 本身。
 * 与 `scripts/check-official-endpoints.mjs` 的 `stripLineComments` 同一个取舍。
 */
function codeLinesOf(source: string): string {
  let inBlock = false
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false
        return false
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true
        return false
      }
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

describe('open-source application boundaries', () => {
  it.each([
    'src/main/ipc/oauth.ts',
    'src/main/edition.ts',
    'src/main/services/authRefresh.ts',
    'src/shared/edition.ts',
    'src/shared/billing.ts',
    'src/renderer/src/api/profile.ts',
    'src/renderer/src/api/storage.ts',
    'src/renderer/src/common/edition.ts',
    'src/renderer/src/common/http/authFetch.ts',
    'src/renderer/src/store/modules/auth.ts',
    'src/renderer/src/store/modules/entitlementStore.ts',
    // 区域推导层：中文→cn / 英文→global。它服务的 `meta.cnOnly` 门禁早就删了，
    // 留着这个 store 等于把「按地区分功能」这个念头留在原地
    'src/renderer/src/store/modules/regionStore.ts',
    // 自动上传诊断包（打包日志 + 设备信息，开机还会重试）与它的重试缓存表
    'src/main/services/system/DiagnosticUploadService.ts',
    'src/main/sqliteDataBase/models/diagnosticUpload.ts',
    // 设备指纹：hostname + CPU 型号 + 内存 哈希成一个 deviceId，座席绑定的做法
    'src/main/services/system/DeviceInfoService.ts',
    // 「资产平台」中控：账号密码登录一个不在本仓库、也没开源的中央服务，
    // 拿回 nodes/vaults/folderGrants/teamRole 这套 ACL，再由主进程按它拦本地资产操作。
    // 配套还有审计日志、成员管理、节点认领的桌面端管理台。
    'src/main/network/AssetPlatformClient.ts',
    'src/main/network/AssetPlatformAccessGuard.ts',
    'src/main/network/PlatformAuthManager.ts',
    'src/main/ipc/assetPlatform.ts',
    'src/renderer/src/views/AssetManagement/components/AssetPlatformAdminPanel.vue',
    'src/renderer/src/views/AssetManagement/components/AssetPlatformConnectionModals.vue',
    'src/renderer/src/views/AssetManagement/composables/useAssetPlatformAccess.ts',
    'src/renderer/src/views/AssetManagement/utils/assetPlatformCapabilities.ts',
    'src/renderer/src/views/AssetManagement/utils/assetPlatformRuntimeAccess.ts',
    'src/main/ipc/deepResearch.ts',
    'src/main/ipc/deepResearchRoute.ts',
    'src/main/sqliteDataBase/ipc/jina.ts',
    'electron.vite.base.ts',
    'src/renderer/src/services/aiDefaults.ts',
    'scripts/blueprint-layout-llm-prototype.ts'
  ])('does not ship the removed platform module %s', (file) => {
    expect(existsSync(join(root, file))).toBe(false)
  })

  it.each(['src/preload/index.ts', 'src/preload/index.d.ts'])(
    'removes platform bridges while preserving user model authentication in %s',
    (file) => {
      const source = read(file)
      for (const removed of [
        'oauth:wechat:start',
        'oauth:epic:start',
        'uploadToS3',
        // 按名字封通道是漏的：`uploadToS3` 拦住了，同一条云上传路径改叫
        // `s3:uploadWithPresignedUrl` 就照样留在白名单里（主进程早就没有 handler 了）。
        // 所以这里连前缀一起封。
        's3:',
        'extractAndAnalyzeAudio',
        '@edition',
        'uebox-protocol'
      ]) {
        expect(source).not.toContain(removed)
      }
      expect(source).toContain('aiProvider')
    }
  )

  /**
   * preload 白名单里的每一条 invoke 通道，主进程都得真有 handler。
   *
   * 这条不是洁癖。白名单是**商业版功能被删之后最容易留下残骸的地方** ——
   * 界面和主进程都拆干净了，通道名还挂在那儿，看起来这个能力仍然存在。
   * `s3:uploadWithPresignedUrl` 就是这么活下来的。
   */
  it('does not keep invoke channels the main process no longer implements', () => {
    const preload = read('src/preload/index.ts')
    const listOf = (name: string): string[] => {
      const matched = preload.match(
        new RegExp(`${name}\\s*=\\s*new Set\\(\\s*\`([\\s\\S]*?)\``, 'm')
      )
      return matched ? matched[1].trim().split(/\s+/) : []
    }
    const channels = [...listOf('GENERIC_INVOKE_CHANNELS'), ...listOf('INVOKE_CHANNELS')]
    expect(channels.length).toBeGreaterThan(50)

    let mainSource = ''
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(next)
        else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name))
          mainSource += read(next)
      }
    }
    walk('src/main')

    expect(channels.filter((channel) => !mainSource.includes(channel))).toEqual([])
  })

  /**
   * 路由层不认账号，也不认地区。
   *
   * `requiresAuth` 曾经铺在 25 条路由上、`meta.cnOnly` 曾经挡住 AI 创作入口，
   * 而**没有任何守卫读过 `requiresAuth`** —— 它是商业版留下的挂载点，
   * 一个空字段，等着有人把认证逻辑接回去。
   */
  it('keeps the router free of auth and region gates', () => {
    for (const file of [
      'src/renderer/src/router/index.ts',
      'src/renderer/src/router/modules/index.ts',
      'src/renderer/src/router/modules/mainRoutes.ts',
      'src/renderer/src/router/modules/systemRoutes.ts',
      'src/renderer/src/types/router.ts'
    ]) {
      expect(codeLinesOf(read(file)), file).not.toMatch(
        /requiresAuth|cnOnly|commercialOnly|regionStore/
      )
    }
  })

  /**
   * 界面上不留推销与登录话术。
   *
   * 这条按**文案内容**查，不按 key 名查：`common.unlockFeatures` 这种键名看不出问题，
   * 值是「解锁高级生成功能」。上一版只查了 4 个顶层 key，于是它和
   * `pleaseLoginForAI`（请先登录后再使用AI功能）在两份语言包里一起活了下来。
   *
   * 「请先登录」这四个字本身**不算**违规 —— 百度网盘、用户自己的资产服务器都要登录，
   * 那是第三方的账号，是社区版正常的能力。这里认的是「登录/升级才能用**本应用的**功能」
   * 这个意思，所以匹配的是「登录后再使用」「解锁高级」这类搭配，不是「登录」两个字。
   */
  it.each([
    ['zh-CN', zh],
    ['en-US', en]
  ])('has no upsell or app-level sign-in copy in %s', (_name, locale) => {
    const offenders: string[] = []
    const forbidden =
      /解锁高级|解锁全部|升级到(专业|高级|Pro)|订阅会员|开通会员|会员专享|登录后再使用|登录才能使用|unlock advanced|unlock (all|premium)|upgrade to pro|log ?in (before|to) (use|using|unlock|access)|sign in to (use|unlock)|subscribe to (unlock|use)/i
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (forbidden.test(node)) offenders.push(`${path}: ${node}`)
        return
      }
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`))
      if (node && typeof node === 'object')
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key)
    }
    walk(locale, '')

    expect(offenders).toEqual([])
  })

  /**
   * 本地资产操作不许再被任何「权限层」拦住。
   *
   * 「资产平台」曾经在主进程给资产的增删改查装了 71 处 `ensureCurrentAssetPlatformCapability*`，
   * 权限不够就抛 `ASSET_PLATFORM_CAPABILITY_DENIED` —— 而那套 ACL 来自一个不在本仓库的
   * 中央服务。社区版的资产库是本机的东西，谁装谁就有全部权限。
   */
  it('does not gate local asset operations behind a permission service', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(next)
        else if (/\.(ts|vue)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
          if (
            /ASSET_PLATFORM_CAPABILITY_DENIED|ensureCurrentAssetPlatformCapability|isPlatformScoped|folderGrants/.test(
              codeLinesOf(read(next))
            )
          )
            offenders.push(next)
        }
      }
    }
    walk('src/main')
    walk('src/renderer/src')

    expect(offenders).toEqual([])
  })

  /** 诊断包只落本地，不许再长出上传、重试队列或设备指纹 */
  it('captures import diagnostics locally without uploading or fingerprinting', () => {
    const source = codeLinesOf(read('src/main/services/system/ImportDiagnosticsService.ts'))

    expect(source).not.toMatch(/axios|fetch\(|PlatformAuthManager|platformUserId|deviceId/)
    expect(source).not.toMatch(/flushPendingDiagnostics|DiagnosticUploadCache|os\.hostname/)
    expect(source).toContain('captureImportDiagnostic')
  })

  it('builds one application without extension hooks for an account shell', () => {
    for (const file of [
      'electron.vite.config.ts',
      'tsconfig.json',
      'tsconfig.node.json',
      'tsconfig.web.json',
      'vitest.config.ts'
    ]) {
      expect(read(file)).not.toMatch(/@edition|@community|VITE_EDITION|editionRoot/)
    }
  })

  it.each([zh, en])('does not include account, plan, purchase or share-link UI copy', (locale) => {
    for (const key of ['auth', 'subscription', 'team', 'lifetimeWelcomeModal'])
      expect(locale).not.toHaveProperty(key)
    for (const key of ['subscription', 'redemption', 'account', 'thirdPartyBindings'])
      expect(locale.profile).not.toHaveProperty(key)
    expect(locale.profile.asset).not.toHaveProperty('enableNetworkVaultLocked')
  })

  it('keeps media understanding on configured providers', () => {
    const source = read('src/main/ipc/vision.ts')
    expect(source).not.toMatch(/\/api\/ai\/|requireOfficialBaseUrl|editionMain/)
    expect(source).toContain('analyzeVideoWithConfiguredModel')
    expect(source).toContain('analyzeImageWithConfiguredModel')
  })

  it('does not bind image understanding to any single vendor', () => {
    /*
      图片理解曾经写死在某一家厂商的 Key 上：
      用户在设置里绑好了看得懂图的模型，只要没顺手申请那一家的 Key，
      截图分析 / 文档内嵌图 / 扫描版 PDF 三个功能全都不工作。这条盯着它不要回来。
    */
    const source = read('src/main/services/configuredImageAnalysis.ts')
    expect(source).not.toMatch(/alibaba|QWEN_API_KEY|dashscope/i)
    expect(source).toContain("resolveBinding({ role: 'vision', hasImages: true })")
  })

  it('does not request platform quota or purchase from notebook actions', () => {
    for (const file of [
      'src/renderer/src/views/Notebook/components/NoteSourcePanel.vue',
      'src/renderer/src/views/Notebook/components/NoteStudioPanel.vue'
    ]) {
      expect(read(file)).not.toMatch(/promptPurchase|useSubscriptionGuard/)
    }
    expect(read('src/main/services/webSearch.ts')).not.toContain('requireOfficialBaseUrl')
  })
})
