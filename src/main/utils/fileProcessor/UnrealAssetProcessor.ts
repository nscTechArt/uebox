import { promises as fs } from 'fs'
import { join, dirname, basename, extname } from 'path'
import { v4 as uuidv4 } from 'uuid'
import { accessSync, copyFileSync } from 'fs'
import fse from 'fs-extra'
import { BaseFileProcessor, FileMetadata } from './BaseFileProcessor'
import { analyzeFromFile } from '../uasset-reader-new'
import { PathManager } from '../PathManager'
import { getSharp } from '../sharpLoader'

/**
 * 红蓝对调的重组矩阵。
 *
 * 以前这一步是「metadata() 解一次 → raw() 再解一次 → JS 里逐像素换通道 → 重编码一次
 * → jpeg() 又解一次再编一次」，一张缩略图 3 次解码 2 次编码外加一个逐像素循环。
 * 交给 sharp 的 recomb 之后是解一次编一次，实测 9.3ms/张 降到 4.9ms/张，
 * 在 189 张真实缩略图和 RGB/RGBA/灰度/JPEG 四种输入上逐像素比对，差值为 0。
 */
const SWAP_RED_AND_BLUE: [
  [number, number, number],
  [number, number, number],
  [number, number, number]
] = [
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0]
]

/**
 * 虚幻引擎资产处理器
 */
// uproject JSON 类型声明
export interface UProjectJSON {
  EngineAssociation: string

  Category: string
  Description: string
  Modules: any[]
  Plugins: any[]
  TargetPlatforms: string[]
  EpicSampleContentPrivacy: string
}

export class UnrealAssetProcessor extends BaseFileProcessor {
  private softPathCache: Map<string, string> = new Map()
  private gamePathRegex = /\/Game\/[^.]+/
  private pathManager: PathManager

  // uproject 类型化结构（与 UE 官方字段保持一致，字段尽量可选）
  private static readonly EMPTY_UPROJECT: UProjectJSON = {
    EngineAssociation: '',

    Category: '',
    Description: '',
    Modules: [],
    Plugins: [],
    TargetPlatforms: [],
    EpicSampleContentPrivacy: ''
  }

  constructor() {
    super()
    this.pathManager = PathManager.getInstance()
    this.ensureThumbnailsDirectory()
  }

  // uproject JSON 类型声明
  private normalizeUprojectJson(json: any): UProjectJSON {
    if (!json || typeof json !== 'object') return { ...UnrealAssetProcessor.EMPTY_UPROJECT }
    return {
      EngineAssociation: String(json.EngineAssociation ?? ''),

      Category: String(json.Category ?? ''),
      Description: String(json.Description ?? ''),
      Modules: Array.isArray(json.Modules) ? json.Modules : [],
      Plugins: Array.isArray(json.Plugins) ? json.Plugins : [],
      TargetPlatforms: Array.isArray(json.TargetPlatforms) ? json.TargetPlatforms : [],
      EpicSampleContentPrivacy: String(json.EpicSampleContentPrivacy ?? '')
    }
  }

  // 解析并类型化 uproject 文件
  private async parseUproject(filePath: string): Promise<UProjectJSON> {
    const raw = await this.readJSONFile(filePath)
    return this.normalizeUprojectJson(raw)
  }

  /**
   * 确保缩略图目录存在
   */
  private async ensureThumbnailsDirectory(): Promise<void> {
    // 保证保管库级与公共级缩略图目录均存在（资产缩略图走保管库，项目信息走公共）
    const vaultThumbs = this.pathManager.getThumbnailsPath()
    const publicThumbs = this.pathManager.getPublicThumbnailsPath()
    try {
      await fs.access(vaultThumbs)
    } catch {
      await fs.mkdir(vaultThumbs, { recursive: true })
    }
    try {
      await fs.access(publicThumbs)
    } catch {
      await fs.mkdir(publicThumbs, { recursive: true })
    }
  }

  /**
   * 修复中文编码问题 - 处理UTF-16编码
   */
  private fixChineseEncoding(text: string): string {
    if (!text) return text

    try {
      // 检查是否是UTF-16编码（包含很多\x00字节）
      if (text.includes('\x00')) {
        // 创建Buffer并尝试UTF-16LE解码
        const buffer = Buffer.from(text, 'binary')
        const decoded = buffer.toString('utf16le')

        // 移除可能残留的空字节
        return decoded.replace(/\0/g, '')
      }

      // 如果不包含空字节，直接返回
      return text
    } catch (error) {
      console.warn('UTF-16解码失败:', error)
      // 回退到简单的空字节移除
      return text.replace(/\0/g, '')
    }
  }

