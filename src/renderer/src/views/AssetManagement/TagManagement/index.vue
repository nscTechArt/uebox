<template>
  <div class="tag-management">
    <!--
      服务器库：文件已不在（删除、或移动后没配上）的标签和备注。只在有的时候出现一行，
      展开能看到是哪些、能认领到服务端建议的那个资产（同样字节的文件）上。
    -->
    <div v-if="unclaimed.length > 0" class="unclaimed-notice">
      <button type="button" class="unclaimed-toggle" @click="unclaimedOpen = !unclaimedOpen">
        {{ t('catalogLibrary.unclaimed.notice', { count: unclaimed.length }) }}
        <span class="unclaimed-action">{{
          unclaimedOpen ? t('catalogLibrary.unclaimed.hide') : t('catalogLibrary.unclaimed.show')
        }}</span>
      </button>
      <ul v-if="unclaimedOpen" class="unclaimed-list">
        <li v-for="item in unclaimed" :key="item.path" class="unclaimed-item">
          <span class="unclaimed-path" :title="item.path">{{ item.path }}</span>
          <span v-if="item.tags.length" class="unclaimed-tags">{{ item.tags.join('、') }}</span>
          <AppButton
            v-if="item.suggestions.length > 0"
            size="small"
            :title="item.suggestions[0].path"
            @click="handleClaim(item.path, item.suggestions[0].path)"
          >
            {{
              t('catalogLibrary.unclaimed.claimTo', { name: baseName(item.suggestions[0].path) })
            }}
          </AppButton>
          <span v-else class="unclaimed-none">{{
            t('catalogLibrary.unclaimed.noSuggestion')
          }}</span>
        </li>
      </ul>
    </div>
    <div class="tag-management-container" :class="{ 'dragging-active': isDragging }">
      <!-- 左侧标签组列表 -->
      <TagGroupList
        v-model:renaming-name="renamingGroupName"
        :tag-groups="tagGroups"
        :selected-group-id="selectedGroupId"
        :ungrouped-tag-count="ungroupedTagCount"
        :total-tag-count="totalTagCount"
        :favorite-tag-count="favoriteTagCount"
        :unused-tag-count="unusedTagCount"
        :quick-filter="quickFilter"
        :renaming-group-id="renamingGroupId"
        :hide-favorite="!registry.abilities.favorite"
        @select-group="handleSelectGroup"
        @create-group="handleCreateGroup"
        @start-rename-group="handleStartRenameGroup"
        @delete-group="handleDeleteGroup"
        @quick-filter="handleQuickFilter"
        @drop-tag="handleDropTag"
        @drop-to-ungrouped="handleDropToUngrouped"
        @drop-to-favorite="handleDropToFavorite"
        @submit-rename="handleSubmitGroupRename"
        @cancel-rename="handleCancelGroupRename"
      />

      <!-- 右侧标签展示区域 -->
      <TagDisplay
        v-model:renaming-tag-name="renamingTagName"
        :tags="tags"
        :tag-groups="tagGroups"
        :usage-counts="usageCounts"
        :selected-group-id="selectedGroupId"
        :selected-group-name="selectedGroupName"
        :quick-filter="quickFilter"
        :renaming-tag-id="renamingTagId"
        :hide-favorite="!registry.abilities.favorite"
        @create-tag="handleCreateTag"
        @start-rename="handleStartRename"
        @delete-tag="handleDeleteTag"
        @toggle-favorite="handleToggleFavorite"
        @drag-tag="handleDragTag"
        @drag-end="handleDragEnd"
        @submit-rename="handleSubmitTagRename"
        @cancel-rename="handleCancelTagRename"
        @batch-move="handleBatchMove"
        @batch-favorite="handleBatchFavorite"
        @batch-delete="handleBatchDelete"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import TagGroupList from './TagGroupList.vue'
