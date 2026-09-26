<template>
  <AppModal
    v-model:open="visible"
    :width="650"
    :mask-closable="false"
    :keyboard="false"
    :closable="false"
    hide-footer
    class="create-vault-modal"
    @cancel="handleCancel"
  >
    <div class="glass-panel">
      <!-- 头部 -->
      <div class="modal-header">
        <div class="header-content">
          <h1 class="modal-title">{{ $t('createVaultModal.header.title') }}</h1>
          <p class="modal-subtitle">{{ $t('createVaultModal.header.subtitle') }}</p>
        </div>
        <button class="close-btn" @click="handleCancel">
          <PhX />
        </button>
      </div>

      <!-- 表单区域 -->
      <div class="form-content">
        <!-- 1. 资产库名称（服务器库的名字来自服务端，这一栏不出现） -->
        <div v-if="!serverMode" class="form-group">
          <label class="form-label">{{ $t('createVaultModal.form.nameLabel') }}</label>
          <div class="input-wrapper">
            <input
              v-model="formData.name"
              type="text"
              :placeholder="$t('createVaultModal.form.namePlaceholder')"
              class="glass-input"
              :class="{ 'has-error': errors.name }"
              maxlength="50"
              @input="onNameInput"
              @blur="validateName"
            />
            <PhFileText class="input-icon" />
          </div>
          <div v-if="errors.name" class="error-message">{{ errors.name }}</div>
        </div>

        <!-- 2. 导入模式选择 -->
        <div class="form-group">
          <label class="form-label">{{ $t('createVaultModal.form.modeLabel') }}</label>
          <div class="mode-cards">
            <!-- 引用模式卡片 -->
            <div
              class="mode-card"
              :class="{ active: !serverMode && formData.vaultType === VaultType.REFERENCE }"
              @click="selectVaultType(VaultType.REFERENCE)"
            >
              <div class="card-header">
                <div
                  class="icon-wrapper"
                  :class="{ active: !serverMode && formData.vaultType === VaultType.REFERENCE }"
                >
                  <PhLink />
                </div>
                <PhCheck
                  v-if="!serverMode && formData.vaultType === VaultType.REFERENCE"
                  class="check-icon"
                />
              </div>
              <div class="card-body">
                <h3 class="card-title">{{ $t('createVaultModal.mode.reference.title') }}</h3>
                <p class="card-desc">{{ $t('createVaultModal.mode.reference.desc') }}</p>
              </div>
            </div>

            <!-- 拷贝模式卡片 -->
            <div
              class="mode-card"
              :class="{ active: !serverMode && formData.vaultType === VaultType.BACKUP }"
              @click="selectVaultType(VaultType.BACKUP)"
            >
              <div class="card-header">
                <div
                  class="icon-wrapper"
                  :class="{ active: !serverMode && formData.vaultType === VaultType.BACKUP }"
                >
                  <PhCopy />
                </div>
                <PhCheck
                  v-if="!serverMode && formData.vaultType === VaultType.BACKUP"
                  class="check-icon"
                />
              </div>
              <div class="card-body">
                <h3 class="card-title">{{ $t('createVaultModal.mode.backup.title') }}</h3>
                <p class="card-desc">{{ $t('createVaultModal.mode.backup.desc') }}</p>
              </div>
            </div>

            <!-- 网络协作库卡片 (实验性功能，需在设置中启用) -->
            <div
              v-if="enableNetworkVault"
              class="mode-card network-card"
              :class="{
                active: !serverMode && formData.vaultType === VaultType.NETWORK
              }"
              @click="selectVaultType(VaultType.NETWORK)"
            >
              <div class="card-header">
                <div
                  class="icon-wrapper network"
                  :class="{ active: !serverMode && formData.vaultType === VaultType.NETWORK }"
                >
                  <PhHardDrives />
                </div>

                <PhCheck
                  v-if="!serverMode && formData.vaultType === VaultType.NETWORK"
                  class="check-icon"
                />
              </div>
              <div class="card-body">
                <h3 class="card-title">{{ $t('createVaultModal.mode.network.title') }}</h3>
                <p class="card-desc">{{ $t('createVaultModal.mode.network.desc') }}</p>
              </div>
            </div>

            <!-- 服务器资产库：在线浏览，不在本机建库 -->
            <div
              v-if="SHOW_SERVER_VAULT_ENTRY"
              class="mode-card"
              :class="{ active: serverMode }"
              @click="serverMode = true"
            >
              <div class="card-header">
                <div class="icon-wrapper" :class="{ active: serverMode }">
                  <PhCloud />
                </div>
                <PhCheck v-if="serverMode" class="check-icon" />
              </div>
              <div class="card-body">
                <h3 class="card-title">{{ $t('catalogLibrary.create.title') }}</h3>
                <p class="card-desc">{{ $t('catalogLibrary.create.desc') }}</p>
              </div>
            </div>
          </div>

          <!-- 动态提示信息 -->
          <div class="mode-hint">
            <template v-if="serverMode">
              <div class="hint-info">
                <PhCloud class="hint-icon" />
                <span>{{ $t('catalogLibrary.create.hint') }}</span>
              </div>
            </template>
            <template v-else-if="formData.vaultType === VaultType.REFERENCE">
              <div class="hint-warning">
                <PhWarning class="hint-icon" />
                <span>{{ $t('createVaultModal.mode.reference.hint') }}</span>
              </div>
            </template>
            <template v-else-if="formData.vaultType === VaultType.BACKUP">
              <div class="hint-success">
                <PhCheck class="hint-icon" />
                <span>{{ $t('createVaultModal.mode.backup.hint') }}</span>
              </div>
            </template>
            <template v-else-if="formData.vaultType === VaultType.NETWORK">
              <div class="hint-info">
                <PhUsersThree class="hint-icon" />
                <span>{{ $t('createVaultModal.mode.network.hint') }}</span>
              </div>
            </template>
          </div>
        </div>

        <!-- 3. 路径选择 (动态展开) -->
        <Transition name="expand">
          <div
            v-if="!serverMode && formData.vaultType === VaultType.BACKUP"
            class="form-group path-group"
          >
            <label class="form-label">{{ $t('createVaultModal.path.saveLocationLabel') }}</label>
            <div class="path-selector">
              <div class="path-display" :class="{ 'is-placeholder': !formData.customPath }">
                <PhFolderOpen class="folder-icon" />
                <span class="path-text">{{
                  formData.customPath || $t('createVaultModal.path.placeholder')
                }}</span>
              </div>
              <button class="change-btn" @click="selectPath">
                {{
                  formData.customPath
                    ? $t('createVaultModal.path.changeButton')
                    : $t('createVaultModal.path.selectButton')
                }}
              </button>
            </div>
          </div>
        </Transition>

        <!-- 4. 网络模式子选项 -->
        <Transition name="expand">
          <div
            v-if="!serverMode && formData.vaultType === VaultType.NETWORK"
            class="form-group path-group"
          >
            <!-- 子模式切换 -->
            <div class="network-sub-tabs">
              <button
                class="sub-tab"
                :class="{ active: networkSubMode === 'smb' }"
                @click="networkSubMode = 'smb'"
              >
                <PhFolderOpen class="tab-icon" />
                {{ $t('createVaultModal.network.tabSmb') }}
              </button>
              <button
                class="sub-tab"
                :class="{ active: networkSubMode === 'nas' }"
                @click="networkSubMode = 'nas'"
              >
                <PhHardDrives class="tab-icon" />
                {{ $t('createVaultModal.network.tabNas') }}
              </button>
            </div>

            <!-- SMB 共享模式 (现有) -->
            <template v-if="networkSubMode === 'smb'">
              <label class="form-label">{{ $t('createVaultModal.network.pathLabel') }}</label>
              <div class="input-wrapper">
                <input
                  v-model="formData.networkPath"
                  type="text"
                  :placeholder="$t('createVaultModal.network.pathPlaceholder')"
                  class="glass-input network-input"
                  :class="{ 'has-error': errors.networkPath }"
                  @input="onNetworkPathInput"
                  @blur="validateNetworkPath"
                />
                <PhHardDrives class="input-icon" />
              </div>
              <div v-if="errors.networkPath" class="error-message">{{ errors.networkPath }}</div>

              <div v-if="networkStatus" class="network-status" :class="networkStatus.type">
                <PhCircleNotch
                  v-if="networkStatus.type === 'loading'"
                  class="icon-spin status-icon"
                />
                <PhCheckCircle v-else-if="networkStatus.type === 'success'" class="status-icon" />
                <PhXCircle v-else-if="networkStatus.type === 'error'" class="status-icon" />
                <PhLock v-else-if="networkStatus.type === 'auth'" class="status-icon" />
                <span>{{ networkStatus.message }}</span>
                <button
                  v-if="networkStatus.type === 'auth'"
                  class="auth-btn"
                  @click="showAuthModal = true"
                >
                  {{ $t('createVaultModal.network.authButton') }}
                </button>
              </div>
            </template>

            <!-- 资产服务器直连模式 -->
            <template v-if="networkSubMode === 'nas'">
              <label class="form-label">{{ $t('createVaultModal.nas.addressLabel') }}</label>
              <div class="nas-connect-row">
                <div class="nas-addr-group">
                  <div class="input-wrapper nas-ip-wrapper">
                    <input
                      v-model="nasServerIp"
                      type="text"
                      :placeholder="$t('createVaultModal.nas.ipPlaceholder')"
                      class="glass-input"
                      :class="{ 'has-error': nasError }"
                      @input="nasError = ''"
                      @keydown.enter="handleNasConnect"
                    />
                    <PhHardDrives class="input-icon" />
                  </div>
                  <div class="input-wrapper nas-port-wrapper">
                    <input
                      v-model="nasServerPort"
                      type="text"
                      :placeholder="$t('createVaultModal.nas.portPlaceholder')"
                      class="glass-input"
                      :class="{ 'has-error': nasError }"
                      @input="nasError = ''"
                      @keydown.enter="handleNasConnect"
                    />
                  </div>
                </div>
                <button
                  class="nas-connect-btn"
                  :disabled="!nasServerIp.trim() || nasConnecting"
                  @click="handleNasConnect"
                >
                  <PhCircleNotch v-if="nasConnecting" class="icon-spin" />
                  <span v-else>{{ $t('createVaultModal.nas.connectButton') }}</span>
                </button>
              </div>

              <div v-if="nasError" class="error-message">{{ nasError }}</div>

              <!-- 高级选项：管理员 KEY 与资产平台，日常浏览用不到，默认折叠 -->
              <div class="advanced-section">
                <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
                  <PhCaretRight class="advanced-caret" :class="{ open: showAdvanced }" />
                  <span>{{ $t('createVaultModal.nas.advancedToggle') }}</span>
                  <span v-if="!showAdvanced" class="advanced-summary">{{
                    $t('createVaultModal.nas.advancedSummary')
                  }}</span>
                  <span
                    v-if="!showAdvanced && nasApiKey"
                    class="advanced-dot"
                    :title="$t('createVaultModal.nas.apiKeyFilledTitle')"
                  />
                </button>

                <div v-if="showAdvanced" class="advanced-body">
                  <!-- API Key 输入 -->
                  <div class="form-group api-key-group">
                    <label class="form-label"
                      >{{ $t('createVaultModal.nas.apiKeyLabel') }}
                      <span class="optional-label"
                        >({{ $t('createVaultModal.nas.apiKeyWritableHint') }})</span
                      ></label
                    >
                    <div class="input-wrapper">
                      <input
                        v-model="nasApiKey"
                        type="password"
                        :placeholder="$t('createVaultModal.nas.apiKeyPlaceholder')"
                        class="glass-input"
                        @input="nasError = ''"
                        @keydown.enter="handleNasConnect"
                      />
                      <PhLock class="input-icon" />
                    </div>
                  </div>
                </div>
              </div>

              <div class="form-group browse-path-group">
                <label class="form-label"
                  >{{ $t('createVaultModal.nas.browsePathLabel') }}
                  <span class="optional-label"
                    >({{ $t('createVaultModal.nas.optionalHint') }})</span
                  ></label
                >
                <div class="input-wrapper">
                  <input
                    v-model="formData.browsePath"
                    type="text"
                    :placeholder="$t('createVaultModal.nas.browsePathPlaceholder')"
                    class="glass-input"
                    :class="{ 'has-error': errors.browsePath }"
                    @input="onBrowsePathInput"
                    @blur="validateBrowsePath"
                  />
                  <PhFolderOpen class="input-icon" />
                </div>
                <div class="form-tip">
                  {{ $t('createVaultModal.nas.browsePathTip') }}
                </div>
                <div v-if="errors.browsePath" class="error-message">{{ errors.browsePath }}</div>
              </div>

              <!-- 远程 Vault 列表（1.0.56+ 按资产路径分组；旧服务端平铺） -->
              <div
                v-if="remoteVaults.length > 0 || remoteRoots.length > 0"
                class="remote-vault-list"
              >
                <label class="form-label">{{
                  $t('createVaultModal.remote.selectVaultLabel')
                }}</label>
                <div
                  v-for="group in groupedRemoteVaults"
                  :key="group.path || '__flat__'"
                  class="rvault-group"
                  :class="{ grouped: !!group.name }"
                >
                  <div v-if="group.name" class="rvault-group-header">
                    <PhFolderOpen class="rvault-group-icon" />
                    <span class="rvault-group-name">{{ group.name }}</span>
                    <span class="rvault-group-path">{{ group.path }}</span>
                    <button
                      v-if="group.path"
                      class="rvault-group-add"
                      :title="$t('createVaultModal.remote.createInRootTitle')"
                      @click.stop="startCreateInRoot(group.path)"
                    >
                      <PhPlus />
                      {{ $t('createVaultModal.remote.createButtonShort') }}
                    </button>
                  </div>
                  <div
                    v-if="group.name && group.vaults.length === 0"
                    class="rvault-group-empty"
                    @click="group.path && startCreateInRoot(group.path)"
                  >
                    {{ $t('createVaultModal.remote.emptyGroupHint') }}
                  </div>
                  <div
                    v-for="vault in group.vaults"
                    :key="vault.vaultId"
                    class="remote-vault-card"
                    :class="{ selected: selectedRemoteVault?.vaultId === vault.vaultId }"
                    @click="selectedRemoteVault = vault"
                  >
                    <div class="rvault-info">
                      <PhDatabase class="rvault-icon" />
                      <div class="rvault-details">
                        <div class="rvault-name">{{ vault.name }}</div>
                        <div class="rvault-path">{{ vault.networkPath }}</div>
                      </div>
                    </div>
                    <div class="rvault-actions">
                      <button
                        class="rvault-delete-btn"
                        :title="$t('createVaultModal.remote.deleteVaultTitle')"
                        @click.stop="handleRemoteDelete(vault)"
                      >
                        <PhTrash />
                      </button>
                      <PhCheckCircle
                        v-if="selectedRemoteVault?.vaultId === vault.vaultId"
                        class="rvault-check"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- 在服务器上新建资产库 -->
              <div v-if="nasConnected" class="remote-create-section">
                <div v-if="!showRemoteCreateForm" class="remote-create-trigger">
                  <button class="remote-create-btn" @click="showRemoteCreateForm = true">
                    <PhPlus />
                    <span>{{ $t('createVaultModal.remote.createOnServerButton') }}</span>
                  </button>
                </div>
                <div v-else class="remote-create-form">
                  <label class="form-label">{{
                    $t('createVaultModal.remote.createVaultLabel')
                  }}</label>
                  <div class="nas-connect-row remote-create-row">
                    <div class="remote-create-inputs">
                      <div class="input-wrapper nas-input-wrapper">
                        <input
                          v-model="remoteCreateName"
                          type="text"
                          :placeholder="$t('createVaultModal.remote.namePlaceholder')"
                          class="glass-input"
                          :class="{ 'has-error': remoteCreateError }"
                          @input="remoteCreateError = ''"
                          @keydown.enter="handleRemoteCreate"
                        />
                        <PhDatabase class="input-icon" />
                      </div>
                      <!-- 1.0.56+：从已配置的资产路径中选择归属；旧服务端保留自由路径输入 -->
                      <div v-if="remoteRoots.length > 0" class="input-wrapper nas-input-wrapper">
                        <select
                          v-model="remoteCreateRootPath"
                          class="glass-input root-select"
                          :title="$t('createVaultModal.remote.rootSelectTitle')"
                          @change="remoteCreateError = ''"
                        >
                          <option v-for="root in remoteRoots" :key="root.path" :value="root.path">
                            {{ root.name }}（{{ root.path }}）
                          </option>
                        </select>
                      </div>
                      <div v-else class="input-wrapper nas-input-wrapper">
                        <input
                          v-model="remoteCreatePath"
                          type="text"
                          :placeholder="$t('createVaultModal.remote.pathPlaceholder')"
                          class="glass-input"
                          :class="{ 'has-error': remoteCreateError }"
                          @input="remoteCreateError = ''"
                          @keydown.enter="handleRemoteCreate"
                        />
                        <PhFolderOpen class="input-icon" />
                      </div>
                    </div>
                    <button
                      class="nas-connect-btn"
                      :disabled="!remoteCreateName.trim() || remoteCreating"
                      @click="handleRemoteCreate"
                    >
                      <PhCircleNotch v-if="remoteCreating" class="icon-spin" />
                      <span v-else>{{ $t('createVaultModal.remote.submitCreateButton') }}</span>
                    </button>
                    <button class="remote-cancel-btn" @click="showRemoteCreateForm = false">
                      <PhX />
                    </button>
                  </div>
                  <div v-if="remoteCreateError" class="error-message">{{ remoteCreateError }}</div>
                </div>
              </div>

              <!-- 连接成功但无 vault -->
              <div
                v-if="
                  nasConnected &&
                  remoteVaults.length === 0 &&
                  remoteRoots.length === 0 &&
                  !showRemoteCreateForm
                "
                class="nas-empty-hint"
              >
                <span>{{ $t('createVaultModal.remote.noVaultsHint') }}</span>
              </div>
            </template>
          </div>
        </Transition>
      </div>

      <!-- 服务器资产库：地址 / 邀请链接 → 证书信任 → 登录 → 选库 -->
      <div v-if="serverMode" class="form-content server-connect">
        <ServerLibraryConnectForm @added="handleServerAdded" @close="handleCancel" />
      </div>

      <!-- 底部操作栏 -->
      <div v-if="!serverMode" class="modal-footer">
        <button class="btn-cancel" @click="handleCancel">
          {{ $t('createVaultModal.footer.cancelButton') }}
        </button>
        <button
          class="btn-create"
          :class="{ disabled: !isFormValid }"
          :disabled="!isFormValid || loading"
          @click="handleCreate"
        >
          <span v-if="loading">{{ $t('createVaultModal.footer.creating') }}</span>
          <template v-else>
            <span>{{ $t('createVaultModal.footer.createButton') }}</span>
            <PhArrowRight class="arrow-icon" />
          </template>
        </button>
      </div>
    </div>
  </AppModal>

  <!-- 网络认证对话框 -->
  <NetworkAuthModal
    v-model:open="showAuthModal"
    :network-path="formData.networkPath || ''"
    @connected="onAuthConnected"
    @cancelled="onAuthCancelled"
  />
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
/**
 * CreateVaultModal - 创建资产库模态框
 * 基于 Glassmorphism 风格设计，提供资产库创建表单
 * 包含名称输入、模式选择（引用/复制/网络）和路径配置
 */
