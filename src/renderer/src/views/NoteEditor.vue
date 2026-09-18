<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import {
  ref,
  computed,
  onMounted,
  watch,
  onBeforeUnmount,
  onUnmounted,
  nextTick,
  inject
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useTabsStore } from '@renderer/store/modules/tabs'
defineOptions({ name: 'NoteEditor' })
import { message } from '@renderer/utils/messageManager'
import { PhArrowLeft, PhNotePencil } from '@phosphor-icons/vue'
import { useEditor, EditorContent, VueRenderer, VueNodeViewRenderer } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import Highlight from '@tiptap/extension-highlight'
import Underline from '@tiptap/extension-underline'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import type { SuggestionProps } from '@tiptap/suggestion'
import { marked } from 'marked'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import 'tippy.js/dist/tippy.css'
import { SlashCommand } from '../extensions/SlashCommand'
import SlashCommandMenu from '../components/SlashCommandMenu.vue'
import BubbleMenuToolbar from '../components/BubbleMenuToolbar.vue'
import TableToolbar from '../components/TableToolbar.vue'
import CodeBlockComponent from '../components/CodeBlockComponent.vue'
import { getNoteStore, type NoteStoreKind } from './Notebook/utils/noteStore'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import {
  collectInlineImages,
  hasInlineImages,
  replaceInlineImageSources,
  savableExtension
} from './Notebook/utils/noteImages'
import { savableVideoExtension } from './Notebook/utils/noteVideos'
import type { EditableNote as Note } from './Notebook/utils/noteStore'
import { useNoteViewStore } from '../store/modules/noteViewStore'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { all, createLowlight } from 'lowlight'
import { FileAttachment } from '../extensions/FileAttachment'
import { VideoEmbed } from '../extensions/VideoEmbed'
import { NoteModelViewer } from '../extensions/NoteModelViewer'

/**
 * 正文保存的防抖。
 *
 * 原来是每敲一个字整篇写回数据库 —— 主进程还要重算内容哈希、把索引标成待重建。
 * 用户停手之后存一次就够了；800ms 是「打字停顿」和「切走之前来得及存」之间的折中。
 */
const SAVE_DEBOUNCE_MS = 800

// 创建 lowlight 实例并注册所有语言
const lowlight = createLowlight(all)

/**
 * 笔记编辑器组件
 * 使用 Tiptap 实现真正的 WYSIWYG 编辑体验
 */

// 路由管理
const noteViewStore = useNoteViewStore()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const tabsStore = useTabsStore()

const loading = ref(false)
const notes = ref<Note[]>([])
const selectedNoteId = ref<number | null>(null)

// 同步和分享状态
// 同步和分享状态

// 编辑状态
const currentNote = ref<Note | null>(null)
const titleElement = ref<HTMLElement | null>(null)

// Markdown 粘贴检测相关
const showMarkdownToast = ref(false)
const pastedMarkdownText = ref('')
const pastedMarkdownRange = ref<{ from: number; to: number } | null>(null)
const toastTimer = ref<number | null>(null)

/**
 * 检测文本是否符合 Markdown 语法
 */
