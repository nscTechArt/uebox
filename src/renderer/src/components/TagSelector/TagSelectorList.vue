<template>
  <div class="modal-container">
    <!-- 头部区域 -->
    <div class="modal-header">
      <h2 class="main-title">{{ t('assetLib.tagSelector.mainTitle2') }}</h2>
      <AppButton
        variant="text"
        size="small"
        shape="circle"
        class="close-btn"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click="$emit('close')"
      >
        <template #icon><PhX /></template>
      </AppButton>
    </div>

    <!-- 搜索栏 -->
    <div class="search-section">
      <div class="search-wrapper">
        <PhMagnifyingGlass class="search-icon" />
        <input
          v-model="searchTerm"
          type="text"
          :placeholder="t('assetLib.tagSelector.searchPlaceholder')"
          class="search-input"
          @keydown="handleKeyDown"
        />
      </div>
    </div>

    <!-- 主内容区域 -->
    <div class="content-area">
      <!-- 左侧分类导航。不再加一行"全部标签"的分组标题 —— 底下第一项就叫这个名字 -->
      <aside class="sidebar">
        <nav class="category-nav">
          <button
            v-for="cat in categories"
            :key="cat.id"
            class="nav-item"
            :class="{ active: activeCategory === cat.id }"
            @click="activeCategory = cat.id"
          >
            <component :is="cat.icon" class="nav-icon" />
            <span class="nav-label">{{ cat.label }}</span>
          </button>
        </nav>
      </aside>

      <!-- 右侧标签云 -->
      <main class="main-content">
        <div v-if="filteredTags.length === 0 && !showCreateOption" class="empty-container">
          <PhTag class="empty-icon" />
          <div class="empty-text">{{ t('assetLib.tagSelector.emptyTags') }}</div>
        </div>

        <!--
          以前这里是 3 列的大卡片网格，和详情面板里的标签长得完全不是一个东西。
          现在统一成 AppTag：同一个形状、同一套档位，选中态由组件自己管。
        -->
        <div v-else class="tags-cloud">
          <!-- 新建排最前：它是你刚打完字最想点的那个，排在几十个标签后面等于没有 -->
          <AppTag
            v-if="showCreateOption"
            size="medium"
            variant="dashed"
            interactive
            :icon="PhPlus"
            @click="handleCreateTag"
          >
            {{ t('assetLib.tagSelector.createNew') }}
          </AppTag>

          <!-- 顺序在打开弹窗时就定下了，勾选不重排 -->
          <AppTag
            v-for="tag in filteredTags"
            :key="tag.id"
            size="medium"
            interactive
            :selected="tag.selected"
            :title="tag.name"
            @click="toggleTag(tag.id)"
          >
            {{ tag.name }}
          </AppTag>
        </div>
      </main>
    </div>

    <!--
      底部只留计数和动作。原来还把已选标签又列了一遍 —— 上面的标签云里
      选中的已经染成实色且排在最前，底下那一份是同一个状态的第二次表达。
    -->
    <div class="modal-footer">
      <div class="selection-label">
        {{ t('assetLib.tagSelector.selectedCount', { count: selectedTagsList.length }) }}
      </div>
      <div class="action-buttons">
        <AppButton variant="text" @click="$emit('close')">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton variant="primary" @click="handleConfirm">
          {{ t('assetLib.tagSelector.confirmBtn') }}
        </AppButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArchive,
  PhMagnifyingGlass,
  PhPlus,
  PhSquaresFour,
  PhStar,
  PhTag,
  PhX
} from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'

const { t } = useI18n()

// 1. 类型定义
interface TagGroup {
  id: number
  name: string
  color?: string
}

interface Tag {
  id?: number
  name: string
  group_id?: number | null
  is_favorite?: boolean
}

interface TagItem {
  id: number
  name: string
  category: string
  group_id?: number | null
  is_favorite?: boolean
  selected: boolean
}

interface CategoryItem {
  id: string
  label: string
  icon: Component
}

const props = defineProps<{ selectedIds: number[] }>()
const emit = defineEmits<{
  (e: 'update:selectedIds', value: number[]): void
  (e: 'close'): void
  (e: 'confirm', value: number[]): void
}>()

