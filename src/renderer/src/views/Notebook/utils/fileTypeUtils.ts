/**
 * 文件类型工具函数
 * 用于获取文件的友好显示名称和类型
 */
import i18n from '@renderer/i18n'

/**
 * 「这是个什么文件」里的**名词**部分。
 *
 * 这里原来是 55 条写死的中文成品标签（`'Word 文档'`、`'JPEG 图片'`…），
 * 英文用户在知识库里看到的每一条来源都标着中文类型。
 *
 * 但那 55 条其实只是 `<格式名> + <名词>` 的排列：格式名（Word / JPEG / MP4）
 * 两种语言下写法一样，真正要翻的只有十来个名词。所以拆开存、显示时再拼 ——
 * 55 条文案变成 14 条，以后加一种格式也不用再翻一遍。
 */
export type FileNoun =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'slideshow'
  | 'template'
  | 'ebook'
  | 'image'
  | 'vector'
  | 'audio'
  | 'video'
  | 'file'
  /** 没有格式名的那几种，模板里不带 {format} */
  | 'plainText'
  | 'icon'
  | 'generic'

/**
 * 文件类型信息接口
 */
export interface FileTypeInfo {
  /** 格式名，如 "Word" / "JPEG"。两种语言下都一样，所以不进语言包 */
  format: string
  /** 名词部分，查 `notebook.fileTypes.*` */
  noun: FileNoun
  /** 类型分类，如 "document", "image", "audio" 等 */
  category: 'document' | 'image' | 'audio' | 'video' | 'text' | 'other'
}

/**
 * 简写：绝大多数条目都是「格式名 + 名词」。
 *
 * **别叫它 `t`** —— 本仓库里 `t('...')` 是 i18n 取词的写法，扫全仓 key 的那道
 * 门禁（`usedKeyCoverage.test.ts`）会把 `t('Word', ...)` 当成一个叫 Word 的
 * 语言包 key，然后报 34 个「缺失」。
 */
function entry(format: string, noun: FileNoun, category: FileTypeInfo['category']): FileTypeInfo {
  return { format, noun, category }
}

/**
 * 文件扩展名到类型信息的映射
 */
const FILE_TYPE_MAP: Record<string, FileTypeInfo> = {
  // 文档类型
  docx: entry('Word', 'document', 'document'),
  docm: entry('Word', 'document', 'document'),
  doc: entry('Word', 'document', 'document'),
  pdf: entry('PDF', 'document', 'document'),
  xlsx: entry('Excel', 'spreadsheet', 'document'),
  xlsm: entry('Excel', 'spreadsheet', 'document'),
  xlsb: entry('Excel', 'spreadsheet', 'document'),
  xls: entry('Excel', 'spreadsheet', 'document'),
  pptx: entry('PowerPoint', 'presentation', 'document'),
  pptm: entry('PowerPoint', 'presentation', 'document'),
  ppsx: entry('PowerPoint', 'slideshow', 'document'),
  ppsm: entry('PowerPoint', 'slideshow', 'document'),
  pps: entry('PowerPoint', 'slideshow', 'document'),
  pot: entry('PowerPoint', 'template', 'document'),
  ppt: entry('PowerPoint', 'presentation', 'document'),
  odt: entry('OpenDocument', 'document', 'document'),
  ods: entry('OpenDocument', 'spreadsheet', 'document'),
  odp: entry('OpenDocument', 'presentation', 'document'),
  rtf: entry('RTF', 'document', 'document'),
  epub: entry('EPUB', 'ebook', 'document'),

  // 文本类型
  txt: entry('', 'plainText', 'text'),
  md: entry('Markdown', 'document', 'text'),
  markdown: entry('Markdown', 'document', 'text'),
  json: entry('JSON', 'file', 'text'),
  xml: entry('XML', 'file', 'text'),
  csv: entry('CSV', 'spreadsheet', 'text'),

  // 图片类型
  jpg: entry('JPEG', 'image', 'image'),
  jpeg: entry('JPEG', 'image', 'image'),
  jpe: entry('JPEG', 'image', 'image'),
  png: entry('PNG', 'image', 'image'),
  gif: entry('GIF', 'image', 'image'),
  bmp: entry('BMP', 'image', 'image'),
  webp: entry('WebP', 'image', 'image'),
  ico: entry('', 'icon', 'image'),
  jp2: entry('JPEG 2000', 'image', 'image'),
  tif: entry('TIFF', 'image', 'image'),
  tiff: entry('TIFF', 'image', 'image'),
  heic: entry('HEIC', 'image', 'image'),
  heif: entry('HEIF', 'image', 'image'),
  svg: entry('SVG', 'vector', 'image'),

  // 音频类型
  mp3: entry('MP3', 'audio', 'audio'),
  wav: entry('WAV', 'audio', 'audio'),
  ogg: entry('OGG', 'audio', 'audio'),
  flac: entry('FLAC', 'audio', 'audio'),
  aac: entry('AAC', 'audio', 'audio'),
  m4a: entry('M4A', 'audio', 'audio'),
  wma: entry('WMA', 'audio', 'audio'),

  // 视频类型
  mp4: entry('MP4', 'video', 'video'),
  avi: entry('AVI', 'video', 'video'),
  mov: entry('MOV', 'video', 'video'),
  wmv: entry('WMV', 'video', 'video'),
  mkv: entry('MKV', 'video', 'video'),
  webm: entry('WebM', 'video', 'video'),
  flv: entry('FLV', 'video', 'video')
}