const isMarkdownContent = (text: string): boolean => {
  if (!text || text.trim().length === 0) return false

  // 常见 Markdown 语法特征
  const markdownPatterns = [
    /^#{1,6}\s+.+/m, // 标题 # ## ### 等
    /\*\*.+?\*\*/g, // 粗体 **text**
    /\*.+?\*/g, // 斜体 *text*
    /\[.+?\]\(.+?\)/g, // 链接 [text](url)
    /^[-*+]\s+/m, // 无序列表
    /^\d+\.\s+/m, // 有序列表
    /^```[\s\S]*?```/m, // 代码块
    /`[^`]+`/g, // 行内代码
    /^>\s+/m // 引用
  ]

  // 如果至少匹配2个以上的 Markdown 特征，则认为是 Markdown 文本
  const matchCount = markdownPatterns.filter((pattern) => pattern.test(text)).length
  return matchCount >= 2
}

/**
 * 将 Markdown 转换为 HTML 并更新编辑器
 */
const convertMarkdownToHtml = async (): Promise<void> => {
  if (!pastedMarkdownText.value || !editor.value || !pastedMarkdownRange.value) return

  try {
    // 使用 marked 将 Markdown 转换为 HTML
    const html = await marked(pastedMarkdownText.value)

    // 只替换粘贴的内容范围
    const { from, to } = pastedMarkdownRange.value
    editor.value
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .deleteSelection()
      .insertContent(html)
      .run()

    message.success(t('noteEditor.markdownConverted'))
    closeMarkdownToast()
  } catch (error) {
    console.error('Markdown 转换失败:', error)
    message.error(t('noteEditor.markdownConvertFailed'))
  }
}

/**
 * 关闭 Markdown 提示框
 */
const closeMarkdownToast = (): void => {
  showMarkdownToast.value = false
  pastedMarkdownText.value = ''
  pastedMarkdownRange.value = null
  if (toastTimer.value) {
    clearTimeout(toastTimer.value)
    toastTimer.value = null
  }
}

/**
 * Tiptap 编辑器实例
 */
const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6]
      },
      codeBlock: false // 禁用默认的代码块，使用 lowlight
    }),
    Placeholder.configure({
      placeholder: "输入 '/' 打开命令菜单...",
      includeChildren: true
    }),
    Typography,
    TaskList,
    TaskItem.configure({
      nested: true
    }),
    Link.configure({
      openOnClick: false,
      linkOnPaste: true
    }),
    Highlight.configure({
      multicolor: false
    }),
    Underline,
    Image.configure({
      inline: true,
      allowBase64: true,
      HTMLAttributes: {
        class: 'editor-image'
      }
    }),
    Table.configure({
      resizable: true,
      HTMLAttributes: {
        class: 'editor-table'
      }
    }),
    TableRow,
    TableHeader,
    TableCell,
    CodeBlockLowlight.configure({
      lowlight
    }).extend({
      addNodeView() {
        return VueNodeViewRenderer(CodeBlockComponent)
      },
      addKeyboardShortcuts() {
        return {
          'Mod-a': ({ editor }) => {
            const { state } = editor
            const { selection } = state
            const { $from } = selection

            // 检查当前光标是否在代码块中
            const codeBlockNode = $from.node($from.depth)
            if (codeBlockNode.type.name !== 'codeBlock') {
              return false // 不在代码块中，使用默认行为
            }

            // 获取代码块的起始和结束位置
            const start = $from.start($from.depth)
            const end = $from.end($from.depth)
            const codeBlockSize = end - start

            // 检查当前是否已经全选了代码块
            const isCodeBlockFullySelected =
              selection.from === start && selection.to === end && codeBlockSize > 0

            if (!isCodeBlockFullySelected) {
              // 第一次按 Ctrl+A：只选择代码块内容
              editor.chain().setTextSelection({ from: start, to: end }).run()
              return true // 阻止默认行为
            }

            // 第二次按 Ctrl+A：返回 false 让事件传播，执行全文选择
            return false
          }
        }
      }
    }),
    FileAttachment,
    NoteModelViewer,
    VideoEmbed,
    SlashCommand.configure({
      suggestion: {
        char: '/',
        startOfLine: false,
        command: ({ editor, range, props }) => {
          props.command({ editor, range })
        },
        render: () => {
          let component: VueRenderer
          let popup: TippyInstance[]

          return {
            onStart: (props: SuggestionProps) => {
              component = new VueRenderer(SlashCommandMenu, {
                props: {
                  editor: props.editor,
                  range: props.range,
                  query: props.query
                },
                editor: props.editor
              })

              if (!props.clientRect) {
                return
              }

              // @ts-ignore - tippy类型定义与实际使用不匹配
              const tippyInstance = tippy(document.body, {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start'
              })
              popup = Array.isArray(tippyInstance) ? tippyInstance : [tippyInstance]
            },

            onUpdate: (props: SuggestionProps) => {
              component.updateProps(props)

              if (!props.clientRect) {
                return
              }

              popup[0].setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect
              })
            },

            onKeyDown: (props: { event: KeyboardEvent }) => {
              if (props.event.key === 'Escape') {
                popup[0].hide()
                return true
              }

              return component.ref?.onKeyDown(props.event)
            },

            onExit: () => {
              popup[0].destroy()
              component.destroy()
            }
          }
        }
      }
    })
  ],
  content: '',
  editorProps: {
    attributes: {
      class: 'prose prose-invert max-w-none focus:outline-none',
      spellcheck: 'false'
    },
    // 监听粘贴事件
    handlePaste: (_view, event) => {
      const clipboardData = event.clipboardData
      if (!clipboardData) return false

      // 处理图片粘贴
      const items = clipboardData.items
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          event.preventDefault()
          const file = items[i].getAsFile()
          if (file) {
            void insertImageFile(file, null)
          }
          return true
        }
      }

      const text = clipboardData.getData('text/plain')
      if (text && isMarkdownContent(text)) {
        // 检测到 Markdown 内容，显示提示框
        pastedMarkdownText.value = text

        // 记录粘贴后的位置范围
        nextTick(() => {
          if (editor.value) {
            const { to } = editor.value.state.selection
            // 粘贴后光标在末尾，计算粘贴内容的范围
            const pasteLength = text.length
            pastedMarkdownRange.value = {
              from: to - pasteLength,
              to: to
            }
          }
        })

        showMarkdownToast.value = true

        // 10秒后自动隐藏提示框
        if (toastTimer.value) {
          clearTimeout(toastTimer.value)
        }
        toastTimer.value = window.setTimeout(() => {
          closeMarkdownToast()
        }, 10000)
      }

      // 返回 false 让 Tiptap 继续处理粘贴事件
      return false
    },
    // 监听拖放事件
    handleDrop: (view, event, _slice, moved) => {
      if (
        !moved &&
        event.dataTransfer &&
        event.dataTransfer.files &&
        event.dataTransfer.files.length > 0
      ) {
        const files = event.dataTransfer.files
        for (let i = 0; i < files.length; i++) {
          const file = files[i]

          // 阻止默认行为
          event.preventDefault()

          // 获取拖拽位置
          const coordinates = view.posAtCoords({
            left: event.clientX,
            top: event.clientY
          })
          let dropPos = coordinates ? coordinates.pos : editor.value?.state.doc.content.size || 0

          if (file.type.startsWith('image/')) {
            void insertImageFile(file, dropPos)
            return true
          }

          // 视频要就地播，不能走下面的文件附件卡片
          if (file.type.startsWith('video/')) {
            if (editor.value) {
              const $pos = editor.value.state.doc.resolve(dropPos)
              if ($pos.parent.isTextblock) dropPos = $pos.after()
            }
            void insertVideoFile(file, dropPos)
            return true
          }

          // 对于非图片文件，我们希望插入到当前行之后（另起一行），而不是拆分当前行
          // 尝试找到当前位置所在的节点的结束位置
          if (editor.value) {
            const $pos = editor.value.state.doc.resolve(dropPos)
            // 如果是在文本块内，移动到块结束位置
            if ($pos.parent.isTextblock) {
              dropPos = $pos.after()
            }
          }

          if (
            file.name.toLowerCase().endsWith('.fbx') ||
            file.name.toLowerCase().endsWith('.obj') ||
            file.name.toLowerCase().endsWith('.glb') ||
            file.name.toLowerCase().endsWith('.gltf')
          ) {
            // 处理 3D 模型文件
            const filePath = (
              window as unknown as { api: { getPathForFile: (file: File) => string } }
            ).api?.getPathForFile(file)

            if (editor.value && filePath) {
              const nodeContent = {
                type: 'noteModelViewer',
                attrs: {
                  src: filePath
                }
              }

              // 插入模型节点
              editor.value
                .chain()
                .insertContentAt(dropPos, nodeContent)
                .insertContentAt(dropPos + 1, { type: 'paragraph' })
                .run()

              return true
            }
          } else {
            // 处理其他文件，插入文件附件卡片
            const api = (
              window as unknown as {
                api: {
                  getFileStats: (path: string) => Promise<{ size: number; mtime: string | Date }>
                }
              }
            ).api
            const filePath = (
              window as unknown as { api: { getPathForFile: (file: File) => string } }
            ).api?.getPathForFile(file)

            if (editor.value && filePath && api && api.getFileStats) {
              api
                .getFileStats(filePath)
                .then((stats) => {
                  if (editor.value) {
                    const nodeContent = {
                      type: 'fileAttachment',
                      attrs: {
                        path: filePath,
                        name: file.name,
                        size: stats.size,
                        mtime: new Date(stats.mtime).toISOString()
                      }
                    }

                    editor.value
                      .chain()
                      .insertContentAt(dropPos, nodeContent)
                      .insertContentAt(dropPos + 1, { type: 'paragraph' }) // 插入一个空段落
                      .run()
                  }
                })
                .catch((err) => {
                  console.error('获取文件信息失败:', err)
                  // 降级处理：插入普通链接
                  if (editor.value) {
                    editor.value
                      .chain()
                      .insertContentAt(dropPos, {
                        type: 'text',
                        text: file.name,
                        marks: [
                          {
                            type: 'link',
                            attrs: {
                              href: `file://${filePath}`,
                              target: '_blank',
                              class: 'file-link'
                            }
                          }
                        ]
                      })
                      .insertContentAt(dropPos + 1, ' ')
                      .run()
                  }
                })
              return true
            }
          }
        }
      }
      return false
    }
  },
  onUpdate: ({ editor }) => {
    // 内容变化时触发自动保存
    if (currentNote.value) {
      saveContent(editor.getHTML())
    }
  }
})