// 2. 状态定义
const searchTerm = ref('')
const activeCategory = ref('all')
const tags = ref<TagItem[]>([])
const tagGroups = ref<TagGroup[]>([])

// 侧边栏分类：合并系统预设与数据库分组
const categories = computed<CategoryItem[]>(() => {
  const base: CategoryItem[] = [
    { id: 'all', label: t('assetLib.tagSelector.categories.all'), icon: PhSquaresFour },
    { id: 'ungrouped', label: t('assetLib.tagSelector.categories.ungrouped'), icon: PhArchive },
    { id: 'favorite', label: t('assetLib.tagSelector.categories.favorite'), icon: PhStar }
  ]

  const fromGroups = tagGroups.value.map((group) => ({
    id: String(group.id),
    label: group.name,
    icon: PhTag
  }))

  return [...base, ...fromGroups]
})

// 4. 计算属性：过滤逻辑
const filteredTags = computed(() => {
  let result = tags.value

  // 分类过滤
  if (activeCategory.value === 'favorite') {
    result = result.filter((t) => t.is_favorite)
  } else if (activeCategory.value === 'ungrouped') {
    result = result.filter((t) => !t.group_id)
  } else if (activeCategory.value !== 'all') {
    const groupId = Number(activeCategory.value)
    result = result.filter((t) => t.group_id === groupId)
  }

  // 搜索过滤
  if (searchTerm.value) {
    const term = searchTerm.value.toLowerCase()
    result = result.filter((t) => t.name.toLowerCase().includes(term))
  }

  return result
})

// 是否显示"新建"选项
const showCreateOption = computed(() => {
  if (!searchTerm.value) return false
  return !tags.value.some((t) => t.name.toLowerCase() === searchTerm.value.toLowerCase())
})

// 已选标签列表
const selectedTagsList = computed(() => tags.value.filter((t) => t.selected))

// 5. 交互方法
const toggleTag = (id: number): void => {
  const tag = tags.value.find((t) => t.id === id)
  if (tag) {
    tag.selected = !tag.selected
    syncSelectedIds()
  }
}

// 新建标签
const handleCreateTag = async (): Promise<void> => {
  if (!searchTerm.value) return

  // 获取当前激活的分组 ID
  const currentGroupId = activeCategory.value !== 'all' ? Number(activeCategory.value) : null

  const newTag: TagItem = {
    id: Date.now(),
    name: searchTerm.value,
    category: 'custom',
    group_id: currentGroupId,
    selected: true
  }

  // 尝试调用 API 创建
  try {
    const resp = await (window as any).api.database.tag.create({
      name: searchTerm.value,
      group_id: currentGroupId
    })
    if (resp?.success && resp.data?.id) {
      newTag.id = resp.data.id
    }
  } catch (e) {
    console.warn('API creation failed, using local mock', e)
  }

  tags.value.unshift(newTag)
  searchTerm.value = ''
  syncSelectedIds()
}

// 键盘事件
const handleKeyDown = (e: KeyboardEvent): void => {
  if (e.key === 'Enter' && showCreateOption.value) {
    handleCreateTag()
  }
}

// 同步回父组件
const syncSelectedIds = (): void => {
  const ids = tags.value.filter((t) => t.selected).map((t) => t.id)
  emit('update:selectedIds', ids)
}

// 6. 生命周期
onMounted(async () => {
  // 1. 获取分组
  try {
    const groupResp = await (window as any).api.database.tagGroup.getAll()
    if (groupResp?.success) {
      tagGroups.value = groupResp.data || []
    }
  } catch (e) {
    console.warn('Load groups failed', e)
  }

  // 2. 获取标签
  let apiTags: Tag[] = []
  try {
    const resp = await (window as any).api.database.tag.getAll()
    if (resp?.success) {
      apiTags = resp.data || []
    }
  } catch {
    // ignore
  }

  const mergedTags: TagItem[] = apiTags.map((tag: Tag) => ({
    id: tag.id!,
    name: tag.name,
    category: 'custom',
    group_id: tag.group_id,
    is_favorite: tag.is_favorite,
    selected: false
  }))

  // 应用初始选中状态
  const selectedSet = new Set(props.selectedIds || [])
  mergedTags.forEach((t) => {
    if (selectedSet.has(t.id)) {
      t.selected = true
    }
  })

  /*
   * 打开时把已选的排到前面，之后这个顺序就冻住了 —— 勾选不重排。
   * 原来是按 selected 实时排序的：点中间一个标签，它立刻窜到最前，
   * 手底下的东西跑了，后面所有标签跟着重新折行，连点几下就完全看花了。
   */
  tags.value = [...mergedTags.filter((t) => t.selected), ...mergedTags.filter((t) => !t.selected)]
})