  /**
   * 获取支持的文件扩展名
   */
  getSupportedExtensions(): string[] {
    return ['uasset', 'umap', 'ubulk', 'uexp', 'uplugin', 'uproject']
  }

  /**
   * 处理虚幻引擎资产文件
   */
  async processFile(filePath: string): Promise<FileMetadata> {
    const basicInfo = await this.getBasicFileInfo(filePath)

    try {
      // ... (uplugin 和 uproject 处理保持不变)
      // 处理 .uplugin 文件
      if (basicInfo.fileExtension === 'uplugin') {
        const pluginData = await this.processUplugin(filePath)
        return pluginData as FileMetadata
      }

      // 处理 .uproject 文件
      if (basicInfo.fileExtension === 'uproject') {
        const projectData = await this.processUproject(filePath)
        return projectData as FileMetadata
      }

      // 只处理 .uasset 和 .umap 文件
      if (basicInfo.fileExtension !== 'uasset' && basicInfo.fileExtension !== 'umap') {
        // ... (保持不变)
        return {
          ...basicInfo,
          processorType: 'UnrealAsset',
          assetType: this.getAssetTypeFromExtension(basicInfo.fileExtension!),
          metadata: {
            note: '非uasset/umap/uplugin/uproject文件，暂未解析详细元数据'
          }
        } as FileMetadata
      }

      // 使用流式读取解析
      const result = await analyzeFromFile(filePath, {
        saveHexView: false
      })

      if (result instanceof Error || result.stack) {
        // ... (保持不变)
        return {
          ...basicInfo,
          processorType: 'UnrealAsset',
          assetType: 'InvalidAsset',
          metadata: {
            error: `uasset解析失败: ${result.message || '解析失败'}`,
            note: '文件可能不是有效的虚幻引擎资产文件'
          }
        } as FileMetadata
      }

      // 标准化虚幻资产信息
      const normalizedData = await this.normalizeUassetInfo(result, filePath)

      // ⚠️ 关键修改：将原始解析结果 (result) 挂载到 metadata._rawData 字段
      // 这样 AssetDependencyResolver 就可以访问 header, names 等原始数据
      // 注意：这可能会增加内存消耗，如果不需要持久化存储，可以在使用后删除
      // 或者我们可以只挂载需要的字段

      // 为了安全起见，我们只挂载需要的核心字段，避免循环引用或过大
      const rawDataForDependencyResolver = {
        header: result.header,
        names: result.names,
        gatherableTextData: result.gatherableTextData
      }

      return {
        ...basicInfo,
        processorType: 'UnrealAsset',
        assetType: normalizedData.className || this.determineAssetType(result),
        engineVersion: normalizedData.engineVersion,
        metadata: {
          ...normalizedData,
          _rawData: rawDataForDependencyResolver // 暴露原始数据
        }
      } as FileMetadata
    } catch (error) {
      // ... (保持不变)
      console.warn(`处理虚幻资产文件失败 ${filePath}:`, error)

      // 即使解析失败，也返回基本信息，不抛出错误
      return {
        ...basicInfo,
        processorType: 'UnrealAsset',
        assetType: 'InvalidAsset',
        metadata: {
          error: `解析失败: ${error instanceof Error ? error.message : String(error)}`,
          note: '文件可能不是有效的虚幻引擎资产文件'
        }
      } as FileMetadata
    }
  }