/**
 * 加载笔记列表
 */
const loadNotes = async (): Promise<void> => {
  try {
    loading.value = true
    notes.value = await noteStore.value.list({ limit: 100 })
  } catch (error) {
    console.error('加载笔记列表失败:', error)
  } finally {
    loading.value = false
  }
}

/**
 * 创建新笔记
 */
const createNewNote = async (): Promise<void> => {
  try {
    const id = await noteStore.value.create({
      title: '',
      content: ''
    })
    await loadNotes()
    selectedNoteId.value = id
    await loadCurrentNote()

    // 自动聚焦标题输入框
    await nextTick()
    if (titleElement.value) {
      titleElement.value.focus()
    }

    if (currentNote.value) {
      emit('created', currentNote.value)
    }
  } catch (error) {
    console.error('创建笔记失败:', error)
  }
}

/**
 * 选择笔记
 */
/**
 * 获取当前选中的笔记
 */
/**
 * 独立标签页里，把标签名换成笔记标题。
 *
 * 不换的话开几篇笔记就是几个一模一样的「笔记」标签，分不出哪个是哪个。
 * 嵌在知识库里时标签归那边管，不要动。
 */
const syncTabTitle = (title?: string): void => {
  if (!isStandalone.value) return
  const next = title?.trim()
  if (next) tabsStore.updateTabTitleByPath(route.fullPath, next)
}

const loadCurrentNote = async (): Promise<void> => {
  if (!selectedNoteId.value) {
    currentNote.value = null
    // 清空是程序行为，不是用户编辑 —— 别让它排一次保存
    editor.value?.commands.setContent('', { emitUpdate: false })
    if (titleElement.value) {
      titleElement.value.textContent = ''
    }
    return
  }
  try {
    const note = await noteStore.value.getById(selectedNoteId.value)
    currentNote.value = note || null
    syncTabTitle(note?.title)

    await nextTick()

    // 更新编辑器内容
    if (note && editor.value) {
      // 更新标题
      if (titleElement.value) {
        titleElement.value.textContent = note.title
      }

      /*
       * 老笔记里的图片是 base64 塞在正文里的（贴五张截图这篇笔记就是几 MB）。
       * 打开时顺手搬到磁盘上，正文只留路径。
       *
       * 搬不动的原样留着继续显示 —— 迁移失败不能让用户看不到自己的图。
       * 只有真的搬走了才回写，避免每次打开都白写一遍数据库。
       */
      const migrated = await migrateInlineImages(note.content || '')
      /*
        `emitUpdate: false` 是必须的：`setContent` 默认会触发 `onUpdate`，
        于是**只是打开一篇笔记**就排了一次保存 —— 而 tiptap 重新序列化出来的 HTML
        和库里存的那串几乎不可能逐字相同，所以每次打开都算一次「内容变了」：
        `updated_at` 被刷新（笔记无故跳到「最近」最前），往外 emit 的 `updated`
        还会让知识库把这条来源重新向量化一遍，花的是用户自己的额度。
        下面那个 `migrated !== note.content` 判断本来就是干这件事的，别绕过它。
      */
      editor.value.commands.setContent(migrated, { emitUpdate: false })
      if (migrated !== note.content) {
        note.content = migrated
        // 占自己那一格：别的笔记没存上的内容留在它们各自的格子里，不受影响
        pendingSaves.set(note.id!, migrated)
        await flushSave()
      }
    }
  } catch (error) {
    console.error('加载笔记失败:', error)
  }
}

/**
 * 处理标题输入
 */
const handleTitleInput = async (event: Event): Promise<void> => {
  if (!currentNote.value) return

  const target = event.target as HTMLElement
  const newTitle = target.textContent?.trim() || ''

  try {
    await noteStore.value.update(currentNote.value.id!, { title: newTitle })
    currentNote.value.title = newTitle
    syncTabTitle(newTitle)

    // 同步更新列表中的标题
    const noteInList = notes.value.find((n) => n.id === currentNote.value?.id)
    if (noteInList) {
      noteInList.title = newTitle
    }

    emit('updated', currentNote.value as Note)
  } catch (error) {
    console.error('保存标题失败:', error)
  }
}

/**
 * 处理标题按键
 */
const handleTitleKeydown = (event: KeyboardEvent): void => {
  // 按下 Enter 键时失去焦点
  if (event.key === 'Enter') {
    event.preventDefault()
    ;(event.target as HTMLElement).blur()
    // 聚焦到编辑器
    editor.value?.commands.focus()
  }
}

