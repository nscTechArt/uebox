<template>
  <!-- 内联模式：直接显示内容 -->
  <div v-if="inlineMode" class="tag-selector-overlay inline-mode">
    <div class="overlay-body">
      <div class="left-pane">
        <ul class="group-list fixed-groups">
          <li
            v-for="g in specialGroups"
            :key="g.id"
            :class="{ active: g.id === currentGroupId }"
            @click="selectGroup(g.id)"
          >
            {{ g.name }}
          </li>
        </ul>
        <div class="group-divider"></div>
        <div class="scrollable-groups">
          <ul class="group-list">
            <li
              v-for="g in userGroups"
              :key="g.id"
              :class="{ active: g.id === currentGroupId }"
              @click="selectGroup(g.id)"
            >
              {{ g.name }}
            </li>
          </ul>
        </div>
      </div>
      <div class="right-pane">
        <div class="search-box">
          <a-input
            v-model:value="searchQuery"
            :allow-clear="true"
            :placeholder="$t('assetTagSelector.search.placeholder')"
            class="search-input"
          />
          <!-- antd 的 checked-children 是把文字塞进开关轨道里；AppSwitch 的轨道是
               固定小尺寸，塞不下。改成开关旁边跟一个当前档位的文字，信息没少 -->
          <span class="tag-mode-toggle">
            <AppSwitch
              v-model:checked="isAllMode"
              :aria-label="$t('assetTagSelector.mode.label')"
            />
            <span class="tag-mode-label">{{
              isAllMode ? $t('assetTagSelector.mode.all') : $t('assetTagSelector.mode.any')
            }}</span>
          </span>
        </div>
        <div class="tags-scroll">
          <div class="tag-list">
            <AppTag
              size="medium"
              variant="dashed"
              :icon="PhProhibit"
              interactive
              :selected="internalHasNoTags"
              @click="toggleHasNoTags"
            >
              {{ $t('assetTagSelector.noTags') }}
            </AppTag>
            <AppTag
              v-for="t in filteredTags"
              :key="t.id"
              size="medium"
              :tone="isExcluded(t.id) ? 'danger' : 'neutral'"
              interactive
              :selected="isIncluded(t.id) || isExcluded(t.id)"
              @click="onTagClick(t.id)"
              @contextmenu.prevent="onTagContextMenu(t.id)"
            >
              {{ t.name }}
            </AppTag>
          </div>
        </div>
      </div>
    </div>
    <div class="footer">
      <div class="footer-hint">{{ $t('assetTagSelector.footer.hint') }}</div>
      <a-space>
        <AppButton size="small" @click="clear">{{ $t('assetTagSelector.footer.clear') }}</AppButton>
      </a-space>
    </div>
  </div>

  <!-- 下拉模式：包装在 dropdown 中 -->
  <AppDropdown v-else v-model:open="open" :trigger="['click']" placement="bottomLeft">
    <AppButton>
      {{ $t('assetTagSelector.trigger.label') }}
      <span v-if="modelValue?.length">{{
        $t('assetTagSelector.trigger.selectedCount', { count: modelValue.length })
      }}</span>
    </AppButton>
    <template #overlay>
      <div class="tag-selector-overlay">
        <div class="overlay-body">
          <div class="left-pane">
            <ul class="group-list fixed-groups">
              <li
                v-for="g in specialGroups"
                :key="g.id"
                :class="{ active: g.id === currentGroupId }"
                @click="selectGroup(g.id)"
              >
                {{ g.name }}
              </li>
            </ul>
            <div class="group-divider"></div>
            <div class="scrollable-groups">
              <ul class="group-list">
                <li
                  v-for="g in userGroups"
                  :key="g.id"
                  :class="{ active: g.id === currentGroupId }"
                  @click="selectGroup(g.id)"
                >
                  {{ g.name }}
                </li>
              </ul>
            </div>
          </div>
          <div class="right-pane">
            <div class="search-box">
              <a-input
                v-model:value="searchQuery"
                :allow-clear="true"
                :placeholder="$t('assetTagSelector.search.placeholder')"
                class="search-input"
              />
              <span class="tag-mode-toggle">
                <AppSwitch
                  v-model:checked="isAllMode"
                  :aria-label="$t('assetTagSelector.mode.label')"
                />
                <span class="tag-mode-label">{{
                  isAllMode ? $t('assetTagSelector.mode.all') : $t('assetTagSelector.mode.any')
                }}</span>
              </span>
            </div>
            <div class="tags-scroll">
              <div class="tag-list">
                <AppTag
                  size="medium"
                  variant="dashed"
                  :icon="PhProhibit"
                  interactive
                  :selected="internalHasNoTags"
                  @click="toggleHasNoTags"
                >
                  {{ $t('assetTagSelector.noTags') }}
                </AppTag>
                <AppTag
                  v-for="t in filteredTags"
                  :key="t.id"
                  size="medium"
                  :tone="isExcluded(t.id) ? 'danger' : 'neutral'"
                  interactive
                  :selected="isIncluded(t.id) || isExcluded(t.id)"
                  @click="onTagClick(t.id)"
                  @contextmenu.prevent="onTagContextMenu(t.id)"
                >
                  {{ t.name }}
                </AppTag>
              </div>
            </div>
          </div>
        </div>
        <div class="footer">
          <div class="footer-hint">{{ $t('assetTagSelector.footer.hint') }}</div>
          <a-space>
            <AppButton size="small" @click="clear">{{
              $t('assetTagSelector.footer.clear')
            }}</AppButton>
            <AppButton variant="primary" size="small" @click="confirm">{{
              $t('assetTagSelector.footer.confirm')
            }}</AppButton>
          </a-space>
        </div>
      </div>
    </template>
  </AppDropdown>
