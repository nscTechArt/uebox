<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
/**
 * 资产库设置组件
 */
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import {
  PhCaretRight,
  PhHardDrives,
  PhInfo,
  PhLightning,
  PhTrash as IconDeleteOrClear
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { ASSET_CATEGORIES } from '@renderer/constants/assetCategories'
import { useI18n } from '@renderer/hooks/useI18n'
import {
  ENABLE_NETWORK_VAULT_KEY,
  readStoredNetworkVaultPreference,
  resolveNetworkVaultEnabled
} from '@renderer/views/AssetManagement/utils/networkVaultAccess'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import { assetSemanticAPI } from '@renderer/api/assetSemantic'

const { t } = useI18n()

// ==============================
// 删除确认设置
// ==============================
// 配置 key
const SKIP_CONFIRM_KEY = 'assetManagement.skipDeleteConfirm'

// 初始化状态：如果 localStorage 中标记为跳过，则"删除确认"为关(false)，否则为开(true)
const deleteConfirm = ref(localStorage.getItem(SKIP_CONFIRM_KEY) !== 'true')

/**
 * 监听设置变化
 */
watch(deleteConfirm, (val) => {
  if (val) {
    // 开启确认 -> 移除跳过标记
    localStorage.removeItem(SKIP_CONFIRM_KEY)
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: SKIP_CONFIRM_KEY, value: null }
      })
    )
  } else {
    // 关闭确认 -> 添加跳过标记
    localStorage.setItem(SKIP_CONFIRM_KEY, 'true')
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: SKIP_CONFIRM_KEY, value: 'true' }
      })
    )
  }
})

// 「显示依赖资产」搬去资产库的筛选栏了，在那里叫「只看主资产」。
// 它筛的是资产列表，属于那个列表；放在这儿的后果是：想临时看一眼附带资产，
// 得离开资产库翻到这一页，改完还得翻回去 —— 而且改完那边并不刷新，
// 因为资产页从来没监听过这个 localStorage 事件

// ==============================
// 压缩包导入询问
// ==============================
//
// 往资产库里拖 zip 不问、也不解 —— 用户可能就是想把包存起来。只有他真的要把这个包
// 导进 UE 工程时才问一次「解压还是原样复制」。这个开关管的就是那一次询问。
//
// 存的是**动作**而不是布尔：关掉询问以后总得有个默认行为，勾了「不再询问」时
// 用户点的哪个按钮，以后就一直走哪个。
const ARCHIVE_ACTION_KEY = 'assetManagement.archiveImportAction'

const archiveImportAsk = ref(!localStorage.getItem(ARCHIVE_ACTION_KEY))

watch(archiveImportAsk, (val) => {
  if (val) {
    // 恢复询问 -> 忘掉上次记住的动作
    localStorage.removeItem(ARCHIVE_ACTION_KEY)
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: ARCHIVE_ACTION_KEY, value: null }
      })
    )
  } else {
    // 从设置里关掉询问时用户没有在选动作，默认「解压后导入」——
    // 把压缩包原样丢进工程是极少数情况，不该成为静默的默认值。
    localStorage.setItem(ARCHIVE_ACTION_KEY, 'extract')
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: ARCHIVE_ACTION_KEY, value: 'extract' }
      })
    )
  }
})

// 「导入并发数」删了。它是个全局值，会盖掉渲染层按库类型算好的那三档
// （远端 HTTP 库 2、局域网库 1、本地库 3，见 AssetManagement/index.vue）——
// 填 10 就是拿 10 路并发去压一个代码里特意限到 1 的 SMB 共享。
// 主进程那侧的 asset:setImportConcurrency / getImportConcurrency 也一并删了

// ==============================
// 局域网协作库实验性功能设置
// ==============================
const networkVaultPreference = ref(readStoredNetworkVaultPreference(localStorage))
const enableNetworkVault = computed(() =>
  resolveNetworkVaultEnabled({
    storedPreference: networkVaultPreference.value
  })
)

/**
 * 处理局域网协作库开关变化
 */
const handleNetworkVaultChange = (checked: boolean) => {
  networkVaultPreference.value = checked
}

/**
 * 监听局域网协作库设置变化
 */