/**
 * 处理标题粘贴 - 强制只粘贴纯文本
 */
const handleTitlePaste = (event: ClipboardEvent): void => {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') || ''
  // 移除换行符，标题应该是单行的
  const cleanText = text.replace(/[\r\n]+/g, ' ').trim()
  document.execCommand('insertText', false, cleanText)
}

/**
 * 点击空白区域聚焦编辑器
 */
const handleContainerClick = (event: MouseEvent): void => {
  const target = event.target as HTMLElement
  // 检查点击目标是否是容器本身或 note-body
  if (
    target.classList.contains('note-editor-container') ||
    target.classList.contains('note-body')
  ) {
    editor.value?.commands.focus()
  }
}

/**
 * 贴 / 拖进来的图片：落到磁盘上，正文里只留路径。
 *
 * 落盘失败时**退回 base64**。图片已经在用户手里了，这一刻丢掉它才是最坏的结果 ——
 * 宁可这一张继续胖在正文里（下次打开笔记的迁移还会再试一次），也不能让它消失。
 */
async function insertImageFile(file: File, dropPos: number | null): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  /*
    主进程存不了的格式（svg / avif / heic / tiff…）不能硬塞给它：它会把扩展名
    改写成 `png`，文件里却是别的字节，那张图再也渲染不出来 —— 而正文里已经写成
    这个路径了，等于把图删了。存不了就走下面的 base64 兜底，至少显示得出来。
  */
  const ext = savableExtension(file.type, file.name)

  let src: string
  try {
    if (!ext) throw new Error(`unsupported image format: ${file.type || file.name}`)
    const filePath = await noteStore.value.saveImage(bytes, ext)
    // 路径为空说明主进程给了个空串，当作失败走兜底，别把 src 写成 undefined
    src = toLocalResourceUrl(filePath) ?? ''
    if (!src) throw new Error('saveImage returned an empty path')
  } catch (error) {
    console.warn('[NoteEditor] 图片落盘失败，暂时以内联形式留在正文里:', error)
    src = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(String(e.target?.result || ''))
      reader.readAsDataURL(file)
    })
    if (!src) return
  }

  if (!editor.value) return
  if (dropPos === null) {
    editor.value.chain().focus().setImage({ src }).run()
  } else {
    editor.value.chain().insertContentAt(dropPos, { type: 'image', attrs: { src } }).run()
  }
}

/**
 * 把拖进来的视频存进保管库，然后插一个能就地播放的节点。
 *
 * 和图片不一样：图片存不下还能退回 base64 塞在正文里，视频不行 —— 几十上百
 * 兆的 base64 会把笔记撑爆。所以存不了就明说，不做兜底。
 */
async function insertVideoFile(file: File, dropPos: number | null): Promise<void> {
  const ext = savableVideoExtension(file.type, file.name)
  if (!ext) {
    const shown = file.type || file.name.split('.').pop() || file.name
    message.warning(t('noteEditor.video.unsupportedFormat', { ext: shown }))
    return
  }

  let filePath: string
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    filePath = await noteStore.value.saveVideo(bytes, ext)
    if (!filePath) throw new Error('saveVideo returned an empty path')
  } catch (error) {
    console.error('[NoteEditor] 视频落盘失败:', error)
    message.error(t('noteEditor.video.saveFailed'))
    return
  }

  if (!editor.value) return
  // src 存原始路径，播放前再转本地资源 URL —— 和 3D 模型节点一个规矩
  const nodeContent = { type: 'videoEmbed', attrs: { src: filePath, name: file.name } }
  if (dropPos === null) {
    editor.value.chain().focus().insertContent(nodeContent).run()
  } else {
    editor.value
      .chain()
      .insertContentAt(dropPos, nodeContent)
      .insertContentAt(dropPos + 1, { type: 'paragraph' })
      .run()
  }
}

/**
 * 老笔记里已经存成 base64 的图片，打开时搬到磁盘上。
 *
 * 一次性、失败不留痕：搬成功几张就替换几张，剩下的原样留着 base64 ——
 * 下次打开这篇笔记再试。任何一步失败都不会动用户的正文。
 */
async function migrateInlineImages(html: string): Promise<string> {
  if (!hasInlineImages(html)) return html

  const replacements = new Map<string, string>()
  for (const image of collectInlineImages(html)) {
    try {
      const url = toLocalResourceUrl(await noteStore.value.saveImage(image.bytes, image.ext))
      // 拿不到地址就当这张没搬走 —— 它继续以 base64 留在正文里，下次打开再试
      if (url) replacements.set(image.src, url)
    } catch (error) {
      console.warn('[NoteEditor] 内联图片迁移失败，这张先留着:', error)
    }
  }
  return replaceInlineImageSources(html, replacements)
}

/** 有内容没存上。界面据此显示「未保存」并给重试 */
const saveFailed = ref(false)
/**
 * 待保存的正文，**按笔记 id 分格**。
 *
 * ## 为什么必须是 Map 而不是一格
 *
 * 防抖是 800ms，而切换笔记比这快得多，所以「待保存」天然可以同时挂着**两篇**：
 * 上一篇刚敲完还没到点，下一篇已经开始编辑。只留一格的话，无论怎么小心都会丢：
 *
 * - 一格 + 只存正文：定时器到点时去问 `currentNote` 是哪篇，拿到的是**新**那篇，
 *   A 的字被写进 B（串）。
 * - 一格 + 带上 noteId：换笔记时得先把上一篇抢救掉再占格，可抢救是异步的 ——
 *   它失败时内容已经被新那篇顶掉了（丢），成功时又会把新那篇的格子清掉（也丢）。
 *
 * 分格之后这些情况根本不存在：两篇各占各的格，互不影响，谁存好了删谁。
 */
