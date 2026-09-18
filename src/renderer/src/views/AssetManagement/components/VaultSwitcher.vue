<template>
  <div ref="vaultSwitcherRef" class="vault-switcher" :class="{ expanded: isExpanded }">
    <!-- 当前选中的保管库 -->
    <div class="vault-current" @click="toggleDropdown">
      <div class="vault-info">
        <div class="vault-icon">
          <img
            v-if="isIconUrl(currentVault?.icon)"
            :src="currentVault?.icon"
            class="vault-icon-img"
          />
          <component :is="getVaultIcon(currentVault?.icon)" v-else />
        </div>
        <div class="vault-details">
          <div class="vault-name-row">
            <div class="vault-name">{{ currentVault?.name || '' }}</div>
          </div>
        </div>
      </div>
      <div class="vault-actions">
        <span class="vault-status" :class="`vault-type-${currentVault?.vaultType || 'reference'}`">
          {{ getVaultTypeLabel(currentVault?.vaultType) }}
        </span>
        <span
          v-if="
            currentVault?.vaultType === 'network' &&
            currentVault?.syncStatus === 'offline' &&
            currentVault?.networkMigrationState !== 'legacy_pending'
          "
          class="vault-status vault-offline"
        >
          {{ t('vaultSwitcher.hostOffline') }}
        </span>
        <PhCaretDown weight="fill" class="expand-icon" :class="{ rotated: isExpanded }" />
      </div>
    </div>

    <!-- 下拉列表 -->
    <Transition name="dropdown">
      <div v-show="isExpanded" class="vault-dropdown">
        <div id="vault-list-container" ref="vaultListRef" class="vault-list">
          <div
            v-for="vault in vaults"
            :key="vault.id"
            class="vault-item draggable"
            :class="{ active: vault.id === currentVault?.id }"
            :data-vault-id="vault.id"
            @click="handleVaultSelect(vault)"
          >
            <div class="drag-handle">
              <div class="drag-dots">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
              </div>
            </div>
            <div class="vault-icon">
              <img v-if="isIconUrl(vault.icon)" :src="vault.icon" class="vault-icon-img" />
              <component :is="getVaultIcon(vault.icon)" v-else />
            </div>
            <div class="vault-details">
              <template v-if="renamingVaultId === vault.id">
                <div class="vault-rename-wrapper" @click.stop>
                  <Input
                    ref="renameInputRef"
                    v-model:value="newVaultName"
                    class="vault-rename-input"
                    @blur="handleRenameConfirm"
                    @press-enter="handleRenameConfirm"
                    @keydown.esc="cancelRename"
                  />
                  <div class="rename-actions">
                    <PhCheck class="rename-action-btn confirm" @click.stop="handleRenameConfirm" />
                    <PhX class="rename-action-btn cancel" @click.stop="cancelRename" />
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="vault-name-row">
                  <div class="vault-name">{{ vault.name }}</div>
                </div>
                <div class="vault-path">{{ vault.networkPath || vault.path }}</div>
              </template>
            </div>
            <div class="vault-status-badge" :class="`vault-type-${vault.vaultType}`">
              {{ getVaultTypeLabel(vault.vaultType) }}
            </div>
            <div
              v-if="
                vault.vaultType === 'network' &&
                vault.syncStatus === 'offline' &&
                vault.networkMigrationState !== 'legacy_pending'
              "
              class="vault-status-badge vault-offline"
            >
              {{ t('vaultSwitcher.offline') }}
            </div>
            <div class="vault-more-btn" @click.stop="handleContextMenu($event, vault)">
              <PhDotsThree />
            </div>
          </div>
        </div>

        <!-- 创建保管库按钮 -->
        <div class="vault-actions-section">
          <div class="vault-action-item" @click="handleCreateVault">
            <PhFolderPlus class="action-icon" />
            <span>{{ t('assetLib.vault.create') }}</span>
          </div>
          <div class="vault-action-item" @click="handleCleanCache">
            <PhTrash class="action-icon" />
            <span>{{ t('assetLib.vault.clearCache') }}</span>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 右键菜单 -->
    <div v-show="contextMenuVisible" class="context-menu" :style="contextMenuStyle" @click.stop>
      <div class="context-menu-item" @click="handleRename">
        {{ t('assetLib.vault.context.rename') }}
      </div>
      <div
        v-if="selectedVault?.vaultType === VaultType.NETWORK"
        class="context-menu-item"
        @click="handleEditBrowsePath"
      >
        {{ t('vaultSwitcher.contextMenu.editBrowsePath') }}
      </div>
      <div
        v-if="isHttpNetworkVault(selectedVault)"
        class="context-menu-item"
        @click="handleEditServerAddress"
      >
        {{ t('vaultSwitcher.contextMenu.editServerAddress') }}
      </div>
      <div
        v-if="isHttpNetworkVault(selectedVault)"
        class="context-menu-item"
        @click="handleEditAdminKey"
      >
        {{ t('vaultSwitcher.contextMenu.editAdminKey') }}
      </div>
      <div
        v-if="isHttpNetworkVault(selectedVault)"
        class="context-menu-item"
        @click="handleOpenThumbnailBackup"
      >
        {{ t('vaultSwitcher.contextMenu.thumbnailBackup') }}
      </div>
      <div class="context-menu-item" @click="handleEditIcon">
        {{ t('assetLib.vault.context.changeIcon') }}
      </div>

      <div class="context-menu-item" @click="handleOpenInFileManager">
        {{ t('assetLib.vault.context.openInExplorer') }}
      </div>
      <div
        v-if="selectedVault?.systemKey === 'aigc'"
        class="context-menu-item"
        @click="handleChangeSaveLocation"
      >
        {{ t('vaultSwitcher.contextMenu.changeSaveLocation') }}
      </div>
      <div v-if="!selectedVault?.isSystem" class="context-menu-divider"></div>
      <div
        v-if="!selectedVault?.isSystem"
        class="context-menu-item danger"
        @click="handleRemoveFromList"
      >
        {{ t('assetLib.vault.delete.title') }}
      </div>
    </div>

    <!-- 遮罩层 -->
    <div
      v-show="isExpanded || contextMenuVisible"
      class="vault-overlay"
      @click="handleOverlayClick"
    ></div>

    <!-- 创建保管库模态框 -->
    <CreateVaultModal v-model:open="showCreateModal" @created="handleVaultCreated" />

    <AppModal
      v-model:open="showBrowsePathModal"
      :title="t('vaultSwitcher.modals.editBrowsePathModal.title')"
      :confirm-loading="browsePathSaving"
      :ok-text="t('vaultSwitcher.buttons.save')"
      :cancel-text="t('vaultSwitcher.buttons.cancel')"
      @ok="handleBrowsePathSave"
      @cancel="handleBrowsePathCancel"
    >
      <div class="browse-path-modal">
        <div v-if="editingBrowseVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.vault') }}</div>
          <div class="browse-path-meta-value">{{ editingBrowseVault.name }}</div>
        </div>
        <div v-if="editingBrowseVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.networkAddress') }}</div>
          <div class="browse-path-meta-value mono">
            {{ editingBrowseVault.networkPath || editingBrowseVault.path }}
          </div>
        </div>
        <div class="browse-path-form">
          <div class="browse-path-label">{{ t('vaultSwitcher.labels.browsePath') }}</div>
          <a-input
            v-model:value="editingBrowsePath"
            :placeholder="t('vaultSwitcher.modals.editBrowsePathModal.pathPlaceholder')"
          />
          <div class="browse-path-tip">
            {{ t('vaultSwitcher.modals.editBrowsePathModal.tip') }}
          </div>
          <div v-if="browsePathError" class="browse-path-error">{{ browsePathError }}</div>
        </div>
      </div>
    </AppModal>

    <AppModal
      v-model:open="showServerAddressModal"
      :title="t('vaultSwitcher.modals.editServerAddressModal.title')"
      :confirm-loading="serverAddressSaving"
      :ok-text="t('vaultSwitcher.buttons.save')"
      :cancel-text="t('vaultSwitcher.buttons.cancel')"
      @ok="handleServerAddressSave"
      @cancel="handleServerAddressCancel"
    >
      <div class="browse-path-modal">
        <div v-if="editingServerVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.vault') }}</div>
          <div class="browse-path-meta-value">{{ editingServerVault.name }}</div>
        </div>
        <div v-if="editingServerVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.currentAddress') }}</div>
          <div class="browse-path-meta-value mono">
            {{ editingServerVault.networkPath }}
          </div>
        </div>
        <div v-if="editingRemoteVaultId" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.remoteVaultId') }}</div>
          <div class="browse-path-meta-value mono">{{ editingRemoteVaultId }}</div>
        </div>
        <div class="browse-path-form">
          <div class="browse-path-label">{{ t('vaultSwitcher.labels.newServerAddress') }}</div>
          <a-input
            v-model:value="editingServerAddress"
            :placeholder="t('vaultSwitcher.modals.editServerAddressModal.addressPlaceholder')"
          />
          <div class="browse-path-tip">
            {{ t('vaultSwitcher.modals.editServerAddressModal.tip') }}
          </div>
        </div>
        <div class="browse-path-form">
          <div class="browse-path-label">{{ t('vaultSwitcher.labels.adminKeyWithHint') }}</div>
          <a-input-password
            v-model:value="editingServerApiKey"
            :placeholder="t('vaultSwitcher.modals.editServerAddressModal.adminKeyPlaceholder')"
          />
        </div>
        <div v-if="serverAddressError" class="browse-path-error">{{ serverAddressError }}</div>
      </div>
    </AppModal>

    <AppModal
      v-model:open="showAdminKeyModal"
      :title="t('vaultSwitcher.modals.editAdminKeyModal.title')"
      :confirm-loading="adminKeySaving"
      :ok-text="t('vaultSwitcher.buttons.save')"
      :cancel-text="t('vaultSwitcher.buttons.cancel')"
      @ok="handleAdminKeySave"
      @cancel="handleAdminKeyCancel"
    >
      <div class="browse-path-modal">
        <div v-if="editingAdminKeyVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.vault') }}</div>
          <div class="browse-path-meta-value">{{ editingAdminKeyVault.name }}</div>
        </div>
        <div v-if="editingAdminKeyVault" class="browse-path-meta">
          <div class="browse-path-meta-label">{{ t('vaultSwitcher.labels.server') }}</div>
          <div class="browse-path-meta-value mono">
            {{ getHttpVaultParts(editingAdminKeyVault.networkPath)?.serverBase }}
          </div>
        </div>
        <div class="browse-path-form">
          <div class="browse-path-label">{{ t('vaultSwitcher.labels.adminKey') }}</div>
          <a-input-password
            v-model:value="editingAdminKey"
            :placeholder="t('vaultSwitcher.modals.editAdminKeyModal.adminKeyPlaceholder')"
            @press-enter="handleAdminKeySave"
          />
        </div>
        <div v-if="adminKeyError" class="browse-path-error">{{ adminKeyError }}</div>
      </div>
    </AppModal>

    <AppModal
      v-model:open="thumbnailBackupModalOpen"
      :title="t('vaultSwitcher.thumbnailBackup.title')"
      hide-footer
      @cancel="handleThumbnailBackupCancel"
    >
      <div class="thumbnail-backup-modal">
        <div v-if="thumbnailBackupVault" class="thumbnail-backup-header">
          <div>
            <div class="thumbnail-backup-label">{{ t('vaultSwitcher.labels.vault') }}</div>
            <div class="thumbnail-backup-value">{{ thumbnailBackupVault.name }}</div>
          </div>
          <div>
            <div class="thumbnail-backup-label">{{ t('vaultSwitcher.labels.server') }}</div>
            <div class="thumbnail-backup-value mono">
              {{ getHttpVaultParts(thumbnailBackupVault.networkPath)?.serverBase }}
            </div>
          </div>
        </div>

        <AppAlert
          v-if="thumbnailBackupError"
          type="error"
          show-icon
          :message="thumbnailBackupError"
        />

        <a-skeleton
          v-if="thumbnailBackupLoading && !thumbnailBackupStatus"
          active
          :paragraph="{ rows: 3 }"
        />

        <template v-else-if="thumbnailBackupStatus">
          <div class="thumbnail-backup-grid">
            <div class="thumbnail-backup-stat">
              <span>{{ t('vaultSwitcher.thumbnailBackup.sourceLabel') }}</span>
              <strong>{{ thumbnailBackupStatus.source.count }}</strong>
              <small>{{ formatBackupBytes(thumbnailBackupStatus.source.bytes) }}</small>
            </div>
            <div class="thumbnail-backup-stat">
              <span>{{ t('vaultSwitcher.thumbnailBackup.backupLabel') }}</span>
              <strong>{{ thumbnailBackupStatus.backup.count }}</strong>
              <small>{{ formatBackupBytes(thumbnailBackupStatus.backup.bytes) }}</small>
            </div>
            <div class="thumbnail-backup-stat warning">
              <span>{{ t('vaultSwitcher.thumbnailBackup.recoverableLabel') }}</span>
              <strong>{{ thumbnailBackupStatus.backupOnlyCount }}</strong>
              <small>{{ t('vaultSwitcher.thumbnailBackup.inBackupOnly') }}</small>
            </div>
            <div class="thumbnail-backup-stat">
              <span>{{ t('vaultSwitcher.thumbnailBackup.notSyncedLabel') }}</span>
              <strong>{{ thumbnailBackupStatus.sourceOnlyCount }}</strong>
              <small>{{ t('vaultSwitcher.thumbnailBackup.sourceOnly') }}</small>
            </div>
          </div>

          <div class="thumbnail-backup-note">
            {{ t('vaultSwitcher.thumbnailBackup.restoreNote') }}
          </div>
        </template>

        <div class="thumbnail-backup-actions">
          <AppButton :loading="thumbnailBackupLoading" @click="loadThumbnailBackupStatus">
            {{ t('vaultSwitcher.thumbnailBackup.refreshButton') }}
          </AppButton>
          <AppButton :loading="thumbnailBackupSyncing" @click="handleSyncThumbnailBackup">
            {{ t('vaultSwitcher.thumbnailBackup.syncButton') }}
          </AppButton>
          <AppButton
            variant="primary"
            :disabled="!canRestoreThumbnails"
            :loading="thumbnailBackupRestoring"
            @click="handleRestoreThumbnailBackup"
          >
            {{ t('vaultSwitcher.thumbnailBackup.restoreButton') }}
          </AppButton>
        </div>
      </div>
    </AppModal>

    <!-- 更换图标模态框 -->
    <ChangeIconModal
      v-model:open="showChangeIconModal"
      :vault-id="selectedVault?.id || ''"
      :current-icon="selectedVault?.icon"
      @success="handleIconChanged"
    />

    <!-- 删除保管库确认模态框 -->
    <DeleteVaultModal v-model:open="deleteModalVisible" :vault="vaultToDelete" />
  </div>