  /**
   * 标准化虚幻资产信息（仿造file-processor.js的normalizeUassetInfo方法）
   */
  private async normalizeUassetInfo(
    assetInfo: any,
    filePath: string
  ): Promise<Record<string, any>> {
    const { header, imports = [], softPackageReferences = [] } = assetInfo

    const baseName =
      filePath
        .split(/[\\\/]/)
        .pop()
        ?.replace(/\.[^.]*$/, '') || ''
    const fileExtension = filePath.split('.').pop()?.toLowerCase() || ''

    // 路径解析核心逻辑
    const softPath = this.getSoftPath(assetInfo, baseName, filePath)

    const assetClass = this.extractAssetClass(softPath)

    // 合并导入数据（强/弱引用分类）
    const refs = this.collectReferences(imports.Imports || [], softPackageReferences, softPath)
    const processedImports = refs.all

    // 构建标准化对象
    // className 优先从缩略图获取，如果没有则从 exports/imports 中解析
    const thumbnailClassName = assetInfo.thumbnails?.Index?.map((i: any) => i.AssetClassName).join(
      ', '
    )
    const resolvedClassName = thumbnailClassName || this.determineAssetType(assetInfo)

    const normalized = {
      assetKey: uuidv4(),
      classKey: fileExtension === 'umap' ? 'umap' : 'uasset', // 根据文件扩展名设置 classKey
      name: baseName,
      originPath: filePath,
      ext: fileExtension,

      // 重构字段
      engineVersion: this.simplifyVersion(header?.CompatibleWithEngineVersion),
      folderName: header?.FolderName,
      softPath,
      assetClass,

      // 转换字段 - 使用解析后的类名
      className: resolvedClassName,
      imports: processedImports,
      importsStrong: refs.strong,
      importsSoft: refs.soft,

      // 保留字段
      assetConfig: '',
      assetConfigPath: '',
      size: assetInfo.size || 0,
      imgLocalPath: ''
    }

    // 缩略图处理（保持异步）
    if (assetInfo.thumbnails?.Thumbnails?.[0]) {
      normalized.imgLocalPath = await this.saveFirstThumbnailToElectronPath(assetInfo)
    }

    // 清理不需要的字段
    return this.deepClean(normalized)
  }

  /**
   * 获取软路径（仿造file-processor.js的getSoftPath方法）
   */
  private getSoftPath(result: any, basename: string, realPath: string): string {
    // 缓存键用文件真实路径 —— 它才唯一标识「正在解析的这个文件」。
    // 原来是「包 Guid_文件名」，而 UE5 的包文件已经不带 Guid 了（读取器明确跳过），
    // 于是所有 UE5 资产的键都退化成 `undefined_<文件名>`：同一次导入里两个不同目录
    // 的同名资产，第二个直接命中第一个的缓存，拿到**别人的 softPath**。
    // 而同名资产在 UE 工程里是常态。
    const cacheKey = realPath || `${result?.header?.Guid}_${basename}`
    const endsWith = '/' + basename

    // 缓存检查
    if (this.softPathCache.has(cacheKey)) {
      return this.softPathCache.get(cacheKey)!
    }

    let softPath = ''
    const pathDerivedSoftPath = this.deriveSoftPathFromRealPath(realPath)

    try {
      // 第一步：优先尝试 FolderName
      if (result.header) {
        const originalPath = result.header.FolderName
        softPath = this.fixChineseEncoding(originalPath)

        if (softPath && softPath.startsWith('/Game') && softPath.endsWith(endsWith)) {
          this.softPathCache.set(cacheKey, softPath)
          return softPath
        }
      }

      // 第二步：名称查找优化
      if (basename && Array.isArray(result.names)) {
        for (const nameObj of result.names) {
          const originalName = nameObj.Name
          const name = this.fixChineseEncoding(originalName)
          if (name && name.endsWith(endsWith) && name.startsWith('/Game')) {
            softPath = name
            break
          }
        }
        if (softPath && softPath.startsWith('/Game') && softPath.endsWith(endsWith)) {
          this.softPathCache.set(cacheKey, softPath)
          return softPath
        }
      }

      // 第三步：双重循环优化
      outerLoop: if (Array.isArray(result.gatherableTextData)) {
        for (const item of result.gatherableTextData) {
          for (const context of item.SourceSiteContexts) {
            const originalDesc = context.SiteDescription
            const desc = this.fixChineseEncoding(originalDesc)
            if (desc && desc.startsWith('/Game') && desc.endsWith(endsWith)) {
              const match = desc.match(this.gamePathRegex)
              if (match) {
                softPath = match[0]
                break outerLoop
              }
            }
          }
        }
      }
      if (softPath && softPath.startsWith('/Game') && softPath.endsWith(endsWith)) {
        this.softPathCache.set(cacheKey, softPath)
        return softPath
      }

      // 对于位于 Unreal Content/备份 Game 目录下的资产，磁盘路径仅作为 fallback
      if (pathDerivedSoftPath && pathDerivedSoftPath.endsWith(endsWith)) {
        this.softPathCache.set(cacheKey, pathDerivedSoftPath)
        return pathDerivedSoftPath
      }

      // 第四步：路径处理优化
      const contentIndex = realPath.indexOf('Content')
      if (contentIndex !== -1) {
        const relativePath = realPath.slice(contentIndex + 7).replace(/\\/g, '/')
        const rawSuffix = relativePath.replace(/\.[^.]*$/, '').replace(/^\/+/, '')
        const normalizedSuffix = this.normalizePackageLikeSuffix(rawSuffix)
        softPath = normalizedSuffix ? `/Game/${normalizedSuffix}` : ''
      }

      // 最终回退方案
      this.softPathCache.set(cacheKey, softPath || '')
    } catch (e) {
      console.error('Error in getSoftPath:', e)
    }

    return softPath
  }

