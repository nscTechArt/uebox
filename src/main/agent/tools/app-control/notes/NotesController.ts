// 笔记控制器 - 处理笔记的创建、查询、更新、删除操作
import { marked } from 'marked'
import type Database from 'better-sqlite3'
import { getVaultDatabase } from '../../../../sqliteDataBase'
import { getAssetDataByKey, updateAssetData } from '../../../../sqliteDataBase/models/assetData'
import {
  getAssetFolderByKey,
  updateAssetFolder
} from '../../../../sqliteDataBase/models/assetFolder'
import {
  alreadyAttachedError,
  resolveAttachTarget,
  targetNotFoundError,
  type NoteAttachTarget
} from './noteAttachment'
import {
  createAssetNote,
  getAssetNoteById,
  searchAssetNotes,
  updateAssetNote,
  deleteAssetNote,
  type AssetNote
} from '../../../../sqliteDataBase/models/assetNote'
import type {
  CreateNoteParams,
  UpdateNoteParams,
  SearchNoteParams,
  GetNoteParams,
  DeleteNoteParams,
  NoteResult,
  NoteInfo
} from './types'

/**
 * 将 Markdown 文本转换为 HTML
 * @param markdown Markdown 格式的文本
 * @returns HTML 格式的内容
 */
async function convertMarkdownToHtml(markdown: string): Promise<string> {
  if (!markdown || markdown.trim().length === 0) {
    return ''
  }

  try {
    // 使用 marked 将 Markdown 转换为 HTML
    const html = await marked(markdown)
    return html
  } catch (error) {
    console.error('Markdown 转换失败:', error)
    // 转换失败时返回原始内容
    return markdown
  }
}

/**
 * 列表模式下每篇笔记的预览长度。
 *
 * 原来是 200 字，而且**没有任何办法拿到更多** —— 列表只给预览，详情又被
 * 硬截在 2000 字。想读一篇笔记就得先 search 再 get，两次调用换一段还可能
 * 是残缺的正文。这是 Router 时代的省法：那会儿一次只能揣几千 token 上路。
 *
 * 现在详情返回完整正文（不截断），列表可以用 `full: true` 一次要全文，
 * 预览只是「列表默认别太长」的一个缺省值，不再是天花板。
 */
const PREVIEW_CHARS = 400

/**
 * 将数据库笔记对象转换为工具返回的笔记信息格式
 * @param note 数据库笔记对象
 * @param options 格式化选项
 * @param options.includeFullContent 是否返回完整正文（默认 false，返回预览）
 * @returns 格式化的笔记信息
 */
function formatNote(note: AssetNote, options: { includeFullContent?: boolean } = {}): NoteInfo {
  const { includeFullContent = false } = options

  const truncated = !includeFullContent && note.content.length > PREVIEW_CHARS
  const content = truncated ? note.content.substring(0, PREVIEW_CHARS) : note.content

  return {
    id: note.id!,
    title: note.title,
    content,
    // 截断这件事必须说出来。
    //
    // 原来列表里的 `content` 是一段悄悄截过的正文，末尾加三个点 ——
    // 调用方分不清「这篇笔记就这么短」和「后面还有」，于是要么把半截正文
    // 当全文汇报，要么对每一篇都保险起见再 get 一次。
    ...(truncated ? { contentTruncated: true as const, contentLength: note.content.length } : {}),
    createdAt: note.created_at || new Date().toISOString(),
    updatedAt: note.updated_at || new Date().toISOString()
  }
}

/**
 * 读挂载目标当前挂着哪篇笔记。
 *
 * 三态，调用方必须分清：
 * - `undefined` —— 目标根本不存在
 * - `null` —— 目标在，但还没有说明
 * - 数字 —— 已经挂了这一篇
 */
function readTargetNoteId(
  db: Database.Database,
  target: NoteAttachTarget
): number | null | undefined {
  const row =
    target.kind === 'asset'
      ? getAssetDataByKey(db, target.key)
      : getAssetFolderByKey(db, target.key)
  if (!row) return undefined
  const noteId = (row as { noteId?: number | null }).noteId
  return noteId ?? null
}

