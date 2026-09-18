<template>
  <div class="tag-display">
    <div class="panel-header">
      <h3 class="panel-title">
        {{ quickFilter ? getQuickFilterTitle() : selectedGroupName }}
        <span class="panel-count">{{ countLabel }}</span>
      </h3>
      <div class="header-actions">
        <AppDropdown placement="bottomRight">
          <AppButton variant="text" size="medium">
            <template #icon><PhArrowsDownUp /></template>
            {{ sortMode === 'usage' ? $t('tagDisplay.sort.usage') : $t('tagDisplay.sort.name') }}
          </AppButton>
          <template #overlay>
            <AppMenu @click="handleSortMenuClick">
              <AppMenuItem item-key="name">
                <PhCheck v-if="sortMode === 'name'" />
                {{ $t('tagDisplay.sort.name') }}
              </AppMenuItem>
              <AppMenuItem item-key="usage">
                <PhCheck v-if="sortMode === 'usage'" />
                {{ $t('tagDisplay.sort.usage') }}
              </AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>

        <div class="search-box">
          <PhMagnifyingGlass class="search-icon" />
          <input
            v-model="searchKeyword"
            class="search-input"
            type="text"
            :placeholder="$t('tagDisplay.searchPlaceholder')"
            @keydown.esc="searchKeyword = ''"
          />
        </div>

        <AppButton variant="primary" size="medium" @click="handleCreateNewTag">
          {{ $t('tagDisplay.createButton') }}
        </AppButton>
      </div>
    </div>

    <div class="tags-content" @contextmenu="handleRightClick">
      <div v-if="filteredTags.length === 0" class="empty-state">
        <PhTag class="empty-icon" />
        <div class="empty-text">
          {{
            searchKeyword
              ? $t('tagDisplay.searchEmpty', { term: searchKeyword })
              : $t('tagDisplay.empty.title')
          }}
        </div>
        <div v-if="!searchKeyword" class="empty-desc">
          {{
            selectedGroupId
              ? $t('tagDisplay.empty.descGrouped')
              : $t('tagDisplay.empty.descUngrouped')
          }}
        </div>
      </div>

      <!--
        字母只是左边一列 14px 的锚点，不是一个 98px 高的区块。
        原来每个首字母都要「标题 + 分隔线 + 下边距 + 网格」，20 个标签能撑出 3 屏。
        搜索或按用量排序时锚点没有意义，退回一条平铺的流。
      -->
      <template v-else-if="showAnchors">
        <div v-for="row in anchoredRows" :key="row.letter" class="anchor-row">
          <div class="anchor-letter">{{ row.letter }}</div>
          <div class="tag-flow">
            <TagChip
              v-for="tag in row.tags"
              :key="tag.id"
              :tag="tag"
              :usage="usageOf(tag)"
              :selected="isSelected(tag)"
              :renaming="renamingTagId === tag.id"
              :rename-value="renamingTagName"
              @select="handleChipSelect(tag, $event)"
              @rename-input="renamingTagName = $event"
              @submit-rename="handleSubmitTagRename"
              @cancel-rename="handleCancelTagRename"
              @start-rename="handleStartRename"
              @toggle-favorite="handleToggleFavorite"
              @contextmenu="handleTagContextMenu(tag, $event)"
              @dragstart="handleDragStart(tag, $event)"
              @dragend="handleDragEnd"
            />
          </div>
        </div>
      </template>

      <div v-else class="tag-flow">
        <TagChip
          v-for="tag in sortedTags"
          :key="tag.id"
          :tag="tag"
          :usage="usageOf(tag)"
          :selected="isSelected(tag)"
          :renaming="renamingTagId === tag.id"
          :rename-value="renamingTagName"
          @select="handleChipSelect(tag, $event)"
          @rename-input="renamingTagName = $event"
          @submit-rename="handleSubmitTagRename"
          @cancel-rename="handleCancelTagRename"
          @start-rename="handleStartRename"
          @toggle-favorite="handleToggleFavorite"
          @contextmenu="handleTagContextMenu(tag, $event)"
          @dragstart="handleDragStart(tag, $event)"
          @dragend="handleDragEnd"
        />
      </div>

      <div v-if="filteredTags.length > 0" class="content-hint">
        {{ $t('tagDisplay.hint.drag') }} · {{ $t('tagDisplay.hint.rename') }} ·
        {{ $t('tagDisplay.hint.multiSelect') }}
      </div>
    </div>

    <!--
      批量操作条。200 个标签一个一个拖进分组是不可能的事，
      没有它，分组功能在这个规模上等于不存在。
    -->
    <div v-if="selectedIds.size > 0" class="batch-bar">
      <span class="batch-count">
        {{ $t('tagDisplay.batch.selected', { count: selectedIds.size }) }}
      </span>
      <div class="batch-actions">
        <AppDropdown v-if="tagGroups.length > 0" placement="topLeft">
          <AppButton size="small">{{ $t('tagDisplay.batch.moveToGroup') }}</AppButton>
          <template #overlay>
            <!--
              分组是用户自己建的，数量没有上限（真实库里见过 28 个）。
              不限高的话这张菜单会长到屏幕外面去 —— 顶部那几项直接够不着。
              限高之后 floating-ui 的 flip/shift 才有办法把它摆回可视区里。
            -->
            <AppMenu class="move-group-menu" @click="handleMoveMenuClick">
              <AppMenuItem v-for="g in tagGroups" :key="g.id" :item-key="String(g.id)">
                {{ g.name }}
              </AppMenuItem>
              <AppMenuDivider />
              <AppMenuItem item-key="none">{{ $t('tagDisplay.batch.ungroup') }}</AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>
        <AppButton size="small" @click="handleBatchFavorite">
          {{ $t('tagDisplay.batch.setFavorite') }}
        </AppButton>
        <AppButton size="small" danger @click="handleBatchDelete">
          {{ $t('tagDisplay.batch.delete') }}
        </AppButton>
        <AppButton variant="text" size="small" @click="clearSelection">
          {{ $t('tagDisplay.batch.clear') }}
        </AppButton>
      </div>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu ref="contextMenuRef" :menu-items="contextMenuItems" @click="handleMenuClick" />
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowsDownUp,
  PhCheck,
  PhMagnifyingGlass,
  PhPencilSimple,
  PhPlus,
  PhTag,
  PhTrash
} from '@phosphor-icons/vue'
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import type { MenuItem } from '@renderer/components/ContextMenu/types'
import type { Tag, TagGroup } from './types'
import TagChip from './TagChip.vue'
import { groupByAnchor, sortTags, usageOf as usageOfTag, type TagSortMode } from './tagOrdering'