  private deriveSoftPathFromRealPath(realPath: string): string {
    if (!realPath || typeof realPath !== 'string') return ''

    const normalizedPath = this.fixChineseEncoding(realPath).replace(/\\/g, '/')
    const withoutExt = normalizedPath.replace(/\.[^.\/]+$/, '')
    const markers = ['/Content/', '/Game/']

    for (const marker of markers) {
      const markerIndex = withoutExt.lastIndexOf(marker)
      if (markerIndex === -1) continue

      const rawSuffix = withoutExt.slice(markerIndex + marker.length).replace(/^\/+/, '')
      const suffix = this.normalizePackageLikeSuffix(rawSuffix)
      if (!suffix) continue

      return marker === '/Content/' ? `/Game/${suffix}` : `/${suffix}`
    }

    return ''
  }

  private normalizePackageLikeSuffix(suffix: string): string {
    const segments = suffix.split('/').filter(Boolean)
    if (segments.length >= 2 && segments[segments.length - 1] === segments[segments.length - 2]) {
      segments.splice(segments.length - 2, 1)
    }
    return segments.join('/')
  }

  /**
   * 从 exports 和 imports 中提取资产类型
   * 逻辑：主导出（exports[0]）的 classIndex 如果为负数，则指向 imports 表中的类
   * 注意：imports 中的 className 是元类（如 "Class"），objectName 才是实际类名（如 "StaticMeshActor"）
   */
  private determineAssetType(result: any): string {
    try {
      const exports = result?.exports
      const imports = result?.imports?.Imports

      if (!exports || exports.length === 0) {
        return 'Asset'
      }

      const mainExport = exports[0]
      const classIndex = mainExport?.classIndex

      // classIndex < 0 表示指向 Imports 表（负索引：-1 对应 imports[0]）
      if (classIndex !== undefined && classIndex < 0 && imports) {
        const importIdx = Math.abs(classIndex) - 1
        const imp = imports[importIdx]
        // 使用 objectName 而不是 className
        // className 是元类（如 "Class"），objectName 才是实际的类名（如 "StaticMeshActor"）
        if (imp?.objectName) {
          return imp.objectName
        }
      }

      // classIndex === 0 表示原生类（无法获取具体类名）
      // classIndex > 0 表示指向 Exports 表（自引用，较少见）

      return 'Asset'
    } catch (error) {
      console.warn('determineAssetType 解析失败:', error)
      return 'Asset'
    }
  }

  /**
   * 合并导入数据
   */