import { ref, reactive, computed, watch, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import {
  PhArrowRight,
  PhLock,
  PhCaretRight,
  PhCheck,
  PhCheckCircle,
  PhCircleNotch,
  PhCopy,
  PhDatabase,
  PhFileText,
  PhFolderOpen,
  PhHardDrives,
  PhCloud,
  PhLink,
  PhPlus,
  PhTrash,
  PhUsersThree,
  PhWarning,
  PhX,
  PhXCircle
} from '@phosphor-icons/vue'
import {
  useVaultStore,
  VaultType,
  type CreateVaultConfig,
  type VaultInfo
} from '../../../store/modules/vaultStore'
import NetworkAuthModal from './NetworkAuthModal.vue'
import ServerLibraryConnectForm from '../catalog/ServerLibraryConnectForm.vue'
import { isBrowsableAbsolutePath } from '../utils/networkBrowsePath'
import {
  readStoredNetworkVaultPreference,
  resolveNetworkVaultEnabled
} from '../utils/networkVaultAccess'

// Props 定义
interface Props {
  open: boolean
}

const props = withDefaults(defineProps<Props>(), {
  open: false
})

// Emits 定义
const emit = defineEmits<{
  'update:open': [value: boolean]
  created: [vault: VaultInfo]
  /** 添加了服务器资产库（库键） */
  serverLibraryAdded: [keys: string[]]
}>()

const { t } = useI18n()
const vaultStore = useVaultStore()

// 响应式数据
const visible = ref(props.open)
const loading = ref(false)
const showAuthModal = ref(false)

/** 服务器资产库入口暂不对外展示；连接逻辑保留，打开这个开关即可恢复 */
const SHOW_SERVER_VAULT_ENTRY = false

const networkVaultPreference = ref(readStoredNetworkVaultPreference(localStorage))
const enableNetworkVault = computed(() =>
  resolveNetworkVaultEnabled({
    storedPreference: networkVaultPreference.value
  })
)

// 网络状态
const networkStatus = ref<{
  type: 'loading' | 'success' | 'error' | 'auth'
  message: string
} | null>(null)

// 扫描进度状态
const scanProgress = ref<{
  visible: boolean
  current: number
  total: number
  assetName: string
} | null>(null)

// 资产服务器直连模式
type NetworkSubMode = 'smb' | 'nas'
const networkSubMode = ref<NetworkSubMode>('smb')
const nasServerIp = ref('')
const nasServerPort = ref('18900')
// 组合 IP:Port 为完整 URL，兼容下游逻辑
const nasServerUrl = computed(() => {
  const ip = nasServerIp.value.trim()
  const port = nasServerPort.value.trim()
  if (!ip) return ''
  return port ? `${ip}:${port}` : ip
})
const nasApiKey = ref(localStorage.getItem('assetManagement.serverApiKey') || '')
const nasConnecting = ref(false)
const nasConnected = ref(false)
const nasError = ref('')
interface RemoteVaultInfo {
  vaultId: string
  name: string
  networkPath: string
  permission?: string
  /** 所属资产根路径（1.0.56+ 服务端提供；旧服务端为 undefined） */
  rootPath?: string | null
}
/** 资产根路径（服务器 → 资产路径 → 资产库 中间层） */
interface RemoteRootInfo {
  name: string
  path: string
  vaultCount: number
}
const remoteVaults = ref<RemoteVaultInfo[]>([])
const selectedRemoteVault = ref<RemoteVaultInfo | null>(null)
const remoteRoots = ref<RemoteRootInfo[]>([])

/** 库列表按资产路径分组；旧服务端（无 roots）时返回单个无名分组，模板按平铺渲染 */
const groupedRemoteVaults = computed<
  Array<{ name: string; path: string; vaults: RemoteVaultInfo[] }>
>(() => {
  if (remoteRoots.value.length === 0) {
    return [{ name: '', path: '', vaults: remoteVaults.value }]
  }
  const groups = remoteRoots.value.map((root) => ({
    name: root.name,
    path: root.path,
    vaults: remoteVaults.value.filter((v) => v.rootPath === root.path)
  }))
  const ungrouped = remoteVaults.value.filter(
    (v) => !v.rootPath || !remoteRoots.value.some((r) => r.path === v.rootPath)
  )
  if (ungrouped.length > 0) {
    groups.push({ name: t('createVaultModal.remote.ungroupedLabel'), path: '', vaults: ungrouped })
  }
  // 空分组也保留：让用户看到"这个资产路径下还没有库"，并可直接在其下新建
  return groups
})

// 远程创建资产库
const showAdvanced = ref(false)
const showRemoteCreateForm = ref(false)
const remoteCreateName = ref('')
const remoteCreatePath = ref('')
const remoteCreateRootPath = ref('')
const remoteCreating = ref(false)
const remoteCreateError = ref('')

// 表单数据
const formData = reactive<
  CreateVaultConfig & { customPath?: string; networkPath?: string; browsePath?: string }
>({
  name: '',
  customPath: '',
  networkPath: '',
  browsePath: '',
  vaultType: VaultType.REFERENCE,
  icon: 'database'
})

// 错误信息
const errors = reactive({
  name: '',
  path: '',
  networkPath: '',
  browsePath: ''
})

// 监听 props 变化
watch(
  () => props.open,
  (newVal) => {
    visible.value = newVal
    // 每次打开模态框时重新读取实验性功能设置
    if (newVal) {
      networkVaultPreference.value = readStoredNetworkVaultPreference(localStorage)
    }
  }
)

watch(visible, (newVal) => {
  emit('update:open', newVal)
  if (!newVal) {
    resetForm()
  }
})

// 监听资产库类型变化，清除路径相关错误
watch(
  () => formData.vaultType,
  () => {
    errors.path = ''
    errors.networkPath = ''
    errors.browsePath = ''
    networkStatus.value = null
    nasError.value = ''
    remoteVaults.value = []
    remoteRoots.value = []
    selectedRemoteVault.value = null
    nasConnected.value = false
    if (formData.vaultType === VaultType.REFERENCE) {
      formData.customPath = ''
      formData.networkPath = ''
      formData.browsePath = ''
    } else if (formData.vaultType === VaultType.NETWORK) {
      formData.customPath = ''
    } else {
      formData.networkPath = ''
      formData.browsePath = ''
    }
  }
)

watch(networkSubMode, (mode) => {
  errors.browsePath = ''
  if (mode !== 'nas') {
    formData.browsePath = ''
  }
})

/**
 * 表单验证状态计算属性
 * - 名称必须填写且无错误
 * - 备份模式下必须选择保存位置
 * - 网络模式下必须输入网络路径且访问成功
 */
const isFormValid = computed(() => {
  const nameValid = formData.name.trim().length > 0 && !errors.name

  if (formData.vaultType === VaultType.REFERENCE) {
    return nameValid
  } else if (formData.vaultType === VaultType.BACKUP) {
    return nameValid && !!formData.customPath && !errors.path
  } else if (formData.vaultType === VaultType.NETWORK) {
    if (networkSubMode.value === 'nas') {
      // NAS 模式：必须选中一个远程 vault
      return !!selectedRemoteVault.value && !errors.browsePath
    }
    // SMB 模式
    const networkValid =
      !!formData.networkPath && !errors.networkPath && networkStatus.value?.type === 'success'
    return nameValid && networkValid
  }
  return false
})

/**
 * 选择资产库类型
 * @param type - 资产库类型枚举值
 */
const selectVaultType = (type: VaultType): void => {
  serverMode.value = false
  formData.vaultType = type
}

/** 选中"服务器资产库"卡片：走连接表单，不创建本地保管库 */
const serverMode = ref(false)
const handleServerAdded = (keys: string[]): void => {
  serverMode.value = false
  emit('serverLibraryAdded', keys)
  visible.value = false
  emit('update:open', false)
}

/**
 * 输入时实时清除错误状态
 * 让按钮能够即时响应输入变化
 */
const onNameInput = (): void => {
  // 用户正在输入时，清除之前的错误提示
  if (errors.name) {
    errors.name = ''
  }
}

/**
 * 验证资产库名称
 * @returns 是否验证通过
 */
const validateName = (): boolean => {
  errors.name = ''

  if (!formData.name.trim()) {
    errors.name = t('createVaultModal.errors.nameRequired')
    return false
  }

  if (formData.name.trim().length < 2) {
    errors.name = t('createVaultModal.errors.nameTooShort')
    return false
  }

  // 检查特殊字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(formData.name)) {
    errors.name = t('createVaultModal.errors.nameInvalidChars')
    return false
  }

  return true
}