watch(networkVaultPreference, (val) => {
  if (val === null) {
    localStorage.removeItem(ENABLE_NETWORK_VAULT_KEY)
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: ENABLE_NETWORK_VAULT_KEY, value: null }
      })
    )
    return
  }

  localStorage.setItem(ENABLE_NETWORK_VAULT_KEY, String(val))
  window.dispatchEvent(
    new CustomEvent('local-storage-change', {
      detail: { key: ENABLE_NETWORK_VAULT_KEY, value: String(val) }
    })
  )
})

// ==============================
// 资产服务器管理
// ==============================
const SERVER_ADDR_KEY = 'assetManagement.serverAddress'
const SERVER_API_KEY_KEY = 'assetManagement.serverApiKey'

const serverAddress = ref(localStorage.getItem(SERVER_ADDR_KEY) || '')
const serverApiKey = ref(localStorage.getItem(SERVER_API_KEY_KEY) || '')
const serverVersion = ref('')
const serverUpdateStatus = ref<
  'idle' | 'checking' | 'available' | 'applying' | 'upToDate' | 'error'
>('idle')
const serverUpdateMessage = ref('')
const serverUpdateInfo = ref<any>(null)

// 持久化保存服务器地址
watch(serverAddress, (val) => {
  if (val.trim()) {
    localStorage.setItem(SERVER_ADDR_KEY, val.trim())
  } else {
    localStorage.removeItem(SERVER_ADDR_KEY)
  }
})

// 持久化保存 API Key
watch(serverApiKey, (val) => {
  if (val.trim()) {
    localStorage.setItem(SERVER_API_KEY_KEY, val.trim())
  } else {
    localStorage.removeItem(SERVER_API_KEY_KEY)
  }
})

/** 获取完整的服务器 URL */
const getServerUrl = (): string => {
  const addr = serverAddress.value.trim()
  if (!addr) return ''
  return addr.startsWith('http') ? addr : `http://${addr}`
}

/** 查询服务器版本 */
const handleCheckVersion = async () => {
  const url = getServerUrl()
  if (!url) {
    message.warning(t('serverManagement.toast.serverUrlRequired'))
    return
  }
  try {
    const resp = await fetch(`${url}/api/system/version`, { signal: AbortSignal.timeout(5000) })
    const data = await resp.json()
    if (data.success) {
      serverVersion.value = data.data?.version || '未知'
    } else {
      serverVersion.value = '获取失败'
    }
  } catch {
    serverVersion.value = '连接失败'
  }
}

/** 检查更新 */
const handleCheckUpdate = async () => {
  const url = getServerUrl()
  if (!url) {
    message.warning(t('serverManagement.toast.serverUrlRequired'))
    return
  }
  const apiKey = serverApiKey.value.trim()
  if (!apiKey) {
    message.warning(t('profile.asset.updateKeyRequired'))
    return
  }

  serverUpdateStatus.value = 'checking'
  serverUpdateMessage.value = '正在检查更新...'

  try {
    const resp = await fetch(`${url}/api/system/check-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000)
    })
    const data = await resp.json()
    if (data.success && data.data) {
      serverUpdateInfo.value = data.data
      if (data.data.hasUpdate) {
        serverUpdateStatus.value = 'available'
        serverUpdateMessage.value = `发现新版本: ${data.data.remoteVersion || ''}（${data.data.changedFiles || 0} 个文件需更新）`
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

/** 应用更新 */
const handleApplyUpdate = async () => {
  const url = getServerUrl()
  const apiKey = serverApiKey.value.trim()
  if (!url || !apiKey) return

  serverUpdateStatus.value = 'applying'
  serverUpdateMessage.value = '正在应用更新...'

  try {
    const resp = await fetch(`${url}/api/system/apply-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120000)
    })
    const data = await resp.json()
    if (data.success && data.data) {
      if (data.data.updatedFiles > 0) {
        serverUpdateStatus.value = 'upToDate'
        serverUpdateMessage.value = `更新成功！已更新 ${data.data.updatedFiles} 个文件，服务器将自动重启`
        message.success(t('profile.asset.updateRestarting'))
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
// 默认应用设置
// ==============================
const DEFAULT_APPS_KEY = 'assetManagement.defaultApps'
const defaultApps = ref<Record<string, string>>({})
const defaultAppsCollapsed = ref(true)

// 加载默认应用配置
const loadDefaultApps = () => {
  try {
    const saved = localStorage.getItem(DEFAULT_APPS_KEY)
    if (saved) {
      defaultApps.value = JSON.parse(saved)
    }
  } catch (e) {
    console.error('Failed to load default apps:', e)
  }
}

// 保存默认应用配置
const saveDefaultApps = () => {
  try {
    localStorage.setItem(DEFAULT_APPS_KEY, JSON.stringify(defaultApps.value))
    // 触发 storage 事件以同步其他窗口/组件
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: DEFAULT_APPS_KEY, value: JSON.stringify(defaultApps.value) }
      })
    )
  } catch (e) {
    console.error('Failed to save default apps:', e)
  }
}