</template>

<script setup lang="ts">
import AppAlert from '@renderer/components/AppAlert.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, onMounted, computed, nextTick, onUnmounted } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import { Input } from 'ant-design-vue'
import {
  PhBookOpen,
  PhCaretDown,
  PhCheck,
  PhCloud,
  PhDatabase,
  PhDotsThree,
  PhFile,
  PhFolder,
  PhFolderPlus,
  PhGear,
  PhHardDrive,
  PhKanban,
  PhShieldCheck,
  PhTrash,
  PhX
} from '@phosphor-icons/vue'
import { useVaultStore, type VaultInfo, VaultType } from '../../../store/modules/vaultStore'
import CreateVaultModal from './CreateVaultModal.vue'
import ChangeIconModal from './ChangeIconModal.vue'
import DeleteVaultModal from './DeleteVaultModal.vue'
import Sortable from 'sortablejs'
import { isBrowsableAbsolutePath } from '../utils/networkBrowsePath'

// 使用保管库store
const vaultStore = useVaultStore()
const { t } = useI18n()

// 计算属性
const vaults = computed(() => vaultStore.vaults)
const currentVault = computed(() => vaultStore.currentVault)
// 加载状态（保留以备后续使用）
// const isLoading = ref(false)

const isProtectedVault = (vault?: VaultInfo | null): boolean => Boolean(vault?.isSystem)