const pendingSaves = new Map<number, string>()
/** 存失败的笔记 id。`saveFailed` 由它决定，别让「B 存好了」把「A 没存上」盖掉 */
const failedSaveIds = new Set<number>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 保存正文。
 *
 * ## 为什么要防抖
 *
 * 这里原来绑在 `onUpdate` 上、每敲一个字就把整篇 HTML 经 IPC 写回数据库，
 * 主进程还要重算内容哈希、把索引标成待重建。笔记越长越卡，而这份开销
 * 完全没必要 —— 用户停手之后存一次就够了。
 *
 * ## 为什么失败要说出来
 *
 * 原来失败只有 `console.error`。用户会继续写下去，界面一切正常，
 * 关掉应用才发现这一段没了。
 */
const flushSave = async (): Promise<void> => {
  if (pendingSaves.size === 0) return

  /*
    先整批取出、立刻清空。

    这个顺序是关键：下面每一次 `await` 都有几十到几百毫秒，用户在这期间接着敲字，
    那些字会进**新**的格子。要是等 await 回来再清，就会把新敲的那份一起抹掉，
    而随后到点的定时器发现没东西可存，直接返回 —— 用户停手之后那段话就永远没了。
  */
  const batch = [...pendingSaves]
  pendingSaves.clear()

  for (const [noteId, content] of batch) {
    try {
      await noteStore.value.update(noteId, { content })
      failedSaveIds.delete(noteId)
      /*
        只有存的确实是**当前这篇**才同步内存和往外广播。
        切走之后才落盘的那次不能碰 `currentNote`（那已经是别人了），
        也不该 emit —— 外面拿这个事件去做知识库重新索引，笔记 id 对不上就索引错了。
      */
      if (currentNote.value?.id === noteId) {
        currentNote.value.content = content
        emit('updated', currentNote.value)
      }
    } catch (error) {
      failedSaveIds.add(noteId)
      // 存不上就放回格子里等重试；但期间用户又敲了的话以新的为准，别往回覆盖
      if (!pendingSaves.has(noteId)) pendingSaves.set(noteId, content)
      console.error(`保存笔记 ${noteId} 的正文失败:`, error)
    }
  }

  saveFailed.value = failedSaveIds.size > 0
}

const saveContent = (htmlContent: string): void => {
  const noteId = currentNote.value?.id
  if (noteId === undefined) return

  // 同一篇连着敲字合并成一格；不同笔记各占一格，互不覆盖
  pendingSaves.set(noteId, htmlContent)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

/** 用户点「重试保存」 */
const retrySave = async (): Promise<void> => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await flushSave()
}

// 监听选中笔记的变化
watch(selectedNoteId, async () => {
  /*
    换笔记之前先把上一篇没落盘的存掉。
    不先存的话，`loadCurrentNote` 会把编辑器内容换成新笔记的，上一篇最后那几个字
     —— 用户刚敲完还没到 800ms 防抖点的那些 —— 就永远没了。
  */
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await flushSave()
  await loadCurrentNote()
})

// 监听笔记被外部更新（如 AI 生成标题后）
watch(
  () => noteViewStore.noteUpdateTimestamp,
  async (newTimestamp, oldTimestamp) => {
    if (newTimestamp > 0 && newTimestamp !== oldTimestamp) {
      const updatedNoteId = noteViewStore.noteUpdatedId
      console.log('[NoteEditor] 收到笔记更新通知, noteId:', updatedNoteId)

      // 刷新笔记列表
      await loadNotes()

      // 如果更新的是当前选中的笔记，刷新内容
      if (updatedNoteId === selectedNoteId.value) {
        await loadCurrentNote()
      }
    }
  }
)

const props = defineProps<{
  autoCreate?: boolean
  noteId?: number
  /**
   * 编哪一边的笔记。默认 `vault` —— 资产/文件夹的详细说明，跟着保管库走。
   * 知识库详情页把它当文本来源的编辑器用，那边必须显式传 `public`。
   */
  store?: NoteStoreKind
}>()

/** 每次读写都现取，这样切保管库之后立刻指向新库 */
const noteStore = computed(() => getNoteStore(props.store ?? 'vault'))

const emit = defineEmits<{
  (e: 'created', note: Note): void
  (e: 'updated', note: Note): void
}>()

/**
 * 注入父组件提供的切换到AI对话的方法
 */
const onSwitchToAIChat = inject<(() => void) | undefined>('onSwitchToAIChat', undefined)

/**
 * 这个组件有两种用法：嵌在知识库详情页里，或者自己占一个标签页
 * （资产/文件夹的「详细说明」就是后者）。没有注入回调就是后者。
 */
const isStandalone = computed(() => !onSwitchToAIChat)

/**
 * 处理返回按钮点击。
 *
 * 独立标签页里没有注入回调，原来这个按钮点了什么都不会发生 —— 用户从资产库
 * 跳过来，想回去却按不动。这种情况退回上一页。
 */
const handleBack = (): void => {
  if (onSwitchToAIChat) {
    onSwitchToAIChat()
    return
  }
  router.back()
}

// 监听 props.noteId 变化
watch(
  () => props.noteId,
  (newId) => {
    if (newId && newId !== selectedNoteId.value) {
      selectedNoteId.value = newId
    }
  }
)

// 监听 props.autoCreate 变化，处理在编辑器已打开时点击"添加笔记"的情况
watch(
  () => props.autoCreate,
  async (newVal) => {
    if (newVal) {
      await createNewNote()
    }
  }
)

// 组件挂载时加载笔记列表
onMounted(async () => {
  await loadNotes()

  if (props.autoCreate) {
    await createNewNote()
  } else {
    // 优先使用 prop 传入的 ID
    if (props.noteId) {
      selectedNoteId.value = props.noteId
    }

    await loadCurrentNote()
  }

  // 监听 Agent 笔记变化事件（AI 创建/更新/删除笔记时触发）
  window.electron.ipcRenderer.on(
    'agent:note:changed',
    async (_event: unknown, payload: { action: string; noteId?: number }) => {
      console.log('[NoteEditor] 收到 Agent 笔记变化事件:', payload)
      // 刷新笔记列表
      await loadNotes()
      // 如果是创建操作，自动选中新创建的笔记
      if (payload.action === 'create' && payload.noteId) {
        selectedNoteId.value = payload.noteId
        await loadCurrentNote()
      }
      // 如果是更新当前笔记，刷新内容
      else if (payload.action === 'update' && payload.noteId === selectedNoteId.value) {
        await loadCurrentNote()
      }
      // 如果是删除当前选中的笔记，清空选择
      else if (payload.action === 'delete' && payload.noteId === selectedNoteId.value) {
        selectedNoteId.value = notes.value.length > 0 ? notes.value[0].id! : null
        await loadCurrentNote()
      }
    }
  )
})