</template>

<script setup lang="ts">
import AppSwitch from '@renderer/components/AppSwitch.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import { PhProhibit } from '@phosphor-icons/vue'
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import tagGroupAPI from '@renderer/api/tagGroup'

interface TagGroup {
  id: string
  name: string
}
interface TagItem {
  id: string
  name: string
  groupId?: string
}

const props = defineProps<{
  modelValue: string[]
  matchMode?: 'any' | 'all'
  include?: string[]
  exclude?: string[]
  hasNoTags?: boolean
  /** 内联模式：直接显示内容，不包装在 dropdown 中 */
  inlineMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: string[]): void
  (e: 'update:matchMode', val: 'any' | 'all'): void
  (e: 'update:include', val: string[]): void
  (e: 'update:exclude', val: string[]): void
  (e: 'update:hasNoTags', val: boolean): void
}>()

const open = ref(false)
const searchQuery = ref('')

const internalMatchMode = ref<'any' | 'all'>(props.matchMode ?? 'any')

watch(
  () => props.matchMode,
  (val) => {
    if (val === 'any' || val === 'all') internalMatchMode.value = val
  }
)

const isAllMode = computed({
  get: () => internalMatchMode.value === 'all',
  set: (val: boolean) => {
    internalMatchMode.value = val ? 'all' : 'any'
    emit('update:matchMode', internalMatchMode.value)
    // 在 inlineMode 下实时同步
    if (props.inlineMode) {
      emit('update:include', [...includeSelected.value])
      emit('update:exclude', [...excludeSelected.value])
      emit('update:modelValue', [...includeSelected.value])
    }
  }
})

// 特殊分组：移除内置分组，保持仅数据库分组
const { t } = useI18n()
const specialGroups: TagGroup[] = [
  { id: 'all', name: t('assetTagSelector.specialGroups.all') },
  { id: 'selected', name: t('assetTagSelector.specialGroups.selected') }
]

// 用户自定义分组
const userGroups = ref<TagGroup[]>([])

// 获取用户分组
async function fetchUserGroups() {
  try {
    const groups = await tagGroupAPI.getAll()
    userGroups.value = groups.map((g: any) => ({
      id: String(g.id),
      name: g.name
    }))
  } catch (err) {
    console.error('获取标签组失败:', err)
  }
}

// 仅使用后端数据（分组不再拉取，保留特殊分组）
const remoteTags = ref<TagItem[]>([])
const tagsLoading = ref(false)

// 取消标签组的主动拉取，仅保留“全部/已选择”两种特殊分组

