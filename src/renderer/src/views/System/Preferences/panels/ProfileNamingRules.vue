<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppButton from '@renderer/components/AppButton.vue'
/**
 * 命名规则设置组件
 */
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { PhArrowClockwise, PhCaretRight, PhPlus, PhTrash } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from '@renderer/hooks/useI18n'
import {
  loadNamingRulesConfig,
  saveNamingRulesConfig,
  resetNamingRulesConfig,
  getNamingRulesConfig
} from '@renderer/services/namingRulesService'
import type { NamingRulesConfig, TextureSuffixPattern } from '@renderer/types/namingRules'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

// 配置数据
const config = ref<NamingRulesConfig>(getNamingRulesConfig())
const loading = ref(false)
const saving = ref(false)
const autoSaving = ref(false)
const lastSavedTime = ref<Date | null>(null)

// 自动保存定时器
let autoSaveTimer: number | null = null
const AUTO_SAVE_DELAY = 2000 // 2秒防抖，减少保存频率
let lastConfigSnapshot: string | null = null // 用于检测配置是否真的变化了

// 编辑状态（用于资产前缀、目录映射等的编辑）
const editingAssetPrefixes = ref<Record<string, { assetType: string; prefix: string }>>({})
const editingDirectories = ref<Record<string, { assetType: string; directory: string }>>({})
// 「从资产库导入的目录」（libraryAssetTypeToDirectory）没有编辑入口，是有意的：
// 那张表目前**没有任何代码路径读得到**。projectImport 只在 destinationPath 不以 /Game/
// 开头时才走资产库映射，而现有调用方（ImportToProjectModal）一律传 '/Game/Imported'，
// 所以那个分支永远进不去。给一张读不到的表配编辑器，用户改完发现毫无效果。
// 等真的有资产库导入入口了再把编辑器加回来。
const editingExtensions = ref<Record<string, { extension: string; assetType: string }>>({})

// 折叠状态（默认收起）
const collapsedSections = ref({
  assetPrefixes: true,
  textureSuffixPatterns: true,
  assetTypeToDirectory: true,
  extensionToAssetType: true,
  namingConvention: false,
  advanced: true,
  customRules: true
})

/**
 * 初始化编辑状态
 */
const initEditingState = (): void => {
  // 初始化资产前缀编辑状态
  editingAssetPrefixes.value = {}
  for (const [assetType, prefix] of Object.entries(config.value.assetPrefixes)) {
    editingAssetPrefixes.value[assetType] = { assetType, prefix }
  }

  // 初始化目录映射编辑状态
  editingDirectories.value = {}
  for (const [assetType, directory] of Object.entries(config.value.assetTypeToDirectory)) {
    editingDirectories.value[assetType] = { assetType, directory }
  }

  // 初始化扩展名映射编辑状态
  editingExtensions.value = {}
  for (const [extension, assetType] of Object.entries(config.value.extensionToAssetType)) {
    editingExtensions.value[extension] = { extension, assetType }
  }
}

/**
 * 同步编辑状态到配置
 */
const syncEditingToConfig = (): void => {
  // 同步资产前缀
  config.value.assetPrefixes = {}
  for (const item of Object.values(editingAssetPrefixes.value)) {
    if (item.assetType && item.prefix) {
      config.value.assetPrefixes[item.assetType] = item.prefix
    }
  }

  // 同步目录映射
  config.value.assetTypeToDirectory = {}
  for (const item of Object.values(editingDirectories.value)) {
    if (item.assetType && item.directory) {
      config.value.assetTypeToDirectory[item.assetType] = item.directory
    }
  }

  // 同步扩展名映射
  config.value.extensionToAssetType = {}
  for (const item of Object.values(editingExtensions.value)) {
    if (item.extension && item.assetType) {
      config.value.extensionToAssetType[item.extension.toLowerCase()] = item.assetType
    }
  }
}

/**
 * 加载配置
 */
