<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'
import {
  PhArrowClockwise,
  PhArrowsClockwise,
  PhCheckCircle,
  PhDatabase,
  PhFolder,
  PhFolderOpen,
  PhHardDrives,
  PhKey,
  PhLink,
  PhPlus,
  PhTrash,
  PhUser,
  PhXCircle
} from '@phosphor-icons/vue'

const { t } = useI18n()

// ==============================
// 连接配置
// ==============================
const SERVER_ADDR_KEY = 'assetManagement.serverAddress'
const SERVER_API_KEY_KEY = 'assetManagement.serverApiKey'

const serverAddress = ref(localStorage.getItem(SERVER_ADDR_KEY) || '')
const serverApiKey = ref(localStorage.getItem(SERVER_API_KEY_KEY) || '')
const serverVersion = ref('')
const connectionStatus = ref<'idle' | 'connecting' | 'connected' | 'error'>('idle')
const connectionError = ref('')
const isContainerMode = ref(false)
const authMode = ref<'member' | 'owner'>('member')
const memberUsername = ref(localStorage.getItem('assetManagement.serverUsername') || '')
const memberPassword = ref('')
const serverAuthToken = ref(localStorage.getItem('assetManagement.serverAuthToken') || '')
const serverAuthSession = ref<{
  userId: string
  username: string
  role: string
  vaultIds?: string[]
  exp?: number
} | null>(null)
const authLoading = ref(false)
const authError = ref('')
const memberList = ref<Array<{ memberId: string; username: string; role: string; status: string }>>(
  []
)
const memberLoading = ref(false)
const memberSaving = ref(false)
const newMemberUsername = ref('')
const newMemberPassword = ref('')
const newMemberRole = ref<'member' | 'node_admin'>('member')
const authModeOptions = computed(() => [
  { label: t('serverManagement.auth.memberMode'), value: 'member' },
  { label: t('serverManagement.auth.ownerMode'), value: 'owner' }
])

// 保存配置
const saveServerAddress = () => {
  const val = serverAddress.value.trim()
  if (val) {
    localStorage.setItem(SERVER_ADDR_KEY, val)
  } else {
    localStorage.removeItem(SERVER_ADDR_KEY)
  }
}
const saveApiKey = () => {
  const val = serverApiKey.value.trim()
  if (val) {
    localStorage.setItem(SERVER_API_KEY_KEY, val)
  } else {
    localStorage.removeItem(SERVER_API_KEY_KEY)
  }
}

const saveMemberUsername = () => {
  const val = memberUsername.value.trim()
  if (val) {
    localStorage.setItem('assetManagement.serverUsername', val)
  } else {
    localStorage.removeItem('assetManagement.serverUsername')
  }
}

const saveServerAuth = (token: string, session: typeof serverAuthSession.value) => {
  serverAuthToken.value = token
  serverAuthSession.value = session
  if (token) {
    localStorage.setItem('assetManagement.serverAuthToken', token)
  } else {
    localStorage.removeItem('assetManagement.serverAuthToken')
  }
}

const getServerUrl = (): string => {
  const addr = serverAddress.value.trim()
  if (!addr) return ''
  return addr.startsWith('http') ? addr : `http://${addr}`
}

// ==============================
// 连接测试 + 版本
// ==============================
// 地址提示：检测用户是否忘记端口号
const addressHint = computed(() => {
  const addr = serverAddress.value.trim()
  if (!addr) return ''
  // 如果看起来像纯 IP 或域名（没有端口），提示默认端口
  const stripped = addr.replace(/^https?:\/\//, '')
  if (stripped && !stripped.includes(':') && !stripped.includes('/')) {
    return '提示：默认端口为 18900，完整地址如 ' + stripped + ':18900'
  }
  return ''
})

const handleConnect = async () => {
  const url = getServerUrl()
  if (!url) {
    message.warning(t('serverManagement.toast.serverUrlRequired'))
    return
  }
  connectionStatus.value = 'connecting'
  connectionError.value = ''
  serverVersion.value = ''
  isContainerMode.value = false
  try {
    const resp = await fetch(`${url}/api/system/version`, { signal: AbortSignal.timeout(5000) })
    const data = await resp.json()
    if (data.success) {
      serverVersion.value = data.data?.version || '未知'
      connectionStatus.value = 'connected'
      saveServerAddress()
      // 检测是否为 Docker/容器模式
      try {
        const hResp = await fetch(`${url}/api/system/health`, { signal: AbortSignal.timeout(3000) })
        const hData = await hResp.json()
        isContainerMode.value = !!hData.data?.containerMode
      } catch {
        // health 接口失败不影响连接
      }
      await authenticateStandalone()
      await loadVaultList()
    } else {
      connectionStatus.value = 'error'
      connectionError.value = '服务器返回错误'
    }
  } catch (e) {
    connectionStatus.value = 'error'
    connectionError.value = e instanceof Error ? e.message : '连接失败'
  }
}

const getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (serverAuthToken.value) {
    headers.Authorization = `Bearer ${serverAuthToken.value}`
  }
  const apiKey = serverApiKey.value.trim()
  if (apiKey) {
    headers['X-API-Key'] = apiKey
  }
  return headers
}