async function fetchTagsForGroup(id: string) {
  tagsLoading.value = true
  try {
    if (id === 'all') {
      const res = await (window as any).api.database.tag.getAll()
      const tagsData = res?.data || []
      remoteTags.value = tagsData.map((t: any) => ({ id: String(t.id), name: t.name }))
    } else if (id === 'selected') {
      // 这里的处理逻辑在 filteredTags 中已经有了，但如果需要远程获取，可能不需要单独API
      // 实际上 selected 模式下我们可能希望显示所有已选的标签，这通常不需要单独 fetch
      // 但为了简单，可以在 filteredTags 中处理，这里只 fetch all 或者不做操作
      // 如果是为了确保 getting updated info for selected tags, we might fetch all anyway
      // 暂时复用 getAll，前端过滤
      const res = await (window as any).api.database.tag.getAll()
      const tagsData = res?.data || []
      remoteTags.value = tagsData.map((t: any) => ({ id: String(t.id), name: t.name }))
    } else {
      const gidNum = Number(id)
      const res = await (window as any).api.database.tag.getByGroupId(gidNum)
      const tagsData = res?.data || []
      remoteTags.value = tagsData.map((t: any) => ({ id: String(t.id), name: t.name }))
    }
  } catch (err) {
    console.error('加载标签失败:', err)
    remoteTags.value = []
  } finally {
    tagsLoading.value = false
  }
}

// 打开下拉时按需加载数据
watch(open, async (val) => {
  if (val) {
    currentGroupId.value = 'all'
    await fetchUserGroups()
    await fetchTagsForGroup('all')
  }
})

// 内联模式下组件挂载时加载数据
onMounted(async () => {
  if (props.inlineMode) {
    currentGroupId.value = 'all'
    await fetchUserGroups()
    await fetchTagsForGroup('all')
  }
})

// 左侧分组不再合并显示，而是分两部分渲染
// const displayGroups = ... (removed)

const currentGroupId = ref<TagGroup['id']>('all')

// 分组切换时，重新拉取该分组下的标签数据
watch(currentGroupId, async (gid) => {
  await fetchTagsForGroup(gid)
})

// 删除 a-checkbox 相关状态，改为包含/排除两组
const includeSelected = ref<string[]>(props.include ?? props.modelValue ?? [])
const excludeSelected = ref<string[]>(props.exclude ?? [])

watch(
  () => props.include,
  (val) => {
    if (Array.isArray(val)) includeSelected.value = [...val]
  }
)
watch(
  () => props.exclude,
  (val) => {
    if (Array.isArray(val)) excludeSelected.value = [...val]
  }
)
watch(
  () => props.modelValue,
  (val) => {
    if (props.include === undefined && Array.isArray(val)) {
      includeSelected.value = [...val]
    }
  }
)

// 右侧标签仅使用当前数据库分组下的标签
const filteredTags = computed(() => {
  const gid = currentGroupId.value
  const q = searchQuery.value.trim().toLowerCase()
  let base: TagItem[] = []

  // 对于 user groups (numeric string id), they are handled by fetchTagsForGroup putting data into remoteTags
  // remoteTags should already contain the correct tags for the current group
  // EXCEPT for 'selected' logic which depends on filtering locally

  if (gid === 'selected') {
    const set = new Set([...includeSelected.value, ...excludeSelected.value])
    // We expect remoteTags to contain ALL tags ideally if we want to filter selected from them
    // But fetchTagsForGroup('selected') currently fetches ALL tags, so this works.
    base = remoteTags.value.filter((t) => set.has(t.id))
  } else {
    // For 'all' or specific group, remoteTags has the data
    base = remoteTags.value
  }

  if (!q) return base
  return base.filter((t) => (t.name || '').toLowerCase().includes(q))
})

function selectGroup(id: string) {
  currentGroupId.value = id
}

// 无标签状态
const internalHasNoTags = ref(props.hasNoTags ?? false)

watch(
  () => props.hasNoTags,
  (val) => {
    internalHasNoTags.value = val ?? false
  }
)

function toggleHasNoTags() {
  internalHasNoTags.value = !internalHasNoTags.value
  // 选择无标签时，清空其他标签选择（互斥）
  if (internalHasNoTags.value) {
    includeSelected.value = []
    excludeSelected.value = []
    emit('update:include', [])
    emit('update:exclude', [])
    emit('update:modelValue', [])
  }
  emit('update:hasNoTags', internalHasNoTags.value)
  if (props.inlineMode) {
    emit('update:matchMode', internalMatchMode.value)
  }
}

function clear() {
  includeSelected.value = []
  excludeSelected.value = []
  internalHasNoTags.value = false
  emit('update:modelValue', [])
  emit('update:include', [])
  emit('update:exclude', [])
  emit('update:hasNoTags', false)
  // 在 inlineMode 下也需要同步 matchMode
  if (props.inlineMode) {
    emit('update:matchMode', internalMatchMode.value)
  }
}

