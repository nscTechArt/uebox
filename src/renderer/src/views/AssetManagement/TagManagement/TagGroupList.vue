<template>
  <div class="tag-group-list">
    <!-- 快捷选择项。不再顶一行「标签管理」标题 —— 你是从菜单里的同名项点进来的 -->
    <div class="quick-filters">
      <div
        class="filter-item"
        :class="{ 'filter-item-active': quickFilter === 'all' && selectedGroupId === null }"
        @click="handleQuickFilter('all')"
      >
        <span class="filter-name">{{ $t('tagGroupList.filters.all') }}</span>
        <span class="count-badge">{{ totalTagCount }}</span>
      </div>
      <div
        class="filter-item"
        :class="{
          'filter-item-active': quickFilter === 'ungrouped' && selectedGroupId === null,
          'filter-item-drag-over': dragOverFilter === 'ungrouped'
        }"
        @click="handleQuickFilter('ungrouped')"
        @dragover.prevent="handleFilterDragOver('ungrouped', $event)"
        @dragleave="handleFilterDragLeave"
        @drop="handleFilterDrop('ungrouped', $event)"
      >
        <span class="filter-name">{{ $t('tagGroupList.filters.ungrouped') }}</span>
        <span class="count-badge">{{ ungroupedTagCount }}</span>
      </div>
      <div
        class="filter-item"
        :class="{
          'filter-item-active': quickFilter === 'favorite' && selectedGroupId === null,
          'filter-item-drag-over': dragOverFilter === 'favorite'
        }"
        @click="handleQuickFilter('favorite')"
        @dragover.prevent="handleFilterDragOver('favorite', $event)"
        @dragleave="handleFilterDragLeave"
        @drop="handleFilterDrop('favorite', $event)"
      >
        <span class="filter-name">{{ $t('tagGroupList.filters.favorite') }}</span>
        <span class="count-badge">{{ favoriteTagCount }}</span>
      </div>
      <!--
        标签一多就会堆积手滑建的、拼错的、试完忘了删的。
        这是唯一能把它们一次性拎出来的入口；数字按当前保管库算，所以文案写「本库未使用」。
      -->
      <div
        v-if="unusedTagCount > 0"
        class="filter-item"
        :class="{ 'filter-item-active': quickFilter === 'unused' && selectedGroupId === null }"
        :title="$t('tagGroupList.filters.unusedTip')"
        @click="handleQuickFilter('unused')"
      >
        <span class="filter-name">{{ $t('tagGroupList.filters.unused') }}</span>
        <span class="count-badge">{{ unusedTagCount }}</span>
      </div>
    </div>
    <div class="panel-header">
      <h3 class="panel-title">{{ $t('tagGroupList.groupsTitle') }}</h3>
      <AppButton
        variant="text"
        size="small"
        shape="circle"
        :title="$t('tagGroupList.empty.action')"
        :aria-label="$t('tagGroupList.empty.action')"
        @click="handleCreateGroup"
      >
        <template #icon><PhPlus /></template>
      </AppButton>
    </div>

    <div class="group-list">
      <!-- 标签组列表 -->
      <div
        v-for="group in tagGroups"
        :key="group.id"
        class="group-item"
        :class="{
          'group-item-active': selectedGroupId === group.id && quickFilter === null,
          'group-item-drag-over': dragOverGroupId === group.id
        }"
        @click="handleSelectGroup(group.id!)"
        @dblclick="handleEditGroup(group)"
        @contextmenu.prevent.stop="openGroupMenu(group, $event)"
        @dragover.prevent="handleDragOver(group.id!, $event)"
        @dragleave="handleDragLeave"
        @drop="handleDrop(group.id!, $event)"
      >
        <div class="group-info">
          <input
            v-if="renamingGroupId === group.id"
            :ref="(el) => setRenameInputRef(el, group.id!)"
            class="group-name-input"
            type="text"
            :value="renamingName"
            @click.stop
            @dblclick.stop
            @input="renamingValue = ($event.target as HTMLInputElement).value"
            @focus="renameFocused = true"
            @keydown.enter="handleSubmitRename(group.id!)"
            @keydown.esc="handleCancelRename"
            @blur="handleRenameBlur(group.id!)"
          />
          <div v-else class="group-name">{{ group.name }}</div>
        </div>

        <div class="group-actions">
          <div class="count-badge">{{ group.tagCount || 0 }}</div>
          <AppButton
            variant="text"
            size="small"
            :title="$t('tagGroupList.menu.more')"
            :aria-label="$t('tagGroupList.menu.more')"
            @click.stop="openGroupMenu(group, $event)"
          >
            <template #icon>
              <PhDotsThree />
            </template>
          </AppButton>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="tagGroups.length === 0" class="empty-state">
        <div class="empty-icon">
          <PhFolderOpen />
        </div>
        <div class="empty-text">{{ $t('tagGroupList.empty.title') }}</div>
        <div class="empty-description">{{ $t('tagGroupList.empty.desc') }}</div>
        <AppButton variant="primary" size="small" class="empty-action" @click="handleCreateGroup">
          <template #icon><PhPlus /></template>
          {{ $t('tagGroupList.empty.action') }}
        </AppButton>
      </div>
    </div>

    <!-- 改名和删除只有这一张菜单：行上右键，或者点行尾的 ⋯ -->
    <ContextMenu ref="groupMenuRef" :menu-items="groupMenuItems" @click="handleGroupMenuClick" />
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import type { MenuItem } from '@renderer/components/ContextMenu/types'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhDotsThree, PhFolderOpen, PhPencilSimple, PhPlus, PhTrash } from '@phosphor-icons/vue'
import type { TagGroup, Tag } from './types'

