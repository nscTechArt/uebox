<script setup lang="ts">
/**
 * 文件夹树 —— 只做树。
 *
 * 资产库那个 `AssetTree.vue` 有两千多行，里面缠着保管库切换、网络库授权、
 * 云盘节点、拖拽导入。那些都不是「树」的职责，是挂在树上的模块。
 * 这个组件只认 {@link BrowserFolder}：一层层画出来、子文件夹能收起展开、能选中、
 * 能增删改名。文件夹区块本身常驻展开，不再把核心导航藏在一次额外点击后面。
 * 方向键在行间导航（上下移动、左右收展/跳父级），语义上仍是一组普通按钮 ——
 * 见 `onRowKeydown` 里的说明。
 *
 * 「新建分组」在这里就是「新建文件夹」—— 不再有拖卡片合并出来的集合。
 * 拖动的落点是**树上的节点**，不是另一张卡片，所以手抖不会凭空造出东西。
 *
 * 改名走弹窗，和库里其它改名（蓝图、材质的「编辑信息」）同一个壳。
 * 以前是行内输入框：侧栏只有一百多像素宽，名字稍长就只剩一截，改完也看不出改成了什么。
 * 新建是「先建出一个未命名文件夹，再把改名弹窗打开」—— 所以这里只有一条改名路径。
 */
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import LibraryFormModal from '../components/LibraryFormModal.vue'
import type { BrowserFolder } from './types'

const props = defineProps<{
  folders: BrowserFolder[]
  /** 当前选中的文件夹，空串表示根 */
  modelValue: string
  /** 每个文件夹里有多少条目，显示在右侧 */
  counts?: Record<string, number>
  /** 根节点显示什么名字（i18n 之后的文本） */
  rootLabel: string
  /** 根节点的条目总数 */
  rootCount?: number
  /** 区块标题，如「文件夹」 */
  sectionTitle: string
  /** 「新建文件夹」按钮的 title */
  createTitle: string
  /** 新建时输入框里的默认名 */
  defaultFolderName: string
  renameTitle: string
  deleteTitle: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', folderKey: string): void
  /** 把条目拖到某个文件夹上 —— 移动，不是合并 */
  (e: 'drop-items', folderKey: string): void
  /**
   * 新建文件夹。key 由父级分配，所以它建完要回调告诉我们是哪个 ——
   * 拿到 key 才能立刻把改名弹窗开在这个新文件夹上。建不出来就别调。
   */
  (e: 'create-folder', name: string, onCreated: (folderKey: string) => void): void
  (e: 'rename-folder', folderKey: string, name: string): void
  (e: 'delete-folder', folderKey: string): void
}>()

const { t } = useI18n()

const collapsed = ref(new Set<string>())
/** 正在被拖过的节点，用来给落点高亮。拖不准就什么也不发生。 */
const dragOverKey = ref<string | null>(null)
/** 弹窗正在改哪个节点，null 表示弹窗关着 */
const editingKey = ref<string | null>(null)
const editingName = ref('')

const nameInputId = useId()
const nameInput = ref<HTMLInputElement | null>(null)

/*
 * 弹窗一开就把名字选中：改名时最常见的动作是整个重打，不用先 Ctrl+A。
 * 弹窗内容在 Teleport 里，要等它真的挂上去才拿得到那个 input。
 */
watch(editingKey, async (key) => {
  if (key === null) return
  await nextTick()
  nameInput.value?.select()
})

/*
 * 行按钮按 key 登记，方向键导航和焦点回位都从这里找落点。
 * 用函数 ref 而不是字符串 ref：编辑输入框在 v-for 里，字符串 ref 会被
 * Vue 收集成数组，`.select()` 那类单元素用法会当场炸掉。
 */
const rowButtons = new Map<string, HTMLButtonElement>()

function setRowButton(key: string, el: unknown): void {
  if (el instanceof HTMLButtonElement) rowButtons.set(key, el)
  else rowButtons.delete(key)
}