const getHttpVaultParts = (
  networkPath?: string
): { serverBase: string; remoteVaultId: string } | null => {
  if (!networkPath || !/^https?:\/\//i.test(networkPath)) return null

  try {
    const url = new URL(networkPath)
    const remoteVaultId = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!remoteVaultId) return null
    return {
      serverBase: `${url.protocol}//${url.host}`,
      remoteVaultId
    }
  } catch {
    return null
  }
}

const isHttpNetworkVault = (vault?: VaultInfo | null): boolean =>
  Boolean(getHttpVaultParts(vault?.networkPath))

const buildHttpVaultNetworkPath = (
  serverInput: string,
  fallbackRemoteVaultId: string
): { serverBase: string; remoteVaultId: string; networkPath: string } => {
  const trimmed = serverInput.trim()
  if (!trimmed) {
    throw new Error(t('vaultSwitcher.serverAddressError.inputRequired'))
  }

  const valueWithScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(valueWithScheme)
  const pastedRemoteVaultId = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const remoteVaultId = pastedRemoteVaultId || fallbackRemoteVaultId

  if (!remoteVaultId) {
    throw new Error(t('vaultSwitcher.serverAddressError.remoteVaultIdUnrecognized'))
  }

  const serverBase = `${url.protocol}//${url.host}`
  return {
    serverBase,
    remoteVaultId,
    networkPath: `${serverBase}/${remoteVaultId}`
  }
}

type ThumbnailBackupDirectoryStats = {
  path: string
  exists: boolean
  count: number
  bytes: number
}

type ThumbnailBackupStatus = {
  sourceDir: string
  backupDir: string
  source: ThumbnailBackupDirectoryStats
  backup: ThumbnailBackupDirectoryStats
  sourceOnlyCount: number
  backupOnlyCount: number
  sourceOnlySamples: string[]
  backupOnlySamples: string[]
  errors: Array<{ relativePath: string; error: string }>
}

type ThumbnailBackupSyncResult = {
  scanned: number
  copied: number
  skipped: number
  bytesCopied: number
  errors: Array<{ relativePath: string; error: string }>
}

type ThumbnailBackupRestoreResult = {
  scanned: number
  restored: number
  skippedExisting: number
  overwritten: number
  bytesRestored: number
  errors: Array<{ relativePath: string; error: string }>
}

// 判断图标是否为URL
const isIconUrl = (icon?: string): boolean => {
  if (!icon) return false
  return icon.includes('/') || icon.includes('\\') || icon.startsWith('http')
}

// 保管库类型标签转换
const getVaultTypeLabel = (vaultType?: VaultType): string => {
  switch (vaultType) {
    case VaultType.REFERENCE:
      return t('assetLib.vault.type.reference')
    case VaultType.BACKUP:
      return t('assetLib.vault.type.backup')
    case VaultType.NETWORK:
      return t('assetLib.vault.type.network')
    default:
      return t('assetLib.vault.type.reference')
  }
}

const getSystemBadgeLabel = (vault?: VaultInfo | null): string => {
  if (!vault?.isSystem) return ''
  return vault.systemKey === 'aigc' ? 'AIGC' : '系统'
}

const getSystemDescription = (vault?: VaultInfo | null): string => {
  if (!vault?.isSystem) return ''
  if (vault.systemKey === 'aigc') return t('vaultSwitcher.systemBadge.aigc')
  if (vault.systemKey === 'default') return t('vaultSwitcher.systemBadge.default')
  return t('vaultSwitcher.systemBadge.system')
}

// 获取保管库图标组件
const getVaultIcon = (iconName?: string) => {
  const iconMap = {
    database: PhDatabase,
    folder: PhFolder,
    cloud: PhCloud,
    hdd: PhHardDrive,
    safety: PhShieldCheck,
    book: PhBookOpen,
    project: PhKanban,
    file: PhFile,
    setting: PhGear
  }
  return iconMap[iconName as keyof typeof iconMap] || PhDatabase
}