/**
 * 打开系统文件选择对话框选择存储路径
 */
const selectPath = async (): Promise<void> => {
  try {
    const result = await window.api.dialog.showOpenDialog({
      title: t('createVaultModal.dialog.selectPathTitle'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('createVaultModal.dialog.selectPathButton')
    })

    if (!result.canceled && result.filePaths.length > 0) {
      formData.customPath = result.filePaths[0]
      errors.path = ''
    }
  } catch (error) {
    console.error('选择路径失败:', error)
    message.error(t('createVaultModal.errors.selectPathFailed'))
  }
}

/**
 * 网络路径输入时清除错误
 */
const onNetworkPathInput = (): void => {
  if (errors.networkPath) {
    errors.networkPath = ''
  }
  networkStatus.value = null
}

const onBrowsePathInput = (): void => {
  if (errors.browsePath) {
    errors.browsePath = ''
  }
}

/**
 * 验证网络路径格式并测试访问
 */
const validateNetworkPath = async (): Promise<boolean> => {
  errors.networkPath = ''

  if (!formData.networkPath?.trim()) {
    errors.networkPath = t('createVaultModal.errors.networkPathRequired')
    return false
  }

  // 检查路径格式
  const networkPath = formData.networkPath.trim()
  if (!networkPath.startsWith('\\\\')) {
    errors.networkPath = t('createVaultModal.errors.networkPathFormat')
    return false
  }

  // 测试网络访问 — 复用 V1 的文件系统访问检查（非 manifest 逻辑）
  networkStatus.value = { type: 'loading', message: t('createVaultModal.network.checking') }

  try {
    const result = await window.api.invoke('networkVault:testAccess', networkPath)

    if (result.success && result.data) {
      const { accessible, requiresAuth, canWrite } = result.data

      if (accessible) {
        networkStatus.value = {
          type: 'success',
          message: canWrite
            ? t('createVaultModal.network.accessibleWritable')
            : t('createVaultModal.network.accessibleReadonly')
        }
        return true
      } else if (requiresAuth) {
        networkStatus.value = { type: 'auth', message: t('createVaultModal.network.authRequired') }
        return false
      } else {
        networkStatus.value = { type: 'error', message: t('createVaultModal.network.inaccessible') }
        return false
      }
    } else {
      networkStatus.value = {
        type: 'error',
        message: result.error || t('createVaultModal.network.checkFailed')
      }
      return false
    }
  } catch {
    networkStatus.value = { type: 'error', message: t('createVaultModal.network.checkFailed') }
    return false
  }
}

const validateBrowsePath = async (): Promise<boolean> => {
  errors.browsePath = ''

  const browsePath = formData.browsePath?.trim()
  if (!browsePath) {
    return true
  }

  if (!isBrowsableAbsolutePath(browsePath)) {
    errors.browsePath = t('createVaultModal.errors.browsePathFormat')
    return false
  }

  return true
}

/**
 * 资产服务器连接
 */
const handleNasConnect = async (): Promise<void> => {
  const url = nasServerUrl.value.trim()
  if (!url) return

  nasError.value = ''
  nasConnecting.value = true
  remoteVaults.value = []
  remoteRoots.value = []
  selectedRemoteVault.value = null
  nasConnected.value = false

  try {
    const result = await window.api.invoke(
      'networkVaultV2:listRemoteVaults',
      url,
      nasApiKey.value || undefined
    )

    if (result.success) {
      remoteVaults.value = result.data || []
      nasConnected.value = true

      // 拉取资产根路径（旧服务端返回空数组 → 平铺模式）
      try {
        const rootsResult = await window.api.invoke('networkVaultV2:listRemoteRoots', url)
        remoteRoots.value = rootsResult.success ? rootsResult.data || [] : []
      } catch {
        remoteRoots.value = []
      }
      if (remoteRoots.value.length > 0 && !remoteCreateRootPath.value) {
        remoteCreateRootPath.value = remoteRoots.value[0].path
      }

      // 如果只有一个 vault，自动选中并填入名称
      if (remoteVaults.value.length === 1) {
        selectedRemoteVault.value = remoteVaults.value[0]
        if (!formData.name.trim()) {
          formData.name = remoteVaults.value[0].name
        }
      }
    } else {
      nasError.value = result.error || t('createVaultModal.errors.connectFailed')
    }
  } catch (err) {
    nasError.value =
      err instanceof Error ? err.message : t('createVaultModal.errors.connectFailedCheckAddress')
  } finally {
    nasConnecting.value = false
  }
}

/**
 * 从某个资产路径的分组头发起新建：预选该根路径并展开表单，
 * 避免用户在 A 组下点新建、表单却停留在 B 组的默认值上。
 */
const startCreateInRoot = (rootPath: string): void => {
  remoteCreateRootPath.value = rootPath
  remoteCreateError.value = ''
  showRemoteCreateForm.value = true
}

/**
 * 在远程资产服务器上创建新的 Vault
 */
const handleRemoteCreate = async (): Promise<void> => {
  const name = remoteCreateName.value.trim()
  const vaultPath = remoteCreatePath.value.trim()
  if (!name) return

  // 检查特殊字符
  const invalidChars = /[<>:"/\\|?*]/
  if (invalidChars.test(name)) {
    remoteCreateError.value = t('createVaultModal.errors.nameInvalidCharsShort')
    return
  }

  remoteCreating.value = true
  remoteCreateError.value = ''

  // 服务端有资产路径中间层时，必须归属到某个根之下（防止误建到默认路径造成嵌套）
  if (remoteRoots.value.length > 0 && !remoteCreateRootPath.value) {
    remoteCreateError.value = t('createVaultModal.errors.selectRootPath')
    return
  }

  try {
    const result = await window.api.invoke(
      'networkVaultV2:createRemoteVault',
      nasServerUrl.value.trim(),
      name,
      nasApiKey.value || undefined,
      remoteRoots.value.length > 0 ? undefined : vaultPath || undefined,
      remoteRoots.value.length > 0 ? remoteCreateRootPath.value : undefined
    )

    if (result.success) {
      message.success(t('createVaultModal.toast.remoteVaultCreated', { name }))

      // 重新拉取列表
      await handleNasConnect()

      // 自动选中新创建的 vault
      const newVault = remoteVaults.value.find((v) => v.name === name)
      if (newVault) {
        selectedRemoteVault.value = newVault
        if (!formData.name.trim()) {
          formData.name = name
        }
      }

      // 重置创建表单（保留已选资产路径，方便连续在同一路径下建多个库）
      showRemoteCreateForm.value = false
      remoteCreateName.value = ''
      remoteCreatePath.value = ''
    } else {
      remoteCreateError.value = result.error || t('createVaultModal.errors.createFailed')
    }
  } catch (err) {
    remoteCreateError.value =
      err instanceof Error ? err.message : t('createVaultModal.errors.createFailedCheckServer')
  } finally {
    remoteCreating.value = false
  }
}

/**
 * 删除远程资产服务器上的 Vault
 */
const handleRemoteDelete = async (vault: RemoteVaultInfo): Promise<void> => {
  // 获取 API Key（优先使用当前输入，其次使用设置页保存的）
  const apiKey =
    nasApiKey.value?.trim() || localStorage.getItem('assetManagement.serverApiKey') || ''
  const hasApiKey = !!apiKey

  const confirmMsg = hasApiKey
    ? t('createVaultModal.confirm.deleteWithApiKey', { name: vault.name })
    : t('createVaultModal.confirm.deleteWithoutApiKey', { name: vault.name })

  if (!window.confirm(confirmMsg)) return

  try {
    const result = await window.api.invoke(
      'networkVaultV2:deleteRemoteVault',
      nasServerUrl.value.trim(),
      vault.vaultId,
      apiKey || undefined
    )

    if (result.success) {
      const physicalDeleted = result.data?.physicalDelete
      const msg = physicalDeleted
        ? t('createVaultModal.toast.deletedWithPhysicalFiles', { name: vault.name })
        : t('createVaultModal.toast.deregistered', { name: vault.name })
      message.success(msg)

      // 如果删除的是当前选中的，清除选中
      if (selectedRemoteVault.value?.vaultId === vault.vaultId) {
        selectedRemoteVault.value = null
      }

      // 重新拉取列表
      await handleNasConnect()
    } else {
      message.error(result.error || t('createVaultModal.errors.deleteFailed'))
    }
  } catch (err) {
    message.error(
      err instanceof Error ? err.message : t('createVaultModal.errors.deleteFailedCheckServer')
    )
  }
}

// 监听远程 vault 选择，自动填入名称
watch(selectedRemoteVault, (vault) => {
  if (vault && !formData.name.trim()) {
    formData.name = vault.name
  }
})

/**
 * V2: 网络库创建后无需 manifest 初始化
 * VaultManager.switchToVault 会自动启动 V2 Server/Client
 * 资产数据直接存入 SQLite，通过 ChangeTracker 跟踪变更
 */

/**
 * 重置表单到初始状态
 */
const resetForm = (): void => {
  formData.name = ''
  formData.customPath = ''
  formData.networkPath = ''
  formData.browsePath = ''
  formData.vaultType = VaultType.REFERENCE
  formData.icon = 'database'

  errors.name = ''
  errors.path = ''
  errors.networkPath = ''
  errors.browsePath = ''
  networkStatus.value = null
  showAuthModal.value = false

  // 资产服务器模式重置
  networkSubMode.value = 'smb'
  nasServerIp.value = ''
  nasServerPort.value = '18900'
  nasApiKey.value = ''
  nasError.value = ''
  remoteVaults.value = []
  remoteRoots.value = []
  selectedRemoteVault.value = null
  nasConnected.value = false
  showRemoteCreateForm.value = false
  remoteCreateName.value = ''
  remoteCreatePath.value = ''
  remoteCreateRootPath.value = ''
  remoteCreateError.value = ''
}

/**
 * 认证成功回调
 */
const onAuthConnected = async (): Promise<void> => {
  // 认证成功后重新测试访问
  if (formData.networkPath) {
    await validateNetworkPath()
  }
}

/**
 * 认证取消回调
 */
const onAuthCancelled = (): void => {
  // 用户取消认证，保持当前状态
}

/**
 * 取消并关闭模态框
 */
const handleCancel = (): void => {
  visible.value = false
}

/**
 * 提交创建资产库请求
 */
const handleCreate = async (): Promise<void> => {
  const shouldUseBrowsePath =
    formData.vaultType === VaultType.NETWORK && networkSubMode.value === 'nas'
  const browsePath = shouldUseBrowsePath ? formData.browsePath?.trim() || undefined : undefined
  // NAS 直连模式特殊处理
  if (formData.vaultType === VaultType.NETWORK && networkSubMode.value === 'nas') {
    if (!selectedRemoteVault.value) return
    if (!(await validateBrowsePath())) return

    try {
      loading.value = true

      const result = await window.api.invoke(
        'networkVaultV2:connectRemoteVault',
        nasServerUrl.value.trim(),
        toRaw(selectedRemoteVault.value),
        nasApiKey.value || undefined,
        formData.name.trim() || undefined,
        browsePath
      )

      if (result.success) {
        message.success(
          t('createVaultModal.toast.connectedTo', { name: selectedRemoteVault.value.name })
        )

        // 重新加载 vault 列表
        await vaultStore.loadVaults()
        const createdVault = vaultStore.getVaultById(result.data.localVaultId)

        if (createdVault) {
          emit('created', createdVault)
        }
        visible.value = false

        // 延迟触发同步
        message.loading({
          content: t('createVaultModal.toast.syncingAssetData'),
          key: 'network-vault-sync',
          duration: 3
        })
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('trigger-network-vault-pull-sync'))
        }, 2000)
      } else {
        message.error(result.error || t('createVaultModal.errors.connectFailed'))
      }
    } catch (error) {
      console.error('NAS 连接失败:', error)
      message.error(
        error instanceof Error ? error.message : t('createVaultModal.errors.connectFailed')
      )
    } finally {
      loading.value = false
    }
    return
  }

  // 验证表单
  if (!validateName()) {
    return
  }

  try {
    loading.value = true

    const config: CreateVaultConfig = {
      name: formData.name.trim(),
      customPath: formData.customPath || undefined,
      vaultType: formData.vaultType,
      icon: formData.icon,
      networkPath: formData.vaultType === VaultType.NETWORK ? formData.networkPath : undefined,
      browsePath
    }

    const newVault = await vaultStore.createVault(config)

    // 网络库：确保切换到新库后再同步资产到本地 SQLite
    if (formData.vaultType === VaultType.NETWORK && formData.networkPath) {
      try {
        // 显式切换到新创建的保管库并等待完成
        console.log('[CreateVaultModal] 显式切换到新保管库...')
        await vaultStore.switchVault(newVault.id)
        console.log('[CreateVaultModal] 切换完成')

        // 先关闭模态框
        emit('created', newVault)
        visible.value = false

        // 🔧 延迟 2 秒后自动触发拉取同步
        // 原因：给数据库 schema 足够的时间初始化
        message.loading({
          content: t('createVaultModal.toast.preparingSync'),
          key: 'network-vault-sync',
          duration: 2
        })
        setTimeout(() => {
          console.log('[CreateVaultModal] 延迟 2 秒后自动触发拉取同步')
          // 派发事件让 index.vue 执行 handlePullSync
          window.dispatchEvent(new CustomEvent('trigger-network-vault-pull-sync'))
        }, 2000)
        return
      } catch (syncErr) {
        console.error('[CreateVaultModal] 网络库初始化失败:', syncErr)
      }
    }

    // 非网络库或网络库初始化失败
    emit('created', newVault)
    visible.value = false
  } catch (error) {
    console.error('创建资产库失败:', error)

    // 转换为用户友好的错误提示
    let errorMessage = t('createVaultModal.errors.createVaultFailed')
    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint') || error.message.includes('vaults.name')) {
        errorMessage = t('createVaultModal.errors.nameAlreadyExists', { name: formData.name })
      } else {
        errorMessage = error.message
      }
    }
    message.error(errorMessage)
  } finally {
    loading.value = false
  }
}
</script>

