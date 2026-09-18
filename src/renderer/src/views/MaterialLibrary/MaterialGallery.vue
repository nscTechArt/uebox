<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@renderer/utils/dialog'
import { message } from '@/utils/messageManager'
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import {
  getDependencyCount,
  getMaterialCompileLabel,
  getParameterCount,
  type MaterialEntry,
  type MaterialEntryType
} from './types/material'
import { buildMaterialEditorRoute } from './utils/materialTabRoute'
import LibraryFormModal from '@renderer/views/library-common/components/LibraryFormModal.vue'
import MaterialMigrationWizard from './MaterialMigrationWizard.vue'
import { LibraryBrowser } from '@renderer/views/library-common/browser'
import type { BrowserItem, BrowserScope } from '@renderer/views/library-common/browser'
import { buildMaterialFacets, toBrowserFolders, toBrowserItems } from './services/materialBrowser'

const router = useRouter()
const store = useMaterialLibraryStore()
const { t } = useI18n()

const DEFAULT_MATERIAL_NAME = computed(() => t('materialGallery.form.defaultMaterialName'))
const LOCAL_MATERIAL_LIBRARY_PATH = '/MaterialLibrary'

const showCreateModal = ref(false)
const isCreateAdvancedOpen = ref(false)
const newMaterialName = ref('')
const newMaterialType = ref<MaterialEntryType>('material')
const newMaterialDescription = ref('')
const showEditModal = ref(false)
const editMaterialId = ref('')
const editMaterialName = ref('')
const editMaterialDescription = ref('')
const showMigrationWizard = ref(false)

// ========== 拖拽整理（条目拖到条目合并成集合 / 拖到集合加入） ==========
const entryTypeOptions = computed<Array<{ value: MaterialEntryType | 'all'; label: string }>>(
  () => [
    { value: 'all', label: t('materialGallery.entryType.all') },
    { value: 'material', label: t('materialGallery.entryType.material') },
    { value: 'instance', label: t('materialGallery.entryType.instance') },
    { value: 'function', label: t('materialGallery.entryType.function') }
  ]
)

const createEntryTypeOptions = computed(() =>
  entryTypeOptions.value.filter(
    (option): option is { value: MaterialEntryType; label: string } => option.value !== 'all'
  )
)

function openCreateModal(): void {
  newMaterialName.value = ''
  newMaterialType.value = 'material'
  newMaterialDescription.value = ''
  isCreateAdvancedOpen.value = false
  showCreateModal.value = true
}

function handleCreateMaterial(): void {
  const materialName = newMaterialName.value.trim() || DEFAULT_MATERIAL_NAME.value
  const created = store.createDraftMaterial({
    name: materialName,
    entryType: newMaterialType.value,
    destinationPath: LOCAL_MATERIAL_LIBRARY_PATH
  })

  if (!created) {
    message.warning(t('materialGallery.toast.invalidName'))
    return
  }

  const description = newMaterialDescription.value.trim()
  if (description) {
    store.updateEntry(created.id, { description })
  }

  showCreateModal.value = false
  message.success(t('materialGallery.toast.createdDraft'))
  router.push(buildMaterialEditorRoute(created.id))
}

function handleOpen(id: string): void {
  router.push(buildMaterialEditorRoute(id))
}

function handleFavorite(entry: MaterialEntry): void {
  store.toggleFavorite(entry.id)
}

function openEditModal(entry: MaterialEntry): void {
  editMaterialId.value = entry.id
  editMaterialName.value = entry.name
  editMaterialDescription.value = entry.description || ''
  showEditModal.value = true
}

function handleEditMaterial(): void {
  const name = editMaterialName.value.trim()
  if (!name || !editMaterialId.value) return
  store.updateEntry(editMaterialId.value, {
    name,
    description: editMaterialDescription.value.trim()
  })
  showEditModal.value = false
  message.success(t('materialGallery.toast.updatedInfo'))
}