const loadConfig = async (): Promise<void> => {
  try {
    loading.value = true
    config.value = await loadNamingRulesConfig()
    initEditingState()
    // 初始化配置快照
    lastConfigSnapshot = JSON.stringify(config.value)
    // message.success(t('profile.namingRules.loadSuccess'))
  } catch (error) {
    console.error('加载配置失败:', error)
    message.error(t('profile.namingRules.loadFailed'))
  } finally {
    loading.value = false
  }
}

/**
 * 保存配置（内部方法）
 */
const doSave = async (showMessage = false): Promise<boolean> => {
  try {
    autoSaving.value = true
    // 先同步编辑状态到配置
    syncEditingToConfig()
    const success = await saveNamingRulesConfig(config.value)
    if (success) {
      // 重新初始化编辑状态
      initEditingState()
      // 更新配置快照
      lastConfigSnapshot = JSON.stringify(config.value)
      lastSavedTime.value = new Date()
      if (showMessage) {
        message.success(t('profile.namingRules.saveSuccess'))
      }
      return true
    } else {
      if (showMessage) {
        message.error(t('profile.namingRules.saveFailed'))
      }
      return false
    }
  } catch (error) {
    console.error('保存配置失败:', error)
    if (showMessage) {
      message.error(t('profile.namingRules.saveFailed'))
    }
    return false
  } finally {
    autoSaving.value = false
  }
}

/**
 * 手动保存（显示提示）
 */
const handleSave = async (): Promise<void> => {
  saving.value = true
  await doSave(true)
  saving.value = false
}

/**
 * 自动保存（防抖）
 */
const autoSave = (): void => {
  // 清除之前的定时器
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer)
  }

  // 设置新的定时器
  autoSaveTimer = window.setTimeout(() => {
    // 先同步编辑状态到配置
    syncEditingToConfig()

    // 序列化当前配置用于比较
    const currentConfigStr = JSON.stringify(config.value)

    // 只有当配置真的变化了才保存
    if (currentConfigStr !== lastConfigSnapshot) {
      lastConfigSnapshot = currentConfigStr
      void doSave(false)
    }

    autoSaveTimer = null
  }, AUTO_SAVE_DELAY)
}

/**
 * 重置配置
 */
const handleReset = (): void => {
  confirmDialog({
    title: t('profile.namingRules.reset'),
    content: t('profile.namingRules.resetConfirm'),
    onOk: async () => {
      try {
        const success = await resetNamingRulesConfig()
        if (success) {
          config.value = getNamingRulesConfig()
          initEditingState()
          // 更新配置快照
          lastConfigSnapshot = JSON.stringify(config.value)
          message.success(t('profile.namingRules.resetSuccess'))
        } else {
          message.error(t('profile.namingRules.resetFailed'))
        }
      } catch (error) {
        console.error('重置配置失败:', error)
        message.error(t('profile.namingRules.resetFailed'))
      }
    }
  })
}

/**
 * 添加资产前缀
 */
const handleAddAssetPrefix = (): void => {
  const newKey = `new_${Date.now()}`
  editingAssetPrefixes.value[newKey] = { assetType: '', prefix: '' }
}

/**
 * 删除资产前缀
 */
const handleRemoveAssetPrefix = (key: string): void => {
  delete editingAssetPrefixes.value[key]
}

/**
 * 添加纹理后缀模式
 */
const handleAddTexturePattern = (): void => {
  const newPattern: TextureSuffixPattern = {
    pattern: '',
    suffix: '',
    type: '',
    enabled: true
  }
  config.value.textureSuffixPatterns.push(newPattern)
}

/**
 * 删除纹理后缀模式
 */
const handleRemoveTexturePattern = (index: number): void => {
  config.value.textureSuffixPatterns.splice(index, 1)
}

/**
 * 添加目录映射
 */
const handleAddDirectoryMapping = (): void => {
  const newKey = `new_${Date.now()}`
  editingDirectories.value[newKey] = { assetType: '', directory: '' }
}

/**
 * 删除目录映射
 */
const handleRemoveDirectoryMapping = (key: string): void => {
  delete editingDirectories.value[key]
}