const authenticateStandalone = async (): Promise<void> => {
  const url = getServerUrl()
  authError.value = ''
  if (!url) return

  const ownerKey = serverApiKey.value.trim()
  const username = memberUsername.value.trim()
  const password = memberPassword.value

  if (authMode.value === 'owner' && !ownerKey) {
    saveServerAuth('', null)
    return
  }
  if (authMode.value === 'member' && (!username || !password)) {
    if (serverAuthToken.value) {
      await refreshStandaloneSession()
    }
    return
  }

  authLoading.value = true
  try {
    const endpoint =
      authMode.value === 'owner' ? '/api/system/auth/owner-login' : '/api/system/auth/login'
    const resp = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authMode.value === 'owner' ? { 'X-API-Key': ownerKey } : {})
      },
      body: JSON.stringify(authMode.value === 'owner' ? { key: ownerKey } : { username, password }),
      signal: AbortSignal.timeout(8000)
    })
    const data = await resp.json()
    if (!resp.ok || !data.success) {
      throw new Error(data.error || '节点登录失败')
    }
    saveServerAuth(data.data?.token || '', data.data?.session || null)
    memberPassword.value = ''
    saveMemberUsername()
    if (serverAuthSession.value && isNodeAdmin.value) {
      await loadMemberList()
    }
  } catch (error) {
    saveServerAuth('', null)
    authError.value = error instanceof Error ? error.message : '节点登录失败'
  } finally {
    authLoading.value = false
  }
}

const refreshStandaloneSession = async (): Promise<void> => {
  const url = getServerUrl()
  if (!url || !serverAuthToken.value) return
  try {
    const resp = await fetch(`${url}/api/system/auth/me`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(5000)
    })
    const data = await resp.json()
    if (resp.ok && data.success) {
      serverAuthSession.value = data.data
    } else {
      saveServerAuth('', null)
    }
  } catch {
    saveServerAuth('', null)
  }
}

const isNodeAdmin = computed(() =>
  ['founder', 'node_admin'].includes(serverAuthSession.value?.role || '')
)

// ==============================
// Vault 管理
// ==============================
interface VaultItem {
  vaultId: string
  name: string
  networkPath: string
  permission?: string
  /** 所属资产根路径（1.0.56+ 服务端提供） */
  rootPath?: string | null
}

/** 资产根路径（服务器 → 资产路径 → 资产库 中间层） */
interface RootItem {
  name: string
  path: string
  vaultCount: number
}

const vaultList = ref<VaultItem[]>([])
const rootList = ref<RootItem[]>([])
const vaultLoading = ref(false)
const newVaultName = ref('')
const newVaultPath = ref('')
const newVaultRootPath = ref('')
const showNewVaultForm = ref(false)
const creatingVault = ref(false)
const deletingVaultId = ref<string | null>(null)

/** 按资产路径分组；旧服务端（无 roots）返回单个无名分组 → 模板平铺 */
const groupedVaultList = computed<Array<{ name: string; path: string; vaults: VaultItem[] }>>(
  () => {
    if (rootList.value.length === 0) {
      return [{ name: '', path: '', vaults: vaultList.value }]
    }
    const groups = rootList.value.map((root) => ({
      name: root.name,
      path: root.path,
      vaults: vaultList.value.filter((v) => v.rootPath === root.path)
    }))
    const ungrouped = vaultList.value.filter(
      (v) => !v.rootPath || !rootList.value.some((r) => r.path === v.rootPath)
    )
    if (ungrouped.length > 0) groups.push({ name: '未分组', path: '', vaults: ungrouped })
    return groups
  }
)

const loadVaultList = async () => {
  const url = getServerUrl()
  if (!url) return
  vaultLoading.value = true
  try {
    const resp = await fetch(`${url}/api/vaults`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(8000)
    })
    const data = await resp.json()
    if (data.success) {
      vaultList.value = data.data || []
    }
    // 资产根路径（旧服务端 404 → 空数组，平铺展示）
    try {
      const rootsResp = await fetch(`${url}/api/roots`, {
        headers: getAuthHeaders(),
        signal: AbortSignal.timeout(8000)
      })
      const rootsData = await rootsResp.json()
      rootList.value = rootsData.success && Array.isArray(rootsData.data) ? rootsData.data : []
    } catch {
      rootList.value = []
    }
    if (rootList.value.length > 0 && !newVaultRootPath.value) {
      newVaultRootPath.value = rootList.value[0].path
    }
  } catch {
    // silently fail
  } finally {
    vaultLoading.value = false
  }
}