function handleDelete(entry: MaterialEntry): void {
  confirmDialog({
    title: t('materialGallery.removeConfirm.title'),
    content: t('materialGallery.removeConfirm.content', { name: entry.name }),
    okText: t('materialGallery.removeConfirm.okText'),
    danger: true,
    cancelText: t('materialGallery.common.cancel'),
    centered: true,
    onOk: () => {
      store.deleteEntry(entry.id)
      message.success(t('materialGallery.toast.removed'))
    }
  })
}

function compileTone(entry: MaterialEntry): string {
  return `status-${entry.compileStatus}`
}

// ========== 库浏览器 ==========
//
// 搜索、筛选、网格、列表这些每个库都一样的「浏览」交给 LibraryBrowser，
// 这里只把材质翻译成它认识的形状，加上确实只有材质才有的东西。

const browserItems = computed(() =>
  toBrowserItems(store.entries, (entry) =>
    t('materialGallery.stats.summary', {
      params: getParameterCount(entry),
      deps: getDependencyCount(entry)
    })
  )
)

const browserFolders = computed(() => toBrowserFolders(store.collections))

const browserScope = computed<BrowserScope>(() => ({
  id: 'material',
  title: 'materialGallery.header.title',
  kinds: ['material'],
  openOnClick: true,
  // 库里通常只有几十条，用不上面包屑和详情面板那一套
  density: 'light',
  facets: buildMaterialFacets(store.entries, {
    entryType: 'materialGallery.list.colType',
    blendMode: 'libraryBrowser.facetBlendMode',
    shadingModel: 'libraryBrowser.facetShadingModel'
  }),
  open: (item) => handleOpen(item.id)
}))

function handleMoveToFolder(items: BrowserItem[], folderKey: string): void {
  store.moveEntriesToFolder(
    items.map((item) => item.id),
    folderKey
  )
}

/** 建完把 id 交回树，它才知道该把改名弹窗开在哪个文件夹上。建不出来就不回调 */
function handleCreateFolder(name: string, onCreated: (folderKey: string) => void): void {
  const created = store.createFolder(name)
  if (created) onCreated(created.id)
}

/** 删文件夹只删这个「地方」，里面的材质回到「全部」 */
function handleDeleteFolder(folderKey: string): void {
  const folder = store.collections.find((item) => item.id === folderKey)
  if (!folder) return

  confirmDialog({
    title: t('libraryBrowser.deleteFolder'),
    content: t('libraryBrowser.deleteFolderConfirm', { name: folder.name }),
    danger: true,
    onOk: () => store.deleteCollection(folderKey)
  })
}

// 自定义指令：自动获取焦点
const vFocus = {
  mounted: (el: HTMLElement) => el.focus()
}
</script>

