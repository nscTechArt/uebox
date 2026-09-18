<template>
  <div class="webdav-user-info-card">
    <div class="info-section">
      <PhHardDrives class="server-icon" />
      <div class="info-content">
        <div class="server-url">{{ displayServerUrl }}</div>
        <div class="connection-status">
          <PhCheckCircle weight="fill" class="status-icon" />
          <span>{{ $t('webdavUserInfoCard.connected') }}</span>
        </div>
      </div>
    </div>
    <AppButton variant="text" size="small" danger class="switch-btn" @click="handleDisconnect">
      <template #icon><PhSignOut /></template>
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { computed } from 'vue'
import { PhCheckCircle, PhHardDrives, PhSignOut } from '@phosphor-icons/vue'
import { useWebdavStore } from '@renderer/store/modules/webdav'

const webdavStore = useWebdavStore()

/**
 * 显示的服务器地址（简化版）
 */
const displayServerUrl = computed(() => {
  if (!webdavStore.connection) return ''
  try {
    const url = new URL(webdavStore.connection.serverUrl)
    return url.host
  } catch {
    return webdavStore.connection.serverUrl
  }
})

/**
 * 断开连接
 */
function handleDisconnect() {
  webdavStore.clearConnection()
}
</script>

<style scoped lang="less">
.webdav-user-info-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 1px 2px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);

  .info-section {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;

    .server-icon {
      font-size: 22px;
      color: var(--color-accent-text);
    }

    .info-content {
      flex: 1;

      .server-url {
        padding-left: 2px;
        font-size: 14px;
        font-weight: 600;
        color: var(--color-text-primary);
      }

      .connection-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--color-success-text);

        .status-icon {
          font-size: 14px;
        }
      }
    }
  }

  .switch-btn {
    color: var(--color-text-secondary);
  }
}
</style>