// 响应式数据
const isExpanded = ref(false)
const dropdownStyle = ref({})
const vaultSwitcherRef = ref<HTMLElement>()
const contextMenuVisible = ref(false)
const contextMenuStyle = ref({})
const selectedVault = ref<VaultInfo | null>(null)
const showCreateModal = ref(false)
const showChangeIconModal = ref(false)
const showBrowsePathModal = ref(false)
const renamingVaultId = ref<string | null>(null)
const renameInputRef = ref<any>(null)
const newVaultName = ref('')
const renaming = ref(false)
const editingBrowseVault = ref<VaultInfo | null>(null)
const editingBrowsePath = ref('')
const browsePathError = ref('')
const browsePathSaving = ref(false)
const showServerAddressModal = ref(false)
const editingServerVault = ref<VaultInfo | null>(null)
const editingServerAddress = ref('')
const editingServerApiKey = ref('')
const serverAddressError = ref('')
const serverAddressSaving = ref(false)
const showAdminKeyModal = ref(false)
const editingAdminKeyVault = ref<VaultInfo | null>(null)
const editingAdminKey = ref('')
const adminKeyError = ref('')
const adminKeySaving = ref(false)
const thumbnailBackupModalOpen = ref(false)
const thumbnailBackupVault = ref<VaultInfo | null>(null)
const thumbnailBackupStatus = ref<ThumbnailBackupStatus | null>(null)
const thumbnailBackupLoading = ref(false)
const thumbnailBackupSyncing = ref(false)
const thumbnailBackupRestoring = ref(false)
const thumbnailBackupError = ref('')
const editingRemoteVaultId = computed(
  () => getHttpVaultParts(editingServerVault.value?.networkPath)?.remoteVaultId || ''
)
const canRestoreThumbnails = computed(() =>
  Boolean(thumbnailBackupStatus.value && thumbnailBackupStatus.value.backupOnlyCount > 0)
)

// SortableJS 实例
const sortableInstance = ref<Sortable | null>(null)
const vaultListRef = ref<HTMLElement>()

