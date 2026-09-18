<template>
  <div class="webdav-auth-form">
    <div class="form-container">
      <AppCard class="auth-card">
        <a-form :model="formState" layout="vertical" class="form-content" @finish="handleConnect">
          <a-form-item :label="$t('webdavAuthForm.serverUrl.label')" required>
            <a-input
              v-model:value="formState.serverUrl"
              placeholder="https://example.com/webdav"
              :disabled="loading"
            >
              <template #prefix>
                <PhGlobe />
              </template>
            </a-input>
          </a-form-item>

          <a-form-item :label="$t('webdavAuthForm.username.label')" required>
            <a-input
              v-model:value="formState.username"
              :placeholder="$t('webdavAuthForm.username.placeholder')"
              :disabled="loading"
            >
              <template #prefix>
                <PhUser />
              </template>
            </a-input>
          </a-form-item>

          <a-form-item :label="$t('webdavAuthForm.password.label')" required>
            <a-input-password
              v-model:value="formState.password"
              :placeholder="$t('webdavAuthForm.password.placeholder')"
              :disabled="loading"
            >
              <template #prefix>
                <PhLock />
              </template>
            </a-input-password>
          </a-form-item>

          <a-form-item>
            <AppButton variant="primary" html-type="submit" block :loading="loading">
              {{
                loading
                  ? $t('webdavAuthForm.connectButton.connecting')
                  : $t('webdavAuthForm.connectButton.connect')
              }}
            </AppButton>
          </a-form-item>
        </a-form>
      </AppCard>

      <!-- 历史记录列表 -->
      <div v-if="webdavStore.history.length > 0" class="history-section">
        <div class="section-header">
          <span class="title">{{ $t('webdavAuthForm.history.title') }}</span>
          <AppButton variant="text" size="small" danger @click="webdavStore.clearHistory">
            {{ $t('webdavAuthForm.history.clear') }}
          </AppButton>
        </div>
        <div class="history-list">
          <div
            v-for="item in webdavStore.history"
            :key="item.serverUrl + item.username"
            class="history-card"
            @click="handleConnectFromHistory(item)"
          >
            <div class="history-info">
              <div class="server">{{ item.serverUrl }}</div>
              <div class="user">{{ item.username }}</div>
            </div>
            <div class="actions">
              <AppButton
                variant="text"
                size="small"
                class="delete-btn"
                @click.stop="webdavStore.removeHistory(item)"
              >
                <template #icon>
                  <PhTrash />
                </template>
              </AppButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppCard from '@renderer/components/AppCard.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { PhGlobe, PhLock, PhTrash, PhUser } from '@phosphor-icons/vue'
import { useWebdavStore } from '@renderer/store/modules/webdav'

const { t } = useI18n()
const webdavStore = useWebdavStore()

/**
 * 表单数据
 */
const formState = reactive({
  serverUrl: '',
  username: '',
  password: ''
})

const loading = ref(false)

/**
 * 从历史记录连接
 */
const handleConnectFromHistory = async (item: any) => {
  formState.serverUrl = item.serverUrl
  formState.username = item.username
  formState.password = item.password
  await handleConnect()
}

/**
 * 处理连接
 */
