<template>
  <div v-if="isAuthenticated" class="baiduyun-user-info-card">
    <div class="info-section">
      <a-avatar :src="userInfo?.avatar_url" :size="24" class="user-avatar" />
      <div class="info-content">
        <div class="user-name" :title="userInfo?.baidu_name">{{ userInfo?.baidu_name || '-' }}</div>
        <div class="vip-status">
          <span class="vip-tag" :class="vipClass">{{ vipLabel(userInfo?.vip_type) }}</span>
        </div>
      </div>
    </div>
    <AppButton variant="text" size="small" danger class="switch-btn" @click="handleSwitchAccount">
      <template #icon><PhSignOut /></template>
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { PhSignOut } from '@phosphor-icons/vue'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import type { BaiduUserInfoResponse } from '@renderer/api-services/baiduYunApi'

const { t } = useI18n()
const baiduyunStore = useBaiduyunStore()
const isAuthenticated = computed(() => baiduyunStore.isAuthenticated && !baiduyunStore.isExpired)
const userInfo = ref<BaiduUserInfoResponse | null>(null)
const loading = ref(false)

async function fetchUserInfo(): Promise<void> {
  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) return
  try {
    loading.value = true
    const res = await window.api.baiduYun.getUserInfo({ accessToken })
    if (res?.success) {
      userInfo.value = res.data ?? null
    } else {
      throw new Error(res?.error || t('assetLib.baiduyun.userInfo.failedToGet'))
    }
  } catch (err) {
    console.error('获取用户信息失败', err)
    message.error(t('assetLib.baiduyun.userInfo.failedToGet'))
  } finally {
    loading.value = false
  }
}

function vipLabel(type?: number): string {
  if (typeof type !== 'number') return t('assetLib.baiduyun.userInfo.unauthorized')
  switch (type) {
    case 1:
      return 'VIP'
    case 2:
      return 'SVIP'
    default:
      return t('assetLib.baiduyun.userInfo.normal')
  }
}

const vipClass = computed(() => {
  const type = userInfo.value?.vip_type
  if (type === 2) return 'svip'
  if (type === 1) return 'vip'
  return 'normal'
})

watch(
  () => isAuthenticated.value,
  (val, oldVal) => {
    if (val && !oldVal) fetchUserInfo()
  }
)

onMounted(() => {
  if (isAuthenticated.value) fetchUserInfo()
})

function handleSwitchAccount() {
  if (typeof baiduyunStore.resetAccount === 'function') {
    baiduyunStore.resetAccount()
  } else {
    baiduyunStore.clearToken()
    baiduyunStore.setCurrentDir('/')
  }
  userInfo.value = null
  message.success(t('assetLib.baiduyun.userInfo.logoutMessage'))
}
</script>

<style scoped lang="less">
.baiduyun-user-info-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  height: 42px;

  .info-section {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;

    .user-avatar {
      flex-shrink: 0;
      border: 1px solid var(--color-border-subtle);
    }

    .info-content {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;

      .user-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--color-text-primary);
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100px;
      }

      .vip-status {
        display: flex;
        align-items: center;
        margin-top: 2px;

        .vip-tag {
          font-size: 12px;
          padding: 0 4px;
          border-radius: 4px;
          line-height: 14px;
          font-weight: 600;

          &.svip {
            background: var(--color-warning-solid);
            color: var(--color-warning-on-solid);
          }

          &.vip {
            background: var(--color-danger-bg);
            color: var(--color-danger-text);
          }

          &.normal {
            background: var(--color-bg-raised);
            color: var(--color-text-secondary);
          }
        }
      }
    }
  }

  .switch-btn {
    color: var(--color-text-secondary);
  }
}
</style>