  /**
   * 收集与分类资产引用（强引用 Imports 与弱引用 SoftPackageReferences）
   *
   * 返回：
   * - strong: 过滤后的强引用路径
   * - soft: 过滤后的软引用路径
   * - all: strong ∪ soft（去重合并）
   */
  private collectReferences(
    imports: Array<{ objectName?: string; packageName?: string; classPackage?: string }>,
    packageRefs: Array<{ assetPathName?: string }>,
    selfSoftPath?: string
  ): { strong: string[]; soft: string[]; all: string[] } {
    // DEBUG: 验证 imports 结构 - 查看 objectName vs packageName
    if (imports.length > 0) {
      console.log('[DEBUG collectReferences] imports 样本 (前5条):')
      imports.slice(0, 5).forEach((imp: any, idx) => {
        console.log(
          `  [${idx}] objectName: "${imp?.objectName}" | packageName: "${imp?.packageName}" | classPackage: "${imp?.classPackage}"`
        )
      })
    }

    const normalize = (p: string | undefined): string => {
      if (!p) return ''
      const s = this.fixChineseEncoding(p)
      // 移除后缀 .xxx
      return s
        .replace(/\0/g, '')
        .trim()
        .replace(/\.[^.]*$/, '')
    }

    const isUserPath = (p: string): boolean => p.startsWith('/Game/')
    const isEnginePath = (p: string): boolean =>
      p.startsWith('/Engine/') || p.startsWith('/Script/')

    const strongSet = new Set<string>()
    for (const imp of imports) {
      const candidates = [normalize(imp?.objectName), normalize(imp?.packageName)].filter(Boolean)

      for (const name of candidates) {
        if (isEnginePath(name)) continue
        if (!name.includes('/')) continue
        if (isUserPath(name)) {
          if (selfSoftPath && name === selfSoftPath) continue
          strongSet.add(name)
        }
      }
    }

    const softSet = new Set<string>()
    for (const ref of packageRefs || []) {
      const path = normalize(ref?.assetPathName)
      if (!path) continue
      if (isEnginePath(path)) continue
      if (isUserPath(path)) {
        if (selfSoftPath && path === selfSoftPath) continue
        softSet.add(path)
      }
    }

    const all = new Set<string>([...strongSet, ...softSet])
    return { strong: Array.from(strongSet), soft: Array.from(softSet), all: Array.from(all) }
  }

  /**
   * 分类提取
   */
  private extractAssetClass(softPath: string): string {
    return softPath.split('/')[2] || ''
  }

  /**
   * 简化版本信息
   */
  private simplifyVersion(versionStr: string | undefined): string {
    try {
      if (!versionStr || typeof versionStr !== 'string') {
        return 'unknown'
      }

      const versionMatch = versionStr.match(/(\d+\.\d+\.\d+|\d+\.\d+)/)
      return versionMatch ? versionMatch[0] : versionStr.slice(0, 15)
    } catch (error) {
      return 'unknown'
    }
  }
  /**
   * 保存第一个缩略图到本地路径（仿造file-processor.js的saveFirstThumbnailToElectronPath方法）
   */
  private async saveFirstThumbnailToElectronPath(assetInfo: any): Promise<string> {
    const thumbnails = assetInfo.thumbnails ? assetInfo.thumbnails.Thumbnails : []
    if (!thumbnails || thumbnails.length === 0 || !thumbnails[0].ImageData) {
      return ''
    }

    const firstThumbnail = thumbnails[0]
    const imageData = firstThumbnail.ImageData

    if (!imageData[0]) {
      return ''
    }

    const imageFormat = firstThumbnail.ImageFormat.toLowerCase()
    const name = assetInfo?.assetKey ?? uuidv4()

    // 生成文件名和路径
    const fileName = `thumbnail-${name}.${imageFormat}`
    const filePath = this.pathManager.getThumbnailFilePath(fileName)

    // 等待文件保存完成，确保后续 existsSync 检查能找到文件
    try {
      await this.saveImageAsync(imageData, filePath)
    } catch (err) {
      console.error('缩略图保存失败:', err)
      return '' // 保存失败则不设置 imgLocalPath
    }

    return fileName
  }

  /**
   * 异步保存图像
   */
  private async saveImageAsync(imageData: number[], filePath: string): Promise<string> {
    try {
      // 检查文件是否已存在
      await fs.access(filePath)
      return filePath
    } catch {
      const sharp = await getSharp()
      // UE 的缩略图是 BGRA，红蓝通道要对调
      await sharp(Buffer.from(imageData)).recomb(SWAP_RED_AND_BLUE).jpeg().toFile(filePath)
      return filePath
    }
  }