<style lang="less">
/**
 * 全局样式 - 覆盖 Ant Design Modal 默认样式
 * 注意：Modal 使用 Teleport 渲染到 body，必须使用全局样式
 */
.create-vault-modal {
  .app-modal__panel {
    background: transparent !important;
    box-shadow: none !important;
    padding: 0 !important;
    border-radius: 16px;
  }

  .app-modal__body {
    padding: 0 !important;
  }
}
</style>

<style lang="less" scoped>
// Glassmorphism 面板样式
.glass-panel {
  background: var(--color-bg-sunken);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 16px;
  box-shadow: 0 20px 50px -12px var(--shadow-color-strong);
  padding: 24px;
}

// 头部样式
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;

  .header-content {
    .modal-title {
      font-size: 20px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 0 0 4px 0;
      letter-spacing: -0.02em;
    }

    .modal-subtitle {
      font-size: 12px;
      color: var(--color-text-secondary);
      margin: 0;
    }
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    border-radius: 50%;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 14px;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }
}

// 表单内容区
.form-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

// 表单组
.form-group {
  .form-label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
    margin-left: 2px;
  }
}

// 输入框样式
.input-wrapper {
  position: relative;

  .glass-input {
    width: 100%;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 10px;
    padding: 12px 40px 12px 16px;
    font-size: 14px;
    color: var(--color-text-primary);
    transition: all 0.2s ease;
    outline: none;

    &::placeholder {
      color: var(--color-text-muted);
    }

    &:focus {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-accent-border);
      box-shadow: 0 0 0 3px var(--color-accent-border);
    }

    &.has-error {
      border-color: var(--color-danger-border);
    }
  }

  .input-icon {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-text-muted);
    font-size: 16px;
  }
}