/**
 * 添加自定义改名规则。
 *
 * 这一块以前只在配置结构和语言包里存在，页面从来没渲染过，导入流程也没接 ——
 * 一份彻底的死代码。现在它有了明确用途：**整理工程时的改名依据**
 * （`main/agent-v3/tools/ue-content/namingPolicy.ts`）。前缀表按类型给前缀，
 * 这里管前缀表表达不了的那些：去掉 `_FINAL` / `_v2`、`Temp_` 换成 `WIP_` 之类。
 *
 * 导入时**不生效**，只在整理时生效 —— 这是 2026-09-10 定的分工，不是漏接。
 */
const handleAddCustomRule = (): void => {
  config.value.customRules = [
    ...(config.value.customRules ?? []),
    { name: '', match: 'endsWith', text: '', replacement: '', enabled: true }
  ]
}

/**
 * 删除自定义改名规则
 */
const handleRemoveCustomRule = (index: number): void => {
  const rules = [...(config.value.customRules ?? [])]
  rules.splice(index, 1)
  config.value.customRules = rules
}

/**
 * 添加扩展名映射
 */
const handleAddExtensionMapping = (): void => {
  const newKey = `new_${Date.now()}`
  editingExtensions.value[newKey] = { extension: '', assetType: '' }
}

/**
 * 删除扩展名映射
 */
const handleRemoveExtensionMapping = (key: string): void => {
  delete editingExtensions.value[key]
}

// 监听编辑状态变化，自动保存
watch(
  () => editingAssetPrefixes.value,
  () => {
    autoSave()
  },
  { deep: true }
)

watch(
  () => editingDirectories.value,
  () => {
    autoSave()
  },
  { deep: true }
)

watch(
  () => editingExtensions.value,
  () => {
    autoSave()
  },
  { deep: true }
)

// 监听配置中的其他字段变化（纹理模式、命名约定等）
watch(
  () => [
    config.value.textureSuffixPatterns,
    config.value.customRules,
    config.value.namingConvention,
    config.value.autoAddPrefix,
    config.value.autoDetectTextureType
  ],
  () => {
    autoSave()
  },
  { deep: true }
)

onMounted(() => {
  loadConfig()
})

// 组件卸载时清理定时器
onUnmounted(() => {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
})
</script>