  /**
   * 深度清理方法（仿造file-processor.js的deepClean方法）
   */
  private deepClean(obj: Record<string, any>): Record<string, any> {
    const cleaned = { ...obj }

    // 字段删除清单
    const REMOVE_KEYS = [
      'thumbnails',
      'Guid',
      'savedByEngineVersion',
      'compatibleWithEngineVersion',
      'names',
      'gatherableTextData'
    ]

    // 条件删除
    if (cleaned.type === 'UASSET') delete cleaned.assetClass
    if (cleaned.folderName === 'None') delete cleaned.folderName

    // 默认值清理
    const DEFAULTS = new Map([
      ['softPackageReferences', []],
      ['imports', []]
    ])

    DEFAULTS.forEach((defaultVal, key) => {
      if (JSON.stringify(cleaned[key]) === JSON.stringify(defaultVal)) {
        delete cleaned[key]
      }
    })

    REMOVE_KEYS.forEach((key) => delete cleaned[key])
    return cleaned
  }

  /**
   * 根据文件扩展名获取资产类型
   */
  private getAssetTypeFromExtension(extension: string): string {
    const typeMap: Record<string, string> = {
      uasset: 'Asset',
      umap: 'Map',
      ubulk: 'BulkData',
      uexp: 'ExportData',
      uplugin: 'Plugin',
      uproject: 'Project'
    }
    return typeMap[extension] || 'Unknown'
  }