// 组件卸载时销毁编辑器
onBeforeUnmount(() => {
  /*
   * 走之前把攒着的那笔存了。
   *
   * 保存有 800ms 防抖 —— 用户打完最后一个字就切页面 / 关笔记的话，那段话还在内存里。
   * 这里等不了 IPC 回来（钩子是同步的），但请求已经发出去，主进程会写完。
   */
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void flushSave()
  editor.value?.destroy()
})

// 清理定时器和事件监听器
onUnmounted(() => {
  if (toastTimer.value) {
    clearTimeout(toastTimer.value)
  }
  // 清理 Agent 笔记变化事件监听器
  window.electron.ipcRenderer.removeAllListeners('agent:note:changed')
})
</script>

<template>
  <div class="note-editor" @drop.prevent @dragover.prevent>
    <!-- 侧边栏触发器 -->
    <!-- 侧边栏触发器 (deleted) -->
    <!-- 新建按钮 (图标) (deleted) -->

    <!-- 左侧笔记列表 -->
    <!-- 左侧笔记列表 (deleted) -->

    <!-- 右侧编辑区域 -->
    <div class="note-content">
      <template v-if="!currentNote">
        <!-- 没有笔记时原来整页是空的 —— 白屏看起来就是坏了 -->
        <div class="note-empty">
          <PhNotePencil class="note-empty-icon" />
          <div class="note-empty-text">{{ t('noteEditor.emptyTitle') }}</div>
          <div class="note-empty-desc">{{ t('noteEditor.emptyDesc') }}</div>
        </div>
      </template>
      <template v-else>
        <!-- 统一的编辑区域容器 -->
        <!-- 统一的编辑区域容器 -->
        <!-- 顶部工具栏：同步状态和分享按钮 (deleted) -->

        <!--
          存不上时常驻在编辑区顶部，直到真的写进去。
          原来失败只有 console.error —— 用户会继续写，关掉应用才发现这一段没了。
        -->
        <div v-if="saveFailed" class="note-save-alert" role="alert">
          <span>{{ t('noteEditor.saveFailedAlert') }}</span>
          <AppButton size="small" @click="retrySave">{{ t('noteEditor.retrySave') }}</AppButton>
        </div>

        <div class="note-editor-container" @click="handleContainerClick">
          <!-- 预览风格的头部 -->
          <div class="note-preview-header">
            <div class="header-left">
              <button class="back-btn" @click.stop="handleBack">
                <PhArrowLeft />
              </button>
            </div>
          </div>

          <!-- 工具栏 -->
          <BubbleMenuToolbar :editor="editor" />

          <!-- 标题区域 -->
          <div class="note-header">
            <div
              ref="titleElement"
              class="title-editable"
              contenteditable="true"
              spellcheck="false"
              :placeholder="t('noteEditor.newNote')"
              @input="handleTitleInput"
              @keydown="handleTitleKeydown"
              @paste="handleTitlePaste"
              @blur="handleTitleInput"
            ></div>
          </div>

          <!-- 内容区域 - Tiptap WYSIWYG 编辑器 -->
          <div class="note-body">
            <EditorContent v-if="editor" :editor="editor" class="tiptap-editor" />
            <div v-else class="editor-loading">{{ t('noteEditor.loading') }}</div>
            <!-- 表格操作工具栏 -->
            <TableToolbar :editor="editor" />
          </div>
        </div>

        <!-- Markdown 粘贴提示框 -->
        <Transition name="toast-slide">
          <div v-if="showMarkdownToast" class="markdown-toast">
            <div class="toast-content">
              <span class="toast-text">识别到粘贴内容符合 Markdown 语法</span>
              <AppButton
                variant="link"
                size="small"
                class="toast-action"
                @click="convertMarkdownToHtml"
              >
                转化为对应格式
              </AppButton>
              <AppButton
                variant="text"
                size="small"
                class="toast-close"
                @click="closeMarkdownToast"
              >
                ×
              </AppButton>
            </div>
          </div>
        </Transition>
      </template>
    </div>
  </div>
</template>

<style scoped lang="less">
.note-editor {
  display: flex;
  height: 100%;
  background: var(--color-bg-surface);
  border-radius: 12px;
  overflow: hidden;
}

.note-sidebar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 240px;
  background: transparent;
  backdrop-filter: blur(20px);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  z-index: 100;
  transform: translateX(-100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 1px 0 14px var(--shadow-color);

  &.visible {
    transform: translateX(0);
  }
}

.sidebar-trigger {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 101;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--color-bg-surface-hover);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &.hidden {
    opacity: 0;
    pointer-events: none;
  }

  font-size: 18px;
}

.sidebar-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 12px;
  height: 64px;
}

.new-note-icon-btn {
  position: absolute;
  top: 16px;
  left: 55px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--color-bg-surface-hover);
  z-index: 101;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.search-bar {
  position: absolute;
  right: 12px;
  height: 40px;
  width: 40px; /* Initial width (collapsed) */
  display: flex;
  align-items: center;
  justify-content: center; /* Center icon */
  transition:
    width 0.4s cubic-bezier(0.2, 0, 0.2, 1),
    background-color 0.4s ease; /* Smooth width and background animation */
  overflow: hidden; /* Hide content during animation */
  background: transparent;
  border-radius: var(--radius-xs);
  z-index: 10;

  &.expanded {
    width: calc(100% - 24px); /* Full width minus margins */
    justify-content: flex-start; /* Align input to left */
    background: var(--color-bg-surface-hover);
  }

  .search-icon-btn {
    width: 32px;
    height: 32px;
    min-width: 32px; /* Prevent shrinking */
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: all 0.2s ease;
    background: var(--color-bg-surface-hover);

    &:hover {
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
    }
  }
}