/**
 * 知识库能收下的文件后缀（带点，小写）。
 *
 * 这份名单以前在 AddSourceModal.vue 和 NoteSourcePanel.vue 里各抄了一份，
 * 靠一句「与 AddSourceModal 保持一致」的注释维系 —— 加一种格式就得记得改两处。
 * 现在只有这一份。
 *
 * 文档部分要与主进程 documentLoader 的 ANYDOC_EXTENSIONS 对得上：那边解析得了、
 * 这边却不让选，用户是看不出所以然的。
 */
export const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  // 文档：交给主进程的 anydoc 转 Markdown
  '.pdf',
  '.doc',
  '.docx',
  '.docm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.ppt',
  '.pps',
  '.pot',
  '.pptx',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.epub',
  // 纯文本
  '.csv',
  '.txt',
  '.md',
  '.markdown',
  // 图片
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.jp2',
  // 视频
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.3gp',
  // 音频
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.wma',
  '.opus',
  '.aiff',
  '.ape'
])

/**
 * 检查文件是否为知识库支持的类型
 * @param fileName 文件名
 * @returns 是否支持
 */
export function isSupportedSourceFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return false
  return SUPPORTED_SOURCE_EXTENSIONS.has(fileName.toLowerCase().slice(dot))
}

/**
 * 从文件名获取文件扩展名
 * @param fileName 文件名
 * @returns 小写的文件扩展名（不含点）
 */
export function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return ''
  }
  return fileName.slice(lastDot + 1).toLowerCase()
}

/**
 * 获取文件类型信息
 * @param fileName 文件名
 * @returns 文件类型信息对象
 */
export function getFileTypeInfo(fileName: string): FileTypeInfo {
  const ext = getFileExtension(fileName)
  return FILE_TYPE_MAP[ext] || { format: '', noun: 'generic', category: 'other' }
}

/**
 * 获取文件类型的友好显示名称。
 *
 * 格式名 + 名词现拼，跟着界面语言走：中文「Word 文档」，英文「Word document」。
 * 原来这里返回的是一条写死的中文标签，英文用户在知识库里看到的每一条来源
 * 都标着中文类型。
 *
 * @param fileName 文件名
 * @returns 显示名称，如 "Word 文档" / "Word document"
 */
export function getFileTypeLabel(fileName: string): string {
  const info = getFileTypeInfo(fileName)
  return i18n.global.t(`notebook.fileTypes.${info.noun}`, { format: info.format })
}

/**
 * 检查是否为纯文本文件（可直接读取内容）
 * @param fileName 文件名
 * @returns 是否为纯文本
 */
export function isPlainTextFile(fileName: string): boolean {
  const ext = getFileExtension(fileName)
  return ['txt', 'md', 'markdown', 'json', 'xml', 'csv'].includes(ext)
}

/**
 * 检查是否为视频文件
 * @param fileName 文件名
 * @returns 是否为视频
 */
export function isVideoFile(fileName: string): boolean {
  const info = getFileTypeInfo(fileName)
  return info.category === 'video'
}