const handleCreateVault = async () => {
  const url = getServerUrl()
  const name = newVaultName.value.trim()
  if (!url || !name) {
    message.warning(t('serverManagement.toast.vaultNameRequired'))
    return
  }
  if (rootList.value.length > 0 && !newVaultRootPath.value && !newVaultPath.value.trim()) {
    message.warning(t('serverManagement.toast.vaultPathRequired'))
    return
  }
  creatingVault.value = true
  try {
    const body: Record<string, string> = { name }
    if (newVaultPath.value.trim()) {
      // 高级：显式完整路径优先
      body.path = newVaultPath.value.trim()
    } else if (rootList.value.length > 0 && newVaultRootPath.value) {
      body.rootPath = newVaultRootPath.value
    }
    const resp = await fetch(`${url}/api/system/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    })
    const data = await resp.json()
    if (data.success) {
      message.success(t('serverManagement.toast.vaultCreated', { name }))
      newVaultName.value = ''
      newVaultPath.value = ''
      showNewVaultForm.value = false
      loadVaultList()
    } else {
      message.error(data.error || '创建失败')
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : '创建失败')
  } finally {
    creatingVault.value = false
  }
}

// ── 资产路径（逻辑分组）管理 ──
const showNewRootForm = ref(false)
const newRootName = ref('')
const newRootPath = ref('')
const savingRoot = ref(false)
const movingVaultId = ref<string | null>(null)

const rootRequest = async (
  method: 'POST' | 'PUT' | 'DELETE',
  body: Record<string, unknown>,
  okMsg: string
): Promise<boolean> => {
  const url = getServerUrl()
  if (!url) return false
  try {
    const resp = await fetch(`${url}/api/system/roots`, {
      method,
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    })
    const data = await resp.json()
    if (data.success) {
      message.success(okMsg)
      await loadVaultList()
      return true
    }
    message.error(data.error || '操作失败')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '操作失败')
  }
  return false
}

const handleCreateRoot = async (): Promise<void> => {
  const p = newRootPath.value.trim()
  if (!p) {
    message.warning(t('serverManagement.toast.rootPathRequired'))
    return
  }
  savingRoot.value = true
  const ok = await rootRequest(
    'POST',
    { name: newRootName.value.trim() || undefined, path: p },
    '资产路径已创建'
  )
  savingRoot.value = false
  if (ok) {
    newRootName.value = ''
    newRootPath.value = ''
    showNewRootForm.value = false
  }
}

// 内联重命名：Electron 渲染进程不支持 window.prompt()，必须走界面内输入
const renamingRootPath = ref<string | null>(null)
const renamingRootName = ref('')

const startRenameRoot = (root: RootItem): void => {
  renamingRootPath.value = root.path
  renamingRootName.value = root.name
}
const cancelRenameRoot = (): void => {
  renamingRootPath.value = null
  renamingRootName.value = ''
}
const commitRenameRoot = async (root: RootItem): Promise<void> => {
  const name = renamingRootName.value.trim()
  if (!name) {
    message.warning(t('serverManagement.toast.nameRequired'))
    return
  }
  if (name === root.name) {
    cancelRenameRoot()
    return
  }
  const ok = await rootRequest('PUT', { path: root.path, name }, '已重命名')
  if (ok) cancelRenameRoot()
}

const handleDeleteRoot = async (root: RootItem): Promise<void> => {
  if (root.vaultCount > 0) {
    message.warning(t('serverManagement.toast.rootHasVaults', { count: root.vaultCount }))
    return
  }
  if (!window.confirm(`移除资产路径「${root.name}」？\n\n磁盘目录不会被删除，只是不再作为分组。`))
    return
  await rootRequest('DELETE', { path: root.path }, '资产路径已移除')
}

/** 变更资产库归属——纯配置变更，不移动任何文件 */
const handleMoveVault = async (vault: VaultItem, rootPath: string | null): Promise<void> => {
  const url = getServerUrl()
  if (!url) return
  movingVaultId.value = vault.vaultId
  try {
    const resp = await fetch(`${url}/api/system/vaults/${encodeURIComponent(vault.vaultId)}/root`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ rootPath }),
      signal: AbortSignal.timeout(10000)
    })
    const data = await resp.json()
    if (data.success) {
      message.success(rootPath ? '归属已变更' : '已恢复为按路径归属')
      await loadVaultList()
    } else {
      message.error(data.error || '变更失败')
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : '变更失败')
  } finally {
    movingVaultId.value = null
  }
}

const handleDeleteVault = async (vault: VaultItem) => {
  const url = getServerUrl()
  if (!url) return
  deletingVaultId.value = vault.vaultId
  try {
    const resp = await fetch(`${url}/api/system/vaults/${encodeURIComponent(vault.vaultId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(10000)
    })
    const data = await resp.json()
    if (data.success) {
      message.success(`资产库 "${vault.name}" 已删除`)
      loadVaultList()
    } else {
      message.error(data.error || '删除失败')
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : '删除失败')
  } finally {
    deletingVaultId.value = null
  }
}

const loadMemberList = async () => {
  const url = getServerUrl()
  if (!url || !isNodeAdmin.value) return
  memberLoading.value = true
  try {
    const resp = await fetch(`${url}/api/system/members`, {
      headers: getAuthHeaders(),
      signal: AbortSignal.timeout(8000)
    })
    const data = await resp.json()
    if (data.success) {
      memberList.value = data.data || []
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '成员列表加载失败')
  } finally {
    memberLoading.value = false
  }
}

const handleCreateMember = async () => {
  const url = getServerUrl()
  if (!url || !isNodeAdmin.value) return
  const username = newMemberUsername.value.trim()
  const password = newMemberPassword.value
  if (!username || !password) {
    message.warning(t('serverManagement.toast.memberCredentialsRequired'))
    return
  }
  memberSaving.value = true
  try {
    const resp = await fetch(`${url}/api/system/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        username,
        password,
        role: newMemberRole.value,
        status: 'active'
      }),
      signal: AbortSignal.timeout(8000)
    })
    const data = await resp.json()
    if (!resp.ok || !data.success) {
      throw new Error(data.error || t('serverManagement.toast.memberSaveFailed'))
    }
    message.success(t('serverManagement.toast.memberSaved'))
    newMemberUsername.value = ''
    newMemberPassword.value = ''
    newMemberRole.value = 'member'
    await loadMemberList()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '成员保存失败')
  } finally {
    memberSaving.value = false
  }
}

// ==============================
// 服务器更新
// ==============================
const serverUpdateStatus = ref<
  'idle' | 'checking' | 'available' | 'applying' | 'upToDate' | 'error'
>('idle')
const serverUpdateMessage = ref('')
const serverUpdateInfo = ref<any>(null)

const handleCheckUpdate = async () => {
  const url = getServerUrl()
  if (!url) {
    message.warning(t('serverManagement.toast.serverUrlRequired'))
    return
  }
  const apiKey = serverApiKey.value.trim()
  if (!apiKey && !serverAuthToken.value) {
    message.warning(t('serverManagement.toast.updateAdminRequired'))
    return
  }

  serverUpdateStatus.value = 'checking'
  serverUpdateMessage.value = '正在检查更新...'

  try {
    const resp = await fetch(`${url}/api/system/check-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...(apiKey ? { 'X-API-Key': apiKey } : {})
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000)
    })
    const data = await resp.json()
    if (data.success && data.data) {
      serverUpdateInfo.value = data.data
      if (data.data.available) {
        serverUpdateStatus.value = 'available'
        const totalChanges =
          (data.data.changedFiles?.length || 0) +
          (data.data.newFiles?.length || 0) +
          (data.data.deletedFiles?.length || 0)
        serverUpdateMessage.value = `发现新版本: ${data.data.remoteVersion || ''}（${totalChanges} 个文件需更新）`
      } else {
        serverUpdateStatus.value = 'upToDate'
        serverUpdateMessage.value = '已是最新版本'
        setTimeout(() => {
          serverUpdateStatus.value = 'idle'
          serverUpdateMessage.value = ''
        }, 3000)
      }
    } else {
      serverUpdateStatus.value = 'error'
      serverUpdateMessage.value = data.error || '检查更新失败'
    }
  } catch (err) {
    serverUpdateStatus.value = 'error'
    serverUpdateMessage.value = err instanceof Error ? err.message : '连接服务器失败'
  }
}

