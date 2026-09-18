<template>
  <div class="baiduyun-auth-form">
    <div class="form-container">
      <!-- 标题区域 -->
      <div class="header-section">
        <h1 class="main-title">{{ t('assetLib.baiduyun.auth.title') }}</h1>
        <p class="main-desc">{{ t('assetLib.baiduyun.auth.description') }}</p>
      </div>

      <!-- 步骤区域 -->
      <div class="steps-container">
        <!-- 准备：配置百度开放平台应用 -->
        <div class="step-item">
          <div class="step-indicator">
            <div class="step-dot" :class="{ active: baiduyunStore.hasAppConfig }" />
            <div class="step-line" />
          </div>
          <div class="step-content">
            <h3 class="step-title">{{ t('assetLib.baiduyun.auth.appSetup.title') }}</h3>
            <p class="step-desc">{{ t('assetLib.baiduyun.auth.appSetup.desc') }}</p>
            <AppButton class="auth-link-btn" block @click="handleOpenConsole">
              {{ t('assetLib.baiduyun.auth.appSetup.consoleBtn') }}
              <template #icon>
                <PhExport />
              </template>
            </AppButton>
            <a-input
              v-model:value="localClientId"
              :placeholder="t('assetLib.baiduyun.auth.appSetup.clientIdPlaceholder')"
              allow-clear
              class="code-input"
            />
            <a-input-password
              v-model:value="localClientSecret"
              :placeholder="t('assetLib.baiduyun.auth.appSetup.clientSecretPlaceholder')"
              allow-clear
              class="code-input"
            />
            <AppButton block class="submit-btn" @click="handleSaveAppConfig">
              {{ t('assetLib.baiduyun.auth.appSetup.saveBtn') }}
            </AppButton>
          </div>
        </div>

        <!-- 第一步：获取授权码 -->
        <div class="step-item">
          <div class="step-indicator">
            <div class="step-dot active" />
            <div class="step-line" />
          </div>
          <div class="step-content">
            <h3 class="step-title">{{ t('assetLib.baiduyun.auth.step1.title') }}</h3>
            <p class="step-desc">
              {{ t('assetLib.baiduyun.auth.step1.desc') }}
            </p>
            <AppButton class="auth-link-btn" block @click="handleOpenAuth">
              {{ t('assetLib.baiduyun.auth.step1.btn') }}
              <template #icon>
                <PhExport />
              </template>
            </AppButton>
          </div>
        </div>

        <!-- 第二步：验证授权 -->
        <div class="step-item">
          <div class="step-indicator">
            <div class="step-dot" :class="{ active: localCode.trim() }" />
          </div>
          <div class="step-content">
            <h3 class="step-title">{{ t('assetLib.baiduyun.auth.step2.title') }}</h3>
            <p class="step-desc">{{ t('assetLib.baiduyun.auth.step2.desc') }}</p>
            <a-input
              v-model:value="localCode"
              :placeholder="t('assetLib.baiduyun.auth.step2.placeholder')"
              allow-clear
              class="code-input"
              @press-enter="handleSubmit"
            />
            <AppButton variant="primary" block class="submit-btn" @click="handleSubmit">
              {{ t('assetLib.baiduyun.auth.step2.btn') }}
            </AppButton>
          </div>
        </div>
      </div>

      <!-- 安全提示 -->
      <div class="security-tip">
        <PhShieldCheck class="tip-icon" />
        <span>{{ t('assetLib.baiduyun.auth.securityTip') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhExport, PhShieldCheck } from '@phosphor-icons/vue'
import { message } from '@/utils/messageManager'
import { request } from '@renderer/common/http/index'
import { useBaiduyunStore, type BaiduOAuthTokenResponse } from '@renderer/store/modules/baiduyun'

const { t } = useI18n()
const localCode = ref('')
const baiduyunStore = useBaiduyunStore()

const localClientId = ref(baiduyunStore.appConfig.clientId)
const localClientSecret = ref(baiduyunStore.appConfig.clientSecret)

// 百度开放平台控制台：用户在这里自建应用，拿到自己的 AppKey / SecretKey
const baiduConsoleUrl = 'https://pan.baidu.com/union/main/application'

const baiduAuthUrl = computed(
  () =>
    `https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=${encodeURIComponent(
      baiduyunStore.appConfig.clientId
    )}&redirect_uri=oob&scope=basic,netdisk`
)

/**
 * 打开百度开放平台控制台
 */
function handleOpenConsole(): void {
  window.open(baiduConsoleUrl, '_blank')
}

/**
 * 保存用户自建应用的凭据
 */
function handleSaveAppConfig(): void {
  const clientId = localClientId.value.trim()
  const clientSecret = localClientSecret.value.trim()
  if (!clientId || !clientSecret) {
    message.error(t('assetLib.baiduyun.auth.error.emptyAppConfig'))
    return
  }
  baiduyunStore.setAppConfig({ clientId, clientSecret })
  message.success(t('assetLib.baiduyun.auth.appSetup.saved'))
}

/**
 * 打开百度授权页面
 */
function handleOpenAuth(): void {
  if (!baiduyunStore.hasAppConfig) {
    message.error(t('assetLib.baiduyun.auth.error.emptyAppConfig'))
    return
  }
  window.open(baiduAuthUrl.value, '_blank')
}

/**
 * 提交授权码
 */
function handleSubmit(): void {
  if (!baiduyunStore.hasAppConfig) {
    message.error(t('assetLib.baiduyun.auth.error.emptyAppConfig'))
    return
  }
  const code = localCode.value.trim()
  if (!code) {
    message.error(t('assetLib.baiduyun.auth.error.emptyCode'))
    return
  }
  const { clientId, clientSecret } = baiduyunStore.appConfig
  const url = `https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=${encodeURIComponent(
    code
  )}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(
    clientSecret
  )}&redirect_uri=oob`
  request
    .get<BaiduOAuthTokenResponse>(url)
    .then((res) => {
      // 处理可能包含 data 字段的响应
      const token =
        (res as unknown as Record<string, unknown>)?.data ?? (res as BaiduOAuthTokenResponse)
      baiduyunStore.setToken(token as BaiduOAuthTokenResponse)
      message.success(t('assetLib.baiduyun.auth.success'))
      localCode.value = ''
    })
    .catch((err) => {
      console.error('授权失败', err)
      message.error(t('assetLib.baiduyun.auth.error.failed'))
    })
}
</script>

<style scoped lang="less">
.baiduyun-auth-form {
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
    background: var(--color-bg-surface-hover);
    backdrop-filter: blur(20px) saturate(120%);
    -webkit-backdrop-filter: blur(20px) saturate(120%);
    border-radius: 12px;
    padding: 36px 40px;
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
  }

  .header-section {
    text-align: center;
    margin-bottom: 28px;

    .main-title {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 500;
      letter-spacing: 0.5px;
      background: var(--gradient-accent);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .main-desc {
      margin: 0;
      font-size: 14px;
      color: var(--color-text-primary);
    }
  }

  .steps-container {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .step-item {
    display: flex;
    gap: 20px;

    .step-indicator {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 4px;

      .step-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--color-bg-surface-hover);
        border: 1.5px solid var(--color-border);
        box-shadow: 0 0 0 3px var(--shadow-color-weak);
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        flex-shrink: 0;
        z-index: 2;

        &.active {
          background: var(--color-accent-solid);
          border-color: var(--color-accent-border);
          box-shadow: 0 0 0 3px var(--color-accent-border);
        }
      }

      .step-line {
        width: 2px;
        flex: 1;
        min-height: 100px;
        background: linear-gradient(to bottom, var(--color-accent-solid) 0%, transparent 100%);
        margin: 4px 0;
        border-radius: 1px;
      }
    }

    .step-content {
      flex: 1;
      padding-bottom: 24px;

      .step-title {
        margin: 0 0 6px;
        font-size: 14px;
        font-weight: 500;
        color: var(--color-text-primary);
        letter-spacing: 0.3px;
      }

      .step-desc {
        margin: 0 0 14px;
        font-size: 13px;
        color: var(--color-text-primary);
        line-height: 1.5;
      }
    }
  }

  .auth-link-btn {
    height: 40px;
    border-radius: 6px;
    font-size: 13px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    color: var(--color-accent-text);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(4px);

    &:hover {
      background: var(--color-accent-bg);
      border-color: var(--color-accent-border);
      color: var(--color-accent-text);
      text-shadow: 0 0 12px var(--color-accent-border);
      transform: translateY(-1px);
    }

    :deep(svg) {
      font-size: 14px;
    }
  }

  .code-input {
    height: 40px;
    border-radius: 6px;
    margin-bottom: 12px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    transition: all 0.25s ease;

    &:hover {
      border-color: var(--color-border);
      background: var(--color-bg-surface-hover);
    }

    :deep(.ant-input) {
      font-size: 14px;
      background: transparent;
      color: var(--color-text-primary);

      &::placeholder {
        color: var(--color-text-disabled);
      }
    }

    &:focus-within {
      border-color: var(--color-accent-border);
      box-shadow: 0 0 0 2px var(--color-accent-border);
      background: var(--color-bg-surface-hover);
    }
  }

  .submit-btn {
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
    position: relative;
    overflow: hidden;

    &::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      // 白色高光只在深色主题成立，浅色下这个 token 是全透明的
      background: linear-gradient(var(--shadow-highlight), transparent);
      opacity: 0;
      transition: opacity 0.3s;
    }

    &:hover {
      transform: translateY(-2px);
      box-shadow:
        0 8px 24px var(--color-accent-border),
        0 1px 0 var(--shadow-highlight) inset;

      &::after {
        opacity: 1;
      }
    }

    &:active {
      transform: translateY(0);
      box-shadow: 0 4px 12px var(--color-accent-border);
    }
  }

  .security-tip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding-top: 24px;
    font-size: 13px;
    color: var(--color-text-muted);

    .tip-icon {
      font-size: 14px;
    }
  }
}
</style>