  /**
   * 读取JSON文件（支持处理多种 BOM 编码）
   */
  private async readJSONFile(filePath: string): Promise<any> {
    try {
      const buffer = await fs.readFile(filePath)

      // 检测并移除 BOM
      let data: string

      // UTF-8 BOM: EF BB BF
      if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        // UTF-8 BOM 检测
        data = buffer.toString('utf8', 3) // 从第3个字节开始读取
      }
      // UTF-16 LE BOM: FF FE
      else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        // UTF-16 LE BOM 检测
        data = buffer.toString('utf16le', 2)
      }
      // UTF-16 BE BOM: FE FF
      else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        // UTF-16 BE BOM 检测
        data = buffer.toString('utf8')
      }
      // 无 BOM
      else {
        data = buffer.toString('utf8')
      }

      // 额外保险：移除字符串开头的 BOM 字符（U+FEFF）
      if (data.charCodeAt(0) === 0xfeff) {
        data = data.substring(1)
      }

      // 移除首尾空白字符
      data = data.trim()

      return JSON.parse(data)
    } catch (error) {
      console.error(`读取JSON文件失败 [${filePath}]:`, error)
      console.error(`错误详情: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * 获取插件缩略图
   */
  private getPluginThumbnail(filePath: string): string {
    try {
      const thumbnail = join(dirname(filePath), 'Resources', 'Icon128.png')
      accessSync(thumbnail)
      const fileName = 'thumbnail-' + uuidv4() + extname(thumbnail)
      const targetPath = this.pathManager.getPublicThumbnailFilePath(fileName)
      copyFileSync(thumbnail, targetPath)
      return fileName
    } catch {
      return ''
    }
  }

  /**
   * 格式化市场链接URL
   */
  private formatMarketplaceURL(url?: string): string {
    if (!url) return ''
    // 如果已经是完整URL，直接返回
    if (url.startsWith('http')) return url
    // 如果是相对路径或ID，构建完整的市场链接
    return `https://www.unrealengine.com/marketplace/product/${url}`
  }

  /**
   * 处理.uplugin文件
   */
  private async processUplugin(filePath: string): Promise<Record<string, any>> {
    const pluginInfo = await this.readJSONFile(filePath)
    const basicInfo = await this.getBasicFileInfo(filePath)

    return {
      ...basicInfo,
      processorType: 'UnrealAsset',
      assetType: 'Plugin',
      name: pluginInfo?.FriendlyName || basename(filePath, extname(filePath)),
      engineVersion: pluginInfo?.EngineVersion || '',
      pluginVersion: pluginInfo?.VersionName || '',
      support: {
        docsURL: pluginInfo?.DocsURL || '',
        marketplaceURL: this.formatMarketplaceURL(pluginInfo?.MarketplaceURL),
        requiredPlugins: pluginInfo?.Plugins?.map((p: any) => p.Name) || [],
        dependencies: pluginInfo?.Description ?? '',
        supportURL: pluginInfo?.SupportURL || '',
        createdByURL: pluginInfo?.CreatedByURL || ''
      },
      imgLocalPath: this.getPluginThumbnail(filePath),
      assetKey: uuidv4(),
      originPath: filePath,
      classKey: 'uplugin',
      status: 'main',
      metadata: {
        friendlyName: pluginInfo?.FriendlyName || '',
        description: pluginInfo?.Description || '',
        category: pluginInfo?.Category || '',
        createdBy: pluginInfo?.CreatedBy || '',
        version: pluginInfo?.Version || 1,
        versionName: pluginInfo?.VersionName || '',
        engineVersion: pluginInfo?.EngineVersion || '',
        canContainContent: pluginInfo?.CanContainContent || false,
        isBetaVersion: pluginInfo?.IsBetaVersion || false,
        isExperimentalVersion: pluginInfo?.IsExperimentalVersion || false,
        installed: pluginInfo?.Installed || false,
        modules: pluginInfo?.Modules || [],
        plugins: pluginInfo?.Plugins || []
      }
    }
  }

  /**
   * 处理.uproject文件
   */
  private async processUproject(filePath: string): Promise<Record<string, any>> {
    try {
      const projectInfo = await this.parseUproject(filePath)
      const basicInfo = await this.getBasicFileInfo(filePath)

      return {
        ...basicInfo,
        processorType: 'UnrealAsset',
        assetType: 'Project',
        name: basename(filePath, extname(filePath)),
        engineVersion: projectInfo.EngineAssociation,
        engineAssociation: projectInfo.EngineAssociation,
        category: projectInfo.Category,
        description: projectInfo.Description,
        imgLocalPath: this.getProjectThumbnail(filePath),
        assetKey: uuidv4(),
        originPath: filePath,
        classKey: 'uproject',
        status: 'main',
        metadata: {
          engineAssociation: projectInfo.EngineAssociation,

          category: projectInfo.Category,
          description: projectInfo.Description,
          modules: projectInfo.Modules,
          plugins: projectInfo.Plugins,
          targetPlatforms: projectInfo.TargetPlatforms,
          epicsampleContentPrivacy: projectInfo.EpicSampleContentPrivacy,
          projectInfo
        }
      }
    } catch (error) {
      console.error(`处理项目文件失败 ${filePath}:`, error)
      throw error
    }
  }

  /**
   * 获取项目缩略图
   */
  private getProjectThumbnail(filePath: string): string {
    try {
      const name = basename(filePath, '.uproject')
      const projectDir = dirname(filePath)

      const candidates = this.getProjectThumbnailCandidates(projectDir, name)
      const found = candidates.find((p) => fse.existsSync(p))

      if (found) {
        const fileName = 'thumbnail-' + uuidv4() + extname(found)
        const targetPath = this.pathManager.getPublicThumbnailFilePath(fileName)
        fse.copyFileSync(found, targetPath)
        return fileName
      }

      return ''
    } catch (error) {
      console.warn(`获取项目缩略图失败 ${filePath}:`, error)
      return ''
    }
  }

  // 项目缩略图候选路径策略：优先同名png，其次 Saved/AutoScreenshot
  private getProjectThumbnailCandidates(projectDir: string, name: string): string[] {
    const list: string[] = []
    const sameNamePng = join(projectDir, `${name}.png`)
    const autoShot = join(projectDir, 'Saved', 'AutoScreenshot.png')
    list.push(sameNamePng)
    list.push(autoShot)
    return list
  }

  /**
   * 项目发现 - 查找所有.uproject文件
   */
  async findAllUprojects(startPath: string): Promise<string[]> {
    const results = new Set<string>()
    const IGNORE_DIRS = new Set([
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      '.cache',
      'Intermediate',
      'Binaries'
    ])
    const MAX_DEPTH = 6

    const traverse = async (currentDir: string, depth: number) => {
      if (depth > MAX_DEPTH) return
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name)

          if (entry.isDirectory()) {
            if (IGNORE_DIRS.has(entry.name)) continue
            await traverse(fullPath, depth + 1)
          } else if (entry.isFile() && /\.uproject$/i.test(entry.name)) {
            results.add(fullPath)
          }
        }
      } catch (error) {
        console.warn(`无法访问目录 ${currentDir}:`, error)
      }
    }

    try {
      const startStat = await fs.stat(startPath)
      if (startStat.isFile() && /\.uproject$/i.test(startPath)) {
        results.add(startPath)
      } else if (startStat.isDirectory()) {
        await traverse(startPath, 0)
      }
    } catch (error) {
      console.warn(`无法访问路径 ${startPath}:`, error)
    }

    return Array.from(results)
  }
}