import AppButton from '@renderer/components/AppButton.vue'
import type { CatalogUnclaimed } from '@core/shared/catalogLibrary'
import TagDisplay from './TagDisplay.vue'
import type { TagGroup, Tag } from './types'
import { DEFAULT_TAG_GROUP_COLOR } from './types'
import { useTagStatsStore } from '@renderer/store/modules/tagStatsStore'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import type { LibraryTagRegistryApi } from '../data/AssetLibrarySource'

type QuickFilter = 'all' | 'ungrouped' | 'favorite' | 'unused' | null

// 响应式数据
const tagGroups = ref<TagGroup[]>([])
const tags = ref<Tag[]>([])
const selectedGroupId = ref<number | null>(null)
const quickFilter = ref<QuickFilter>(null)
/**
 * tagId → 当前保管库里的引用数。
 *
 * 标签存在公共库（全局），asset_tags 存在保管库里，所以这个数字是**按库**算的。
 * 界面上一律说成「本库用量」，不能让人以为 0 就能放心删 —— 别的库可能还在用。
 */
const usageCounts = ref<Record<number, number>>({})
const isDragging = ref(false)
const renamingGroupId = ref<number | null>(null)
const renamingGroupName = ref('')
const renamingSubmitting = ref(false)

// 标签重命名状态
const renamingTagId = ref<number | null>(null)
const renamingTagName = ref('')
const renamingTagSubmitting = ref(false)

const tagStatsStore = useTagStatsStore()
const { t } = useI18n()

/**
 * 标签从哪里来：本地库是公共标签库，服务器库是那个库的标签注册表。
 * 页面只认 registry 的这组方法；做不到的（服务器库的「常用」、改名已在用的标签）看 abilities。
 */
const libraryStore = useAssetLibraryStore()
const registry = computed((): LibraryTagRegistryApi => libraryStore.source.tagRegistry)

/** 服务器库：已挂在资产上的标签不能在这里改名 / 删除（要逐个改资产），说一句原因 */
const blockedByUsage = (tag: Tag | undefined): boolean => {
  if (!tag?.id || registry.value.abilities.renameUsed) return false
  const count = usageCounts.value[tag.id] ?? 0
  if (count === 0) return false
  message.warning(t('catalogLibrary.reasons.tagInUse', { count }))
  return true
}

// 计算属性
const selectedGroupName = computed(() => {
  if (selectedGroupId.value === null) return t('tagManagement.ungrouped')
  const group = tagGroups.value.find((g) => g.id === selectedGroupId.value)
  return group ? group.name : t('tagManagement.unknownGroup')
})

const ungroupedTagCount = computed(() => {
  return tags.value.filter((tag) => !tag.group_id).length
})

const totalTagCount = computed(() => {
  return tags.value.length
})

const favoriteTagCount = computed(() => {
  return tags.value.filter((tag) => tag.is_favorite).length
})

const unusedTagCount = computed(() => {
  return tags.value.filter((tag) => !tag.id || !usageCounts.value[tag.id]).length
})

// 标签组操作
const handleSelectGroup = (groupId: number | null) => {
  selectedGroupId.value = groupId
  quickFilter.value = null // 清除快捷选择状态
}

const handleQuickFilter = (filter: Exclude<QuickFilter, null>) => {
  quickFilter.value = filter
  selectedGroupId.value = null // 清除分组选择状态
}

const generateDefaultGroupName = () => {
  const baseName = t('tagManagement.defaultGroupName')
  const existingNames = new Set(tagGroups.value.map((group) => group.name))
  if (!existingNames.has(baseName)) return baseName

  let index = 1
  let candidate = `${baseName}-${index}`
  while (existingNames.has(candidate)) {
    index += 1
    candidate = `${baseName}-${index}`
  }
  return candidate
}

