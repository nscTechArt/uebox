<template>
  <AppModal
    v-model:open="visible"
    :width="420"
    :mask-closable="false"
    :keyboard="false"
    :closable="false"
    hide-footer
    class="network-auth-modal"
    @cancel="handleCancel"
  >
    <div class="glass-panel">
      <!-- 头部 -->
      <div class="modal-header">
        <div class="header-content">
          <div class="icon-wrapper">
            <PhLock />
          </div>
          <h1 class="modal-title">{{ $t('assetNetworkAuthModal.header.title') }}</h1>
          <p class="modal-subtitle">{{ networkPath }}</p>
        </div>
        <button class="close-btn" @click="handleCancel">
          <PhX />
        </button>
      </div>

      <!-- 表单区域 -->
      <div class="form-content">
        <!-- 用户名 -->
        <div class="form-group">
          <label class="form-label">{{ $t('assetNetworkAuthModal.form.usernameLabel') }}</label>
          <div class="input-wrapper">
            <input
              v-model="formData.username"
              type="text"
              :placeholder="$t('assetNetworkAuthModal.form.usernamePlaceholder')"
              class="glass-input"
              :class="{ 'has-error': errors.username }"
              @input="onInput('username')"
            />
            <PhUser class="input-icon" />
          </div>
          <div v-if="errors.username" class="error-message">{{ errors.username }}</div>
        </div>

        <!-- 密码 -->
        <div class="form-group">
          <label class="form-label">{{ $t('assetNetworkAuthModal.form.passwordLabel') }}</label>
          <div class="input-wrapper">
            <input
              v-model="formData.password"
              :type="showPassword ? 'text' : 'password'"
              :placeholder="$t('assetNetworkAuthModal.form.passwordPlaceholder')"
              class="glass-input"
              :class="{ 'has-error': errors.password }"
              @input="onInput('password')"
              @keyup.enter="handleConnect"
            />
            <button class="toggle-password" @click="showPassword = !showPassword">
              <PhEye v-if="showPassword" />
              <PhEyeSlash v-else />
            </button>
          </div>
          <div v-if="errors.password" class="error-message">{{ errors.password }}</div>
        </div>

        <!-- 记住凭据 -->
        <div class="form-group checkbox-group">
          <AppCheckbox v-model:checked="formData.rememberCredentials" class="checkbox-label">
            <span class="checkbox-text">{{
              $t('assetNetworkAuthModal.form.rememberCredentials')
            }}</span>
          </AppCheckbox>
          <span class="checkbox-hint">{{ $t('assetNetworkAuthModal.form.rememberHint') }}</span>
        </div>

        <!-- 错误提示 -->
        <div v-if="connectionError" class="connection-error">
          <PhXCircle class="error-icon" />
          <span>{{ connectionError }}</span>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="modal-footer">
        <button class="btn-cancel" @click="handleCancel">
          {{ $t('assetNetworkAuthModal.footer.cancel') }}
        </button>
        <button
          class="btn-connect"
          :class="{ disabled: !isFormValid || loading }"
          :disabled="!isFormValid || loading"
          @click="handleConnect"
        >
          <PhCircleNotch v-if="loading" class="icon-spin" />
          <span v-else>{{ $t('assetNetworkAuthModal.footer.connect') }}</span>
        </button>
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
/**
 * NetworkAuthModal - 网络认证对话框
 * 用于输入网络共享的用户名和密码
 */
import { ref, reactive, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhCircleNotch,
  PhEye,
  PhEyeSlash,
  PhLock,
  PhUser,
  PhX,
  PhXCircle
} from '@phosphor-icons/vue'

const { t } = useI18n()

// Props 定义
interface Props {
  open?: boolean
  networkPath: string
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  networkPath: ''
})

// Emits 定义
const emit = defineEmits<{
  'update:open': [value: boolean]
  connected: []
  cancelled: []
}>()

// 响应式数据
const visible = ref(props.open)
const loading = ref(false)
const showPassword = ref(false)
const connectionError = ref('')

// 表单数据
const formData = reactive({
  username: '',
  password: '',
  rememberCredentials: true
})

// 错误信息
const errors = reactive({
  username: '',
  password: ''
})

// 监听 props 变化
watch(
  () => props.open,
  (newVal) => {
    visible.value = newVal
  }
)

watch(visible, (newVal) => {
  emit('update:open', newVal)
  if (!newVal) {
    resetForm()
  }
})