interface Props {
  tags: Tag[]
  tagGroups: TagGroup[]
  /** tagId → 当前保管库里的引用数 */
  usageCounts: Record<number, number>
  selectedGroupId: number | null
  selectedGroupName: string
  quickFilter: 'all' | 'ungrouped' | 'favorite' | 'unused' | null
  renamingTagId: number | null
  renamingTagName: string
}

interface Emits {
  (e: 'createTag'): void
  (e: 'deleteTag', tagId: number): void
  (e: 'toggleFavorite', tag: Tag): void
  (e: 'dragTag', tag: Tag): void
  (e: 'dragEnd'): void
  (e: 'submitRename', payload: { id: number; name: string }): void
  (e: 'cancelRename'): void
  (e: 'update:renamingTagName', value: string): void
  (e: 'startRename', tag: Tag): void
  (e: 'batchMove', payload: { ids: number[]; groupId: number | null }): void
  (e: 'batchFavorite', ids: number[]): void
  (e: 'batchDelete', ids: number[]): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()

const searchKeyword = ref('')
const sortMode = ref<TagSortMode>('name')
const contextMenuRef = ref()
const selectedIds = ref<Set<number>>(new Set())
/** Shift 连选的锚点 */
let rangeAnchorId: number | null = null

const renamingTagName = computed({
  get: () => props.renamingTagName,
  set: (value: string) => emit('update:renamingTagName', value)
})
const renamingTagId = computed(() => props.renamingTagId)

/**
 * 右键菜单是标签**改名和删除**的唯一入口 —— chip 上不再挂 ✕。
 * 点在标签上就是那一个标签的菜单，点在空白处才是「新建标签」。
 */
const contextTag = ref<Tag | null>(null)

const contextMenuItems = computed((): MenuItem[] => {
  const tag = contextTag.value
  if (!tag) {
    return [
      { key: 'createTag', label: t('tagDisplay.createButton'), icon: PhPlus, shortcut: 'Ctrl+N' }
    ]
  }
  return [
    { key: 'renameTag', label: t('tagDisplay.actions.edit'), icon: PhPencilSimple },
    { type: 'divider' },
    { key: 'deleteTag', label: t('tagDisplay.actions.delete'), icon: PhTrash, danger: true }
  ]
})

const usageOf = (tag: Tag): number => usageOfTag(tag, props.usageCounts)

const currentGroupTags = computed((): Tag[] => {
  if (props.quickFilter) {
    switch (props.quickFilter) {
      case 'all':
        return props.tags
      case 'ungrouped':
        return props.tags.filter((tag) => !tag.group_id)
      case 'favorite':
        return props.tags.filter((tag) => tag.is_favorite)
      case 'unused':
        return props.tags.filter((tag) => usageOf(tag) === 0)
      default:
        return props.tags
    }
  }
  return props.tags.filter((tag) =>
    props.selectedGroupId === null ? !tag.group_id : tag.group_id === props.selectedGroupId
  )
})

const filteredTags = computed((): Tag[] => {
  if (!searchKeyword.value) return currentGroupTags.value
  const keyword = searchKeyword.value.toLowerCase()
  return currentGroupTags.value.filter((tag) => tag.name.toLowerCase().includes(keyword))
})

const sortedTags = computed((): Tag[] =>
  sortTags(filteredTags.value, sortMode.value, props.usageCounts)
)

/** 搜索中或按用量排序时，首字母锚点没有意义 */
const showAnchors = computed(() => sortMode.value === 'name' && !searchKeyword.value)

const anchoredRows = computed(() => groupByAnchor(sortedTags.value))

const countLabel = computed(() => {
  if (!searchKeyword.value) return String(currentGroupTags.value.length)
  return t('tagDisplay.matchCount', {
    matched: filteredTags.value.length,
    total: currentGroupTags.value.length
  })
})

// ==================== 多选 ====================
const isSelected = (tag: Tag): boolean => (tag.id ? selectedIds.value.has(tag.id) : false)

const clearSelection = (): void => {
  selectedIds.value = new Set()
  rangeAnchorId = null
}

/** 切走分组 / 改了筛选之后，选中的标签可能已经不在视野里了，一并清掉 */
watch(
  () => [props.selectedGroupId, props.quickFilter],
  () => clearSelection()
)

const handleChipSelect = (tag: Tag, event: MouseEvent): void => {
  if (!tag.id) return
  const next = new Set(selectedIds.value)
  const visible = showAnchors.value ? anchoredRows.value.flatMap((r) => r.tags) : sortedTags.value

  if (event.shiftKey && rangeAnchorId !== null) {
    const from = visible.findIndex((x) => x.id === rangeAnchorId)
    const to = visible.findIndex((x) => x.id === tag.id)
    if (from >= 0 && to >= 0) {
      visible.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((x) => {
        if (x.id) next.add(x.id)
      })
    }
  } else if (next.has(tag.id)) {
    next.delete(tag.id)
    rangeAnchorId = tag.id
  } else {
    next.add(tag.id)
    rangeAnchorId = tag.id
  }
  selectedIds.value = next
}

const selectedIdList = (): number[] => [...selectedIds.value]

const handleMoveMenuClick = ({ key }: { key: string }): void => {
  emit('batchMove', { ids: selectedIdList(), groupId: key === 'none' ? null : Number(key) })
  clearSelection()
}

const handleBatchFavorite = (): void => {
  emit('batchFavorite', selectedIdList())
  clearSelection()
}

const handleBatchDelete = (): void => {
  emit('batchDelete', selectedIdList())
  clearSelection()
}

// ==================== 单个标签 ====================
const handleSortMenuClick = ({ key }: { key: string }): void => {
  sortMode.value = key === 'usage' ? 'usage' : 'name'
}

const handleCreateNewTag = (): void => emit('createTag')
const handleStartRename = (tag: Tag): void => emit('startRename', tag)
const handleCancelTagRename = (): void => emit('cancelRename')
const handleDeleteTag = (tagId: number): void => emit('deleteTag', tagId)
const handleToggleFavorite = (tag: Tag): void => emit('toggleFavorite', tag)

const handleSubmitTagRename = (id: number): void => {
  emit('submitRename', { id, name: renamingTagName.value })
}

const handleDragStart = (tag: Tag, event: DragEvent): void => {
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/json', JSON.stringify(tag))
    event.dataTransfer.effectAllowed = 'move'
  }
  emit('dragTag', tag)
}