type QuickFilter = 'all' | 'ungrouped' | 'favorite' | 'unused' | null

interface Props {
  tagGroups: TagGroup[]
  selectedGroupId: number | null
  ungroupedTagCount: number
  totalTagCount: number
  favoriteTagCount: number
  /** 当前保管库里一次都没被用到的标签数 */
  unusedTagCount: number
  quickFilter: QuickFilter
  renamingGroupId: number | null
  renamingName: string
}

interface Emits {
  (e: 'selectGroup', groupId: number | null): void
  (e: 'createGroup'): void
  (e: 'startRenameGroup', group: TagGroup): void
  (e: 'deleteGroup', groupId: number): void
  (e: 'quickFilter', filter: Exclude<QuickFilter, null>): void
  (e: 'dropTag', tag: Tag, groupId: number): void
  (e: 'dropToUngrouped', tag: Tag): void
  (e: 'dropToFavorite', tag: Tag): void
  (e: 'update:renamingName', name: string): void
  (e: 'submitRename', payload: { id: number; name: string }): void
  (e: 'cancelRename'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()

const dragOverGroupId = ref<number | null>(null)
const dragOverFilter = ref<'ungrouped' | 'favorite' | null>(null)
const renameInputRef = ref<HTMLInputElement | null>(null)
/**
 * 输入框是不是真的拿到过焦点。
 *
 * 菜单关掉时浮层会把焦点还给触发器（AppDropdown 的既定行为），这一下发生在
 * 输入框刚挂上、还没聚焦的那一瞬。没有这个开关的话，那次焦点变动会被当成
 * 「用户改完了」触发一次提交，名字没变 → 直接退出编辑态 ——
 * 表现就是「点了重命名，框一闪就没了，改不动」。
 */
const renameFocused = ref(false)
/** Enter/Esc 已经结束这一轮了，后面补来的 blur 不能再提交一次 */
let renameSettled = false

const renamingValue = computed({
  get: () => props.renamingName,
  set: (val) => emit('update:renamingName', val)
})

watch(
  () => props.renamingGroupId,
  (id) => {
    renameFocused.value = false
    renameSettled = false
    if (id === null) return
    nextTick(() => {
      // 再排一个宏任务：浮层的焦点归位是在 post-flush 里做的，
      // 直接在 nextTick 里聚焦会跟它抢，抢输了框就是灰的
      setTimeout(() => {
        renameInputRef.value?.focus()
        renameInputRef.value?.select()
      }, 0)
    })
  }
)

const setRenameInputRef = (el: unknown, groupId: number): void => {
  if (props.renamingGroupId === groupId) {
    renameInputRef.value = (el as HTMLInputElement | null) ?? null
  }
}

const handleSelectGroup = (groupId: number | null) => {
  emit('selectGroup', groupId)
}

const handleCreateGroup = () => {
  emit('createGroup')
}

/**
 * 处理编辑标签组（触发行内编辑模式）
 * @param group 要编辑的标签组
 */
const handleEditGroup = (group: TagGroup): void => {
  emit('startRenameGroup', group)
}

const handleDeleteGroup = (groupId: number) => {
  emit('deleteGroup', groupId)
}

// ==================== 右键菜单 ====================
const groupMenuRef = ref<{ show: (x: number, y: number) => void } | null>(null)
/** 菜单打开时点的是哪一组 —— 菜单本身是共用的一张 */
const menuGroup = ref<TagGroup | null>(null)

const groupMenuItems = computed((): MenuItem[] => [
  { key: 'rename', label: t('tagGroupList.menu.edit'), icon: PhPencilSimple },
  { type: 'divider' },
  { key: 'delete', label: t('tagGroupList.menu.delete'), icon: PhTrash, danger: true }
])

const openGroupMenu = (group: TagGroup, event: MouseEvent): void => {
  menuGroup.value = group
  groupMenuRef.value?.show(event.clientX, event.clientY)
}

const handleGroupMenuClick = (key: string): void => {
  const group = menuGroup.value
  if (!group?.id) return
  if (key === 'rename') handleEditGroup(group)
  else if (key === 'delete') handleDeleteGroup(group.id)
}

const handleQuickFilter = (filter: Exclude<QuickFilter, null>) => {
  emit('quickFilter', filter)
}

const handleDragOver = (groupId: number, event: DragEvent) => {
  event.preventDefault()
  dragOverGroupId.value = groupId
}

const handleDragLeave = () => {
  dragOverGroupId.value = null
}

const handleDrop = (groupId: number, event: DragEvent) => {
  event.preventDefault()
  dragOverGroupId.value = null

  try {
    const tagData = event.dataTransfer?.getData('application/json')
    if (tagData) {
      const tag: Tag = JSON.parse(tagData)
      emit('dropTag', tag, groupId)
    }
  } catch (error) {
    console.error('解析拖拽数据失败:', error)
  }
}

// 快捷筛选区域拖拽处理
const handleFilterDragOver = (filter: 'ungrouped' | 'favorite', event: DragEvent) => {
  event.preventDefault()
  dragOverFilter.value = filter
}

const handleFilterDragLeave = () => {
  dragOverFilter.value = null
}

const handleFilterDrop = (filter: 'ungrouped' | 'favorite', event: DragEvent) => {
  event.preventDefault()
  dragOverFilter.value = null

  try {
    const tagData = event.dataTransfer?.getData('application/json')
    if (tagData) {
      const tag: Tag = JSON.parse(tagData)
      if (filter === 'ungrouped') {
        emit('dropToUngrouped', tag)
      } else if (filter === 'favorite') {
        emit('dropToFavorite', tag)
      }
    }
  } catch (error) {
    console.error('解析拖拽数据失败:', error)
  }
}

const handleSubmitRename = (groupId: number) => {
  renameSettled = true
  emit('submitRename', { id: groupId, name: renamingValue.value })
}

/** 只有输入框自己拿到过焦点、而且还没提交过，才把失焦当成一次提交 */
const handleRenameBlur = (groupId: number): void => {
  if (renameSettled || !renameFocused.value) return
  handleSubmitRename(groupId)
}

const handleCancelRename = () => {
  renameSettled = true
  emit('cancelRename')
}
</script>

<style scoped lang="less">
.tag-group-list {
  width: 300px;
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;

  .panel-header {
    padding: var(--space-2);

    display: flex;
    justify-content: space-between;
    align-items: center;

    .panel-title {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--color-text-primary);
    }
  }

  .quick-filters {
    padding: var(--space-1) var(--space-1);
    margin-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);

    .filter-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--motion-fast) var(--easing-standard);

