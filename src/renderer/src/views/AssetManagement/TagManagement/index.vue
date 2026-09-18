<template>
  <div class="tag-management">
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
import TagDisplay from './TagDisplay.vue'
import type { TagGroup, Tag } from './types'
import { DEFAULT_TAG_GROUP_COLOR } from './types'
import { useTagStatsStore } from '@renderer/store/modules/tagStatsStore'

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
    const result = await window.api.database.tagGroup.create({
      name: defaultName,
      color: DEFAULT_TAG_GROUP_COLOR,
      sort_order: tagGroups.value.length + 1
    })

    if (result.success) {
      message.success(t('tagManagement.messages.groupCreated'))
      await loadGroups()
      const newId = result.data?.id ?? null
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
        const result = await window.api.database.tagGroup.delete(id)
        if (result.success) {
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
    const result = await window.api.database.tagGroup.update(id, { name: trimmedName })
    if (result.success) {
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
    const result = await window.api.database.tag.create({
      name: defaultName,
      group_id: quickFilter.value ? null : selectedGroupId.value,
      is_favorite: quickFilter.value === 'favorite'
    })

    if (result.success) {
      await loadTags()
      await loadGroups()
      const newId = result.data?.id ?? null
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
    const result = await window.api.database.tag.update(payload.id, { name: trimmedName })
    if (result.success) {
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
  renamingTagId.value = tag.id ?? null
  renamingTagName.value = tag.name
}

const handleDeleteTag = async (id: number) => {
  try {
    const result = await window.api.database.tag.delete(id)
    if (result.success) {
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
    const result = await window.api.database.tag.toggleFavorite(tag.id!)
    if (result.success) {
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

    const result = await window.api.database.tag.update(tag.id!, {
      name: tag.name,
      group_id: groupId,
      is_favorite: tag.is_favorite
    })

    if (result.success) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _targetGroup = tagGroups.value.find((g) => g.id === groupId)
      // message.success(`标签已移动到「${targetGroup?.name || '未知分组'}」`)
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

    const result = await window.api.database.tag.update(tag.id!, {
      name: tag.name,
      group_id: null,
      is_favorite: tag.is_favorite
    })

    if (result.success) {
      // message.success('标签已移动到未分组')
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

    const result = await window.api.database.tag.update(tag.id!, {
      name: tag.name,
      group_id: tag.group_id,
      is_favorite: true
    })

    if (result.success) {
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
    const result = await window.api.database.tagGroup.getAllWithCount()
    if (result.success) {
      tagGroups.value = result.data
      if (renamingGroupId.value !== null) {
        const renamingGroup = result.data.find((group) => group.id === renamingGroupId.value)
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
    const result = await window.api.database.tag.getAll()
    if (result.success) {
      tags.value = result.data
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
    const result = await window.api.database.assetTag.getUsageCounts()
    if (!result.success) {
      usageCounts.value = {}
      return
    }
    const next: Record<number, number> = {}
    result.data.forEach((row) => {
      next[row.tagId] = row.count
    })
    usageCounts.value = next
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
    const result = await window.api.database.tag.moveToGroup(payload.ids, payload.groupId)
    if (result.success) {
      message.success(
        t('tagDisplay.batch.moved', { count: result.data?.updatedCount ?? payload.ids.length })
      )
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
    await Promise.all(
      targets.map((id) => window.api.database.tag.update(id, { is_favorite: true }))
    )
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
        const result = await window.api.database.tag.batchDelete(ids)
        if (result.success) {
          message.success(
            t('tagDisplay.batch.deleted', { count: result.data?.deletedCount ?? ids.length })
          )
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

// 初始化
onMounted(async () => {
  await loadGroups()
  await loadTags()
  await loadUsageCounts()
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

  .tag-management-container {
    display: flex;
    height: 100%;
    min-height: 0;
  }
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