function confirm() {
  emit('update:modelValue', [...includeSelected.value])
  emit('update:include', [...includeSelected.value])
  emit('update:exclude', [...excludeSelected.value])
  emit('update:matchMode', internalMatchMode.value)
  open.value = false
}

function onTagClick(id: string) {
  // 选择具体标签时，自动关闭无标签筛选
  if (internalHasNoTags.value) {
    internalHasNoTags.value = false
    emit('update:hasNoTags', false)
  }
  const i = includeSelected.value.indexOf(id)
  if (i >= 0) {
    includeSelected.value.splice(i, 1)
  } else {
    includeSelected.value.push(id)
    const ei = excludeSelected.value.indexOf(id)
    if (ei >= 0) excludeSelected.value.splice(ei, 1)
  }
  // 在 inlineMode 下实时同步更新
  if (props.inlineMode) {
    emit('update:include', [...includeSelected.value])
    emit('update:exclude', [...excludeSelected.value])
    emit('update:modelValue', [...includeSelected.value])
    emit('update:matchMode', internalMatchMode.value)
  }
}

function onTagContextMenu(id: string) {
  // 排除具体标签时，自动关闭无标签筛选
  if (internalHasNoTags.value) {
    internalHasNoTags.value = false
    emit('update:hasNoTags', false)
  }
  const ei = excludeSelected.value.indexOf(id)
  if (ei >= 0) {
    excludeSelected.value.splice(ei, 1)
  } else {
    excludeSelected.value.push(id)
    const ii = includeSelected.value.indexOf(id)
    if (ii >= 0) includeSelected.value.splice(ii, 1)
  }
  // 在 inlineMode 下实时同步更新
  if (props.inlineMode) {
    emit('update:include', [...includeSelected.value])
    emit('update:exclude', [...excludeSelected.value])
    emit('update:modelValue', [...includeSelected.value])
    emit('update:matchMode', internalMatchMode.value)
  }
}

const isIncluded = (id: string): boolean => includeSelected.value.includes(id)
const isExcluded = (id: string): boolean => excludeSelected.value.includes(id)
</script>

<style scoped lang="less">
// 开关 + 当前档位文字。文字原来是塞在 antd 开关轨道里的（checked-children），
// AppSwitch 的轨道尺寸固定，装不下，所以挪到旁边
.tag-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.tag-mode-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.tag-selector-overlay {
  display: flex;
  flex-direction: column;
  min-height: 220px;
  background: var(--color-bg-raised);
  border-radius: 6px;
}
.overlay-body {
  display: flex;
  height: 300px; /* 固定高度以支持滚动 */
}
.left-pane {
  width: 100px;
  padding: 8px 0;
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 防止溢出 */
}

.scrollable-groups {
  flex: 1;
  overflow-y: auto;

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
}

.group-divider {
  height: 1px;
  background: var(--color-bg-surface-hover);
  margin: 4px 12px;
  flex-shrink: 0;
}

.search-box {
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.search-input {
  flex: 1;
}
.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.group-list li {
  padding: 8px 12px;
  cursor: pointer;
  /* border-radius: 6px; */
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-list li.active {
  font-weight: 600;
  background: var(--color-bg-selected);
  color: var(--color-text-selected);
}
.group-list li:hover {
  background: var(--color-bg-surface-hover);
}
.right-pane {
  flex: 1;
  padding: 12px;
  display: flex;
  flex-direction: column;
}
.tags-scroll {
  flex: 1;
  overflow: auto;
  padding-right: 6px;

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
}
.footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
}
.footer-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
}
/*
 * 标签本身的长相归 [AppTag.vue] 管，这里只排版。
 *
 * 原来这块自己画了一套：16px 胶囊、投影、文字阴影，选中还加 ✓ / ✕ 前缀，
 * 竖着一行一个铺满整栏 —— 和标签管理里的 chip 完全是两种东西，用户看不出
 * 那是同一个标签。现在换成 AppTag：同一个形状、同一档尺寸、同一套选中色，
 * 并且流式折行，一屏能看到的标签多了好几倍。
 *
 * 三种状态全靠颜色分，盒子尺寸不随状态变（加 ✓ 会多十几像素，一点就整片重排）：
 *   不管 → 中性淡底   包含 → 强调实色   排除 → 危险实色
 */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