const handleCreateGroup = async () => {
  handleCancelGroupRename()
  const defaultName = generateDefaultGroupName()
  try {
    const createdId = await registry.value.createGroup(
      defaultName,
      tagGroups.value.length + 1,
      DEFAULT_TAG_GROUP_COLOR
    )

    if (createdId !== null) {
      message.success(t('tagManagement.messages.groupCreated'))
      await loadGroups()
      const newId = createdId || null
      if (newId) {
        renamingGroupId.value = newId
        const createdGroup = tagGroups.value.find((group) => group.id === newId)
        renamingGroupName.value = createdGroup?.name ?? defaultName
        selectedGroupId.value = newId
        quickFilter.value = null
      }
    } else {
      message.error(t('tagManagement.messages.groupCreateFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.groupCreateFailed'))
  }
}

/**
 * 处理开始重命名标签组（编辑按钮点击）
 * @param group 要重命名的标签组
 */
const handleStartRenameGroup = (group: TagGroup): void => {
  handleCancelGroupRename() // 先取消可能正在进行的重命名
  renamingGroupId.value = group.id ?? null
  renamingGroupName.value = group.name
}

const handleDeleteGroup = async (id: number) => {
  confirmDialog({
    title: t('tagManagement.deleteGroupConfirm.title'),
    content: t('tagManagement.deleteGroupConfirm.content'),
    okText: t('tagManagement.deleteGroupConfirm.okText'),
    cancelText: t('tagManagement.deleteGroupConfirm.cancelText'),
    danger: true,
    async onOk() {
      try {
        if (await registry.value.deleteGroup(id)) {
          message.success(t('tagManagement.messages.groupDeleted'))
          if (selectedGroupId.value === id) {
            selectedGroupId.value = null
          }
          if (renamingGroupId.value === id) {
            handleCancelGroupRename()
          }
          await loadGroups()
          await loadTags()
        } else {
          message.error(t('tagManagement.messages.groupDeleteFailed'))
        }
      } catch (error) {
        message.error(t('tagManagement.messages.deleteFailed'))
      }
    }
  })
}

const handleSubmitGroupRename = async ({ id, name }: { id: number; name: string }) => {
  if (renamingSubmitting.value) return

  const trimmedName = name.trim()
  if (!trimmedName) {
    message.error(t('tagManagement.messages.groupNameRequired'))
    return
  }

  const currentGroup = tagGroups.value.find((group) => group.id === id)
  if (currentGroup && currentGroup.name === trimmedName) {
    handleCancelGroupRename()
    return
  }

  const duplicate = tagGroups.value.some((group) => group.id !== id && group.name === trimmedName)
  if (duplicate) {
    message.error(t('tagManagement.messages.groupNameDuplicate'))
    return
  }

  renamingSubmitting.value = true
  try {
    if (await registry.value.renameGroup(id, trimmedName)) {
      message.success(t('tagManagement.messages.groupNameUpdated'))
      handleCancelGroupRename()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.groupUpdateFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.groupUpdateFailed'))
  } finally {
    renamingSubmitting.value = false
  }
}

const handleCancelGroupRename = () => {
  renamingGroupId.value = null
  renamingGroupName.value = ''
}

// 标签操作
/**
 * 生成默认标签名称
 * 如果已存在"新标签"则按 新标签-1, 新标签-2 递增
 */
const generateDefaultTagName = (): string => {
  const baseName = t('tagManagement.defaultTagName')
  const existingNames = new Set(tags.value.map((tag) => tag.name))
  if (!existingNames.has(baseName)) return baseName

  let index = 1
  let candidate = `${baseName}-${index}`
  while (existingNames.has(candidate)) {
    index += 1
    candidate = `${baseName}-${index}`
  }
  return candidate
}

/**
 * 处理创建标签
 * 直接创建一个默认名称的标签，并自动进入编辑模式
 */
const handleCreateTag = async (): Promise<void> => {
  handleCancelTagRename()
  const defaultName = generateDefaultTagName()
  try {
    const createdId = await registry.value.createTag(
      defaultName,
      quickFilter.value ? null : selectedGroupId.value,
      quickFilter.value === 'favorite'
    )

    if (createdId !== null) {
      await loadTags()
      await loadGroups()
      const newId = createdId || null
      if (newId) {
        // 进入重命名模式
        renamingTagId.value = newId
        const createdTag = tags.value.find((tag) => tag.id === newId)
        renamingTagName.value = createdTag?.name ?? defaultName
      }
    } else {
      message.error(t('tagManagement.messages.tagCreateFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.tagCreateFailed'))
  }
}

/**
 * 处理标签重命名提交
 * @param payload 包含标签ID和新名称的对象
 */
const handleSubmitTagRename = async (payload: { id: number; name: string }): Promise<void> => {
  if (renamingTagSubmitting.value) return

  const trimmedName = payload.name.trim()
  if (!trimmedName) {
    message.error(t('tagManagement.messages.tagNameRequired'))
    return
  }

  const currentTag = tags.value.find((tag) => tag.id === payload.id)
  if (currentTag && currentTag.name === trimmedName) {
    handleCancelTagRename()
    return
  }

  const duplicate = tags.value.some((tag) => tag.id !== payload.id && tag.name === trimmedName)
  if (duplicate) {
    message.error(t('tagManagement.messages.tagNameDuplicate'))
    return
  }

  renamingTagSubmitting.value = true
  try {
    if (await registry.value.renameTag(payload.id, trimmedName)) {
      handleCancelTagRename()
      await loadTags()
    } else {
      message.error(t('tagManagement.messages.tagUpdateFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.tagUpdateFailed'))
  } finally {
    renamingTagSubmitting.value = false
  }
}

/**
 * 取消标签重命名
 */
const handleCancelTagRename = (): void => {
  renamingTagId.value = null
  renamingTagName.value = ''
}

/**
 * 处理开始重命名（编辑按钮点击）
 * @param tag 要重命名的标签
 */
const handleStartRename = (tag: Tag): void => {
  handleCancelTagRename() // 先取消可能正在进行的重命名
  if (blockedByUsage(tag)) return
  renamingTagId.value = tag.id ?? null
  renamingTagName.value = tag.name
}

const handleDeleteTag = async (id: number) => {
  if (blockedByUsage(tags.value.find((tag) => tag.id === id))) return
  try {
    if ((await registry.value.deleteTags([id])) > 0) {
      message.success(t('tagManagement.messages.tagDeleted'))
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.tagDeleteFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.deleteFailed'))
  }
}

const handleToggleFavorite = async (tag: Tag) => {
  try {
    if (await registry.value.toggleFavorite(tag.id!)) {
      message.success(
        tag.is_favorite
          ? t('tagManagement.messages.favoriteRemoved')
          : t('tagManagement.messages.favoriteSet')
      )
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.operationFailed'))
    }
  } catch (error) {
    message.error(t('tagManagement.messages.operationFailed'))
  }
}

// 拖拽操作
const handleDragTag = (tag: Tag) => {
  // 拖拽开始时的处理，可以在这里添加一些状态管理
  isDragging.value = true
  console.log('开始拖拽标签:', tag.name)
}

const handleDragEnd = () => {
  // 拖拽结束时重置状态
  isDragging.value = false
}

const handleDropTag = async (tag: Tag, groupId: number) => {
  try {
    // 重置拖拽状态
    isDragging.value = false

    // 如果标签已经在目标分组中，则不需要更新
    if (tag.group_id === groupId) {
      message.info(t('tagManagement.messages.tagAlreadyInGroup'))
      return
    }

    if (await registry.value.update(tag.id!, { group_id: groupId })) {
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.moveTagFailed'))
    }
  } catch (error) {
    console.error('移动标签失败:', error)
    message.error(t('tagManagement.messages.moveTagFailed'))
  }
}

// 拖拽到未分组
const handleDropToUngrouped = async (tag: Tag) => {
  try {
    // 重置拖拽状态
    isDragging.value = false

    // 如果标签已经是未分组，则不需要更新
    if (!tag.group_id) {
      message.info(t('tagManagement.messages.tagAlreadyUngrouped'))
      return
    }

    if (await registry.value.update(tag.id!, { group_id: null })) {
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.moveTagFailed'))
    }
  } catch (error) {
    console.error('移动标签到未分组失败:', error)
    message.error(t('tagManagement.messages.moveTagFailed'))
  }
}

// 拖拽到常用
const handleDropToFavorite = async (tag: Tag) => {
  try {
    // 重置拖拽状态
    isDragging.value = false

    // 如果标签已经是常用，则不需要更新
    if (tag.is_favorite) {
      message.info(t('tagManagement.messages.tagAlreadyFavorite'))
      return
    }

    if (await registry.value.update(tag.id!, { is_favorite: true })) {
      message.success(t('tagManagement.messages.tagSetFavorite'))
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.setFavoriteFailed'))
    }
  } catch (error) {
    console.error('设置标签为常用失败:', error)
    message.error(t('tagManagement.messages.setFavoriteFailed'))
  }
}

// 数据加载
const loadGroups = async () => {
  try {
    const groups = (await registry.value.groups()) as TagGroup[]
    {
      tagGroups.value = groups
      if (renamingGroupId.value !== null) {
        const renamingGroup = groups.find((group) => group.id === renamingGroupId.value)
        if (renamingGroup) {
          renamingGroupName.value = renamingGroup.name
        } else {
          handleCancelGroupRename()
        }
      }
    }
  } catch (error) {
    message.error(t('tagManagement.messages.loadGroupsFailed'))
  }
}

const loadTags = async () => {
  try {
    const loaded = (await registry.value.tags()) as Tag[]
    {
      tags.value = loaded
      // 同步标签总数到 store，供其它视图展示
      tagStatsStore.setTotalCount(Array.isArray(tags.value) ? tags.value.length : 0)
    }
  } catch (error) {
    message.error(t('tagManagement.messages.loadTagsFailed'))
  }
}

/**
 * 加载每个标签在当前保管库里的引用数。
 *
 * 拿不到就退回空表（所有标签显示 0）—— 这一页的其它功能不该被统计失败拖垮。
 */
const loadUsageCounts = async (): Promise<void> => {
  try {
    usageCounts.value = await registry.value.usageCounts()
  } catch (error) {
    console.error('加载标签用量失败:', error)
    usageCounts.value = {}
  }
}

// ==================== 批量操作 ====================
const handleBatchMove = async (payload: {
  ids: number[]
  groupId: number | null
}): Promise<void> => {
  if (payload.ids.length === 0) return
  try {
    const moved = await registry.value.moveToGroup(payload.ids, payload.groupId)
    if (moved > 0) {
      message.success(t('tagDisplay.batch.moved', { count: moved }))
      await loadTags()
      await loadGroups()
    } else {
      message.error(t('tagManagement.messages.moveTagFailed'))
    }
  } catch (error) {
    console.error('批量移动标签失败:', error)
    message.error(t('tagManagement.messages.moveTagFailed'))
  }
}

const handleBatchFavorite = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return
  try {
    // 批量「设为常用」是单向的：已经是常用的跳过，避免把它们反向取消
    const targets = ids.filter((id) => !tags.value.find((tag) => tag.id === id)?.is_favorite)
    await Promise.all(targets.map((id) => registry.value.update(id, { is_favorite: true })))
    message.success(t('tagDisplay.batch.favorited'))
    await loadTags()
  } catch (error) {
    console.error('批量设为常用失败:', error)
    message.error(t('tagManagement.messages.setFavoriteFailed'))
  }
}

const handleBatchDelete = (ids: number[]): void => {
  if (ids.length === 0) return
  confirmDialog({
    title: t('tagDisplay.batch.deleteConfirmTitle', { count: ids.length }),
    content: t('tagDisplay.batch.deleteConfirmContent'),
    okText: t('tagManagement.deleteGroupConfirm.okText'),
    cancelText: t('tagManagement.deleteGroupConfirm.cancelText'),
    danger: true,
    async onOk() {
      try {
        const deleted = await registry.value.deleteTags(ids)
        if (deleted > 0 || ids.length === 0) {
          message.success(t('tagDisplay.batch.deleted', { count: deleted }))
          await loadTags()
          await loadGroups()
          await loadUsageCounts()
        } else {
          message.error(t('tagManagement.messages.tagDeleteFailed'))
        }
      } catch (error) {
        console.error('批量删除标签失败:', error)
        message.error(t('tagManagement.messages.tagDeleteFailed'))
      }
    }
  })
}

// ==================== 待认领的注释（服务器库） ====================
const unclaimed = ref<CatalogUnclaimed[]>([])
const unclaimedOpen = ref(false)
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const loadUnclaimed = async (): Promise<void> => {
  try {
    unclaimed.value = (await registry.value.unclaimed?.()) ?? []
  } catch {
    unclaimed.value = []
  }
}

const handleClaim = async (from: string, to: string): Promise<void> => {
  if (!registry.value.claim) return
  if (await registry.value.claim(from, to)) {
    message.success(t('catalogLibrary.unclaimed.claimed', { name: baseName(to) }))
    await loadUnclaimed()
    await loadTags()
    await loadUsageCounts()
  } else {
    message.error(t('catalogLibrary.unclaimed.claimFailed'))
  }
}

// 初始化
onMounted(async () => {
  await loadGroups()
  await loadTags()
  await loadUsageCounts()
  await loadUnclaimed()
})
</script>

<style scoped lang="less">
.tag-management {
  /*
   * 开在弹窗里，高度固定。跟内容走的话，筛掉几个标签、少折一行，
   * 整个弹窗就跳一次高 —— 和上一轮标签选择器踩的是同一个坑。
   * 原来这里写死 calc(100vh - 36px)，那是当整页用时假定的标题栏高度。
   */
  height: 660px;
  max-height: calc(100vh - 200px);
  min-height: 0;
  overflow: hidden;

  display: flex;
  flex-direction: column;

  .tag-management-container {
    display: flex;
    flex: 1;
    height: 100%;
    min-height: 0;
  }
}

.unclaimed-notice {
  flex-shrink: 0;
  margin-bottom: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-xs);
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: var(--font-size-sm);
}

.unclaimed-toggle {
  display: flex;
  gap: var(--space-2);
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.unclaimed-action {
  margin-left: auto;
  text-decoration: underline;
}

.unclaimed-list {
  max-height: 160px;
  margin: var(--space-2) 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.unclaimed-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  color: var(--color-text-secondary);
}

.unclaimed-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unclaimed-tags,
.unclaimed-none {
  flex-shrink: 0;
  max-width: 30%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 这里原来还有四段 :deep 覆盖，全删了：
 *
 * 1. :deep(.app-button) 把 primary 的反相底换成了 --color-bg-raised，
 *    文字却还是 --color-text-inverse —— 深色下是 #111111 印在 #272727 上，
 *    对比度 1.26:1。「新建标签」「创建标签组」两个主按钮因此看着像禁用。
 * 2. :deep(.app-modal__panel) 和 :deep(.ant-form) 是给 TagGroupModal /
 *    TagModal 调外观的，那两个弹窗从来没被打开过，已随之删除。
 * 3. :deep(.app-dropdown) 重定义了菜单的悬停色，和 AppMenu 自己的一致，纯重复。
 * 4. :deep(.ant-input-search) 随搜索框一起下线。
 *
 * 组件的长相归组件管，页面不该伸手改。
 */
</style>