<template>
  <div class="profile-naming-rules">
    <!-- Actions -->
    <div class="actions-bar">
      <div class="save-status">
        <span v-if="autoSaving" class="saving-indicator">
          <AppSpin size="small" style="margin-right: 4px" />
          {{ $t('profile.namingRules.saving') }}
        </span>
        <span v-else-if="lastSavedTime" class="saved-indicator">
          {{ $t('profile.namingRules.autoSaved') }}
        </span>
      </div>
      <div class="actions-buttons">
        <AppButton :loading="loading" @click="loadConfig">
          <template #icon><PhArrowClockwise /></template>
          {{ $t('profile.namingRules.reload') }}
        </AppButton>
        <AppButton danger @click="handleReset">
          <template #icon><PhArrowClockwise /></template>
          {{ $t('profile.namingRules.reset') }}
        </AppButton>
      </div>
    </div>

    <!-- 命名约定 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.namingConvention = !collapsedSections.namingConvention"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.namingConvention }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.namingConvention.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.namingConvention" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">
              {{ $t('profile.namingRules.namingConvention.description') }}
            </div>
          </div>
          <div class="row-control">
            <a-select v-model:value="config.namingConvention" style="width: 200px">
              <a-select-option value="pascalCase">{{
                $t('profile.namingRules.namingConvention.pascalCase')
              }}</a-select-option>
              <a-select-option value="camelCase">{{
                $t('profile.namingRules.namingConvention.camelCase')
              }}</a-select-option>
              <a-select-option value="snake_case">{{
                $t('profile.namingRules.namingConvention.snake_case')
              }}</a-select-option>
              <a-select-option value="kebab-case">{{
                $t('profile.namingRules.namingConvention.kebab-case')
              }}</a-select-option>
            </a-select>
          </div>
        </div>
      </div>
    </div>

    <!-- 资产前缀 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.assetPrefixes = !collapsedSections.assetPrefixes"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.assetPrefixes }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.assetPrefixes.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.assetPrefixes" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">{{ $t('profile.namingRules.assetPrefixes.assetType') }}</div>
          <div class="row-title">{{ $t('profile.namingRules.assetPrefixes.prefix') }}</div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div
          v-for="(item, key) in editingAssetPrefixes"
          :key="key"
          class="setting-row editable-row"
        >
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.assetPrefixes.assetType')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.prefix"
              :placeholder="$t('profile.namingRules.assetPrefixes.prefix')"
            />
          </div>
          <div class="row-control">
            <AppButton variant="text" danger size="small" @click="handleRemoveAssetPrefix(key)">
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddAssetPrefix">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.assetPrefixes.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 纹理后缀模式 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.textureSuffixPatterns = !collapsedSections.textureSuffixPatterns"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.textureSuffixPatterns }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.textureSuffixPatterns.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.textureSuffixPatterns" class="settings-card">
        <div
          v-for="(pattern, index) in config.textureSuffixPatterns"
          :key="index"
          class="setting-row texture-pattern-row"
        >
          <div class="row-content">
            <a-input
              v-model:value="pattern.pattern"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.pattern')"
              style="margin-bottom: 8px"
            />
            <a-input
              v-model:value="pattern.suffix"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.suffix')"
              style="margin-bottom: 8px"
            />
            <a-input
              v-model:value="pattern.type"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.type')"
            />
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="pattern.enabled" style="margin-right: 8px" />
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveTexturePattern(index)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddTexturePattern">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.textureSuffixPatterns.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 目录映射 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.assetTypeToDirectory = !collapsedSections.assetTypeToDirectory"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.assetTypeToDirectory }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.assetTypeToDirectory.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.assetTypeToDirectory" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">
            {{ $t('profile.namingRules.assetTypeToDirectory.assetType') }}
          </div>
          <div class="row-title">
            {{ $t('profile.namingRules.assetTypeToDirectory.directory') }}
          </div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div v-for="(item, key) in editingDirectories" :key="key" class="setting-row editable-row">
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.assetTypeToDirectory.assetType')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.directory"
              :placeholder="$t('profile.namingRules.assetTypeToDirectory.directoryPlaceholder')"
            />
          </div>
          <div class="row-control">
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveDirectoryMapping(key)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddDirectoryMapping">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.assetTypeToDirectory.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 扩展名映射 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.extensionToAssetType = !collapsedSections.extensionToAssetType"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.extensionToAssetType }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.extensionToAssetType.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.extensionToAssetType" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">
            {{ $t('profile.namingRules.extensionToAssetType.extension') }}
          </div>
          <div class="row-title">
            {{ $t('profile.namingRules.extensionToAssetType.assetType') }}
          </div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div v-for="(item, key) in editingExtensions" :key="key" class="setting-row editable-row">
          <div class="row-content">
            <a-input
              v-model:value="item.extension"
              :placeholder="$t('profile.namingRules.extensionToAssetType.extensionPlaceholder')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.extensionToAssetType.assetType')"
            />
          </div>
          <div class="row-control">
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveExtensionMapping(key)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddExtensionMapping">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.extensionToAssetType.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!--
      自定义改名规则。以前配置结构和语言包里都有，页面从来没渲染过 —— 死代码。
      现在它是整理工程时的改名依据（见 namingPolicy.ts），所以得有地方填。
    -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.customRules = !collapsedSections.customRules"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.customRules }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.customRules.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.customRules" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-desc">{{ $t('profile.namingRules.customRules.description') }}</div>
          </div>
        </div>
        <div
          v-for="(rule, index) in config.customRules ?? []"
          :key="index"
          class="setting-row texture-pattern-row"
        >
          <div class="row-content custom-rule-fields">
            <a-input
              v-model:value="rule.name"
              :placeholder="$t('profile.namingRules.customRules.name')"
            />
            <div class="custom-rule-match">
              <a-select v-model:value="rule.match" class="custom-rule-where">
                <a-select-option value="endsWith">
                  {{ $t('profile.namingRules.customRules.endsWith') }}
                </a-select-option>
                <a-select-option value="startsWith">
                  {{ $t('profile.namingRules.customRules.startsWith') }}
                </a-select-option>
                <a-select-option value="contains">
                  {{ $t('profile.namingRules.customRules.contains') }}
                </a-select-option>
              </a-select>
              <a-input
                v-model:value="rule.text"
                :placeholder="$t('profile.namingRules.customRules.textPlaceholder')"
              />
            </div>
            <a-input
              v-model:value="rule.replacement"
              :placeholder="$t('profile.namingRules.customRules.replacementPlaceholder')"
            />
          </div>
          <div class="row-control custom-rule-control">
            <AppSwitch v-model:checked="rule.enabled" />
            <AppButton variant="text" danger size="small" @click="handleRemoveCustomRule(index)">
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddCustomRule">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.customRules.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 高级选项 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.advanced = !collapsedSections.advanced"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.advanced }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.advanced.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.advanced" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">{{ $t('profile.namingRules.advanced.autoAddPrefix') }}</div>
            <div class="row-desc">{{ $t('profile.namingRules.advanced.autoAddPrefixDesc') }}</div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="config.autoAddPrefix" />
          </div>
        </div>
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">
              {{ $t('profile.namingRules.advanced.autoDetectTextureType') }}
            </div>
            <div class="row-desc">
              {{ $t('profile.namingRules.advanced.autoDetectTextureTypeDesc') }}
            </div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="config.autoDetectTextureType" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.profile-naming-rules {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px;
  animation: fadeIn 0.3s ease;
}

.actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;

  .save-status {
    display: flex;
    align-items: center;
    font-size: 13px;
    color: var(--color-text-secondary);

    .saving-indicator {
      color: var(--color-accent-text);
      display: flex;
      align-items: center;
    }

    .saved-indicator {
      color: var(--color-success-text);
    }
  }

  .actions-buttons {
    display: flex;
    gap: 12px;
  }
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .group-title {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-primary);
    margin: 0;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border-subtle);
    letter-spacing: 0.02em;
    width: 100%;
  }

  .group-title-collapsible {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    padding: 4px;
    margin: 0 0 0 -4px;
    border-radius: 4px;
    transition: background-color 0.2s;

    &:hover {
      background-color: var(--color-bg-surface-hover);
    }

    .collapse-icon {
      font-size: 12px;
      color: var(--color-text-muted);
      transition: transform 0.2s;
      transform: rotate(0deg);

      &:not(.collapsed) {
        transform: rotate(90deg);
      }
    }
  }
}

.settings-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  .setting-row:not(:last-child) {
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .setting-row-header {
    display: flex;
    align-items: center;
    padding: 12px 20px;
    gap: 16px;
    background: var(--color-bg-surface-hover);
    font-weight: 600;
    font-size: 13px;
    color: var(--color-text-secondary);

    .row-title {
      flex: 1;
    }
  }
}

.setting-row {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  gap: 16px;
  transition: background-color 0.2s;
  min-height: 48px;

  .row-icon {
    font-size: 20px;
    color: var(--color-text-secondary);
    width: 24px;
    display: flex;
    justify-content: center;
  }

  .row-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;

    .row-title {
      font-size: var(--font-size-sm);
      color: var(--color-text-primary);
    }

    .row-desc {
      font-size: 12px;
      color: var(--color-text-muted);
    }
  }

  .row-control {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &.texture-pattern-row {
    flex-direction: column;
    align-items: stretch;

    .row-content {
      display: flex;
      flex-direction: column;
    }
  }

  // 自定义改名规则那三格。间距走 --space-2（=8px），不写死像素
  .custom-rule-fields {
    gap: var(--space-2);
  }

  .custom-rule-match {
    display: flex;
    gap: var(--space-2);

    .custom-rule-where {
      flex: 0 0 auto;
      min-width: 120px;
    }

    :deep(.ant-input) {
      flex: 1 1 auto;
    }
  }

  .custom-rule-control {
    gap: var(--space-2);
  }

  &.editable-row {
    .row-content {
      min-width: 0;

      :deep(.ant-input) {
        font-size: 13px;
      }
    }
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