/** 把笔记挂到目标上。返回是否写成功 */
function writeTargetNoteId(
  db: Database.Database,
  target: NoteAttachTarget,
  noteId: number | null
): boolean {
  return target.kind === 'asset'
    ? updateAssetData(db, target.key, { noteId })
    : updateAssetFolder(db, target.key, { noteId })
}

/**
 * 笔记被删之后，把所有指向它的挂载点清成 null。
 *
 * 直接一条 UPDATE 打掉，不做「先查再改」—— 一篇笔记正常只挂在一个地方，
 * 但真出现多处指向（比如以后允许一篇挂多个资产），这样也一次清干净。
 * 删笔记是低频操作，两条全表 UPDATE 的代价可以接受。
 */
function detachNoteEverywhere(noteId: number): boolean {
  try {
    const db = getVaultDatabase()
    const assets = db.prepare('UPDATE assetData SET noteId = NULL WHERE noteId = ?').run(noteId)
    const folders = db.prepare('UPDATE assetFolder SET noteId = NULL WHERE noteId = ?').run(noteId)
    return assets.changes + folders.changes > 0
  } catch (error) {
    // 清不掉不该让「删笔记」整个失败：界面读不到笔记时会自己把关联清空
    console.warn('清理笔记挂载点失败:', error)
    return false
  }
}

/**
 * 创建笔记
 * @param params 创建笔记参数
 * @returns 笔记操作结果
 */