// 计算下拉菜单位置
const calculateDropdownPosition = () => {
  if (!vaultSwitcherRef.value) return

  const rect = vaultSwitcherRef.value.getBoundingClientRect()
  dropdownStyle.value = {
    top: `${rect.bottom + 4}px`,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width + 40, 400)}px`
  }
}

// 切换下拉状态
const toggleDropdown = async () => {
  console.log('toggleDropdown 被调用，当前 isExpanded:', isExpanded.value)

  if (!isExpanded.value) {
    calculateDropdownPosition()
  }
  isExpanded.value = !isExpanded.value

  console.log('切换后 isExpanded:', isExpanded.value)

  // 如果展开了下拉菜单，初始化SortableJS
  if (isExpanded.value) {
    await nextTick()
    initSortable()
  } else {
    // 如果关闭了下拉菜单，销毁SortableJS实例
    destroySortable()
  }
}

// 关闭下拉
const closeDropdown = () => {
  isExpanded.value = false
  destroySortable()
}

// 选择保管库
const handleVaultSelect = async (vault: VaultInfo) => {
  if (vault.id === currentVault.value?.id) {
    closeDropdown()
    return
  }

  try {
    await vaultStore.switchVault(vault.id)
    closeDropdown()

    const vaultName = vault.name || t('assetLib.vault.untitled')
    // message.success(t('assetLib.vault.messages.switched', { name: vaultName }))

    // 触发数据刷新事件
    emit('vaultChanged', vault)

    // 网络库连接时 SyncClient 已在后台同步；切库本身保持轻量，避免自动扫描卡住页面。
  } catch (error) {
    console.error('切换保管库失败:', error)
    // 显示具体的错误信息
    const errorMsg =
      error instanceof Error ? error.message : t('vaultSwitcher.messages.switchFailed')
    message.error(errorMsg)
  }
}

// 创建保管库
const handleCreateVault = () => {
  closeDropdown()
  showCreateModal.value = true
}

// 清除缓存（清理未使用的缩略图/视频文件）
const handleCleanCache = async () => {
  closeDropdown()

  try {
    message.loading({ content: t('assetLib.vault.cleaningCache'), key: 'cleanCache', duration: 0 })

    const result = await vaultStore.cleanThumbnailCache()

    if (result.success) {
      const freedMB = ((result.freedBytes || 0) / 1024 / 1024).toFixed(2)
      message.success({
        content: t('assetLib.vault.cacheCleanedSuccess', {
          count: result.deletedCount || 0,
          size: freedMB
        }),
        key: 'cleanCache'
      })
    } else if (result.error === 'NO_WRITE_PERMISSION') {
      message.warning({
        content: t('assetLib.vault.cacheCleanNoPermission'),
        key: 'cleanCache'
      })
    } else {
      message.error({
        content: t('assetLib.vault.cacheCleanFailed'),
        key: 'cleanCache'
      })
    }
  } catch (error) {
    console.error('清理缓存失败:', error)
    message.error({
      content: t('assetLib.vault.cacheCleanFailed'),
      key: 'cleanCache'
    })
  }
}

// 定义事件
const emit = defineEmits<{
  manage: []
  vaultChanged: [vault: VaultInfo]
}>()

/**
 * 处理创建保管库成功
 * 创建成功后自动切换到新创建的资产库，并在 500ms 后导航到 ALL 文件夹
 */
const handleVaultCreated = async (vault: VaultInfo) => {
  showCreateModal.value = false

  // 刷新保管库列表
  await vaultStore.loadVaults()

  // 自动切换到新创建的资产库
  try {
    await vaultStore.switchVault(vault.id)
    // message.success(t('assetLib.vault.messages.switched', { name: vault.name }))
  } catch (error) {
    console.error('自动切换到新资产库失败:', error)
  }

  // 触发保管库变更事件
  emit('vaultChanged', vault)

  // 500ms 后自动导航到 ALL 文件夹
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('navigate-to-all-folder'))
  }, 500)
}

/**
 * 右键菜单处理
 * 在鼠标点击位置附近显示菜单
 */
const handleContextMenu = (event: MouseEvent, vault: VaultInfo): void => {
  event.stopPropagation()

  selectedVault.value = vault

  // 在鼠标位置稍微偏移显示（减小左偏移，让菜单更靠右）
  contextMenuStyle.value = {
    top: `${event.clientY - 40}px`,
    left: `${event.clientX - 210}px`
  }
  contextMenuVisible.value = true
}

// 关闭右键菜单
const closeContextMenu = () => {
  contextMenuVisible.value = false
  // 移除 selectedVault.value = null 的逻辑，避免后续操作获取不到选中的保管库
}

// 右键菜单操作
const handleRename = async () => {
  closeContextMenu()
  if (selectedVault.value) {
    renamingVaultId.value = selectedVault.value.id
    newVaultName.value = selectedVault.value.name
    await nextTick()

    const input = Array.isArray(renameInputRef.value)
      ? renameInputRef.value[0]
      : renameInputRef.value

    if (input) {
      input.focus()
      if (typeof input.select === 'function') {
        input.select()
      }
    }
  }
}

const handleRenameConfirm = async () => {
  if (!renamingVaultId.value || !newVaultName.value.trim()) {
    cancelRename()
    return
  }

  // 获取当前正在重命名的保管库
  const targetVault = vaults.value.find((v) => v.id === renamingVaultId.value)
  if (!targetVault) {
    cancelRename()
    return
  }

  if (newVaultName.value === targetVault.name) {
    cancelRename()
    return
  }

  try {
    renaming.value = true
    await vaultStore.renameVault(renamingVaultId.value, newVaultName.value.trim())
    message.success(t('assetLib.vault.messages.renamed') || '重命名成功')
    renamingVaultId.value = null
  } catch (error) {
    console.error('重命名失败:', error)
    message.error(t('assetLib.vault.messages.renameFailed') || '重命名失败')
  } finally {
    renaming.value = false
  }
}

const cancelRename = () => {
  renamingVaultId.value = null
  newVaultName.value = ''
}

const handleEditIcon = () => {
  closeContextMenu()
  if (selectedVault.value) {
    showChangeIconModal.value = true
  }
}

const validateBrowsePath = (): boolean => {
  browsePathError.value = ''

  const browsePath = editingBrowsePath.value.trim()
  if (!browsePath) {
    return true
  }

  if (!isBrowsableAbsolutePath(browsePath)) {
    browsePathError.value = t('vaultSwitcher.browsePathError.uncOrAbsolute')
    return false
  }

  return true
}

const handleEditBrowsePath = () => {
  closeContextMenu()
  if (!selectedVault.value || selectedVault.value.vaultType !== VaultType.NETWORK) {
    return
  }

  editingBrowseVault.value = selectedVault.value
  editingBrowsePath.value = selectedVault.value.browsePath || ''
  browsePathError.value = ''
  showBrowsePathModal.value = true
}

const handleBrowsePathCancel = () => {
  showBrowsePathModal.value = false
  editingBrowseVault.value = null
  editingBrowsePath.value = ''
  browsePathError.value = ''
}

const handleBrowsePathSave = async () => {
  if (!editingBrowseVault.value) {
    return
  }
  if (!validateBrowsePath()) {
    return
  }

  try {
    browsePathSaving.value = true
    await vaultStore.updateVaultBrowsePath(
      editingBrowseVault.value.id,
      editingBrowsePath.value.trim() || undefined
    )
    message.success(t('vaultSwitcher.messages.browsePathUpdated'))
    handleBrowsePathCancel()
  } catch (error) {
    console.error('更新共享浏览路径失败:', error)
    message.error(
      error instanceof Error ? error.message : t('vaultSwitcher.messages.updateBrowsePathFailed')
    )
  } finally {
    browsePathSaving.value = false
  }
}

const handleEditServerAddress = (): void => {
  closeContextMenu()
  if (!selectedVault.value || !isHttpNetworkVault(selectedVault.value)) {
    return
  }

  const parts = getHttpVaultParts(selectedVault.value.networkPath)
  if (!parts) {
    message.error(t('vaultSwitcher.serverAddressError.invalidFormat'))
    return
  }

  editingServerVault.value = selectedVault.value
  editingServerAddress.value = parts.serverBase
  editingServerApiKey.value = localStorage.getItem('assetManagement.serverApiKey') || ''
  serverAddressError.value = ''
  showServerAddressModal.value = true
}

const handleServerAddressCancel = (): void => {
  showServerAddressModal.value = false
  editingServerVault.value = null
  editingServerAddress.value = ''
  editingServerApiKey.value = ''
  serverAddressError.value = ''
}

const handleEditAdminKey = (): void => {
  closeContextMenu()
  if (!selectedVault.value || !isHttpNetworkVault(selectedVault.value)) return
  editingAdminKeyVault.value = selectedVault.value
  editingAdminKey.value = ''
  adminKeyError.value = ''
  showAdminKeyModal.value = true
}

const handleAdminKeyCancel = (): void => {
  showAdminKeyModal.value = false
  editingAdminKeyVault.value = null
  editingAdminKey.value = ''
  adminKeyError.value = ''
}

const handleAdminKeySave = async (): Promise<void> => {
  if (!editingAdminKeyVault.value) return
  if (adminKeySaving.value) return
  adminKeySaving.value = true
  adminKeyError.value = ''
  try {
    const key = editingAdminKey.value.trim()
    const result = await window.api.invoke(
      'networkVaultV2:setRemoteVaultApiKey',
      editingAdminKeyVault.value.id,
      key || undefined
    )
    if (!result?.success) {
      adminKeyError.value = result?.error || t('vaultSwitcher.messages.adminKeySaveFailed')
      return
    }
    message.success(
      key ? t('vaultSwitcher.messages.adminKeySaved') : t('vaultSwitcher.messages.adminKeyCleared')
    )
    handleAdminKeyCancel()
  } catch (error) {
    adminKeyError.value =
      error instanceof Error ? error.message : t('vaultSwitcher.messages.adminKeySaveFailed')
  } finally {
    adminKeySaving.value = false
  }
}

const formatBackupBytes = (bytes?: number): string => {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const formatThumbnailBackupError = (error: unknown, fallback: string): string => {
  const messageText =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error || '')
  if (/unknown route/i.test(messageText)) {
    return t('vaultSwitcher.thumbnailBackup.oldServerError')
  }
  return messageText || fallback
}

const handleOpenThumbnailBackup = (): void => {
  closeContextMenu()
  if (!selectedVault.value || !isHttpNetworkVault(selectedVault.value)) {
    return
  }

  thumbnailBackupVault.value = selectedVault.value
  thumbnailBackupStatus.value = null
  thumbnailBackupError.value = ''
  thumbnailBackupModalOpen.value = true
  void loadThumbnailBackupStatus()
}

const handleThumbnailBackupCancel = (): void => {
  thumbnailBackupModalOpen.value = false
  thumbnailBackupVault.value = null
  thumbnailBackupStatus.value = null
  thumbnailBackupError.value = ''
}

const loadThumbnailBackupStatus = async (): Promise<void> => {
  const vault = thumbnailBackupVault.value
  if (!vault) return

  try {
    thumbnailBackupLoading.value = true
    thumbnailBackupError.value = ''
    const result = await window.api.invoke('networkVaultV2:getThumbnailBackupStatus', vault.id)
    if (!result?.success) {
      throw new Error(result?.error || t('vaultSwitcher.thumbnailBackup.loadStatusFailed'))
    }
    thumbnailBackupStatus.value = result.data as ThumbnailBackupStatus
  } catch (error) {
    console.error('获取缩略图备份状态失败:', error)
    thumbnailBackupError.value = formatThumbnailBackupError(
      error,
      t('vaultSwitcher.thumbnailBackup.loadStatusFailed')
    )
  } finally {
    thumbnailBackupLoading.value = false
  }
}

const handleSyncThumbnailBackup = async (): Promise<void> => {
  const vault = thumbnailBackupVault.value
  if (!vault) return

  try {
    thumbnailBackupSyncing.value = true
    thumbnailBackupError.value = ''
    const result = await window.api.invoke('networkVaultV2:syncThumbnailBackup', vault.id)
    if (!result?.success) {
      throw new Error(result?.error || t('vaultSwitcher.thumbnailBackup.syncFailed'))
    }
    const data = result.data as ThumbnailBackupSyncResult
    message.success(
      t('vaultSwitcher.thumbnailBackup.syncDone', { copied: data.copied, skipped: data.skipped })
    )
    await loadThumbnailBackupStatus()
  } catch (error) {
    console.error('同步缩略图备份失败:', error)
    thumbnailBackupError.value = formatThumbnailBackupError(
      error,
      t('vaultSwitcher.thumbnailBackup.syncFailed')
    )
  } finally {
    thumbnailBackupSyncing.value = false
  }
}

const handleRestoreThumbnailBackup = async (): Promise<void> => {
  const vault = thumbnailBackupVault.value
  if (!vault || !canRestoreThumbnails.value) return

  const missingCount = thumbnailBackupStatus.value?.backupOnlyCount || 0
  const confirmed = await new Promise<boolean>((resolve) => {
    confirmDialog({
      title: t('vaultSwitcher.thumbnailBackup.restoreConfirmTitle'),
      content: t('vaultSwitcher.thumbnailBackup.restoreConfirmContent', { count: missingCount }),
      okText: t('vaultSwitcher.thumbnailBackup.startRestore'),
      cancelText: t('vaultSwitcher.buttons.cancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
  if (!confirmed) return

  try {
    thumbnailBackupRestoring.value = true
    thumbnailBackupError.value = ''
    const result = await window.api.invoke('networkVaultV2:restoreThumbnailBackup', vault.id, {
      overwrite: false
    })
    if (!result?.success) {
      throw new Error(result?.error || t('vaultSwitcher.thumbnailBackup.restoreFailed'))
    }
    const data = result.data as ThumbnailBackupRestoreResult
    message.success(t('vaultSwitcher.thumbnailBackup.restoreDone', { count: data.restored }))
    await loadThumbnailBackupStatus()
    if (currentVault.value?.id === vault.id) {
      emit('vaultChanged', vault)
    }
  } catch (error) {
    console.error('恢复缩略图失败:', error)
    thumbnailBackupError.value = formatThumbnailBackupError(
      error,
      t('vaultSwitcher.thumbnailBackup.restoreFailed')
    )
  } finally {
    thumbnailBackupRestoring.value = false
  }
}

const handleServerAddressSave = async (): Promise<void> => {
  if (!editingServerVault.value) {
    return
  }

  serverAddressError.value = ''
  const currentParts = getHttpVaultParts(editingServerVault.value.networkPath)
  if (!currentParts) {
    serverAddressError.value = t('vaultSwitcher.serverAddressError.invalidFormat')
    return
  }

  let nextPath: { serverBase: string; remoteVaultId: string; networkPath: string }
  try {
    nextPath = buildHttpVaultNetworkPath(editingServerAddress.value, currentParts.remoteVaultId)
  } catch (error) {
    serverAddressError.value =
      error instanceof Error
        ? error.message
        : t('vaultSwitcher.serverAddressError.invalidServerFormat')
    return
  }

  try {
    serverAddressSaving.value = true
    const listResult = await window.api.invoke(
      'networkVaultV2:listRemoteVaults',
      nextPath.serverBase,
      editingServerApiKey.value.trim() || undefined
    )

    if (!listResult.success) {
      serverAddressError.value =
        listResult.error || t('vaultSwitcher.serverAddressError.cannotConnect')
      return
    }

    const remoteVaults = Array.isArray(listResult.data)
      ? (listResult.data as Array<{ vaultId?: string }>)
      : []
    const hasTargetVault = remoteVaults.some((vault) => vault.vaultId === nextPath.remoteVaultId)
    if (!hasTargetVault) {
      serverAddressError.value = t('vaultSwitcher.serverAddressError.vaultIdNotFound', {
        id: nextPath.remoteVaultId
      })
      return
    }

    const updateResult = await vaultStore.updateVaultNetworkPath(
      editingServerVault.value.id,
      nextPath.networkPath
    )
    const keyResult = await window.api.invoke(
      'networkVaultV2:setRemoteVaultApiKey',
      editingServerVault.value.id,
      editingServerApiKey.value.trim() || undefined
    )
    if (!keyResult?.success) {
      serverAddressError.value = keyResult?.error || '管理员 KEY 保存失败'
      return
    }
    const updatedVault = vaultStore.getVaultById(editingServerVault.value.id)

    message.success(t('vaultSwitcher.messages.serverAddressUpdated'))
    if (updateResult.networkError) {
      message.warning(
        t('vaultSwitcher.messages.reconnectFailed', { error: updateResult.networkError })
      )
    }
    if (updatedVault) {
      emit('vaultChanged', updatedVault)
    }
    if (currentVault.value?.id === editingServerVault.value.id) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('trigger-network-sync'))
      }, 500)
    }
    handleServerAddressCancel()
  } catch (error) {
    console.error('更新资产服务器地址失败:', error)
    serverAddressError.value =
      error instanceof Error ? error.message : t('vaultSwitcher.messages.updateServerAddressFailed')
  } finally {
    serverAddressSaving.value = false
  }
}

const handleIconChanged = async () => {
  await vaultStore.loadVaults()
}

const handleOpenInFileManager = () => {
  closeContextMenu()
  console.log(selectedVault.value)

  if (selectedVault.value?.path) {
    // 调用系统API打开文件管理器
    window.api.shell
      .openPath(selectedVault.value.path)
      .then(() => {
        message.success(t('assetLib.vault.messages.openSuccess'))
      })
      .catch((error) => {
        console.error('打开文件管理器失败:', error)
        message.error(t('assetLib.vault.messages.openFailed'))
      })
  }
}

const handleChangeSaveLocation = async () => {
  closeContextMenu()
  if (!selectedVault.value || selectedVault.value.systemKey !== 'aigc') {
    return
  }

  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('vaultSwitcher.changeSaveLocation.dialogTitle'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('vaultSwitcher.changeSaveLocation.dialogButtonLabel')
    })

    if (result.canceled || result.filePaths.length === 0) {
      return
    }

    const targetPath = result.filePaths[0]
    const confirmed = await new Promise<boolean>((resolve) => {
      confirmDialog({
        title: t('vaultSwitcher.changeSaveLocation.confirmTitle'),
        content: t('vaultSwitcher.changeSaveLocation.confirmContent'),
        okText: t('vaultSwitcher.changeSaveLocation.startMigration'),
        cancelText: t('vaultSwitcher.buttons.cancel'),
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })

    if (!confirmed) {
      return
    }

    const hide = message.loading(t('vaultSwitcher.changeSaveLocation.migrating'), 0)
    try {
      await vaultStore.moveVault(selectedVault.value.id, targetPath)
      message.success(t('vaultSwitcher.changeSaveLocation.migrated'))
    } finally {
      hide()
    }
  } catch (error) {
    console.error('迁移 AIGC 资产库失败:', error)
    message.error(
      error instanceof Error ? error.message : t('vaultSwitcher.changeSaveLocation.migrateFailed')
    )
  }
}

const deleteModalVisible = ref(false)
const vaultToDelete = ref<VaultInfo | null>(null)

const handleRemoveFromList = () => {
  closeContextMenu()
  if (!selectedVault.value) return

  if (isProtectedVault(selectedVault.value)) {
    message.warning(t('vaultSwitcher.messages.systemVaultNotDeletable'))
    return
  }

  vaultToDelete.value = selectedVault.value
  deleteModalVisible.value = true
}

// 初始化SortableJS
const initSortable = () => {
  if (!vaultListRef.value || sortableInstance.value) return

  console.log('🔧 初始化SortableJS')

  sortableInstance.value = Sortable.create(vaultListRef.value, {
    handle: '.drag-handle',
    animation: 150,
    ghostClass: 'vault-item-ghost',
    chosenClass: 'vault-item-chosen',
    dragClass: 'vault-item-drag',
    onStart: (evt) => {
      console.log('🔧 SortableJS 开始拖拽:', evt.oldIndex)
    },
    onEnd: async (evt) => {
      console.log('🔧 SortableJS 拖拽结束:', evt.oldIndex, '->', evt.newIndex)

      if (
        evt.oldIndex !== undefined &&
        evt.newIndex !== undefined &&
        evt.oldIndex !== evt.newIndex
      ) {
        try {
          // 获取当前保管库列表
          const currentVaults = [...vaults.value]

          // 重新排序
          const [movedVault] = currentVaults.splice(evt.oldIndex, 1)
          currentVaults.splice(evt.newIndex, 0, movedVault)

          // 获取新的排序ID数组
          const newOrder = currentVaults.map((vault) => vault.id)
          console.log('🔧 新的排序:', newOrder)

          // 更新排序到数据库
          await vaultStore.updateVaultOrder(newOrder)
          // message.success(`保管库从位置 ${evt.oldIndex} 移动到位置 ${evt.newIndex}`)
        } catch (error) {
          console.error('保存排序失败:', error)
          message.error(t('vaultSwitcher.messages.saveOrderFailed'))

          // 如果保存失败，重新加载保管库列表以恢复原始顺序
          await vaultStore.loadVaults()
        }
      }
    }
  })
}

// 销毁SortableJS实例
const destroySortable = () => {
  if (sortableInstance.value) {
    console.log('🔧 销毁SortableJS实例')
    sortableInstance.value.destroy()
    sortableInstance.value = null
  }
}

// 初始化数据
onMounted(async () => {
  console.log('VaultSwitcher 组件已挂载')
  try {
    await vaultStore.loadVaults()
  } catch (error) {
    console.error('加载保管库列表失败:', error)
    message.error(t('assetLib.vault.messages.loadFailed'))
  }
})

// 组件卸载时清理
onUnmounted(() => {
  destroySortable()
})
// 处理遮罩层点击
const handleOverlayClick = () => {
  closeDropdown()
  // 只有在点击遮罩层关闭菜单时才清空选中项
  if (contextMenuVisible.value) {
    contextMenuVisible.value = false
    selectedVault.value = null
  }
}
</script>

<style lang="less" scoped>
.vault-switcher {
  position: relative;
  width: 100%;

  .vault-current {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: var(--color-bg-surface);
    border: 1px solid transparent;
    border-radius: var(--radius-md); // 增加圆角
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    user-select: none;

    &:hover {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-border-strong);
    }

    &:active {
      transform: scale(0.995);
      background: var(--color-bg-raised);
    }

    &.active {
      background: var(--color-bg-selected);
    }

    .vault-info {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0; // 防止flex子项溢出

      .vault-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        color: var(--color-text-primary);
        font-size: 14px;
        flex-shrink: 0;
        box-shadow: 0 2px 4px var(--shadow-color-weak);
        overflow: hidden;

        .vault-icon-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
      }

      .vault-details {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;

        .vault-name-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .vault-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--color-text-primary);
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .vault-system-chip {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 10px;
          line-height: 1.4;
          font-weight: 600;
          color: var(--color-warning-text);
          background: var(--color-warning-bg);
          border: 1px solid var(--color-warning-border);
        }

        .vault-meta-note {
          margin-top: 2px;
          font-size: 11px;
          line-height: 1.4;
          color: var(--color-text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }
    }

    .vault-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;

      .vault-status {
        display: inline-flex;
        align-items: center;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.2;

        &.vault-type-reference {
          color: var(--color-accent-text);
          background: var(--color-accent-bg);
        }

        &.vault-type-backup {
          color: var(--color-success-text);
          background: var(--color-success-bg);
        }

        &.vault-type-network {
          color: var(--color-warning-text);
          background: var(--color-warning-bg);
        }

        &.vault-offline {
          color: var(--color-text-on-solid);
          background: var(--color-danger-solid);
        }
      }

      .expand-icon {
        font-size: 12px;
        color: var(--color-text-muted);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);

        &.rotated {
          transform: rotate(180deg);
          color: var(--color-text-primary);
        }
      }
    }
  }

  .vault-dropdown {
    position: fixed;
    z-index: 2000; // 确保在最上层

    // 基础背景色 (Fallback) - 使用主题变量
    background: var(--color-bg-raised);

    // 毛玻璃效果
    @supports (backdrop-filter: blur(20px)) {
      // 使用 color-mix 混合主题色和透明度，保持色调一致
      background: color-mix(in srgb, var(--color-bg-raised), transparent 7%);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);

    margin-top: 6px;
    min-width: 280px;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    overflow: hidden; // 确保圆角不被子元素覆盖
    transform-origin: top center;

    .vault-list {
      flex: 1;
      max-height: 320px;
      overflow-y: auto;
      padding: 6px;

      .vault-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        margin-bottom: 2px;
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all 0.2s ease;
        position: relative;
        border: 1px solid transparent;

        &:last-child {
          margin-bottom: 0;
        }

        &:hover {
          background: var(--color-bg-surface-hover);

          .drag-handle {
            opacity: 1;
          }

          .vault-more-btn {
            opacity: 1;
          }
        }

        &.active {
          background: var(--color-bg-selected);

          .vault-name {
            color: var(--color-text-selected);
          }

          .vault-icon {
            box-shadow: 0 0 0 2px var(--color-accent-border);
          }
        }

        .drag-handle {
          width: 16px;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: grab;
          opacity: 0; // 默认隐藏，hover显示
          transition: opacity 0.2s ease;
          color: var(--color-text-muted);

          &:active {
            cursor: grabbing;
          }

          .drag-dots {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 2px;

            .dot {
              width: 2px;
              height: 2px;
              background-color: currentColor;
              border-radius: 50%;
            }
          }
        }

        .vault-icon {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--color-bg-surface-hover);
          border-radius: var(--radius-sm);
          color: var(--color-text-secondary);
          font-size: 16px;
          flex-shrink: 0;
          transition: all 0.2s ease;
          overflow: hidden;

          .vault-icon-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
        }

        .vault-details {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;

          .vault-name-row {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
          }

          .vault-name {
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-primary);
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .vault-system-chip {
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            padding: 1px 6px;
            border-radius: 999px;
            font-size: 10px;
            line-height: 1.4;
            font-weight: 600;
            color: var(--color-warning-text);
            background: var(--color-warning-bg);
            border: 1px solid var(--color-warning-border);
          }

          .vault-meta-note {
            font-size: 11px;
            line-height: 1.4;
            color: var(--color-text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .vault-path {
            font-size: 11px;
            color: var(--color-text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .vault-rename-wrapper {
            display: flex;
            align-items: center;
            gap: 4px;
            width: 100%;

            .vault-rename-input {
              flex: 1;
              min-width: 0;
              background: var(--color-bg-page);
              border: 1px solid var(--color-accent-border);
              border-radius: var(--radius-sm);
              color: var(--color-text-primary);
              font-size: 13px;
              padding: 2px 6px;
              outline: none;
              box-shadow: 0 0 0 2px var(--color-accent-border);
            }

            .rename-actions {
              display: flex;
              align-items: center;
              gap: 2px;

              .rename-action-btn {
                padding: 4px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s ease;

                &.confirm {
                  color: var(--color-success-text);
                  &:hover {
                    background: var(--color-success-bg);
                  }
                }

                &.cancel {
                  color: var(--color-text-muted);
                  &:hover {
                    background: var(--color-bg-raised);
                    color: var(--color-text-secondary);
                  }
                }
              }
            }
          }
        }

        .vault-status-badge {
          font-size: 12px;
          padding: 1px 6px;
          border-radius: 4px;
          background: var(--color-bg-surface-hover);
          color: var(--color-text-secondary);
          white-space: nowrap;

          &.vault-offline {
            color: var(--color-text-on-solid);
            background: var(--color-danger-solid);
          }
        }

        .vault-more-btn {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          color: var(--color-text-muted);
          opacity: 0; // 默认隐藏
          transition: all 0.2s ease;

          &:hover {
            background: var(--color-bg-raised);
            color: var(--color-text-primary);
          }
        }
      }
    }

    .vault-actions-section {
      border-top: 1px solid var(--color-border-subtle);
      padding: 6px;
      background: var(--color-bg-surface); // 使用主题定义的表面色
      display: flex;
      flex-direction: column;
      gap: 2px;

      .vault-action-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: var(--radius-md);
        cursor: pointer;
        font-size: 13px;
        color: var(--color-text-secondary);
        transition: all 0.2s ease;

        &:hover {
          background: var(--color-bg-surface-hover);
          color: var(--color-text-primary);
        }

        .action-icon {
          font-size: 14px;
          color: var(--color-text-muted);
        }
      }
    }
  }

  .vault-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1999;
    background: transparent;
  }
}

.browse-path-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .browse-path-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .browse-path-meta-label,
  .browse-path-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .browse-path-meta-value {
    color: var(--color-text-primary);
    word-break: break-all;

    &.mono {
      font-family: 'Consolas', 'SFMono-Regular', monospace;
      font-size: 12px;
    }
  }

  .browse-path-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .browse-path-tip {
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }

  .browse-path-error {
    font-size: 12px;
    color: var(--color-danger-text);
  }
}

.thumbnail-backup-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;

  .thumbnail-backup-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: var(--color-bg-surface);
  }

  .thumbnail-backup-label {
    margin-bottom: 4px;
    color: var(--color-text-secondary);
    font-size: 12px;
    font-weight: 600;
  }

  .thumbnail-backup-value {
    color: var(--color-text-primary);
    font-size: 13px;
    word-break: break-all;

    &.mono {
      font-family: 'Consolas', 'SFMono-Regular', monospace;
      font-size: 12px;
    }
  }

  .thumbnail-backup-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  .thumbnail-backup-stat {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-md);
    background: var(--color-bg-surface);

    span,
    small {
      display: block;
      color: var(--color-text-secondary);
      font-size: 12px;
      line-height: 1.4;
    }

    strong {
      display: block;
      margin: 3px 0;
      color: var(--color-text-primary);
      font-size: 20px;
      line-height: 1.2;
    }

    &.warning strong {
      color: var(--color-warning-text);
    }
  }

  .thumbnail-backup-note {
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  .thumbnail-backup-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
}

// 动画相关样式
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

// 右键菜单样式 (保持但微调)
.context-menu {
  position: fixed;
  z-index: 3000;

  background: var(--color-bg-raised);
  @supports (backdrop-filter: blur(16px)) {
    background: color-mix(in srgb, var(--color-bg-raised), transparent 10%);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }

  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  padding: 4px;
  min-width: 140px;
  box-shadow:
    0 4px 16px var(--shadow-color),
    0 0 0 1px var(--shadow-highlight);

  .context-menu-item {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--color-text-primary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
      background: var(--color-accent-bg);
      color: var(--color-accent-text);
    }

    &.danger {
      color: var(--color-danger-text);

      &:hover {
        background: var(--color-danger-bg);
      }
    }
  }

  .context-menu-divider {
    height: 1px;
    background: var(--color-bg-surface-hover);
    margin: 4px 0;
  }
}

// SortableJS 样式类 (微调)
.vault-item-ghost {
  opacity: 0.4;
  background: var(--color-bg-surface-hover) !important;
  border: 1px dashed var(--color-accent-border) !important;
}

.vault-item-chosen {
  background: var(--color-bg-page) !important;
  box-shadow: var(--shadow-md);
}

.vault-item-drag {
  cursor: grabbing;
}

// 滚动条样式优化
.vault-list {
  &::-webkit-scrollbar {
    width: 4px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;

    &:hover {
      background: var(--color-text-muted);
    }
  }
}
</style>