const handleConnect = async () => {
  if (!formState.serverUrl.trim()) {
    message.error(t('webdavAuthForm.validation.serverUrlRequired'))
    return
  }
  if (!formState.username.trim()) {
    message.error(t('webdavAuthForm.validation.usernameRequired'))
    return
  }
  if (!formState.password.trim()) {
    message.error(t('webdavAuthForm.validation.passwordRequired'))
    return
  }

  loading.value = true
  try {
    // 调用主进程的 WebDAV 连接测试
    const result = await (window as any).api.webdav.testConnection({
      serverUrl: formState.serverUrl.trim(),
      username: formState.username.trim(),
      password: formState.password.trim()
    })

    if (result.success) {
      // 保存连接信息到 store (会自动添加到历史记录)
      webdavStore.setConnection({
        serverUrl: formState.serverUrl.trim(),
        username: formState.username.trim(),
        password: formState.password.trim()
      })
      message.success(t('webdavAuthForm.messages.connectSuccess'))
    } else {
      message.error(result.error || t('webdavAuthForm.messages.connectFailed'))
    }
  } catch (error) {
    console.error('WebDAV 连接失败:', error)
    message.error(t('webdavAuthForm.messages.connectFailedNetwork'))
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="less">
.webdav-auth-form {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 48px 24px;
  height: 100%;
  overflow-y: auto;
  background:
    radial-gradient(
      circle at 50% 0%,
      color-mix(in oklab, var(--color-accent-solid) 15%, transparent),
      transparent 70%
    ),
    var(--color-bg-page);

  .form-container {
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .auth-card {
    width: 100%;
    background: var(--color-bg-surface-hover);
    backdrop-filter: blur(20px) saturate(120%);
    -webkit-backdrop-filter: blur(20px) saturate(120%);
    border-radius: 12px;
    box-shadow:
      0 8px 32px var(--shadow-color-weak),
      0 1px 0 var(--shadow-highlight) inset,
      0 0 0 1px var(--shadow-highlight);
    border: none;
    position: relative;
    overflow: hidden;

    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--color-border), transparent);
    }

    :deep(.app-card__body) {
      padding: 36px 40px;
    }
  }

  .form-content {
    width: 100%;

    :deep(.ant-form-item-label > label) {
      color: var(--color-text-primary);
      font-size: 13px;
      font-weight: 500;
    }

    :deep(.ant-form-item-required::before) {
      color: var(--color-accent-text);
    }

    :deep(.ant-input-affix-wrapper),
    :deep(.ant-input-password) {
      height: 40px;
      border-radius: 6px;
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      transition: all 0.25s ease;

      &:hover {
        border-color: var(--color-border);
        background: var(--color-bg-surface-hover);
      }

      &:focus-within {
        border-color: var(--color-accent-border);
        box-shadow: 0 0 0 2px var(--color-accent-border);
        background: var(--color-bg-surface-hover);
      }
    }

    :deep(.ant-input) {
      background: transparent;
      color: var(--color-text-primary);
      font-size: 13px;

      &::placeholder {
        color: var(--color-text-disabled);
      }
    }

    :deep(.app-button--primary) {
      height: 40px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      background: var(--gradient-accent);
      border: none;
      box-shadow:
        0 2px 8px var(--color-accent-border),
        0 1px 0 var(--shadow-highlight) inset;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);

      &:hover {
        transform: translateY(-1px);
        box-shadow:
          0 4px 16px var(--color-accent-border),
          0 1px 0 var(--shadow-highlight) inset;
      }
    }
  }

  .history-section {
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding: 0 4px;

      .title {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-text-primary);
        letter-spacing: 0.3px;
      }

      :deep(.app-button--text) {
        font-size: 12px;
        color: var(--color-text-primary);

        &:hover {
          color: var(--color-danger-text);
        }
      }
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: 8px;

      .history-card {
        background: var(--color-bg-surface-hover);
        backdrop-filter: blur(12px);
        border: 1px solid var(--color-border-subtle);
        border-radius: 8px;
        padding: 12px 14px;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        justify-content: space-between;
        align-items: center;

        &:hover {
          background: var(--color-accent-bg);
          border-color: var(--color-accent-border);
          transform: translateY(-1px);
        }

        .history-info {
          flex: 1;
          overflow: hidden;
          margin-right: 10px;

          .server {
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-primary);
            margin-bottom: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .user {
            font-size: 11px;
            color: var(--color-text-primary);
          }
        }

        .actions {
          .delete-btn {
            color: var(--color-text-muted);
            opacity: 0;
            transition: all 0.2s;

            &:hover {
              color: var(--color-danger-text);
              background: var(--color-danger-bg);
            }
          }
        }

        &:hover .actions .delete-btn {
          opacity: 1;
        }
      }
    }
  }
}
</style>