// 选择应用
const handleSelectApp = async (categoryKey: string) => {
  try {
    const result = await (window as any).api.dialog.showOpenDialog({
      title: t('profile.asset.selectApp'),
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      defaultApps.value[categoryKey] = result.filePaths[0]
      saveDefaultApps()
      message.success(t('profile.asset.selectAppSuccess'))
    }
  } catch (e) {
    message.error(t('profile.asset.selectAppFailed'))
    console.error(e)
  }
}

// 清除应用设置
const handleClearApp = (categoryKey: string) => {
  if (defaultApps.value[categoryKey]) {
    delete defaultApps.value[categoryKey]
    saveDefaultApps()
    message.success(t('profile.asset.clearAppSuccess'))
  }
}

// 获取文件名称（用于显示）
const getAppName = (path: string) => {
  if (!path) return t('profile.asset.defaultAppLabel')
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

// 已经配过应用的类别数，挂在折叠标题上
const configuredAppCount = computed(
  () => ASSET_CATEGORIES.filter((cat) => !!defaultApps.value[cat.key]).length
)

// 获取资产类别的翻译标签
const getCategoryLabel = (categoryKey: string): string => {
  const key = `profile.asset.categories.${categoryKey}` as any
  return (t(key) as string) || categoryKey
}

// ==============================
// 生命周期与事件监听
// ==============================

/**
 * 监听 storage 事件，实现多窗口/跨组件状态同步
 */
const handleStorageChange = (e: StorageEvent) => {
  if (e.key === SKIP_CONFIRM_KEY) {
    deleteConfirm.value = e.newValue !== 'true'
  }
  if (e.key === ARCHIVE_ACTION_KEY) {
    archiveImportAsk.value = !e.newValue
  }
  if (e.key === DEFAULT_APPS_KEY) {
    loadDefaultApps()
  }
  if (e.key === ENABLE_NETWORK_VAULT_KEY) {
    networkVaultPreference.value = readStoredNetworkVaultPreference(localStorage)
  }
}

const handleCustomStorageChange = (e: CustomEvent) => {
  if (e.detail?.key === SKIP_CONFIRM_KEY) {
    deleteConfirm.value = localStorage.getItem(SKIP_CONFIRM_KEY) !== 'true'
  }
  if (e.detail?.key === ARCHIVE_ACTION_KEY) {
    archiveImportAsk.value = !localStorage.getItem(ARCHIVE_ACTION_KEY)
  }
  if (e.detail?.key === DEFAULT_APPS_KEY) {
    loadDefaultApps()
  }
  if (e.detail?.key === ENABLE_NETWORK_VAULT_KEY) {
    networkVaultPreference.value = readStoredNetworkVaultPreference(localStorage)
  }
}

onMounted(() => {
  window.addEventListener('storage', handleStorageChange)
  // Custom event for same-window sync (localStorage.setItem doesn't trigger storage event in same window)
  window.addEventListener('local-storage-change', handleCustomStorageChange as EventListener)

  loadDefaultApps()
})

onUnmounted(() => {
  window.removeEventListener('storage', handleStorageChange)
  window.removeEventListener('local-storage-change', handleCustomStorageChange as EventListener)
})

// ==============================
// 语义搜索
// ==============================
//
// 默认关闭，开关在这里而不是自动开启，是因为**建索引要花钱**：
// 每个资产都要调一次嵌入模型。几十万个资产的库，这笔账该不该付只有用户知道。
const semanticStatus = ref<AssetSemanticStatus | null>(null)
const semanticBusy = ref(false)
let semanticTimer: ReturnType<typeof setInterval> | null = null

const semanticEnabled = computed(() => semanticStatus.value?.enabled === true)

/** 建索引期间要看得见进度 —— 只显示一个「已开启」的话，用户不知道还要等多久 */
const semanticHint = computed(() => {
  const status = semanticStatus.value
  if (!status) return ''
  if (!status.available) return t('profile.asset.semantic.unavailable')
  if (!status.enabled) return ''
  if (status.lastError) return t('profile.asset.semantic.paused', { error: status.lastError })
  if (status.running || status.pending > 0) {
    return t('profile.asset.semantic.indexing', {
      indexed: status.indexed,
      total: status.total
    })
  }
  return t('profile.asset.semantic.ready', { indexed: status.indexed })
})

/** 停下来了才给「继续」按钮：正在跑的时候按它没有任何意义 */
const semanticCanResume = computed(() => {
  const status = semanticStatus.value
  return !!status?.enabled && !status.running && (status.pending > 0 || !!status.lastError)
})

const refreshSemanticStatus = async (): Promise<void> => {
  try {
    semanticStatus.value = await assetSemanticAPI.status()
  } catch {
    // 还没选保管库时读不到，属于正常情况，不打扰用户
    semanticStatus.value = null
  }
}

const onToggleSemantic = async (next: boolean): Promise<void> => {
  if (semanticBusy.value) return
  semanticBusy.value = true
  try {
    if (next) {
      semanticStatus.value = await assetSemanticAPI.enable()
    } else {
      semanticStatus.value = await assetSemanticAPI.disable()
    }
  } catch (error) {
    // 开失败最常见的原因是没配嵌入模型。把厂商原话带出来，比「操作失败」有用得多。
    message.error(
      t('profile.asset.semantic.enableFailed', {
        error: error instanceof Error ? error.message : String(error)
      })
    )
    await refreshSemanticStatus()
  } finally {
    semanticBusy.value = false
  }
}

const onResumeSemantic = async (): Promise<void> => {
  try {
    semanticStatus.value = await assetSemanticAPI.resume()
  } catch (error) {
    message.error(String(error))
  }
}

onMounted(() => {
  void refreshSemanticStatus()
  // 建索引是后台跑的，轮询是这里唯一能看到进度的办法
  semanticTimer = setInterval(() => void refreshSemanticStatus(), 2000)
})

onUnmounted(() => {
  if (semanticTimer) clearInterval(semanticTimer)
})
</script>

<template>
  <div class="profile-asset-settings">
    <!-- General Settings Group -->
    <div class="settings-group">
      <h3 class="group-title">{{ $t('profile.asset.general') }}</h3>
      <div class="settings-card">
        <!-- Delete Confirm Row -->
        <div class="setting-row">
          <div class="row-icon">
            <PhInfo />
          </div>
          <div class="row-content">
            <div class="row-title">{{ $t('profile.asset.deleteConfirm') }}</div>
            <div class="row-desc">{{ $t('profile.asset.deleteConfirmDesc') }}</div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="deleteConfirm" />
          </div>
        </div>

        <!-- Archive Import Confirm Row -->
        <div class="setting-row">
          <div class="row-icon">
            <PhInfo />
          </div>
          <div class="row-content">
            <div class="row-title">{{ $t('profile.asset.archiveImportAsk') }}</div>
            <div class="row-desc">{{ $t('profile.asset.archiveImportAskDesc') }}</div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="archiveImportAsk" />
          </div>
        </div>
      </div>
    </div>

    <!-- Semantic Search Group -->
    <div class="settings-group">
      <h3 class="group-title">{{ $t('profile.asset.semantic.group') }}</h3>
      <div class="settings-card">
        <div class="setting-row">
          <div class="row-icon">
            <PhLightning />
          </div>
          <div class="row-content semantic-content">
            <div class="row-title">{{ $t('profile.asset.semantic.title') }}</div>
            <div class="row-desc">{{ $t('profile.asset.semantic.desc') }}</div>
            <div class="row-desc">{{ $t('profile.asset.semantic.note') }}</div>
            <div v-if="semanticHint" class="row-desc semantic-hint">{{ semanticHint }}</div>
          </div>
          <div class="row-control semantic-control">
            <AppButton v-if="semanticCanResume" size="medium" @click="onResumeSemantic">
              {{ $t('profile.asset.semantic.resume') }}
            </AppButton>
            <AppSwitch
              :checked="semanticEnabled"
              :disabled="semanticBusy || semanticStatus?.available === false"
              @update:checked="onToggleSemantic"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Advanced Settings Group -->
    <div class="settings-group">
      <h3 class="group-title">{{ $t('profile.asset.advanced') }}</h3>
      <div class="settings-card">
        <!-- Enable Network Vault Row -->
        <div class="setting-row">
          <div class="row-icon">
            <PhInfo />
          </div>
          <div class="row-content">
            <div class="row-title">
              {{ $t('profile.asset.enableNetworkVault') }}
            </div>
            <div class="row-desc">
              {{ $t('profile.asset.enableNetworkVaultDesc') }}
            </div>
          </div>
          <div class="row-control">
            <AppSwitch :checked="enableNetworkVault" @change="handleNetworkVaultChange" />
          </div>
        </div>
      </div>
    </div>

    <!--
      TODO(服务器管理): 入口暂时隐藏。/server-management 整页只是 standalone 服务端的客户端，
      而服务端不在本仓库里，社区版用户点进去只会看到一排禁用按钮。等服务端开源、
      并补上凭据安全存储（当前 API Key 明文存 localStorage）和该页测试之后再放出来。
      页面代码与路由保留，不删。
    <div v-if="enableNetworkVault" class="settings-group">
      <h3 class="group-title">{{ $t('profileAssetSettings.serverGroup.title') }}</h3>
      <div class="settings-card">
        <div class="setting-row app-row" @click="$router.push('/server-management')">
          <div class="row-icon">
            <PhHardDrives />
          </div>
          <div class="row-content">
            <div class="row-title">{{ $t('profileAssetSettings.serverManagement.title') }}</div>
            <div class="row-desc">{{ $t('profileAssetSettings.serverManagement.desc') }}</div>
          </div>
          <div class="row-control">
            <PhCaretRight style="font-size: 12px; color: var(--color-text-muted)" />
          </div>
        </div>
      </div>
    </div>
    -->

    <!--
      默认应用和上面三组是同级的分组，所以用的就是这一页自己的分组样式：
      一行小标题 + 一条下划线，下面直接是行。

      它跟别人不一样的地方只有两点 —— 能折起来、有个「配了几个」的计数 ——
      那就只在标题行上加这两点。之前照搬 MCP 页那套带边框的卡片，结果整页
      只有这一块有框，比它上面三组都重，读起来像是另一个模块掉进来了。
    -->
    <div class="settings-group">
      <button
        class="group-title group-title-toggle"
        :aria-expanded="!defaultAppsCollapsed"
        @click="defaultAppsCollapsed = !defaultAppsCollapsed"
      >
        <PhCaretRight class="caret" :class="{ open: !defaultAppsCollapsed }" />
        <span>{{ $t('profile.asset.defaultApps') }}</span>
        <span class="group-count">{{ configuredAppCount }} / {{ ASSET_CATEGORIES.length }}</span>
      </button>

      <div v-show="!defaultAppsCollapsed" class="settings-card">
        <div
          v-for="cat in ASSET_CATEGORIES"
          :key="cat.key"
          class="setting-row app-row"
          @click="handleSelectApp(cat.key)"
        >
          <div class="row-icon">
            <component :is="cat.icon" />
          </div>
          <div class="row-content">
            <div class="row-title">{{ getCategoryLabel(cat.key) }}</div>
            <div class="row-desc">{{ cat.extensions.join(', ') }}</div>
          </div>

          <div class="row-control app-control">
            <div class="current-app" :class="{ 'is-set': defaultApps[cat.key] }">
              <span class="app-name">{{ getAppName(defaultApps[cat.key]) }}</span>
            </div>
            <div class="row-chevron">
              <PhCaretRight v-if="!defaultApps[cat.key]" />
              <AppButton
                v-else
                variant="text"
                shape="circle"
                class="clear-btn"
                @click.stop="handleClearApp(cat.key)"
              >
                <template #icon><IconDeleteOrClear /></template>
              </AppButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.profile-asset-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px;
  animation: fadeIn 0.3s ease;
}

/* Groups */
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
}