.note-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  margin-top: 12px;
}

.note-item {
  padding: 10px 16px;
  margin-bottom: 8px;
  background: var(--color-bg-surface-hover);
  // border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: space-between;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);

    .delete-btn {
      opacity: 1;
    }
  }

  &.active {
    background: linear-gradient(135deg, rgba(183, 197, 226, 0.3), rgba(153, 224, 235, 0.2));
    border-color: var(--color-accent-border);
  }

  .note-item-content {
    flex: 1;
    min-width: 0;
  }

  .delete-btn {
    opacity: 0;
    transition: opacity 0.2s ease;
    flex-shrink: 0;
    margin-left: 8px;
  }
}

.note-title {
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-time {
  color: var(--color-text-primary);
  font-size: 12px;
}

.note-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-items: center;
}

// 没有笔记时的空态
.note-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-muted);

  .note-empty-icon {
    font-size: 48px;
    opacity: 0.5;
  }

  .note-empty-text {
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  .note-empty-desc {
    font-size: 13px;
  }
}

// 统一的编辑器容器
.note-editor-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  padding: 24px 0; /* 上下padding保留,左右去掉以便滚动条在边缘 */
  overflow-y: auto; /* 滚动条在容器上 */
  width: 100%;
  position: relative;
}

// 预览风格的头部
.note-preview-header {
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  // 和下面的标题/正文同宽同居中。原来贴在窗口最左边，和内容列差了几百像素，
  // 看着像一个飘在角落里的孤儿按钮
  width: 60%;
  max-width: 900px;
  margin: 0 auto;
  padding: 0;
  // border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  // backdrop-filter: blur(10px);
  // -webkit-backdrop-filter: blur(10px);
  z-index: 20;

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0;

    .back-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      flex-shrink: 0;
      font-size: 16px;

      &:hover {
        background: var(--color-bg-surface-hover);
        transform: translateX(-2px);
        box-shadow: 0 2px 8px var(--shadow-color-weak);
      }

      &:active {
        transform: translateX(-2px) scale(0.95);
      }
    }

    .note-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-width: 0;

      .note-type {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
        padding: 3px 10px;
        border-radius: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        font-weight: 500;
        width: fit-content;
      }
    }
  }
}

// 顶部工具栏
.note-toolbar {
  position: absolute;
  top: 16px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 16px;
  z-index: 10;

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .share-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-primary);
    font-size: 13px;
    padding: 4px 6px;
    border-radius: var(--radius-xs);
    transition: all 0.2s ease;

    &:hover {
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
    }

    svg {
      font-size: 14px;
    }

    :deep(span) {
      margin-inline-start: 0;
    }
  }
}

.note-header {
  width: 60%;
  margin: 0 auto 20px; /* 居中 */
  max-width: 900px;
  padding-bottom: 16px;
  // border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
  // 原来是 120px，返回按钮和标题之间空出一大片。缩到 48px，
  // 留白还在，但不至于让人以为页面没加载完
  padding-top: 48px;

  .title-editable {
    color: var(--color-text-primary);
    font-size: 40px;
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
    padding: 4px 0;
    outline: none;
    cursor: text;
    transition: all 0.2s ease;
    word-break: break-word;
    min-height: 36px;

    &:empty::before {
      /*
       * 读元素上的 placeholder，不写死文案。
       *
       * 那个 `:placeholder="t('noteEditor.newNote')"` 一直绑在元素上（见模板），
       * 只是这里写死了 `content: '新笔记'`，于是绑定等于没绑 —— 英文用户新建
       * 笔记，标题栏里的占位符是中文。contenteditable 没有原生 placeholder，
       * 这条 attr() 就是让它生效的那一半。
       */
      content: attr(placeholder);
      color: var(--color-text-muted);
    }

    &:focus {
      color: var(--color-text-primary);
    }
  }
}

