<template>
  <div v-show="expanded" class="filter-toolbar">
    <!-- 筛选工具栏 - 单行横向排列 -->
    <div class="toolbar-row">
      <!-- 文件格式下拉 -->
      <AppDropdown :trigger="['click']" placement="bottomLeft">
        <button class="filter-dropdown-btn" :class="{ active: fileCategoryProxy }">
          <PhFile />
          <span>{{ fileCategoryLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
        <template #overlay>
          <AppMenu @click="handleFileCategorySelect">
            <AppMenuItem key="" item-key="">
              <span>{{ t('assetLib.filter.allFormats') }}</span>
            </AppMenuItem>
            <AppMenuDivider />
            <AppMenuItem
              v-for="category in fileCategories"
              :key="category.key"
              :item-key="category.key"
            >
              <component :is="category.icon" v-if="category.icon" class="category-icon" />
              <PhCheck v-if="fileCategoryProxy === category.key" class="check-icon" />
              <span>{{ category.label }}</span>
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>

      <!-- 资产类型下拉（多选 - UE 风格分组） -->
      <a-popover
        v-model:open="assetTypeDropdownOpen"
        trigger="click"
        placement="bottomLeft"
        :overlay-style="{ padding: 0 }"
        :overlay-inner-style="{
          padding: 0,
          background: 'var(--color-bg-surface-hover)',
          borderRadius: '8px'
        }"
        :arrow="false"
        @open-change="handleAssetTypeDropdownVisibleChange"
      >
        <template #content>
          <div class="asset-type-selector">
            <!-- 头部：标题和清空按钮 -->
            <div class="selector-header">
              <span class="selector-title">{{ t('assetLib.filter.selectAssetTypes') }}</span>
              <AppButton
                v-if="assetTypesProxy.length > 0"
                type="link"
                size="small"
                class="clear-btn"
                @click="clearAssetTypes"
              >
                {{ t('assetLib.filter.clearAll') }}
              </AppButton>
            </div>

            <!-- 加载中 -->
            <div v-if="classOptionsLoading" class="selector-loading">
              <PhCircleNotch class="icon-spin" />
              <span>{{ t('common.loading') }}</span>
            </div>

            <!-- 分组列表 -->
            <div v-else class="selector-groups">
              <!-- 常用类型分组 -->
              <div v-if="commonAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.common') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in commonAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 蓝图类型分组 -->
              <div v-if="blueprintAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.blueprint') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in blueprintAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 材质类型分组 -->
              <div v-if="materialAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.material') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in materialAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 网格体类型分组 -->
              <div v-if="meshAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.mesh') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in meshAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 动画类型分组 -->
              <div v-if="animationAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.animation') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in animationAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 纹理类型分组 -->
              <div v-if="textureAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.texture') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in textureAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 音频类型分组 -->
              <div v-if="audioAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.audio') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in audioAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 特效与粒子类型分组 -->
              <div v-if="vfxAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.vfx') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in vfxAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 地形与环境类型分组 -->
              <div v-if="landscapeAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.landscape') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in landscapeAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 数据与AI类型分组 -->
              <div v-if="dataAiAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.data') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in dataAiAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 骨骼与绑定类型分组 -->
              <div v-if="rigAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.skeletal') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in rigAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 曲线类型分组 -->
              <div v-if="curveAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.curve') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in curveAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 序列与媒体类型分组 -->
              <div v-if="sequenceMediaAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.media') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in sequenceMediaAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 输入系统类型分组 -->
              <div v-if="inputAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.input') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in inputAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>

              <!-- 其他类型分组 -->
              <div v-if="otherAssetTypes.length > 0" class="type-group">
                <div class="group-header">
                  <span class="group-title">{{ t('assetFilterBar.typeGroups.other') }}</span>
                </div>
                <div class="group-items">
                  <label
                    v-for="opt in otherAssetTypes"
                    :key="opt.classNameCn"
                    class="type-item"
                    :class="{ checked: assetTypesProxy.includes(opt.classNameCn) }"
                  >
                    <AppCheckbox
                      :checked="assetTypesProxy.includes(opt.classNameCn)"
                      @change="toggleAssetType(opt.classNameCn)"
                    />
                    <span class="type-label">{{ opt.displayName }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </template>
        <button class="filter-dropdown-btn" :class="{ active: assetTypesProxy.length > 0 }">
          <PhSquaresFour />
          <span>{{ assetTypeButtonLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
      </a-popover>

      <!-- 引擎版本（服务器库的分面，带数量） -->
      <AppDropdown v-if="libraryCaps.filters.engine" :trigger="['click']" placement="bottomLeft">
        <button
          class="filter-dropdown-btn"
          :class="{ active: engineVersionsProxy.length > 0 }"
          @click="loadEngineOptions"
        >
          <PhGameController />
          <span>{{ engineButtonLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
        <template #overlay>
          <AppMenu @click="handleEngineSelect">
            <AppMenuItem key="" item-key="">{{
              t('catalogLibrary.filter.allEngines')
            }}</AppMenuItem>
            <AppMenuDivider />
            <AppMenuItem
              v-for="option in engineOptions"
              :key="option.value"
              :item-key="option.value"
            >
              <PhCheck v-if="engineVersionsProxy.includes(option.value)" class="check-icon" />
              {{ option.value }}
              <span class="option-count">{{ option.n }}</span>
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>

      <!-- 文件大小下拉 -->
      <button
        v-if="!libraryCaps.filters.size"
        class="filter-dropdown-btn"
        disabled
        :title="capabilityReason('filters.size')"
      >
        <PhDatabase />
        <span>{{ t('assetLib.filter.allSizes') }}</span>
      </button>
      <AppDropdown v-else :trigger="['click']" placement="bottomLeft">
        <button class="filter-dropdown-btn" :class="{ active: sizeRangeProxy }">
          <PhDatabase />
          <span>{{ sizeRangeLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
        <template #overlay>
          <AppMenu @click="handleSizeRangeSelect">
            <AppMenuItem key="" item-key="">{{ t('assetLib.filter.allSizes') }}</AppMenuItem>
            <AppMenuDivider />
            <AppMenuItem key="small" item-key="small">
              <PhCheck v-if="sizeRangeProxy === 'small'" class="check-icon" />
              {{ t('assetLib.filter.sizeSmall') }}
            </AppMenuItem>
            <AppMenuItem key="medium" item-key="medium">
              <PhCheck v-if="sizeRangeProxy === 'medium'" class="check-icon" />
              {{ t('assetLib.filter.sizeMedium') }}
            </AppMenuItem>
            <AppMenuItem key="large" item-key="large">
              <PhCheck v-if="sizeRangeProxy === 'large'" class="check-icon" />
              {{ t('assetLib.filter.sizeLarge') }}
            </AppMenuItem>
            <AppMenuItem key="xlarge" item-key="xlarge">
              <PhCheck v-if="sizeRangeProxy === 'xlarge'" class="check-icon" />
              {{ t('assetLib.filter.sizeXLarge') }}
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>

      <!-- 收藏状态下拉 -->
      <button
        v-if="!libraryCaps.filters.favorite"
        class="filter-dropdown-btn"
        disabled
        :title="capabilityReason('filters.favorite')"
      >
        <PhStar />
        <span>{{ t('assetLib.filter.all') }}</span>
      </button>
      <AppDropdown v-else :trigger="['click']" placement="bottomLeft">
        <button
          class="filter-dropdown-btn"
          :class="{ active: favoriteStatusProxy && favoriteStatusProxy !== 'all' }"
        >
          <PhStar />
          <span>{{ favoriteStatusLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
        <template #overlay>
          <AppMenu @click="handleFavoriteStatusSelect">
            <AppMenuItem key="all" item-key="all">
              <PhCheck v-if="favoriteStatusProxy === 'all'" class="check-icon" />
              {{ t('assetLib.filter.all') }}
            </AppMenuItem>
            <AppMenuItem key="favorite" item-key="favorite">
              <PhCheck v-if="favoriteStatusProxy === 'favorite'" class="check-icon" />
              {{ t('assetLib.filter.favorite') }}
            </AppMenuItem>
            <AppMenuItem key="unfavorite" item-key="unfavorite">
              <PhCheck v-if="favoriteStatusProxy === 'unfavorite'" class="check-icon" />
              {{ t('assetLib.filter.unfavorite') }}
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>

      <!-- 标签选择 - 使用 Popover 直接显示 -->
      <button
        v-if="!libraryCaps.filters.tags"
        class="filter-dropdown-btn"
        disabled
        :title="capabilityReason('filters.tags')"
      >
        <PhTagChevron />
        <span>{{ t('assetLib.filter.tags') }}</span>
      </button>
      <a-popover
        v-else
        v-model:open="showTagSelector"
        trigger="click"
        placement="bottomLeft"
        :overlay-style="{ padding: 0, width: '400px' }"
        :arrow="false"
      >
        <template #content>
          <div class="tag-selector-dropdown">
            <TagSelector
              v-model="tagsProxy"
              v-model:include="includeTagsProxy"
              v-model:exclude="excludeTagsProxy"
              v-model:match-mode="tagMatchModeProxy"
              v-model:has-no-tags="hasNoTagsProxy"
              :inline-mode="true"
            />
          </div>
        </template>
        <button class="filter-dropdown-btn" :class="{ active: hasActiveTags }">
          <PhTagChevron />
          <span>{{ tagButtonLabel }}</span>
          <PhCaretDown class="dropdown-arrow" />
        </button>
      </a-popover>

      <!--
        只看主资产：这一项原来在「偏好设置 → 资产」里叫「显示依赖资产」。
        它筛的是眼前这个列表，就该待在这排筛选条件里
      -->
      <button
        class="filter-dropdown-btn"
        :class="{ active: mainAssetsOnly }"
        :disabled="!libraryCaps.filters.showDependencies"
        :title="
          libraryCaps.filters.showDependencies
            ? undefined
            : capabilityReason('filters.showDependencies')
        "
        @click="mainAssetsOnly = !mainAssetsOnly"
      >
        <PhStack />
        <span>{{ t('assetFilterBar.mainAssetsOnly') }}</span>
      </button>

      <!-- 分隔线 -->
      <div class="toolbar-divider"></div>

      <!-- 重置按钮 -->
      <button v-if="hasActiveFilters" class="reset-btn" @click="handleResetFilter">
        <PhArrowClockwise />
        <span>{{ t('assetLib.filter.reset') }}</span>
      </button>
    </div>

    <!-- Filter Chips - 已选条件可视化 -->
    <div v-if="hasActiveFilters" class="filter-chips">
      <!-- 文件格式 Chip -->
      <div v-if="fileCategoryProxy" class="filter-chip">
        <span>{{ fileCategoryLabel }}</span>
        <PhX class="chip-close" @click="clearFileCategory" />
      </div>

      <!-- 资产类型 Chips（多选） -->
      <div v-for="assetType in assetTypesProxy" :key="`type-${assetType}`" class="filter-chip">
        <span>{{ getAssetTypeDisplayName(assetType) }}</span>
        <PhX class="chip-close" @click="removeAssetType(assetType)" />
      </div>

      <!-- 文件大小 Chip -->
      <div v-if="sizeRangeProxy" class="filter-chip">
        <span>{{ sizeRangeLabel }}</span>
        <PhX class="chip-close" @click="clearSizeRange" />
      </div>

      <!-- 收藏状态 Chip -->
      <div v-if="favoriteStatusProxy && favoriteStatusProxy !== 'all'" class="filter-chip">
        <span>{{ favoriteStatusLabel }}</span>
        <PhX class="chip-close" @click="clearFavoriteStatus" />
      </div>

      <!-- 只看主资产 Chip：藏掉了东西，得有一处看得见、点一下能撤 -->
      <div v-if="mainAssetsOnly" class="filter-chip">
        <span>{{ t('assetFilterBar.mainAssetsOnly') }}</span>
        <PhX class="chip-close" @click="mainAssetsOnly = false" />
      </div>

      <!-- 无标签 Chip -->
      <div v-if="hasNoTagsProxy" class="filter-chip tag-include">
        <span>{{ t('assetFilterBar.noTags') }}</span>
        <PhX class="chip-close" @click="clearHasNoTags" />
      </div>
      <!-- 标签 Chips -->
      <div v-for="tagId in includeTagsProxy" :key="`inc-${tagId}`" class="filter-chip tag-include">
        <span># {{ tagNameMap.get(tagId) || tagId }}</span>
        <PhX class="chip-close" @click="removeIncludeTag(tagId)" />
      </div>
      <div v-for="tagId in excludeTagsProxy" :key="`exc-${tagId}`" class="filter-chip tag-exclude">
        <span>{{
          t('assetFilterBar.excludePrefix', { name: tagNameMap.get(tagId) || tagId })
        }}</span>
        <PhX class="chip-close" @click="removeExcludeTag(tagId)" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhArrowClockwise,
  PhCaretDown,
  PhCheck,
  PhDatabase,
  PhFile,
  PhSquaresFour,
  PhStack,
  PhStar,
  PhTagChevron,
  PhX,
  PhCircleNotch,
  PhGameController
} from '@phosphor-icons/vue'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import { activeLibrarySource, getActiveLibrarySource } from '../data/activeLibrarySource'
import TagSelector from './TagSelector.vue'
import dayjs from 'dayjs'
import { ASSET_CATEGORIES } from '@renderer/constants/assetCategories'
import tagAPI from '@renderer/api/tag'

/**
 * 筛选表单属性定义
 */
const props = defineProps<{
  fileCategory?: string | undefined
  assetTypes?: string[] | undefined
  sizeRange?: string | undefined
  dateRange?: dayjs.Dayjs[] | null
  tags: string[]
  includeTags?: string[]
  excludeTags?: string[]
  tagMatchMode?: 'any' | 'all'
  hasNoTags?: boolean
  keyword: string
  favoriteStatus?: string | undefined
  /** 显不显示导入时自动带进来的依赖资产。true（默认）= 都显示 */
  showDependencies?: boolean
  expanded?: boolean
  /** 引擎版本（只有服务器库有这一组） */
  engineVersions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:fileCategory', val?: string): void
  (e: 'update:assetTypes', val: string[]): void
  (e: 'update:sizeRange', val?: string): void
  (e: 'update:dateRange', val: dayjs.Dayjs[] | null): void
  (e: 'update:tags', val: string[]): void
  (e: 'update:includeTags', val: string[]): void
  (e: 'update:excludeTags', val: string[]): void
  (e: 'update:tagMatchMode', val: 'any' | 'all'): void
  (e: 'update:hasNoTags', val: boolean): void
  (e: 'update:favoriteStatus', val?: string): void
  (e: 'update:showDependencies', val: boolean): void
  (e: 'update:engineVersions', val: string[]): void
  (e: 'update:keyword', val: string): void
  (e: 'apply-filter'): void
  (e: 'reset-filter'): void
  (e: 'keyword-input'): void
  (e: 'keyword-enter'): void
  (e: 'close'): void
}>()

// ========== 国际化 ==========
const { t } = useI18n()

// ========== 当前数据源能筛什么（不能的那几组原位禁用，并给一句原因） ==========
const libraryStore = useAssetLibraryStore()
const libraryCaps = computed(() => libraryStore.capabilities)
const capabilityReason = (name: string): string => {
  const key = libraryCaps.value.reasons[name]
  return key ? t(key) : ''
}

const engineVersionsProxy = computed({
  get: () => props.engineVersions ?? [],
  set: (val: string[]) => emit('update:engineVersions', val)
})
const engineOptions = ref<Array<{ value: string; n: number }>>([])
const engineButtonLabel = computed((): string => {
  const selected = engineVersionsProxy.value
  if (selected.length === 0) return t('catalogLibrary.filter.allEngines')
  if (selected.length === 1) return selected[0]
  return t('catalogLibrary.filter.enginesWithCount', { count: selected.length })
})
/** 引擎版本的取值和数量来自服务端分面（整个库） */
async function loadEngineOptions(): Promise<void> {
  const facets = getActiveLibrarySource().facets
  if (!facets) return
  try {
    engineOptions.value = await facets.engines({ includeSubfolders: true })
  } catch {
    engineOptions.value = []
  }
}
const handleEngineSelect = ({ key }: { key: string }): void => {
  if (!key) {
    engineVersionsProxy.value = []
    return
  }
  const current = engineVersionsProxy.value
  engineVersionsProxy.value = current.includes(key)
    ? current.filter((value) => value !== key)
    : [...current, key]
}

// ========== 响应式代理 ==========
const fileCategoryProxy = computed({
  get: () => props.fileCategory,
  set: (val) => emit('update:fileCategory', val)
})

const assetTypesProxy = computed({
  get: () => props.assetTypes ?? [],
  set: (val: string[]) => emit('update:assetTypes', val)
})

const sizeRangeProxy = computed({
  get: () => props.sizeRange,
  set: (val) => emit('update:sizeRange', val)
})

const dateRangeProxy = computed<dayjs.Dayjs[] | null | undefined>({
  get: () => props.dateRange,
  set: (val) => emit('update:dateRange', val ?? null)
})

const tagsProxy = computed({
  get: () => props.tags,
  set: (val) => emit('update:tags', val)
})

const includeTagsProxy = computed({
  get: () => props.includeTags ?? [],
  set: (val: string[]) => emit('update:includeTags', val)
})

const excludeTagsProxy = computed({
  get: () => props.excludeTags ?? [],
  set: (val: string[]) => emit('update:excludeTags', val)
})

const tagMatchModeProxy = computed({
  get: () => props.tagMatchMode ?? 'any',
  set: (val: 'any' | 'all') => emit('update:tagMatchMode', val)
})

const hasNoTagsProxy = computed({
  get: () => props.hasNoTags ?? false,
  set: (val: boolean) => emit('update:hasNoTags', val)
})

const favoriteStatusProxy = computed({
  get: () => props.favoriteStatus,
  set: (val) => emit('update:favoriteStatus', val)
})

/**
 * 「只看主资产」。
 *
 * 存的是 showDependencies，展示的是它的反面 —— 因为默认是「都显示」，
 * 用户真正要表达的动作是「把附带的那些藏起来」。开关文案写成
 * 「显示依赖资产 = 关」会让人读两遍才明白自己勾的是什么
 */
const mainAssetsOnly = computed({
  get: () => props.showDependencies === false,
  set: (val: boolean) => emit('update:showDependencies', !val)
})

// ========== 标签选择器弹窗状态 ==========
const showTagSelector = ref(false)

// ========== 资产类型下拉菜单状态 ==========
const assetTypeDropdownOpen = ref(false)

// ========== 标签名称缓存 ==========
const tagNameCache = ref<Map<string, string>>(new Map())

/** 批量获取标签名称 */
const loadTagNames = async (tagIds: string[]): Promise<void> => {
  const missingIds = tagIds.filter((id) => !tagNameCache.value.has(id))
  if (missingIds.length === 0) return

  try {
    // 批量获取所有标签
    const allTags = await tagAPI.getAll()
    allTags.forEach((tag) => {
      if (tag.id) {
        tagNameCache.value.set(String(tag.id), tag.name || String(tag.id))
      }
    })
  } catch (err) {
    console.error('批量加载标签名称失败:', err)
  }
}

/** 标签名称映射（计算属性） */
const tagNameMap = computed(() => {
  const map = new Map<string, string>()
  // 从缓存中获取已加载的标签名称
  tagNameCache.value.forEach((name, id) => {
    map.set(id, name)
  })
  return map
})

// ========== 显示标签计算属性 ==========

/** 文件格式分类列表 - UE 资产排在第一位，支持国际化 */
const fileCategories = computed(() => {
  const categories = [...ASSET_CATEGORIES]
  // 找到 UE 资产的索引
  const uassetIndex = categories.findIndex((cat) => cat.key === 'uasset')
  if (uassetIndex > 0) {
    // 将 UE 资产移到第一位
    const uassetCategory = categories.splice(uassetIndex, 1)[0]
    categories.unshift(uassetCategory)
  }
  // 为每个分类添加国际化标签
  return categories.map((cat) => {
    // 特殊处理 uasset -> UAsset（U 和 A 都要大写）
    let i18nKey: string
    if (cat.key === 'uasset') {
      i18nKey = 'assetLib.filter.formatUAsset'
    } else {
      i18nKey = `assetLib.filter.format${cat.key.charAt(0).toUpperCase() + cat.key.slice(1)}`
    }
    return {
      ...cat,
      label: t(i18nKey)
    }
  })
})

/** 文件格式显示文本 */
const fileCategoryLabel = computed((): string => {
  if (!fileCategoryProxy.value) return t('assetLib.filter.allFormats')
  const category = ASSET_CATEGORIES.find((cat) => cat.key === fileCategoryProxy.value)
  if (category) {
    // 特殊处理 uasset -> UAsset（U 和 A 都要大写）
    let i18nKey: string
    if (category.key === 'uasset') {
      i18nKey = 'assetLib.filter.formatUAsset'
    } else {
      i18nKey = `assetLib.filter.format${
        category.key.charAt(0).toUpperCase() + category.key.slice(1)
      }`
    }
    return t(i18nKey)
  }
  return t('assetLib.filter.allFormats')
})

/** 文件大小显示文本 */
const sizeRangeLabel = computed((): string => {
  const map: Record<string, string> = {
    small: t('assetLib.filter.sizeSmall'),
    medium: t('assetLib.filter.sizeMedium'),
    large: t('assetLib.filter.sizeLarge'),
    xlarge: t('assetLib.filter.sizeXLarge')
  }
  return sizeRangeProxy.value
    ? map[sizeRangeProxy.value] || t('assetLib.filter.allSizes')
    : t('assetLib.filter.allSizes')
})

/** 收藏状态显示文本 */
const favoriteStatusLabel = computed((): string => {
  const map: Record<string, string> = {
    all: t('assetLib.filter.favoriteStatus'),
    favorite: t('assetLib.filter.favorite'),
    unfavorite: t('assetLib.filter.unfavorite')
  }
  return favoriteStatusProxy.value
    ? map[favoriteStatusProxy.value] || t('assetLib.filter.favoriteStatus')
    : t('assetLib.filter.favoriteStatus')
})

/** 是否有激活的标签过滤 */
const hasActiveTags = computed((): boolean => {
  return (
    includeTagsProxy.value.length > 0 || excludeTagsProxy.value.length > 0 || hasNoTagsProxy.value
  )
})

/** 标签按钮显示文本 */
const tagButtonLabel = computed((): string => {
  const count = includeTagsProxy.value.length + excludeTagsProxy.value.length
  // 这里是**筛选**入口，不是给资产打标签的地方 —— 叫「添加标签」会让人以为点了就能新建
  return count > 0 ? t('assetLib.filter.tagWithCount', { count }) : t('assetLib.filter.tags')
})

/** 资产类型按钮显示文本 */
const assetTypeButtonLabel = computed((): string => {
  const count = assetTypesProxy.value.length
  if (count === 0) return t('assetLib.filter.allTypes')
  if (count === 1) return getAssetTypeDisplayName(assetTypesProxy.value[0])
  return t('assetLib.filter.typesWithCount', { count })
})

/** 是否有任何激活的筛选条件 */
const hasActiveFilters = computed((): boolean => {
  return !!(
    fileCategoryProxy.value ||
    assetTypesProxy.value.length > 0 ||
    sizeRangeProxy.value ||
    dateRangeProxy.value?.length ||
    (favoriteStatusProxy.value && favoriteStatusProxy.value !== 'all') ||
    mainAssetsOnly.value ||
    hasActiveTags.value ||
    engineVersionsProxy.value.length > 0
  )
})

// ========== 下拉菜单选择处理 ==========

/** 文件格式选择 */
const handleFileCategorySelect = ({ key }: { key: string }): void => {
  fileCategoryProxy.value = key || undefined
  // 如果选择了非 UE 资产类别，自动清空资产类型筛选
  if (key && key !== 'uasset') {
    assetTypesProxy.value = []
  }
}

/** 资产类型下拉菜单可见性变化处理 */
const handleAssetTypeDropdownVisibleChange = (visible: boolean): void => {
  // 当下拉菜单打开时，动态加载资产类型列表
  if (visible) {
    loadClassOptions()
  }
}

/** 文件大小选择 */
const handleSizeRangeSelect = ({ key }: { key: string }): void => {
  sizeRangeProxy.value = key || undefined
}

/** 收藏状态选择 */
const handleFavoriteStatusSelect = ({ key }: { key: string }): void => {
  favoriteStatusProxy.value = key || 'all'
}

// ========== 清除单个筛选条件 ==========

const clearFileCategory = (): void => {
  fileCategoryProxy.value = undefined
  // 清空文件格式时，也清空资产类型
  assetTypesProxy.value = []
}

/** 清空所有资产类型 */
const clearAssetTypes = (): void => {
  assetTypesProxy.value = []
}

/** 移除单个资产类型 */
const removeAssetType = (assetType: string): void => {
  assetTypesProxy.value = assetTypesProxy.value.filter((t) => t !== assetType)
}

const clearSizeRange = (): void => {
  sizeRangeProxy.value = undefined
}

const clearFavoriteStatus = (): void => {
  favoriteStatusProxy.value = 'all'
}

/** 移除单个包含标签 */
const removeIncludeTag = (tag: string): void => {
  includeTagsProxy.value = includeTagsProxy.value.filter((t) => t !== tag)
}

/** 移除单个排除标签 */
const removeExcludeTag = (tag: string): void => {
  excludeTagsProxy.value = excludeTagsProxy.value.filter((t) => t !== tag)
}

/** 清除无标签筛选 */
const clearHasNoTags = (): void => {
  hasNoTagsProxy.value = false
}

// ========== 重置筛选 ==========
const handleResetFilter = (): void => {
  emit('reset-filter')
}

// ========== 即时响应：监听筛选条件变化自动触发筛选 ==========
// 当资产类型变化时，如果有选择，自动切换到 UE 资产格式
watch(
  assetTypesProxy,
  (newTypes) => {
    if (newTypes.length > 0 && fileCategoryProxy.value !== 'uasset') {
      fileCategoryProxy.value = 'uasset'
    }
  },
  { deep: true }
)

watch(
  [
    fileCategoryProxy,
    assetTypesProxy,
    engineVersionsProxy,
    sizeRangeProxy,
    dateRangeProxy,
    favoriteStatusProxy,
    includeTagsProxy,
    excludeTagsProxy,
    tagMatchModeProxy,
    hasNoTagsProxy
  ],
  async () => {
    // 当标签变化时，加载标签名称
    const allTagIds = [...includeTagsProxy.value, ...excludeTagsProxy.value]
    if (allTagIds.length > 0) {
      await loadTagNames(allTagIds)
    }
    // 筛选条件变化时自动应用筛选
    emit('apply-filter')
  },
  { deep: true }
)

// ========== 组件挂载时预加载标签名称 ==========
onMounted(async () => {
  // 预加载当前已选择的标签名称
  const allTagIds = [...includeTagsProxy.value, ...excludeTagsProxy.value]
  if (allTagIds.length > 0) {
    await loadTagNames(allTagIds)
  }
})

// ========== 资产类型选项列表（动态从数据库获取） ==========

// 换了库（本地 ↔ 服务器库）：类型和引擎的取值都要重取
watch(activeLibrarySource, () => {
  classOptions.value = []
  engineOptions.value = []
})

/** 资产类型选项（包含中英文） */
interface ClassOption {
  className: string // 英文类名（用于筛选）
  classNameCn: string // 中文类名（用于显示）
  displayName: string // 国际化显示名称
}

const classOptions = ref<ClassOption[]>([])
const classOptionsLoading = ref(false)

/** 资产类型中文名到国际化键的映射 */
const assetTypeI18nMap: Record<string, string> = {
  材质实例: 'assetTypeMaterialInstance',
  静态网格体: 'assetTypeStaticMesh',
  蓝图: 'assetTypeBlueprint',
  纹理2D: 'assetTypeTexture2D',
  主材质: 'assetTypeMaterial',
  骨骼网格体: 'assetTypeSkeletalMesh',
  动画: 'assetTypeAnimation',
  音效: 'assetTypeSound',
  关卡: 'assetTypeWorld',
  数据表: 'assetTypeDataTable',
  曲线: 'assetTypeCurve',
  字体: 'assetTypeFont'
}

/** 获取资产类型的国际化显示名称 */
const getAssetTypeDisplayName = (classNameCn: string): string => {
  const i18nKey = assetTypeI18nMap[classNameCn]
  if (i18nKey) {
    return t(`assetLib.filter.${i18nKey}`)
  }
  // 如果没有映射，返回原中文名或尝试直接翻译
  return classNameCn
}

/**
 * 从数据库加载实际存在的资产类型
 * 使用优化后的 getDistinctAssetTypes API，直接在数据库层去重
 * 性能远高于读取所有资产再在内存中去重
 */
async function loadClassOptions(): Promise<void> {
  // 如果正在加载，避免重复请求
  if (classOptionsLoading.value) {
    return
  }

  classOptionsLoading.value = true
  try {
    // 使用优化后的 API，直接从数据库获取去重后的资产类型
    const types = await getActiveLibrarySource().assets.getDistinctAssetTypes()

    // 构建选项列表
    classOptions.value = types
      .filter((t) => t.classNameCn) // 过滤掉空值
      .map((t) => ({
        className: t.className || t.classNameCn,
        classNameCn: t.classNameCn,
        displayName: getAssetTypeDisplayName(t.classNameCn)
      }))
      .sort((a, b) => a.classNameCn.localeCompare(b.classNameCn, 'zh-CN'))
  } catch (err) {
    console.error('加载资产类型列表失败:', err)
    classOptions.value = []
  } finally {
    classOptionsLoading.value = false
  }
}

// ========== 资产类型分组定义（UE 风格） ==========

/** 常用类型关键词（高频使用的资产类型） */
const commonTypeKeywords = [
  '蓝图',
  '材质实例',
  '静态网格体',
  '纹理2D',
  '骨骼网格体',
  // 新增常用类型
  '动画蓝图',
  'Niagara系统',
  '关卡',
  '动画序列',
  '主材质'
]

/** 蓝图类型关键词 */
const blueprintTypeKeywords = ['蓝图', 'Blueprint', '控件', 'Widget']

/** 材质类型关键词 */
const materialTypeKeywords = ['材质', 'Material', '着色器', 'Shader']

/** 网格体类型关键词 */
const meshTypeKeywords = ['网格体', 'Mesh', '模型']

/** 动画类型关键词 */
const animationTypeKeywords = [
  '动画',
  'Animation',
  'Pose',
  '姿态',
  '骨骼',
  'Skeleton',
  '蒙太奇',
  'Montage'
]

/** 纹理类型关键词 */
const textureTypeKeywords = ['纹理', 'Texture', '贴图']

/** 音频类型关键词 */
const audioTypeKeywords = ['音效', '音频', 'Sound', 'Audio', '音乐']

/** 特效与粒子类型关键词 */
const vfxTypeKeywords = ['Niagara', '粒子', 'Particle', '发射器', 'Emitter', '特效']

/** 地形与环境类型关键词 */
const landscapeTypeKeywords = ['地形', 'Landscape', '地图构建', '植被', 'Foliage', '草地']

/** 数据与AI类型关键词 */
const dataAiTypeKeywords = [
  '数据表',
  '黑板',
  'Blackboard',
  '行为树',
  'BehaviorTree',
  '自定义结构体',
  '自定义枚举',
  'Dialogue',
  '环境查询'
]

/** 骨骼与绑定类型关键词 */
const rigTypeKeywords = [
  '控制绑定',
  'ControlRig',
  'IK',
  '重定向',
  'Retarget',
  '物理资产',
  'PhysicsAsset',
  '物理材质'
]

/** 曲线类型关键词 */
const curveTypeKeywords = ['曲线', 'Curve', '浮点', '线性颜色']

/** 序列与媒体类型关键词 */
const sequenceMediaTypeKeywords = [
  '关卡序列',
  'LevelSequence',
  '渲染序列',
  'MoviePipeline',
  '媒体',
  'Media'
]

/** 输入系统类型关键词 */
const inputTypeKeywords = ['输入动作', '输入映射', 'InputAction', 'InputMapping']

/** 检查资产类型是否匹配关键词列表 */
const matchesKeywords = (classNameCn: string, keywords: string[]): boolean => {
  return keywords.some((keyword) => classNameCn.includes(keyword))
}

/** 常用类型（高频使用） */
const commonAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => commonTypeKeywords.includes(opt.classNameCn))
})

/** 蓝图类型分组 */
const blueprintAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, blueprintTypeKeywords))
})

/** 材质类型分组 */
const materialAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, materialTypeKeywords))
})