// 表单验证
const isFormValid = computed(() => {
  return formData.username.trim().length > 0 && formData.password.length > 0
})

/**
 * 输入时清除错误
 */
const onInput = (field: 'username' | 'password'): void => {
  errors[field] = ''
  connectionError.value = ''
}

/**
 * 验证表单
 */
const validate = (): boolean => {
  let valid = true

  if (!formData.username.trim()) {
    errors.username = t('assetNetworkAuthModal.errors.usernameRequired')
    valid = false
  }

  if (!formData.password) {
    errors.password = t('assetNetworkAuthModal.errors.passwordRequired')
    valid = false
  }

  return valid
}

/**
 * 连接网络共享
 */
const handleConnect = async (): Promise<void> => {
  if (!validate()) return

  loading.value = true
  connectionError.value = ''

  try {
    // 解析用户名（支持 domain\user 格式）
    let username = formData.username.trim()
    let domain: string | undefined

    if (username.includes('\\')) {
      const parts = username.split('\\')
      domain = parts[0]
      username = parts[1]
    }

    // 调用主进程连接
    const result = await window.api.invoke('networkVault:connect', props.networkPath, {
      username,
      password: formData.password,
      domain
    })

    if (result.success) {
      // 保存凭据
      if (formData.rememberCredentials) {
        await window.api.invoke('networkVault:saveCredentials', props.networkPath, {
          username: formData.username.trim(),
          password: formData.password,
          domain
        })
      }

      emit('connected')
      visible.value = false
    } else {
      connectionError.value = result.error || t('assetNetworkAuthModal.errors.connectionFailed')
    }
  } catch (error) {
    connectionError.value =
      error instanceof Error ? error.message : t('assetNetworkAuthModal.errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

/**
 * 取消
 */
const handleCancel = (): void => {
  emit('cancelled')
  visible.value = false
}

/**
 * 重置表单
 */
const resetForm = (): void => {
  formData.username = ''
  formData.password = ''
  formData.rememberCredentials = true
  errors.username = ''
  errors.password = ''
  connectionError.value = ''
  showPassword.value = false
}
</script>

<style lang="less">
.network-auth-modal {
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
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 24px 24px 16px 24px;
  border-bottom: 1px solid var(--color-border-subtle);

  .header-content {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--color-warning-solid);
      color: var(--color-warning-on-solid);
      font-size: 18px;
      margin-bottom: 4px;
    }
  }

  .modal-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0;
  }

  .modal-subtitle {
    font-size: 12px;
    color: var(--color-text-muted);
    margin: 0;
    font-family: 'Consolas', 'Monaco', monospace;
    word-break: break-all;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: var(--color-bg-surface-hover);
    border-radius: 8px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.2s ease;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }
}

.form-content {
  padding: 20px 24px;
}

.form-group {
  margin-bottom: 16px;

  &:last-child {
    margin-bottom: 0;
  }
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}

.input-wrapper {
  position: relative;

  .glass-input {
    width: 100%;
    padding: 12px 40px 12px 14px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 10px;
    font-size: 14px;
    color: var(--color-text-primary);
    outline: none;
    transition: all 0.2s ease;

    &::placeholder {
      color: var(--color-text-muted);
    }

    &:focus {
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
    font-size: 14px;
  }

  .toggle-password {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: color 0.2s ease;

    &:hover {
      color: var(--color-text-secondary);
    }
  }
}

.error-message {
  font-size: 12px;
  color: var(--color-danger-text);
  margin-top: 6px;
}

.checkbox-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.checkbox-label {
  align-items: center;

  .checkbox-text {
    font-size: 13px;
    color: var(--color-text-secondary);
  }
}

.checkbox-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.connection-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger-border);
  border-radius: 8px;
  margin-top: 16px;

  .error-icon {
    color: var(--color-danger-text);
    font-size: 14px;
  }

  span {
    font-size: 13px;
    color: var(--color-danger-text);
  }
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px 20px 24px;
  border-top: 1px solid var(--color-border-subtle);
}

.btn-cancel {
  padding: 10px 20px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
  }
}

.btn-connect {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 24px;
  min-width: 80px;
  background: var(--color-warning-solid);
  border: none;
  border-radius: 10px;
  color: var(--color-warning-on-solid);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 4px 12px -2px var(--color-warning-border);

  &:hover:not(.disabled) {
    background: var(--color-warning-solid);
    transform: translateY(-1px);
  }

  &.disabled {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-secondary);
    cursor: not-allowed;
    box-shadow: none;
  }
}
</style>