<template>
  <div class="library-gallery-page">
    <LibraryBrowser
      class="gallery-browser"
      :scope="browserScope"
      :items="browserItems"
      :folders="browserFolders"
      @move="handleMoveToFolder"
      @create-folder="handleCreateFolder"
      @rename-folder="store.renameCollection"
      @delete-folder="handleDeleteFolder"
    >
      <template #toolbar>
        <div class="action-island">
          <button
            type="button"
            class="icon-btn btn-import"
            :title="$t('materialMigration.title')"
            :aria-label="$t('materialMigration.title')"
            @click="showMigrationWizard = true"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>

        <button type="button" class="btn-primary-create" @click="openCreateModal">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>{{ $t('materialGallery.actions.newMaterial') }}</span>
        </button>
      </template>

      <template #card-cover="{ item }">
        <div class="card-cover" :style="item.thumbnail ? undefined : item.coverStyle">
          <img v-if="item.thumbnail" class="cover-media" :src="item.thumbnail" alt="" />
          <span v-else class="cover-text-placeholder">
            {{ item.name.slice(0, 2).toUpperCase() }}
          </span>
          <span v-if="item.isFavorite" class="fav-badge">★</span>
          <span class="status-badge" :class="compileTone(item.source as MaterialEntry)">
            ● {{ getMaterialCompileLabel((item.source as MaterialEntry).compileStatus) }}
          </span>
        </div>
      </template>

      <template #card-menu="{ item }">
        <div class="menu-item" @click.stop="openEditModal(item.source as MaterialEntry)">
          ✎ {{ $t('materialGallery.actions.editInfo') }}
        </div>
        <div class="menu-item" @click.stop="handleFavorite(item.source as MaterialEntry)">
          {{
            item.isFavorite
              ? `☆ ${$t('materialGallery.actions.unfavorite')}`
              : `★ ${$t('materialGallery.actions.favorite')}`
          }}
        </div>
        <div class="menu-item danger" @click.stop="handleDelete(item.source as MaterialEntry)">
          ✕ {{ $t('materialGallery.actions.removeFromLibrary') }}
        </div>
      </template>

      <!-- 材质的脚注是资产路径，不是标签 -->
      <template #card-footnote="{ item }">
        <div class="card-path" :title="(item.source as MaterialEntry).assetPath">
          {{ (item.source as MaterialEntry).assetPath }}
        </div>
      </template>
    </LibraryBrowser>

    <!-- 新建材质 -->
    <LibraryFormModal
      v-model:open="showCreateModal"
      v-model:advanced-expanded="isCreateAdvancedOpen"
      size="wide"
      icon="plus"
      :title="$t('materialGallery.actions.newMaterial')"
      :advanced-hint="$t('materialGallery.form.advancedHint')"
      :advanced-label="$t('materialGallery.form.advancedToggle')"
      :cancel-text="$t('materialGallery.common.cancel')"
      :confirm-text="$t('materialGallery.actions.createMaterialConfirm')"
      @confirm="handleCreateMaterial"
    >
      <div class="name-section">
        <label class="form-label">{{ $t('materialGallery.form.nameLabel') }}</label>
        <input
          v-model="newMaterialName"
          v-focus
          class="form-input name-input"
          :placeholder="$t('materialGallery.form.namePlaceholder')"
          @keyup.enter="handleCreateMaterial"
        />
      </div>

      <template #advanced>
        <div class="form-group">
          <label class="form-label">{{ $t('materialGallery.form.typeLabel') }}</label>
          <select v-model="newMaterialType" class="form-input">
            <option
              v-for="option in createEntryTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">{{ $t('materialGallery.form.descriptionLabel') }}</label>
          <textarea
            v-model="newMaterialDescription"
            class="form-input form-textarea"
            :placeholder="$t('materialGallery.form.descriptionPlaceholder')"
            maxlength="500"
            rows="3"
          />
        </div>
      </template>
    </LibraryFormModal>

    <!-- 编辑材质信息 -->
    <LibraryFormModal
      v-model:open="showEditModal"
      icon="edit"
      :title="$t('materialGallery.editModal.title')"
      :cancel-text="$t('materialGallery.common.cancel')"
      :confirm-text="$t('materialGallery.common.save')"
      :confirm-disabled="!editMaterialName.trim()"
      @confirm="handleEditMaterial"
    >
      <div class="name-section">
        <label class="form-label">{{ $t('materialGallery.form.nameLabel') }}</label>
        <input
          v-model="editMaterialName"
          v-focus
          class="form-input name-input"
          @keyup.enter="handleEditMaterial"
        />
      </div>
      <div class="form-group">
        <label class="form-label">{{ $t('materialGallery.form.noteLabel') }}</label>
        <textarea
          v-model="editMaterialDescription"
          class="form-input form-textarea"
          :placeholder="$t('materialGallery.form.descriptionPlaceholder')"
          maxlength="500"
          rows="3"
        />
      </div>
    </LibraryFormModal>

    <MaterialMigrationWizard
      v-if="showMigrationWizard"
      @close="showMigrationWizard = false"
      @done="showMigrationWizard = false"
    />
  </div>
</template>

<style scoped lang="less">
.library-gallery-page {
  // 列布局 + overflow: hidden，让浏览器自己的内容区成为**唯一**的滚动容器。
  // 页面这一层也开 overflow-y: auto 的话会出现两条滚动条，内容区还会被挤扁。
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  // 不刷自己的底色：页面背景归 App 外壳，这里刷一层不透明黑会把分层背景盖死
  padding: var(--space-4) var(--space-1);
  color: var(--color-text-secondary);
}
</style>