/** 网格体类型分组 */
const meshAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, meshTypeKeywords))
})

/** 动画类型分组 */
const animationAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, animationTypeKeywords))
})

/** 纹理类型分组 */
const textureAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, textureTypeKeywords))
})

/** 音频类型分组 */
const audioAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, audioTypeKeywords))
})

/** 特效与粒子类型分组 */
const vfxAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, vfxTypeKeywords))
})

/** 地形与环境类型分组 */
const landscapeAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, landscapeTypeKeywords))
})

/** 数据与AI类型分组 */
const dataAiAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, dataAiTypeKeywords))
})

/** 骨骼与绑定类型分组 */
const rigAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, rigTypeKeywords))
})

/** 曲线类型分组 */
const curveAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, curveTypeKeywords))
})

/** 序列与媒体类型分组 */
const sequenceMediaAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) =>
    matchesKeywords(opt.classNameCn, sequenceMediaTypeKeywords)
  )
})

/** 输入系统类型分组 */
const inputAssetTypes = computed((): ClassOption[] => {
  return classOptions.value.filter((opt) => matchesKeywords(opt.classNameCn, inputTypeKeywords))
})

/** 其他类型（未分类的） */
const otherAssetTypes = computed((): ClassOption[] => {
  const categorizedTypes = new Set([
    ...commonAssetTypes.value.map((o) => o.classNameCn),
    ...blueprintAssetTypes.value.map((o) => o.classNameCn),
    ...materialAssetTypes.value.map((o) => o.classNameCn),
    ...meshAssetTypes.value.map((o) => o.classNameCn),
    ...animationAssetTypes.value.map((o) => o.classNameCn),
    ...textureAssetTypes.value.map((o) => o.classNameCn),
    ...audioAssetTypes.value.map((o) => o.classNameCn),
    ...vfxAssetTypes.value.map((o) => o.classNameCn),
    ...landscapeAssetTypes.value.map((o) => o.classNameCn),
    ...dataAiAssetTypes.value.map((o) => o.classNameCn),
    ...rigAssetTypes.value.map((o) => o.classNameCn),
    ...curveAssetTypes.value.map((o) => o.classNameCn),
    ...sequenceMediaAssetTypes.value.map((o) => o.classNameCn),
    ...inputAssetTypes.value.map((o) => o.classNameCn)
  ])
  return classOptions.value.filter((opt) => !categorizedTypes.has(opt.classNameCn))
})