/*
 * 可折叠的分组标题：长得和上面几组的 `.group-title` 一模一样，
 * 只是多了一个 caret 和右侧计数，并且整行可点。
 */
.group-title-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: none;
  text-align: left;
  cursor: pointer;
  border-top: none;
  border-left: none;
  border-right: none;
  font-family: inherit;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  .caret {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-text-muted);
    transition: transform var(--motion-fast, 0.15s) var(--easing-standard, ease-in-out);

    &.open {
      transform: rotate(90deg);
    }
  }

  /* 配了几个挂在标题右端：不展开也看得见 */
  .group-count {
    margin-left: auto;
    font-weight: var(--font-weight-normal);
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }
}

/* Cards */
.settings-card {
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  // Dividers between rows
  .setting-row:not(:last-child) {
    border-bottom: 1px solid var(--color-border-subtle);
  }
}

/* Rows */
.setting-row {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  gap: 12px;
  transition: background-color 0.2s;
  min-height: 52px;

  &.app-row {
    cursor: pointer;
    padding: 10px 16px;
    min-height: 48px;

    &:hover {
      background-color: var(--color-bg-surface-hover);
    }
    &:active {
      background-color: var(--color-bg-surface-hover);
    }
  }

  &.is-locked {
    opacity: 0.7;

    .row-icon {
      color: var(--color-warning-text);
    }
  }

  .row-icon {
    font-size: 14px;
    color: var(--color-text-secondary);
    width: 20px;
    display: flex;
    justify-content: center;

    &.category-icon {
      width: 32px;
      height: 32px;
      background: var(--color-bg-surface-hover);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: var(--color-text-muted);
    }
  }

  .row-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;

    .row-title {
      font-size: var(--font-size-xs);
      color: var(--color-text-primary);
      font-weight: var(--font-weight-normal);
    }

    .row-desc {
      font-size: 12px;
      color: var(--color-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /*
     * 语义搜索那一行的说明要换行显示完整。
     *
     * 其余的 row-desc 都是一句短话，省略号截断没损失；这里三行分别是
     * 「它能干什么」「要花多少钱」「现在建到哪了」—— 每一条都是用户
     * 决定开不开的依据，截掉一半等于没写。
     */
    .semantic-hint {
      margin-top: 4px;
      color: var(--color-text-secondary);
    }
  }

  .semantic-content .row-desc {
    white-space: normal;
    overflow: visible;
    text-overflow: unset;
  }

  .row-control {
    display: flex;
    align-items: center;
    gap: 8px;

    &.app-control {
      max-width: 50%;
      justify-content: flex-end;
    }
  }
}

/* App Specific Controls */
.current-app {
  font-size: 13px;
  color: var(--color-text-muted);
  text-align: right;

  &.is-set {
    color: var(--color-accent-text);
    font-weight: 500;
  }

  .app-name {
    display: inline-block;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }
}

.row-chevron {
  color: var(--color-text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
}

.clear-btn {
  color: var(--color-text-muted);
  &:hover {
    color: var(--color-danger-text);
    background: var(--color-danger-bg);
  }
}

/* Server Management */
.server-input {
  width: 180px;
  padding: 4px 10px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
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

.server-version-badge {
  display: inline-block;
  padding: 1px 6px;
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
  border-radius: 4px;
}

.server-update-btn {
  padding: 4px 14px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  color: var(--color-text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;

  &:hover:not(:disabled) {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }

  &.apply {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);

    &:hover {
      background: var(--color-accent-bg);
    }
  }
}

.update-error {
  color: var(--color-danger-text) !important;
}
.update-available {
  color: var(--color-warning-text) !important;
}
.update-success {
  color: var(--color-success-text) !important;
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