.error-message {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-danger-text);
}

// 模式选择卡片
.mode-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.mode-card {
  padding: 16px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover:not(.active) {
    background: var(--color-bg-selected);
    border-color: var(--color-border);
  }

  &.active {
    background: var(--color-bg-selected);
    box-shadow: 0 4px 20px -5px var(--color-accent-border);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--color-bg-sunken);
    color: var(--color-text-secondary);
    font-size: 16px;
    transition: all 0.2s ease;

    &.active {
      background: var(--color-accent-solid);
      color: var(--color-text-on-solid);
    }
  }

  .check-icon {
    color: var(--color-accent-text);
    font-size: 14px;
  }

  .card-body {
    .card-title {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0 0 6px 0;
    }

    .card-desc {
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-text-muted);
      margin: 0;
    }
  }
}

// 模式提示信息
.mode-hint {
  min-height: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  margin-top: 10px;

  .hint-warning,
  .hint-success,
  .hint-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .hint-warning {
    color: var(--color-warning-text);
    animation: pulse 2s infinite;

    .hint-icon {
      font-size: 12px;
    }
  }

  .hint-success {
    color: var(--color-success-text);

    .hint-icon {
      font-size: 12px;
    }
  }

  .hint-info {
    color: var(--color-accent-text);

    .hint-icon {
      font-size: 12px;
    }
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

// 网络状态指示器
.network-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;

  .status-icon {
    font-size: 14px;
  }

  &.loading {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
  }

  &.success {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  &.error {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }

  &.auth {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  .auth-btn {
    margin-left: auto;
    padding: 4px 12px;
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    border-radius: 6px;
    color: var(--color-warning-text);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s ease;

    &:hover {
      background: var(--color-warning-bg);
    }
  }
}

// 网络库卡片特殊样式
.mode-card.network-card {
  &.disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    pointer-events: auto; /* Required for tooltip */

    &:hover {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-border-subtle);
      transform: none;
    }
  }

  .icon-wrapper.network {
    &.active {
      background: var(--gradient-accent);
    }
  }
}

// 路径选择器
.path-group {
  padding-bottom: 4px;
}

.path-selector {
  display: flex;
  gap: 10px;

  .path-display {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 10px;

    .folder-icon {
      color: var(--color-text-muted);
      font-size: 14px;
      flex-shrink: 0;
    }

    .path-text {
      font-size: 12px;
      font-family: 'Consolas', 'Monaco', monospace;
      color: var(--color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    // 占位符状态样式
    &.is-placeholder .path-text {
      font-family: inherit;
      font-style: italic;
      color: var(--color-text-muted);
    }
  }

  .change-btn {
    padding: 10px 18px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    color: var(--color-text-primary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;

    &:hover {
      background: var(--color-bg-surface-hover);
    }

    &:active {
      background: var(--color-bg-surface-hover);
    }
  }
}

// 展开动画
.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-8px);
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.expand-enter-to,
.expand-leave-from {
  max-height: 500px;
  opacity: 1;
  transform: translateY(0);
}

// 底部操作栏
.modal-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--color-border-subtle);
  background: none;

  .btn-cancel {
    padding: 10px 20px;
    background: transparent;
    border: none;
    color: var(--color-text-secondary);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.2s ease;

    &:hover {
      color: var(--color-text-primary);
    }
  }

  .btn-create {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 24px;
    background: var(--color-accent-solid);
    border: none;
    border-radius: 10px;
    color: var(--color-text-on-solid);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 4px 12px -2px var(--color-accent-border);

    &:hover:not(.disabled) {
      background: var(--color-accent-solid);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px -2px var(--color-accent-border);
    }

    &:active:not(.disabled) {
      transform: scale(0.98);
    }

    &.disabled {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-secondary);
      cursor: not-allowed;
      box-shadow: none;
    }

    .arrow-icon {
      font-size: 12px;
      transition: transform 0.2s ease;
    }

    &:hover:not(.disabled) .arrow-icon {
      transform: translateX(3px);
    }
  }
}