/** 切换单个资产类型的选中状态 */
const toggleAssetType = (classNameCn: string): void => {
  const index = assetTypesProxy.value.indexOf(classNameCn)
  if (index === -1) {
    // 添加
    assetTypesProxy.value = [...assetTypesProxy.value, classNameCn]
  } else {
    // 移除
    assetTypesProxy.value = assetTypesProxy.value.filter((t) => t !== classNameCn)
  }
}
</script>

<style lang="less" scoped>
.filter-toolbar {
  background: var(--color-bg-surface-hover);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--color-border-subtle);
}

// 工具栏行
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  height: 44px;
}

// 筛选下拉按钮
.filter-dropdown-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s ease;
  white-space: nowrap;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-selected);
  }

  .dropdown-arrow {
    font-size: 12px;
    opacity: 0.6;
    margin-left: 2px;
  }

  .check-icon {
    color: var(--color-accent-text);
    margin-right: 4px;
  }
}

// 分隔线
.toolbar-divider {
  width: 1px;
  height: 20px;
  background: var(--color-bg-surface-hover);
  margin: 0 4px;
}

// 重置按钮
.reset-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;

  &:hover {
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
  }
}

// Filter Chips 区域
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 10px;
  border-top: 1px solid var(--color-border-subtle);
}

// 单个 Chip
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  font-size: 12px;
  transition: all 0.2s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .chip-close {
    font-size: 12px;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.2s;

    &:hover {
      opacity: 1;
    }
  }

  // 包含标签样式
  &.tag-include {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  // 排除标签样式
  &.tag-exclude {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

// 标签选择器下拉面板
.tag-selector-dropdown {
  background: var(--color-bg-surface-hover);
  border-radius: 8px;
  max-height: 400px;
  overflow-y: auto;
}

// 文件格式分类图标
.category-icon {
  margin-right: 6px;
  font-size: 14px;
}

// ========== 资产类型选择器（UE 风格分组） ==========
.asset-type-selector {
  padding: 12px;
  min-width: 280px;
  max-width: 400px;
  max-height: 400px;
  overflow-y: auto;

  // 头部
  .selector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border-subtle);

    .selector-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .clear-btn {
      padding: 0 4px;
      height: auto;
      font-size: 12px;
      color: var(--color-accent-text);
    }
  }

  // 加载中
  .selector-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    color: var(--color-text-muted);
    font-size: 12px;
  }

  // 分组容器
  .selector-groups {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  // 类型分组
  .type-group {
    .group-header {
      margin-bottom: 6px;

      .group-title {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    }

    .group-items {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
    }

    // 类型项
    .type-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s;
      min-width: 110px;

      &:hover {
        background: var(--color-bg-surface-hover);
      }

      &.checked {
        background: var(--color-bg-surface-hover);

        .type-label {
          color: var(--color-accent-text);
        }
      }

      .type-label {
        font-size: 12px;
        color: var(--color-text-secondary);
        white-space: nowrap;
      }
    }
  }

  // 滚动条
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

// 资产类型多选面板（旧版，保留兼容）
.asset-type-panel {
  padding: 12px;
  min-width: 220px;
  max-height: 360px;
  overflow-y: auto;

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border-subtle);

    .panel-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--color-text-primary);
    }
  }

  .asset-type-list {
    display: flex;
    flex-direction: column;
    gap: 2px;

    .asset-type-checkbox {
      padding: 6px 8px;
      border-radius: 4px;
      transition: background 0.2s;

      &:hover {
        background: var(--color-bg-surface-hover);
      }

      :deep(.app-checkbox) {
        width: 100%;

        span:not(.app-checkbox__box) {
          font-size: 13px;
          color: var(--color-text-secondary);
        }
      }

      :deep(.app-checkbox--checked + span) {
        color: var(--color-text-primary);
      }
    }

    .loading-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--color-text-muted);
      font-size: 12px;
    }
  }

  // 自定义滚动条
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}
</style>

<!-- 全局样式：限制下拉菜单高度 -->
<style lang="less">
// 资产类型下拉菜单滚动样式
.app-dropdown {
  .app-menu {
    overflow-y: auto;

    // 自定义滚动条样式
    &::-webkit-scrollbar {
      width: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: var(--color-bg-surface-hover);
      border-radius: 3px;

      &:hover {
        background: var(--color-bg-surface-hover);
      }
    }
  }
}

.option-count {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}
</style>