export async function createNoteAction(params: CreateNoteParams): Promise<NoteResult> {
  const { title = '无标题笔记', content = '' } = params

  // 先把挂载目标定下来再动手建。建完再发现挂不上，就正好造出了
  // 「没有入口的孤儿笔记」——那正是这条规则要防的东西
  const resolved = resolveAttachTarget(params)
  if (!resolved.ok) return { success: false, error: resolved.error }
  const target = resolved.target

  try {
    // 说明和它挂载的资产在同一个保管库里，一个句柄就够了
    const db = getVaultDatabase()
    const existingNoteId = readTargetNoteId(db, target)
    if (existingNoteId === undefined) {
      return { success: false, error: targetNotFoundError(target) }
    }
    if (existingNoteId !== null) {
      return { success: false, error: alreadyAttachedError(target, existingNoteId) }
    }

    // 将 Markdown 内容转换为 HTML（与 UI 行为保持一致）
    const htmlContent = await convertMarkdownToHtml(content.trim())

    const noteId = createAssetNote(db, {
      title: title.trim() || '无标题笔记',
      content: htmlContent
    })

    // 挂上去。挂不上就把刚建的笔记删掉 —— 留着它就是一篇用户看不见的孤儿
    if (!writeTargetNoteId(db, target, noteId)) {
      deleteAssetNote(db, noteId)
      return {
        success: false,
        error: '笔记已建但没能挂到目标上，已回滚。请确认 assetKey / folderKey 是否仍然有效。'
      }
    }

    // 获取创建的笔记
    const createdNote = getAssetNoteById(db, noteId)
    if (!createdNote) {
      return {
        success: false,
        error: '创建笔记成功，但无法获取创建的笔记'
      }
    }

    const where = target.kind === 'asset' ? '资产' : '文件夹'
    return {
      success: true,
      message: `笔记「${createdNote.title}」已创建，并挂在${where} ${target.key} 上（用户在详情面板的「备注」里能看到它）`,
      count: 1,
      noteId,
      note: formatNote(createdNote, { includeFullContent: true })
    }
  } catch (error) {
    console.error('创建笔记失败:', error)
    return {
      success: false,
      error: `创建笔记失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 获取笔记详情
 * @param params 获取笔记参数
 * @returns 笔记操作结果
 */
export async function getNoteAction(params: GetNoteParams): Promise<NoteResult> {
  const { id } = params

  try {
    const db = getVaultDatabase()
    const note = getAssetNoteById(db, id)

    if (!note) {
      return {
        success: false,
        error: `未找到 ID 为 ${id} 的笔记`
      }
    }

    return {
      success: true,
      message: `已获取笔记「${note.title}」`,
      count: 1,
      note: formatNote(note, { includeFullContent: true })
    }
  } catch (error) {
    console.error('获取笔记失败:', error)
    return {
      success: false,
      error: `获取笔记失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 搜索/列表笔记
 * @param params 搜索笔记参数
 * @returns 笔记操作结果
 */
export async function searchNotesAction(params: SearchNoteParams): Promise<NoteResult> {
  const { keyword, limit = 50, full = false } = params

  try {
    const db = getVaultDatabase()

    // 空关键词由 searchAssetNotes 自己当「列全部」处理，不用再分一支
    const notes: AssetNote[] = searchAssetNotes(db, (keyword ?? '').trim(), { limit })

    // full=true 时一次给全文。查得准（关键词很窄、或者本来就只有几篇）的时候，
    // 这一个参数省掉的是「一篇一次 note_get」的整串往返。
    const formattedNotes = notes.map((n) => formatNote(n, { includeFullContent: full }))
    const anyTruncated = formattedNotes.some((n) => n.contentTruncated)

    return {
      success: true,
      message:
        (keyword && keyword.trim()
          ? `找到 ${notes.length} 篇包含「${keyword}」的笔记`
          : `共有 ${notes.length} 篇笔记`) +
        (anyTruncated
          ? '。部分笔记正文过长只给了开头（看 contentTruncated），要全文就用 note_get，或者这个工具加 full=true 重来一次。'
          : ''),
      count: notes.length,
      notes: formattedNotes
    }
  } catch (error) {
    console.error('搜索笔记失败:', error)
    return {
      success: false,
      error: `搜索笔记失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 更新笔记
 * @param params 更新笔记参数
 * @returns 笔记操作结果
 */
export async function updateNoteAction(params: UpdateNoteParams): Promise<NoteResult> {
  const { id, title, content } = params

  // 至少需要一个更新字段
  if (title === undefined && content === undefined) {
    return {
      success: false,
      error: '更新笔记需要至少提供一个字段（title 或 content）'
    }
  }

  try {
    const db = getVaultDatabase()

    // 检查笔记是否存在
    const existingNote = getAssetNoteById(db, id)
    if (!existingNote) {
      return {
        success: false,
        error: `未找到 ID 为 ${id} 的笔记`
      }
    }

    // 准备更新数据
    const updates: Partial<AssetNote> = {}
    if (title !== undefined) {
      updates.title = title.trim() || existingNote.title
    }
    if (content !== undefined) {
      // 将 Markdown 内容转换为 HTML（与 UI 行为保持一致）
      updates.content = await convertMarkdownToHtml(content.trim())
    }

    // 执行更新
    const success = updateAssetNote(db, id, updates)
    if (!success) {
      return {
        success: false,
        error: '更新笔记失败'
      }
    }

    // 获取更新后的笔记
    const updatedNote = getAssetNoteById(db, id)
    if (!updatedNote) {
      return {
        success: false,
        error: '更新成功，但无法获取更新后的笔记'
      }
    }

    return {
      success: true,
      message: `笔记「${updatedNote.title}」更新成功`,
      count: 1,
      note: formatNote(updatedNote, { includeFullContent: true })
    }
  } catch (error) {
    console.error('更新笔记失败:', error)
    return {
      success: false,
      error: `更新笔记失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * 删除笔记
 * @param params 删除笔记参数
 * @returns 笔记操作结果
 */
export async function deleteNoteAction(params: DeleteNoteParams): Promise<NoteResult> {
  const { id } = params

  try {
    const db = getVaultDatabase()

    // 检查笔记是否存在
    const existingNote = getAssetNoteById(db, id)
    if (!existingNote) {
      return {
        success: false,
        error: `未找到 ID 为 ${id} 的笔记`
      }
    }

    const noteTitle = existingNote.title

    // 执行删除
    const success = deleteAssetNote(db, id)
    if (!success) {
      return {
        success: false,
        error: '删除笔记失败'
      }
    }

    // 把指向它的挂载点一起清掉。界面在读不到笔记时也会自愈，但不清的话
    // 那个资产在下一次被打开之前，「详细说明」卡片会指着一篇不存在的笔记
    const detached = detachNoteEverywhere(id)

    return {
      success: true,
      message: detached
        ? `笔记「${noteTitle}」已删除，它所挂载的资产/文件夹也已取消关联`
        : `笔记「${noteTitle}」已删除`,
      count: 1
    }
  } catch (error) {
    console.error('删除笔记失败:', error)
    return {
      success: false,
      error: `删除笔记失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