      &:hover {
        background: var(--color-bg-surface-hover);
      }

      &.filter-item-active {
        // 选中态走 --color-bg-selected：原来的浅灰/浅青渐变在亮色底上完全看不见。
        background: var(--color-bg-selected);

        .filter-name {
          color: var(--color-text-primary);
          font-weight: 500;
        }
      }

      // 用 outline 而不是 border：border 会把盒子撑大 4px，
      // 再叠个 scale，落点正好在鼠标底下抽搐
      &.filter-item-drag-over {
        background: var(--color-accent-bg);
        outline: 2px dashed var(--color-accent-border);
        outline-offset: -2px;
      }

      .filter-name {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-text-secondary);
      }

      .count-badge {
        margin-left: auto;
        flex-shrink: 0;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: var(--color-text-muted);
      }
    }
  }

  .group-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);

    .group-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--space-2) var(--space-3);
      margin-bottom: var(--space-1);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--motion-fast) var(--easing-standard);

      &:hover {
        background: var(--color-bg-surface-hover);
      }

      &.group-item-active {
        // 选中态走 --color-bg-selected：原来的浅灰/浅青渐变在亮色底上完全看不见。
        background: var(--color-bg-selected);

        .group-name {
          color: var(--color-text-primary) !important;
          font-weight: 500;
        }
      }

      &.group-item-drag-over {
        background: var(--color-accent-bg);
        outline: 2px dashed var(--color-accent-border);
        outline-offset: -2px;
      }

      .group-info {
        min-width: 0;
        flex: 1;

        .group-name {
          overflow: hidden;
          font-size: 12px;
          font-weight: 500;
          color: var(--color-text-secondary);
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        // 和 TagChip 的改名框同一副长相：这一页里「正在改名」应该只有一种样子
        .group-name-input {
          width: 100%;
          height: 20px;
          padding: 0 4px;
          border: 1px solid var(--color-border-focus);
          border-radius: 2px;
          background: var(--color-bg-page);
          color: var(--color-text-primary);
          font-family: inherit;
          font-size: 12px;
          outline: none;
        }
      }
      // 徽章不可点，不给它 hover 样式
      .count-badge {
        margin-left: auto;
        flex-shrink: 0;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: var(--color-text-muted);
      }

      .group-actions {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: var(--space-1);
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--space-8) var(--space-4);
      text-align: center;

      .empty-icon {
        font-size: 48px;
        color: var(--color-text-muted);
        margin-bottom: var(--space-4);
        opacity: 0.6;
      }

      .empty-text {
        font-size: 16px;
        font-weight: 500;
        color: var(--color-text-secondary);
        margin-bottom: var(--space-2);
      }

      .empty-description {
        font-size: 14px;
        color: var(--color-text-muted);
        margin-bottom: var(--space-6);
        line-height: 1.5;
      }

      .empty-action {
        border-radius: var(--radius-xs);
      }
    }
  }
}
</style>