// 资产服务器模式样式
.network-sub-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;

  .sub-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 8px;
    color: var(--color-text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s ease;

    .tab-icon {
      font-size: 14px;
    }

    &:hover:not(.active) {
      background: var(--color-bg-selected);
    }

    &.active {
      background: var(--color-bg-selected);
      color: var(--color-text-selected);
    }
  }
}

.nas-connect-row {
  display: flex;
  gap: 8px;

  .nas-addr-group {
    flex: 1;
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 8px;
  }

  .nas-ip-wrapper {
    min-width: 0;
  }

  .nas-port-wrapper {
    min-width: 0;
  }

  .nas-connect-btn {
    padding: 10px 20px;
    background: var(--color-accent-solid);
    border: none;
    border-radius: 10px;
    color: var(--color-text-on-solid);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
    min-width: 72px;

    &:hover:not(:disabled) {
      background: var(--color-accent-solid);
    }

    &:disabled {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-secondary);
      cursor: not-allowed;
    }
  }
}

.remote-vault-list {
  margin-top: 12px;

  .form-label {
    margin-bottom: 8px;
  }
}

/* 高级选项折叠区 */
.advanced-section {
  margin-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
  padding-top: 10px;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 2px;
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--color-text-primary);
  font-size: 13px;
  transition: color 0.2s ease;

  &:hover {
    color: var(--color-text-primary);
  }

  .advanced-caret {
    font-size: 11px;
    transition: transform 0.2s ease;

    &.open {
      transform: rotate(90deg);
    }
  }

  .advanced-summary {
    margin-left: auto;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .advanced-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent-solid);
    flex: none;
  }
}