const handleDragEnd = (): void => emit('dragEnd')

const handleRightClick = (event: MouseEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  contextTag.value = null
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

const handleTagContextMenu = (tag: Tag, event: MouseEvent): void => {
  contextTag.value = tag
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

const handleMenuClick = (key: string, item: MenuItem): void => {
  void item
  const tag = contextTag.value
  if (key === 'createTag') {
    handleCreateNewTag()
    return
  }
  if (!tag?.id) return
  if (key === 'renameTag') handleStartRename(tag)
  else if (key === 'deleteTag') handleDeleteTag(tag.id)
}

const getQuickFilterTitle = (): string => {
  switch (props.quickFilter) {
    case 'all':
      return t('tagDisplay.quickFilterTitle.all')
    case 'ungrouped':
      return t('tagDisplay.quickFilterTitle.ungrouped')
    case 'favorite':
      return t('tagDisplay.quickFilterTitle.favorite')
    case 'unused':
      return t('tagDisplay.quickFilterTitle.unused')
    default:
      return t('tagDisplay.quickFilterTitle.default')
  }
}
</script>

<style scoped lang="less">
.tag-display {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border-subtle);
    flex-shrink: 0;

    .panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--color-text-primary);
      white-space: nowrap;

      .panel-count {
        margin-left: var(--space-2);
        font-size: 13px;
        font-weight: 400;
        color: var(--color-text-muted);
      }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    // 搜索是这一页的主角：标签一多，翻是翻不到的，只能搜
    .search-box {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 200px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid transparent;
      border-radius: var(--radius-xs);
      background: var(--color-bg-surface-hover);
      transition:
        background-color var(--motion-fast) var(--easing-standard),
        border-color var(--motion-fast) var(--easing-standard);

      &:hover {
        background: var(--color-bg-soft-hover);
      }

      &:focus-within {
        border-color: var(--color-border-focus);
        background: var(--color-bg-soft-hover);
      }

      .search-icon {
        flex-shrink: 0;
        font-size: 15px;
        color: var(--color-text-muted);
      }

      .search-input {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        color: var(--color-text-primary);
        font-family: inherit;
        font-size: 13px;
        outline: none;

        &::placeholder {
          color: var(--color-text-muted);
        }
      }
    }
  }

  .tags-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);

    // 轨道透明、滑块用边框色。用容器底色当滑块等于没有滚动条
    &::-webkit-scrollbar {
      width: 8px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: var(--radius-full);
      background: var(--color-border-strong);
      background-clip: content-box;
    }
  }

  .anchor-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin-bottom: var(--space-2);

    .anchor-letter {
      flex-shrink: 0;
      width: 16px;
      padding-top: 5px;
      font-size: 12px;
      color: var(--color-text-muted);
    }
  }

  .tag-flow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .content-hint {
    margin-top: var(--space-4);
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px var(--space-4);
    text-align: center;

    .empty-icon {
      margin-bottom: var(--space-3);
      font-size: 40px;
      color: var(--color-text-muted);
      opacity: 0.5;
    }

    .empty-text {
      margin-bottom: var(--space-2);
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-secondary);
    }

    .empty-desc {
      font-size: 13px;
      color: var(--color-text-muted);
    }
  }

  .batch-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    flex-shrink: 0;
    border-top: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);

    .batch-count {
      font-size: 12px;
      color: var(--color-text-secondary);
    }

    .batch-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
  }
}

/*
 * 浮层被 Teleport 挂到 <body>，不在 .tag-display 里面 —— 所以这条必须写在最外层，
 * 嵌进上面那个块就永远选不中。AppMenu 的根元素带着本组件的 scope id，`.move-group-menu`
 * 这一条照样只作用于这张菜单。
 */
.move-group-menu {
  max-height: 320px;
  overflow-y: auto;
}
</style>