.note-body {
  width: 60%;
  margin: 0 auto; /* 居中 */
  max-width: 900px;
  display: flex;
  flex-direction: column;
  /* overflow: hidden; Removed to allow scrolling in container */

  .tiptap-editor {
    flex: 1;
    /* overflow-y: auto;  移除内部滚动 */
    padding: 0;

    // Tiptap 编辑器基础样式
    :deep(.ProseMirror) {
      outline: none;
      min-height: 100%;
      color: var(--color-text-primary);
      font-size: 15px;
      line-height: 1.6;

      // Placeholder 样式
      p.is-empty::before {
        content: attr(data-placeholder);
        float: left;
        color: var(--color-text-muted);
        pointer-events: none;
        height: 0;
      }

      // 标题样式
      h1,
      h2,
      h3,
      h4,
      h5,
      h6 {
        // margin: 24px 0 16px;
        font-weight: 600;
        line-height: 1.25;
        color: var(--color-text-primary);
        margin-bottom: 16px !important;

        &:first-child {
          margin-top: 0;
        }
      }

      h1 {
        font-size: 30px;
        padding-bottom: 8px;
        margin-top: 2em !important;
      }

      h2 {
        font-size: 24px;
        padding-bottom: 8px;
        margin-top: 1.4em !important;
      }

      h3 {
        font-size: 20px;
        margin-top: 1em !important;
      }

      h4 {
        font-size: 16px;
        margin-top: 1em !important;
      }

      h5 {
        font-size: 16px;
        margin-top: 1em !important;
      }

      h6 {
        font-size: 16px;
        margin-top: 1em !important;
      }

      //段落
      p {
        font-size: 16px;
        margin-top: 1px;
      }

      // 链接
      a {
        color: var(--color-accent-text);
        text-decoration: none;
        transition: color 0.2s ease;

        &:hover {
          color: var(--color-accent-text);
          text-decoration: underline;
        }
      }

      // 行内代码
      code {
        padding: 2px 6px;
        background: var(--color-bg-surface-hover);
        border: 1px solid var(--color-border-subtle);
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 0.9em;
        color: var(--color-danger-text);
      }

      // 代码块
      pre {
        margin: 16px 0;
        padding: 16px;
        background: var(--color-bg-surface-hover);
        border: 1px solid var(--color-border-subtle);
        border-radius: 8px;
        overflow-x: auto;

        code {
          padding: 0;
          background: transparent;
          border: none;
          color: var(--color-text-primary);
        }
      }

      // 引用
      blockquote {
        margin: 16px 0;
        padding: 8px 16px;
        border-left: 4px solid var(--color-accent-border);
        background: var(--color-accent-bg);
        color: var(--color-text-primary);

        p:last-child {
          margin-bottom: 0;
        }
      }

      // 列表
      ul,
      ol {
        margin: 0 0 16px;
        padding-left: 2em;
      }

      li {
        margin: 4px 0;
      }

      // 水平线
      hr {
        margin: 24px 0;
        border: none;
        border-top: 1px solid var(--color-border-subtle);
      }

      // 加粗
      strong {
        font-weight: 600;
        color: var(--color-text-primary);
      }

      // 斜体
      em {
        font-style: italic;
        color: var(--color-text-primary);
      }

      // 下划线
      u {
        text-decoration: underline;
      }

      // 高亮
      mark {
        background: var(--color-accent-solid);
        color: var(--color-text-on-solid);
        padding: 2px 4px;
        border-radius: 3px;
      }

      // 待办列表
      ul[data-type='taskList'] {
        list-style: none;
        padding-left: 0;

        li {
          display: flex;
          align-items: flex-start;
          gap: 8px;

          > label {
            margin-top: 2px;
            user-select: none;
            cursor: pointer;

            > input[type='checkbox'] {
              cursor: pointer;
              accent-color: var(--color-accent-text);
              width: 16px;
              height: 16px;
              border-radius: 12px;
            }
          }

          > div {
            flex: 1;
          }

          // 已完成的待办项
          &[data-checked='true'] > div {
            text-decoration: line-through;
            opacity: 0.6;
          }
        }

        // 嵌套的待办列表
        ul[data-type='taskList'] {
          margin-top: 4px;
          padding-left: 24px;
        }
      }

      // 图片
      img {
        max-width: 100%;
        height: auto;
        border-radius: 8px;
        margin: 16px 0;
        transition: all 0.2s ease;
        border: 2px solid transparent;

        // 选中状态
        &.ProseMirror-selectednode {
          border-color: var(--color-border-strong);
          outline: none;
        }
      }

      // 表格样式
      table {
        border-collapse: collapse;
        table-layout: fixed;
        width: 100%;
        margin: 16px 0;
        overflow: hidden;
        border: 1px solid var(--color-border-subtle);
        border-radius: 8px;

        td,
        th {
          min-width: 100px;
          border: 1px solid var(--color-border-subtle);
          padding: 8px 12px;
          vertical-align: top;
          box-sizing: border-box;
          position: relative;
          background: var(--color-bg-surface-hover);

          > * {
            margin-bottom: 0;
          }
        }

        th {
          font-weight: 600;
          text-align: left;
          background: var(--color-accent-bg);
          color: var(--color-text-primary);
        }

        .selectedCell:after {
          z-index: 2;
          position: absolute;
          content: '';
          left: 0;
          right: 0;
          top: 0;
          bottom: 0;
          background: var(--color-accent-bg);
          pointer-events: none;
        }

        .column-resize-handle {
          position: absolute;
          right: -2px;
          top: 0;
          bottom: -2px;
          width: 4px;
          background-color: var(--color-accent-solid);
          pointer-events: none;
        }
      }
    }
  }

  .editor-loading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-primary);
    font-style: italic;
  }

  :deep(.model-viewer-wrapper) {
    justify-content: flex-start !important;
  }
}

// 语法高亮样式 (GitHub Dark)
.hljs-comment,
.hljs-quote {
  color: var(--color-text-secondary);
  font-style: italic;
}

.hljs-doctag,
.hljs-keyword,
.hljs-formula {
  color: var(--color-danger-text);
}

.hljs-section,
.hljs-name,
.hljs-selector-tag,
.hljs-deletion,
.hljs-subst {
  color: var(--color-accent-text);
}

.hljs-literal {
  color: var(--color-accent-text);
}

.hljs-string,
.hljs-regexp,
.hljs-addition,
.hljs-attribute,
.hljs-meta .hljs-string {
  color: var(--color-accent-text);
}

.hljs-attr,
.hljs-variable,
.hljs-template-variable,
.hljs-type,
.hljs-selector-class,
.hljs-selector-attr,
.hljs-selector-pseudo,
.hljs-number {
  color: var(--color-accent-text);
}

.hljs-symbol,
.hljs-bullet,
.hljs-link,
.hljs-meta,
.hljs-selector-id,
.hljs-title {
  color: var(--color-accent-text);
}

.hljs-built_in,
.hljs-title.class_,
.hljs-class .hljs-title {
  color: var(--color-warning-text);
}

.hljs-emphasis {
  font-style: italic;
}

.hljs-strong {
  font-weight: bold;
}

.hljs-link {
  text-decoration: underline;
}

// Markdown 提示框样式
.note-save-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: var(--space-3) var(--space-4) 0;
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
}

.markdown-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-bg-raised);
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-accent-border);
  border-radius: 12px;
  padding: 12px 20px;
  box-shadow: 0 8px 32px var(--shadow-color);
  z-index: 1000;
  //毛玻璃
  -webkit-backdrop-filter: blur(20px);

  .toast-content {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .toast-text {
    color: var(--color-text-primary);
    font-size: 14px;
  }

  .toast-action {
    color: var(--color-accent-text);
    padding: 0;
    height: auto;
    font-size: 14px;

    &:hover {
      color: var(--color-accent-text);
    }
  }

  .toast-close {
    color: var(--color-text-primary);
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    line-height: 1;
    margin-left: 4px;

    &:hover {
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
    }
  }
}

// 提示框动画
.toast-slide-enter-active,
.toast-slide-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.toast-slide-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}

.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}

// 隐藏 Empty 组件的图片，只显示描述
:deep(.app-empty__icon) {
  display: none;
}
</style>