.advanced-body {
  padding-top: 6px;
}

/* 资产路径分组（服务器 → 资产路径 → 资产库） */
.rvault-group {
  &:not(:first-of-type) {
    margin-top: 10px;
  }

  .rvault-group-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 2px 6px;

    .rvault-group-icon {
      font-size: 12px;
      color: var(--color-text-primary);
      align-self: center;
    }

    .rvault-group-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--color-text-primary);
    }

    .rvault-group-path {
      font-size: 11px;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .rvault-group-add {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 10px;
      font-size: 11px;
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        color: var(--color-text-primary);
        background: var(--color-accent-bg);
        border-color: var(--color-accent-border);
      }
    }
  }

  .rvault-group-empty {
    padding: 8px 14px;
    margin-bottom: 8px;
    margin-left: 20px;
    font-size: 12px;
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
    border: 1px dashed var(--color-border-subtle);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
      color: var(--color-text-primary);
      border-color: var(--color-accent-border);
    }
  }

  /* 仅在真正分组时缩进；旧服务端平铺模式保持原样 */
  &.grouped .remote-vault-card {
    margin-left: 20px;
  }
}

/* 新建时的资产路径下拉：保留原生箭头作为"可选择"的视觉提示 */
select.root-select {
  cursor: pointer;

  option {
    background: var(--color-bg-surface);
    color: var(--color-text-primary);
  }
}