/** 按父级分桶，画树时一层层取 */
const childrenOf = computed(() => {
  const map = new Map<string | null, BrowserFolder[]>()
  for (const folder of props.folders) {
    const list = map.get(folder.parentKey) ?? []
    list.push(folder)
    map.set(folder.parentKey, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return map
})

/**
 * 从某一层往下摊平成可渲染的行，带上缩进层级。
 *
 * 用摊平而不是递归组件：树可能很深，递归组件在 Vue 里每层都是一个实例，
 * 几千个文件夹时开销明显；摊平之后只是一个 v-for。
 */
interface Row {
  folder: BrowserFolder
  depth: number
  hasChildren: boolean
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (parentKey: string | null, depth: number): void => {
    for (const folder of childrenOf.value.get(parentKey) ?? []) {
      const hasChildren = (childrenOf.value.get(folder.key)?.length ?? 0) > 0
      out.push({ folder, depth, hasChildren })
      if (hasChildren && !collapsed.value.has(folder.key)) walk(folder.key, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

function toggle(key: string): void {
  const next = new Set(collapsed.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsed.value = next
}

/*
 * 方向键导航 —— 按 WAI-ARIA 树视图的惯例：上下在可见行之间移动，
 * 右展开 / 钻进第一个子级，左收起 / 退到父级，Home/End 跳首尾。
 * 语义上仍是一组普通按钮（行里还有改名删除等兄弟按钮，套 role="tree"
 * 会让读屏把可交互子元素全吞掉），方向键只是让键盘用户不用按几十次 Tab。
 */
function onRowKeydown(event: KeyboardEvent, key: string): void {
  if (editingKey.value !== null) return
  /** 可聚焦的行序列：根行在最前，后面是当前展开状态下的摊平行 */
  const keys = ['', ...rows.value.map((row) => row.folder.key)]
  const index = keys.indexOf(key)
  if (index === -1) return

  const go = (target?: string): void => {
    if (target === undefined) return
    rowButtons.get(target)?.focus()
  }

  switch (event.key) {
    case 'ArrowDown':
      go(keys[index + 1])
      break
    case 'ArrowUp':
      go(keys[index - 1])
      break
    case 'Home':
      go(keys[0])
      break
    case 'End':
      go(keys[keys.length - 1])
      break
    case 'ArrowRight': {
      if (key === '') return
      if (collapsed.value.has(key)) toggle(key)
      else go(childrenOf.value.get(key)?.[0]?.key)
      break
    }
    case 'ArrowLeft': {
      if (key === '') return
      const hasChildren = (childrenOf.value.get(key)?.length ?? 0) > 0
      if (hasChildren && !collapsed.value.has(key)) toggle(key)
      else go(props.folders.find((f) => f.key === key)?.parentKey ?? '')
      break
    }
    default:
      return
  }
  event.preventDefault()
}

function onDragLeave(event: DragEvent): void {
  // 从行容器挪进行内按钮也算还在同一个落点上，别把高亮闪没了
  const wrap = event.currentTarget
  if (
    wrap instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    wrap.contains(event.relatedTarget)
  )
    return
  dragOverKey.value = null
}

function onDrop(folderKey: string): void {
  dragOverKey.value = null
  emit('drop-items', folderKey)
}

function startEditing(key: string, name: string): void {
  editingKey.value = key
  editingName.value = name
}

/*
 * 新建 = 先建出来，再弹改名。和资源管理器一样：点一下就有一个「未命名文件夹」，
 * 改名窗口跟着打开。取消改名也留得住它 —— 用户点的是「新建」，本来就该建出来。
 *
 * 建不出来（只读库、保存失败）父级就不回调，什么也不弹，焦点留在「新建」按钮上。
 */
function startCreating(): void {
  emit('create-folder', props.defaultFolderName, (folderKey) => {
    startEditing(folderKey, props.defaultFolderName)
  })
}

/**
 * 弹窗关掉后把焦点还给那一行。不还的话焦点掉进 body，
 * 键盘用户得从页头重新 Tab 一遍。
 */
async function restoreFocus(key: string): Promise<void> {
  await nextTick()
  rowButtons.get(key)?.focus()
}

/** 空名字点不动「保存」（confirm-disabled），所以这里不必再兜一遍 */
function commitEditing(): void {
  const key = editingKey.value
  const name = editingName.value.trim()
  editingKey.value = null
  if (!key || !name) return

  emit('rename-folder', key, name)
  void restoreFocus(key)
}

function cancelEditing(): void {
  const key = editingKey.value
  editingKey.value = null
  if (key !== null) void restoreFocus(key)
}
</script>

<template>
  <nav class="browser-folder-tree" :aria-label="sectionTitle">
    <div class="tree-section-header">
      <div class="tree-section-label">
        <span class="section-title">{{ sectionTitle }}</span>
      </div>
      <button
        type="button"
        class="section-action"
        :title="createTitle"
        :aria-label="createTitle"
        @click="startCreating"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div
      class="tree-row-wrap"
      :class="{ 'is-drag-over': dragOverKey === '' }"
      @dragover.prevent="dragOverKey = ''"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop('')"
    >
      <span class="tree-caret is-spacer" aria-hidden="true" />
      <button
        :ref="(el) => setRowButton('', el)"
        type="button"
        class="tree-row"
        :class="{ 'is-active': modelValue === '' }"
        :aria-current="modelValue === '' ? 'true' : undefined"
        @click="emit('update:modelValue', '')"
        @keydown="onRowKeydown($event, '')"
      >
        <svg
          class="tree-item-icon is-root"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </svg>
        <span class="tree-name" :title="rootLabel">{{ rootLabel }}</span>
        <span v-if="rootCount !== undefined" class="tree-count">{{ rootCount }}</span>
      </button>
    </div>

    <template v-for="row in rows" :key="row.folder.key">
      <div
        class="tree-row-wrap has-actions"
        :class="{ 'is-drag-over': dragOverKey === row.folder.key }"
        :style="{ paddingLeft: `calc(${row.depth} * var(--space-4))` }"
        @dragover.prevent="dragOverKey = row.folder.key"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop(row.folder.key)"
      >
        <!--
          展开箭头是独立按钮，不能套在下面那个按钮里 —— 嵌套 button 是非法 HTML，
          浏览器会把它拆出去，键盘和读屏都会错乱。
        -->
        <button
          v-if="row.hasChildren"
          type="button"
          class="tree-caret"
          :class="{ 'is-collapsed': collapsed.has(row.folder.key) }"
          :aria-expanded="!collapsed.has(row.folder.key)"
          :aria-label="row.folder.name"
          @click.stop="toggle(row.folder.key)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m8 10 4 4 4-4" />
          </svg>
        </button>
        <span v-else class="tree-caret is-spacer" aria-hidden="true" />

        <button
          :ref="(el) => setRowButton(row.folder.key, el)"
          type="button"
          class="tree-row"
          :class="{ 'is-active': modelValue === row.folder.key }"
          :aria-current="modelValue === row.folder.key ? 'true' : undefined"
          @click="emit('update:modelValue', row.folder.key)"
          @keydown="onRowKeydown($event, row.folder.key)"
        >
          <svg class="tree-item-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3.5 7h6l2 2h9v9.5h-17z" />
          </svg>
          <span class="tree-name" :title="row.folder.name">{{ row.folder.name }}</span>
          <span v-if="counts?.[row.folder.key] !== undefined" class="tree-count">
            {{ counts[row.folder.key] }}
          </span>
        </button>

        <span class="tree-actions">
          <button
            type="button"
            :title="renameTitle"
            :aria-label="renameTitle"
            @click.stop="startEditing(row.folder.key, row.folder.name)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2z" />
              <path d="m14.5 7.1 2.8 2.8" />
            </svg>
          </button>
          <button
            type="button"
            :title="deleteTitle"
            :aria-label="deleteTitle"
            @click.stop="emit('delete-folder', row.folder.key)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
            </svg>
          </button>
        </span>
      </div>
    </template>

    <LibraryFormModal
      :open="editingKey !== null"
      icon="edit"
      :title="renameTitle"
      :cancel-text="t('libraryBrowser.folderNameCancel')"
      :confirm-text="t('libraryBrowser.folderNameConfirm')"
      :confirm-disabled="!editingName.trim()"
      @update:open="(open: boolean) => !open && cancelEditing()"
      @confirm="commitEditing"
    >
      <div class="form-group">
        <label class="form-label" :for="nameInputId">
          {{ t('libraryBrowser.folderNameLabel') }}
        </label>
        <input
          :id="nameInputId"
          ref="nameInput"
          v-model="editingName"
          class="form-input"
          :placeholder="t('libraryBrowser.folderNamePlaceholder')"
          @keyup.enter="editingName.trim() && commitEditing()"
        />
      </div>
    </LibraryFormModal>
  </nav>
</template>

<style scoped>
/*
 * 观感对齐资产库的侧栏（区块小标题 + 渐变圆点、行的悬停/选中、右侧计数徽标），
 * 但一律走主题变量 —— `AssetTree.vue` 那边把 #7c5cff 之类写死了，
 * 深色以外的两套主题会当场垮掉，别照抄那部分。
 */
.browser-folder-tree {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  /* 侧栏是固定宽的，横向一律不滚 —— 长名字用省略号收，不是甩出一条滚动条 */
  min-width: 0;
  padding: var(--space-3) var(--space-2);
  overflow-x: hidden;
  overflow-y: auto;
}

.tree-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0 var(--space-1) var(--space-2);
}

.tree-section-label {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* 区块前面那个渐变小圆点，是这套侧栏的标志性元素 */

.section-title {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  letter-spacing: 0.2px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.section-action {
  flex: 0 0 auto;
  /* 桌面紧凑工具栏也保留完整点击区，不能只有字形那么大 */
  width: var(--space-8);
  height: var(--space-8);
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);
}

.section-action svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.section-action:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

/* 一行 = 箭头 + 主按钮 + 操作区。三者是兄弟，不能相互嵌套（嵌套 button 非法） */
.tree-row-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-height: var(--sidebar-row-height, 32px);
  min-width: 0;
  /* 行尾留一点，操作按钮不贴着边框 */
  padding-right: var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard),
    box-shadow var(--motion-fast) var(--easing-standard);
}

.tree-row-wrap:hover {
  background: var(--color-bg-surface-hover);
}

/* 落点高亮：拖到树上才算数，拖到卡片上不会有任何反应 */
.tree-row-wrap.is-drag-over {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg-hover);
}

.tree-row {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: var(--sidebar-row-height, 32px);
  padding: 0 var(--space-2) 0 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.tree-row-wrap:hover .tree-row {
  color: var(--color-text-primary);
}

.tree-row.is-active {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.tree-row-wrap:has(.tree-row.is-active) {
  background: var(--color-bg-selected);
}

.tree-caret {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-8);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: transform var(--motion-fast) var(--easing-standard);
}

.tree-caret svg {
  width: var(--space-4);
  height: var(--space-4);
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tree-caret.is-spacer {
  cursor: default;
}

.tree-caret.is-collapsed {
  transform: rotate(-90deg);
}

.tree-item-icon {
  flex: 0 0 auto;
  width: var(--space-4);
  height: var(--space-4);
  fill: var(--color-text-muted);
  stroke: var(--color-text-muted);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition:
    fill var(--motion-fast) var(--easing-standard),
    stroke var(--motion-fast) var(--easing-standard);
}

.tree-item-icon.is-root {
  fill: none;
}

.tree-row-wrap:hover .tree-item-icon {
  fill: var(--color-text-muted);
  stroke: var(--color-text-primary);
}

.tree-row.is-active .tree-item-icon {
  fill: var(--color-accent-text);
  stroke: var(--color-accent-text);
}

.tree-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tree-count {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: var(--space-5);
  height: var(--space-5);
  padding: 0 var(--space-1);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  font-family: var(--font-family-numeric);
  font-size: var(--font-size-xs);
  line-height: 1;
  transition: opacity var(--motion-fast) var(--easing-standard);
}

/*
 * 改名/删除平时不占位，悬停或键盘聚焦时才把宽度撑开，名字同步让出位置。
 * 这是会话列表行尾图钉/归档的同一套做法，见 layout/components/ChatSessionList.vue
 * 的 .chat-item-actions。以前是一块带描边和投影的浮层压在行上，把文件夹名遮掉一半，
 * 读不出这行叫什么。
 * 只在 hover 露出等于触屏和键盘用户永远够不到，所以 focus-within 也要露。
 */
.tree-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  width: 0;
  margin-left: calc(0px - var(--space-1));
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--easing-standard);
}

.tree-row-wrap:hover .tree-actions,
.tree-row-wrap:focus-within .tree-actions {
  width: auto;
  margin-left: 0;
  overflow: visible;
  opacity: 1;
}

/* 计数是元信息，整块收掉给操作让位 —— 只调透明度的话它还占着宽度 */
.tree-row-wrap.has-actions:hover .tree-count,
.tree-row-wrap.has-actions:focus-within .tree-count {
  width: 0;
  min-width: 0;
  padding: 0;
  border-width: 0;
  overflow: hidden;
  opacity: 0;
}

.tree-actions button {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.tree-actions svg {
  width: var(--sidebar-icon-size, 14px);
  height: var(--sidebar-icon-size, 14px);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 行本身悬停时已经是 --color-bg-surface-hover，按钮要再深一档才看得出来 */
.tree-actions button:hover {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

.section-action:focus-visible,
.tree-caret:not(.is-spacer):focus-visible,
.tree-row:focus-visible,
.tree-actions button:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .tree-row-wrap,
  .tree-caret,
  .tree-item-icon,
  .tree-count,
  .tree-actions,
  .section-action {
    transition: none;
  }
}
</style>
