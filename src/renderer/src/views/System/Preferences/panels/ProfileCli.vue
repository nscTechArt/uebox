<script setup lang="ts">
/**
 * 命令行（uebox）面板。
 *
 * ## 为什么单独一个面板，而不是塞进 MCP 那一页
 *
 * MCP 面板的职责是「**外部 MCP 客户端**怎么连我」—— 它发的是地址、令牌和一段
 * 贴进 `.mcp.json` 的配置片段。而 uebox 根本不消费那段片段（它自己去读盒子的
 * 配置文件）。两者是不同的东西。
 *
 * ## 默认不动用户的 PATH
 *
 * 不开也完全可用 —— Agent 配置里填绝对路径本来就是常态。改 PATH 是用户点出来的
 * 动作，再点一下能撤销。写的是**用户级**（HKCU），装包本来就是 per-user、
 * 没有管理员权限。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { cliAPI, type CliStatus } from '@renderer/api/cli'
import { message } from '@renderer/utils/messageManager'
import AppButton from '@renderer/components/AppButton.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const status = ref<CliStatus | null>(null)
const loading = ref(true)
/** 改 PATH 期间锁住开关，避免连点造成两次注册表写入 */
const busy = ref(false)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    status.value = await cliAPI.status()
  } catch (error) {
    message.error(t('profile.cli.statusFailed', { error: (error as Error).message }))
  } finally {
    loading.value = false
  }
}

async function togglePath(next: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = next ? await cliAPI.addToPath() : await cliAPI.removeFromPath()
    status.value = result.status
    if (!result.ok) {
      message.error(result.message ?? t('profile.cli.pathFailed'))
      return
    }
    message.success(next ? t('profile.cli.pathAdded') : t('profile.cli.pathRemoved'))
  } catch (error) {
    message.error(t('profile.cli.pathFailedWith', { error: (error as Error).message }))
  } finally {
    busy.value = false
  }
}

async function copyPath(): Promise<void> {
  if (!status.value?.path) return
  try {
    await navigator.clipboard.writeText(status.value.path)
    message.success(t('profile.cli.copied'))
  } catch {
    message.error(t('profile.cli.copyFailed'))
  }
}

async function reveal(): Promise<void> {
  const result = await cliAPI.reveal()
  if (!result.ok) message.error(result.message ?? t('profile.cli.revealFailed'))
}

onMounted(refresh)
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.cli.section') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.cli.about') }}</div>
            <div class="setting-desc">
              {{
                loading
                  ? $t('profile.cli.loading')
                  : status?.available
                    ? $t('profile.cli.intro')
                    : status?.reason === 'CLI_UNSUPPORTED_PLATFORM'
                      ? $t('profile.cli.unsupportedPlatform')
                      : status?.reason
              }}
            </div>
          </div>
        </div>

        <div v-if="status?.available" class="setting-item setting-item-stack">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.cli.location') }}</div>
            <div class="setting-desc setting-desc-mono">{{ status.path }}</div>
          </div>
          <div class="setting-actions">
            <AppButton variant="soft" @click="copyPath">
              {{ $t('profile.cli.copy') }}
            </AppButton>
            <AppButton variant="soft" @click="reveal">
              {{ $t('profile.cli.reveal') }}
            </AppButton>
          </div>
        </div>
      </div>
    </section>

    <section v-if="status?.available" class="settings-section">
      <h4 class="section-title">{{ $t('profile.cli.integration') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.cli.addToPath') }}</div>
            <div class="setting-desc">{{ $t('profile.cli.addToPathDesc') }}</div>
            <!-- 查不出来时单独说，不让它伪装成「不在 PATH 里」 -->
            <div v-if="status.onPath === null && status.reason" class="setting-desc-warn">
              {{ status.reason }}
            </div>
          </div>
          <AppSwitch
            :checked="status.onPath === true"
            :disabled="busy"
            @update:checked="togglePath"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 这几个类是各设置面板各自 scoped 定义的，没有共享样式表 —— 照 ProfileGeneral
   那份原样抄过来，保证和常规设置、AI 设置一个观感。改的时候三边要一起改。 */
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-item-stack {
  align-items: flex-start;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

.setting-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

/* 路径要能一眼看清，等宽字体比正文好读，也方便和终端里粘的对照 */
.setting-desc-mono {
  font-family: var(--font-family-mono);
  word-break: break-all;
  user-select: text;
}

.setting-desc-warn {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-warning-text);
}
</style>