.remote-vault-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 8px;

  &:hover:not(.selected) {
    background: var(--color-bg-selected);
    border-color: var(--color-border-subtle);
  }

  &.selected {
    background: var(--color-bg-selected);
  }

  .rvault-info {
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: hidden;
  }

  .rvault-icon {
    color: var(--color-accent-text);
    font-size: 18px;
    flex-shrink: 0;
  }

  .rvault-details {
    overflow: hidden;
  }

  .rvault-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rvault-path {
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rvault-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .rvault-delete-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 13px;
    opacity: 0;

    &:hover {
      background: var(--color-danger-bg);
      border-color: var(--color-danger-border);
      color: var(--color-danger-text);
    }
  }

  &:hover .rvault-delete-btn {
    opacity: 1;
  }

  .rvault-check {
    color: var(--color-accent-text);
    font-size: 16px;
    flex-shrink: 0;
  }
}

.api-key-group {
  margin-top: 12px;

  .optional-label {
    font-size: 11px;
    color: var(--color-text-secondary);
    font-weight: 400;
  }
}

.browse-path-group {
  margin-top: 12px;
}

.optional-label {
  font-size: 11px;
  color: var(--color-text-secondary);
  font-weight: 400;
}

.form-tip {
  margin-top: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.nas-empty-hint {
  text-align: center;
  padding: 20px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.remote-create-section {
  margin-top: 12px;
}

.remote-create-trigger {
  display: flex;
  justify-content: center;
}

.remote-create-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--color-bg-surface-hover);
  border: 1px dashed var(--color-accent-border);
  border-radius: 8px;
  color: var(--color-accent-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  width: 100%;
  justify-content: center;

  &:hover {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
  }
}

.remote-create-form {
  .form-label {
    margin-bottom: 8px;
  }
}

.remote-create-row {
  align-items: flex-start;
}

.remote-create-inputs {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.remote-cancel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;

  &:hover {
    background: var(--color-danger-bg);
    border-color: var(--color-danger-border);
    color: var(--color-danger-text);
  }
}

.server-connect {
  padding-top: 0;
}
</style>