const handleConfirm = (): void => {
  emit(
    'confirm',
    selectedTagsList.value.map((t: TagItem) => t.id)
  )
}
</script>

<style scoped lang="less">
/*
 * 这份样式原来带着一整套自己的主题变量（@accent: #0ea5e9 之类）—— 一个天蓝色，
 * 和调色板里的 accent 根本不是一个颜色，换主题也不跟着走。全部换成 token 了。
 * 同时删掉了：叠在不透明底色上的 backdrop-filter（毛玻璃根本看不见，白交 GPU）、
 * 只此一处生效的 font-family 覆盖、以及对中文无效的 text-transform: uppercase。
 */

/* ===================================
   主容器
   =================================== */
.modal-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  /*
   * 高度固定。跟着内容走的话，选中的标签会重排到最前面，标签宽度不一
   * 导致折行数变化，于是每点一下弹窗都跳一次高 —— 选东西的时候底下那排
   * 按钮不能乱动。多出来的标签由 .main-content 自己滚。
   */
  height: 520px;
  max-height: 80vh;
  overflow: hidden;
  color: var(--color-text-primary);
}

/* ===================================
   头部区域
   =================================== */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 20px 24px 12px;
  flex-shrink: 0;
}

.main-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.close-btn {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--color-text-secondary);

  &:hover {
    color: var(--color-text-primary);
  }
}

/* ===================================
   搜索栏
   =================================== */
.search-section {
  padding: 0 24px 16px;
  flex-shrink: 0;
}

.search-wrapper {
  position: relative;

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 16px;
    color: var(--color-text-muted);
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    height: 36px;
    padding: 0 12px 0 36px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
    font-family: inherit;
    font-size: 13px;
    outline: none;
    transition:
      background-color var(--motion-fast) var(--easing-standard),
      border-color var(--motion-fast) var(--easing-standard);

    &::placeholder {
      color: var(--color-text-muted);
    }

    &:hover {
      background: var(--color-bg-soft-hover);
    }

    &:focus {
      border-color: var(--color-border-focus);
      background: var(--color-bg-soft-hover);
    }
  }
}

/* ===================================
   主内容区域
   =================================== */
.content-area {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--color-border-subtle);
}

/* ===================================
   左侧边栏
   =================================== */
.sidebar {
  width: 160px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 8px;
  border-right: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
}

.category-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);

  .nav-icon {
    flex-shrink: 0;
    font-size: 16px;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 侧栏底色本来就是 surface-hover，hover 再用同一个值等于没有反馈 */
  &:hover {
    background: var(--color-bg-soft-hover);
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  /* 选中靠底色和字重，不靠右边那个 4px 的小圆点 */
  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-primary);
    font-weight: 600;
  }
}

/* ===================================
   右侧标签云
   =================================== */
.main-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px;

  /* 滚动条：轨道透明、滑块用边框色。原来滑块和容器底色是同一个 token，等于隐形 */
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

/* 标签本身的长相全在 AppTag 里，这里只管排布 */
.tags-cloud {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 8px;
}

.empty-container {
  height: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);

  .empty-icon {
    margin-bottom: 12px;
    font-size: 40px;
    opacity: 0.5;
  }

  .empty-text {
    font-size: 13px;
  }
}

/* ===================================
   底部操作栏
   =================================== */
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: 12px 24px;
  flex-shrink: 0;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
}

.selection-label {
  font-size: 12px;
  color: var(--color-text-muted);
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