const handleApplyUpdate = async () => {
  const url = getServerUrl()
  const apiKey = serverApiKey.value.trim()
  if (!url || (!apiKey && !serverAuthToken.value)) return

  serverUpdateStatus.value = 'applying'
  serverUpdateMessage.value = '正在应用更新...'

  try {
    const resp = await fetch(`${url}/api/system/apply-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...(apiKey ? { 'X-API-Key': apiKey } : {})
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120000)
    })
    const data = await resp.json()
    if (data.success && data.data) {
      if (data.data.updatedFiles > 0) {
        serverUpdateStatus.value = 'upToDate'
        serverUpdateMessage.value = `更新成功！已更新 ${data.data.updatedFiles} 个文件，服务器将自动重启`
        message.success(t('serverManagement.toast.updateRestarting'))
      } else {
        serverUpdateStatus.value = 'upToDate'
        serverUpdateMessage.value = '无需更新'
      }
    } else {
      serverUpdateStatus.value = 'error'
      serverUpdateMessage.value = data.error || '更新失败'
    }
  } catch (err) {
    serverUpdateStatus.value = 'error'
    serverUpdateMessage.value = err instanceof Error ? err.message : '连接服务器失败'
  }
}

// ==============================
// 连接状态图标
// ==============================
const statusConfig = computed(() => {
  switch (connectionStatus.value) {
    case 'connected':
      return {
        color: '#34d399',
        text: t('serverManagement.status.connected'),
        icon: PhCheckCircle
      }
    case 'connecting':
      return {
        color: '#fbbf24',
        text: t('serverManagement.status.connecting'),
        icon: PhArrowsClockwise
      }
    case 'error':
      return {
        color: '#f87171',
        text: t('serverManagement.status.error'),
        icon: PhXCircle
      }
    default:
      return { color: '#64748b', text: t('serverManagement.status.idle'), icon: PhLink }
  }
})

// ==============================
// 生命周期
// ==============================
onMounted(() => {
  // 如果已有配置则自动连接
  if (serverAddress.value.trim()) {
    handleConnect()
  }
})
</script>

<template>
  <div class="server-management">
    <!-- Header -->
    <div class="page-header">
      <div class="header-left">
        <PhHardDrives class="header-icon" />
        <div>
          <h1 class="page-title">{{ $t('serverManagement.header.title') }}</h1>
          <p class="page-subtitle">{{ $t('serverManagement.header.subtitle') }}</p>
        </div>
      </div>
      <div class="connection-badge" :class="connectionStatus">
        <component :is="statusConfig.icon" :spin="connectionStatus === 'connecting'" />
        <span>{{ statusConfig.text }}</span>
        <span v-if="serverVersion" class="version-tag">v{{ serverVersion }}</span>
      </div>
    </div>

    <div class="page-content">
      <!-- Section: 连接配置 -->
      <section class="section">
        <h2 class="section-title">
          <PhLink />
          {{ $t('serverManagement.connection.sectionTitle') }}
        </h2>
        <div class="section-card">
          <div class="form-row">
            <label class="form-label">
              <PhHardDrives />
              {{ $t('serverManagement.connection.addressLabel') }}
            </label>
            <div class="form-input-group">
              <input
                v-model="serverAddress"
                type="text"
                placeholder="192.168.1.100:18900"
                class="form-input"
                @keyup.enter="handleConnect"
                @blur="saveServerAddress"
              />
              <button
                class="connect-btn"
                :disabled="connectionStatus === 'connecting'"
                @click="handleConnect"
              >
                <PhArrowsClockwise :spin="connectionStatus === 'connecting'" />
                {{
                  connectionStatus === 'connecting'
                    ? $t('serverManagement.connection.connectingButton')
                    : $t('serverManagement.connection.connectButton')
                }}
              </button>
            </div>
          </div>
          <p v-if="addressHint" class="hint-text">{{ addressHint }}</p>
          <div class="form-row">
            <label class="form-label">
              <PhUser />
              {{ $t('serverManagement.connection.identityLabel') }}
            </label>
            <div class="form-input-group">
              <a-segmented v-model:value="authMode" :options="authModeOptions" />
              <button
                class="connect-btn"
                :disabled="authLoading || connectionStatus !== 'connected'"
                @click="authenticateStandalone"
              >
                <PhArrowsClockwise :spin="authLoading" />
                {{ $t('serverManagement.connection.loginButton') }}
              </button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">
              <PhKey />
              {{
                authMode === 'owner'
                  ? $t('serverManagement.connection.ownerKeyLabel')
                  : $t('serverManagement.connection.accountLabel')
              }}
            </label>
            <div v-if="authMode === 'owner'" class="form-input-group">
              <input
                v-model="serverApiKey"
                type="password"
                :placeholder="$t('serverManagement.connection.ownerKeyPlaceholder')"
                class="form-input"
                @blur="saveApiKey"
              />
            </div>
            <div v-else class="form-input-group">
              <input
                v-model="memberUsername"
                type="text"
                :placeholder="$t('serverManagement.connection.memberUsernamePlaceholder')"
                class="form-input"
                @blur="saveMemberUsername"
                @keyup.enter="authenticateStandalone"
              />
              <input
                v-model="memberPassword"
                type="password"
                :placeholder="$t('serverManagement.connection.passwordPlaceholder')"
                class="form-input"
                @keyup.enter="authenticateStandalone"
              />
            </div>
          </div>
          <div v-if="serverAuthSession" class="auth-status">
            {{
              $t('serverManagement.connection.loggedInAs', {
                username: serverAuthSession.username,
                role: serverAuthSession.role
              })
            }}
          </div>
          <p v-if="authError" class="error-text"><PhXCircle /> {{ authError }}</p>
          <p v-if="connectionError" class="error-text"><PhXCircle /> {{ connectionError }}</p>
        </div>
      </section>

      <!-- Section: 资产库管理 -->
      <section class="section">
        <div class="section-title-row">
          <h2 class="section-title">
            <PhDatabase />
            {{ $t('serverManagement.vault.sectionTitle') }}
            <span v-if="vaultList.length" class="count-badge">{{ vaultList.length }}</span>
          </h2>
          <div class="section-actions">
            <button
              class="icon-btn"
              :title="$t('serverManagement.vault.refreshTitle')"
              :disabled="vaultLoading"
              @click="loadVaultList"
            >
              <PhArrowClockwise :spin="vaultLoading" />
            </button>
            <button
              v-if="isNodeAdmin"
              class="action-btn"
              :disabled="connectionStatus !== 'connected'"
              :title="$t('serverManagement.vault.addRootTitle')"
              @click="showNewRootForm = !showNewRootForm"
            >
              <PhFolderOpen /> {{ $t('serverManagement.vault.rootButton') }}
            </button>
            <button
              class="action-btn primary"
              :disabled="connectionStatus !== 'connected'"
              @click="showNewVaultForm = !showNewVaultForm"
            >
              <PhPlus />
              {{ $t('serverManagement.vault.createButton') }}
            </button>
          </div>
        </div>

        <!-- 新增资产路径表单 -->
        <div v-if="showNewRootForm" class="new-vault-form">
          <div class="form-row compact">
            <input
              v-model="newRootName"
              type="text"
              :placeholder="$t('serverManagement.vault.rootNamePlaceholder')"
              class="form-input"
              @keyup.enter="handleCreateRoot"
            />
            <input
              v-model="newRootPath"
              type="text"
              :placeholder="$t('serverManagement.vault.rootPathPlaceholder')"
              class="form-input"
              @keyup.enter="handleCreateRoot"
            />
            <button
              class="action-btn primary"
              :disabled="savingRoot || !newRootPath.trim()"
              @click="handleCreateRoot"
            >
              {{
                savingRoot
                  ? $t('serverManagement.vault.creating')
                  : $t('serverManagement.vault.create')
              }}
            </button>
            <button class="action-btn" @click="showNewRootForm = false">
              {{ $t('serverManagement.vault.cancel') }}
            </button>
          </div>
          <p class="form-hint">
            {{ $t('serverManagement.vault.rootHint') }}
          </p>
        </div>

        <!-- 新建表单 -->
        <div v-if="showNewVaultForm" class="new-vault-form">
          <div class="form-row compact">
            <input
              v-model="newVaultName"
              type="text"
              :placeholder="$t('serverManagement.vault.namePlaceholder')"
              class="form-input"
              @keyup.enter="handleCreateVault"
            />
            <select v-if="rootList.length > 0" v-model="newVaultRootPath" class="form-input">
              <option v-for="root in rootList" :key="root.path" :value="root.path">
                {{ root.name }}（{{ root.path }}）
              </option>
            </select>
            <input
              v-else
              v-model="newVaultPath"
              type="text"
              :placeholder="$t('serverManagement.vault.pathPlaceholder')"
              class="form-input"
            />
            <button
              class="action-btn primary"
              :disabled="creatingVault || !newVaultName.trim()"
              @click="handleCreateVault"
            >
              {{
                creatingVault
                  ? $t('serverManagement.vault.creating')
                  : $t('serverManagement.vault.create')
              }}
            </button>
            <button class="action-btn" @click="showNewVaultForm = false">
              {{ $t('serverManagement.vault.cancel') }}
            </button>
          </div>
        </div>

        <!-- Vault 列表 -->
        <div class="section-card vault-list">
          <div v-if="connectionStatus !== 'connected'" class="empty-state">
            <PhHardDrives class="empty-icon" />
            <p>{{ $t('serverManagement.vault.emptyConnect') }}</p>
          </div>
          <div v-else-if="vaultLoading" class="empty-state">
            <PhArrowsClockwise spin class="empty-icon" />
            <p>{{ $t('serverManagement.vault.loading') }}</p>
          </div>
          <div v-else-if="vaultList.length === 0" class="empty-state">
            <PhDatabase class="empty-icon" />
            <p>{{ $t('serverManagement.vault.empty') }}</p>
            <button class="action-btn primary" @click="showNewVaultForm = true">
              <PhPlus /> {{ $t('serverManagement.vault.createFirst') }}
            </button>
          </div>
          <template v-for="group in groupedVaultList" :key="group.path || '__flat__'">
            <div
              v-if="group.name && connectionStatus === 'connected' && !vaultLoading"
              class="vault-group-header"
            >
              <PhFolderOpen />
              <template v-if="renamingRootPath === group.path">
                <input
                  v-model="renamingRootName"
                  class="group-rename-input"
                  :placeholder="$t('serverManagement.vault.renameNamePlaceholder')"
                  autofocus
                  @keyup.enter="
                    commitRenameRoot({
                      name: group.name,
                      path: group.path,
                      vaultCount: group.vaults.length
                    })
                  "
                  @keyup.esc="cancelRenameRoot"
                />
                <button
                  class="group-act"
                  @click="
                    commitRenameRoot({
                      name: group.name,
                      path: group.path,
                      vaultCount: group.vaults.length
                    })
                  "
                >
                  {{ $t('serverManagement.vault.save') }}
                </button>
                <button class="group-act" @click="cancelRenameRoot">
                  {{ $t('serverManagement.vault.cancel') }}
                </button>
              </template>
              <template v-else>
                <span class="vault-group-name">{{ group.name }}</span>
                <span class="vault-group-path">{{ group.path }}</span>
                <span class="vault-group-count">{{ group.vaults.length }}</span>
                <template v-if="group.path && isNodeAdmin">
                  <button
                    class="group-act"
                    :title="$t('serverManagement.vault.renameTitle')"
                    @click="
                      startRenameRoot({
                        name: group.name,
                        path: group.path,
                        vaultCount: group.vaults.length
                      })
                    "
                  >
                    {{ $t('serverManagement.vault.renameTitle') }}
                  </button>
                  <button
                    class="group-act danger"
                    :disabled="group.vaults.length > 0"
                    :title="
                      group.vaults.length > 0
                        ? $t('serverManagement.vault.removeBlockedTitle')
                        : $t('serverManagement.vault.removeTitle')
                    "
                    @click="
                      handleDeleteRoot({
                        name: group.name,
                        path: group.path,
                        vaultCount: group.vaults.length
                      })
                    "
                  >
                    {{ $t('serverManagement.vault.remove') }}
                  </button>
                </template>
              </template>
            </div>
            <div
              v-for="vault in group.vaults"
              :key="vault.vaultId"
              class="vault-item"
              :class="{ grouped: !!group.name }"
            >
              <div class="vault-icon">
                <PhFolder />
              </div>
              <div class="vault-info">
                <div class="vault-name">{{ vault.name }}</div>
                <div class="vault-path">{{ vault.networkPath }}</div>
              </div>
              <select
                v-if="rootList.length > 0 && isNodeAdmin"
                class="vault-root-select"
                :value="vault.rootPath || ''"
                :disabled="movingVaultId === vault.vaultId"
                :title="$t('serverManagement.vault.changeRootTitle')"
                @change="handleMoveVault(vault, ($event.target as HTMLSelectElement).value || null)"
              >
                <option value="">{{ $t('serverManagement.vault.byPathOption') }}</option>
                <option v-for="root in rootList" :key="root.path" :value="root.path">
                  {{ root.name }}
                </option>
              </select>
              <div class="vault-id">{{ vault.vaultId.slice(0, 8) }}...</div>
              <button
                class="icon-btn danger"
                :title="$t('serverManagement.vault.deleteTitle')"
                :disabled="deletingVaultId === vault.vaultId"
                @click="handleDeleteVault(vault)"
              >
                <PhTrash :spin="deletingVaultId === vault.vaultId" />
              </button>
            </div>
          </template>
        </div>
      </section>

      <section v-if="isNodeAdmin" class="section">
        <div class="section-title-row">
          <h2 class="section-title">
            <PhUser />
            {{ $t('serverManagement.member.sectionTitle') }}
            <span v-if="memberList.length" class="count-badge">{{ memberList.length }}</span>
          </h2>
          <div class="section-actions">
            <button
              class="icon-btn"
              :title="$t('serverManagement.member.refreshTitle')"
              :disabled="memberLoading"
              @click="loadMemberList"
            >
              <PhArrowClockwise :spin="memberLoading" />
            </button>
          </div>
        </div>

        <div class="new-vault-form">
          <div class="form-row compact">
            <input
              v-model="newMemberUsername"
              type="text"
              :placeholder="$t('serverManagement.member.usernamePlaceholder')"
              class="form-input"
            />
            <input
              v-model="newMemberPassword"
              type="password"
              :placeholder="$t('serverManagement.member.passwordPlaceholder')"
              class="form-input"
            />
            <select v-model="newMemberRole" class="form-input role-select">
              <option value="member">{{ $t('serverManagement.member.roleMember') }}</option>
              <option value="node_admin">{{ $t('serverManagement.member.roleAdmin') }}</option>
            </select>
            <button
              class="action-btn primary"
              :disabled="memberSaving || !newMemberUsername.trim() || !newMemberPassword"
              @click="handleCreateMember"
            >
              {{
                memberSaving
                  ? $t('serverManagement.member.saving')
                  : $t('serverManagement.member.add')
              }}
            </button>
          </div>
        </div>

        <div class="section-card vault-list">
          <div v-if="memberLoading" class="empty-state">
            <PhArrowsClockwise spin class="empty-icon" />
            <p>{{ $t('serverManagement.member.loading') }}</p>
          </div>
          <div v-else-if="memberList.length === 0" class="empty-state">
            <PhUser class="empty-icon" />
            <p>{{ $t('serverManagement.member.empty') }}</p>
          </div>
          <div v-for="member in memberList" :key="member.memberId" class="vault-item">
            <div class="vault-icon">
              <PhUser />
            </div>
            <div class="vault-info">
              <div class="vault-name">{{ member.username }}</div>
              <div class="vault-path">{{ member.role }} / {{ member.status }}</div>
            </div>
            <div class="vault-id">{{ member.memberId.slice(0, 12) }}...</div>
          </div>
        </div>
      </section>

      <!-- Section: 服务器更新 (已隐藏) -->
    </div>
  </div>
</template>

<style scoped lang="less">
.server-management {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-page);
  color: var(--color-text-primary);
  overflow-y: auto;
}

// ─── Header ───
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28px 36px 20px;
  border-bottom: 1px solid var(--color-border-subtle);

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;

    .header-icon {
      font-size: 28px;
      color: var(--color-accent-text);
    }
  }

  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
    letter-spacing: -0.01em;
  }

  .page-subtitle {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--color-text-muted);
  }
}

.connection-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  transition: all 0.3s;

  &.connected {
    color: var(--color-success-text);
    border-color: var(--color-success-border);
    background: var(--color-success-bg);
  }
  &.connecting {
    color: var(--color-warning-text);
    border-color: var(--color-warning-border);
    background: var(--color-warning-bg);
  }
  &.error {
    color: var(--color-danger-text);
    border-color: var(--color-danger-border);
    background: var(--color-danger-bg);
  }
  &.idle {
    color: var(--color-text-muted);
  }

  .version-tag {
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 400;
    color: var(--color-accent-text);
    background: var(--color-accent-bg);
    border-radius: 4px;
  }
}

// ─── Content ───
.page-content {
  flex: 1;
  padding: 24px 36px 40px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.management-tabs {
  display: flex;
  justify-content: flex-start;
}

// ─── Section ───
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;

  .count-badge {
    padding: 0 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
    border-radius: 10px;
    min-width: 20px;
    text-align: center;
  }
}

.section-description {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;

  .section-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
}

.section-card {
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  padding: 16px 20px;
}

// ─── Form ───
.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;

  &:not(:last-child) {
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &.compact {
    padding: 0;
    border: none;
  }
}

.form-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 100px;
  font-size: 13px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.form-input-group {
  flex: 1;
  display: flex;
  gap: 8px;
}

.form-input {
  flex: 1;
  padding: 7px 12px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 7px;
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;
  transition: all 0.2s;

  &::placeholder {
    color: var(--color-text-secondary);
  }
  &:focus {
    border-color: var(--color-accent-border);
    background: var(--color-bg-surface-hover);
  }
}

.role-select {
  max-width: 150px;
}

.error-text {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-danger-text);
}

.auth-status {
  margin-top: 8px;
  padding-left: 112px;
  font-size: 12px;
  color: var(--color-success-text);
}

.hint-text {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  padding-left: 112px;
}

.container-mode-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: 8px;
  margin-bottom: 12px;

  .notice-icon {
    font-size: 20px;
    flex-shrink: 0;
    line-height: 1.3;
  }

  .notice-content {
    flex: 1;
    min-width: 0;
  }

  .notice-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-accent-text);
  }

  .notice-desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    margin-top: 2px;
    line-height: 1.5;

    code {
      padding: 1px 5px;
      background: var(--color-bg-surface-hover);
      border-radius: 3px;
      font-size: 11px;
      color: var(--color-text-primary);
    }
  }
}

.version-tag {
  &.container {
    color: var(--color-accent-text);
    background: var(--color-accent-bg);
  }
}

// ─── Buttons ───
.connect-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: 7px;
  color: var(--color-accent-text);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
  }
  &:disabled {
    color: var(--color-text-disabled);
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    box-shadow: none;
    cursor: not-allowed;
  }
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 7px;
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
  }
  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
  &.primary {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
    &:hover:not(:disabled) {
      background: var(--color-accent-bg);
    }
  }
  &.accent {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
    &:hover:not(:disabled) {
      background: var(--color-accent-bg);
    }
  }
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
  &.danger:hover:not(:disabled) {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

// ─── New Vault Form ───
.new-vault-form {
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: 10px;
  padding: 14px 16px;
  animation: slideDown 0.2s ease;

  .form-row.compact {
    gap: 8px;
  }
}

// ─── Vault List ───
.vault-list {
  padding: 0;
  overflow: hidden;
}

.vault-group-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 4px 4px;
  font-size: 13px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.65));

  .vault-group-name {
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .vault-group-path {
    font-size: 11px;
    color: var(--color-text-muted, rgba(255, 255, 255, 0.35));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .vault-group-count {
    font-size: 11px;
    color: var(--color-text-muted, rgba(255, 255, 255, 0.35));
  }
}

.vault-item.grouped {
  margin-left: 18px;
}

.group-rename-input {
  flex: 1;
  max-width: 260px;
  padding: 3px 9px;
  font-size: 13px;
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-accent-border);
  border-radius: 5px;
  outline: none;
}

.group-act {
  flex: none;
  padding: 2px 9px;
  font-size: 11px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 5px;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &.danger:hover:not(:disabled) {
    color: var(--color-danger-text);
    border-color: var(--color-danger-border);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
}

.vault-root-select {
  flex: none;
  max-width: 150px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  cursor: pointer;

  option {
    background: var(--color-bg-surface);
    color: var(--color-text-primary);
  }
}

.form-hint {
  margin: 8px 2px 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.4));
}

.vault-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  transition: background 0.15s;

  &:not(:last-child) {
    border-bottom: 1px solid var(--color-border-subtle);
  }

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .vault-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-accent-bg);
    border-radius: 8px;
    color: var(--color-accent-text);
    font-size: 16px;
    flex-shrink: 0;
  }

  .vault-info {
    flex: 1;
    min-width: 0;

    .vault-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
    }
    .vault-path {
      font-size: 12px;
      color: var(--color-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .vault-id {
    font-size: 11px;
    color: var(--color-text-muted);
    font-family: 'SF Mono', 'Cascadia Code', monospace;
    flex-shrink: 0;
  }
}

// ─── Empty State ───
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 12px;
  color: var(--color-text-muted);

  .empty-icon {
    font-size: 32px;
    opacity: 0.4;
  }

  p {
    margin: 0;
    font-size: 14px;
  }
}

// ─── Update Row ───
.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  .update-info {
    flex: 1;

    .update-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .update-message {
      margin-top: 4px;
      font-size: 13px;
      color: var(--color-text-secondary);

      &.muted {
        color: var(--color-text-muted);
      }
      &.error {
        color: var(--color-danger-text);
      }
      &.available {
        color: var(--color-warning-text);
      }
      &.success {
        color: var(--color-success-text);
      }
    }
  }

  .update-actions {
    flex-shrink: 0;
  }
}

.version-tag {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
  border-radius: 4px;

  &.muted {
    color: var(--color-text-muted);
    background: var(--color-bg-surface-hover);
  }
}

// ─── Animations ───
@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
