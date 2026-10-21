<script setup lang="ts">
/**
 * 把自己的一个技能发布到官网共享库，作者是连接的 UEBox 账户。
 *
 * 打开时主进程先打包一遍，列出会提交哪些文件、哪些不符合要求被跳过，并告诉界面连没连账户。
 * 没连就先连：浏览器打开 uebox.ai/connect，用户点「允许」后回到这里继续。
 * 提交时主进程按盘上的文件重新打包，不用这里显示的内容。
 */
import { onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { shareAPI } from '@renderer/api/share'
import { message } from '@renderer/utils/messageManager'
import type { SharedSkillPack, SharedSkillSubmitResult } from '@core/shared/share'

const props = defineProps<{ name: string }>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()

const pack = ref<SharedSkillPack | null>(null)
const loadError = ref('')
const connecting = ref(false)
const connectCode = ref('')
const submitting = ref(false)
const done = ref<SharedSkillSubmitResult | null>(null)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

watch(open, async (value) => {
  if (!value) {
    if (connecting.value) shareAPI.cancelConnect()
    return
  }
  pack.value = null
  loadError.value = ''
  done.value = null
  connectCode.value = ''
  try {
    pack.value = await shareAPI.packSkill(props.name)
  } catch (error) {
    loadError.value = errorText(error)
  }
})

const offPrompt = shareAPI.onConnectPrompt((prompt) => {
  connectCode.value = prompt.userCode
})
onUnmounted(offPrompt)

async function connect(): Promise<void> {
  connecting.value = true
  try {
    const { account } = await shareAPI.connect()
    if (pack.value) pack.value = { ...pack.value, account }
  } catch (error) {
    // 用户关掉弹窗会取消授权，那不算失败
    if (open.value)
      message.error(t('profile.skills.shareConnectFailed', { reason: errorText(error) }))
  } finally {
    connecting.value = false
    connectCode.value = ''
  }
}

async function submit(): Promise<void> {
  submitting.value = true
  try {
    done.value = await shareAPI.submitSkill(props.name)
  } catch (error) {
    message.error(t('profile.skills.shareFailed', { reason: errorText(error) }))
    // 账户连接失效时主进程已经把 Key 丢了，重新读一遍让界面回到「连接账户」
    pack.value = await shareAPI.packSkill(props.name).catch(() => pack.value)
  } finally {
    submitting.value = false
  }
}

function openPage(): void {
  if (done.value?.url) void shareAPI.openPage(done.value.url).catch(() => undefined)
}
</script>

<template>
  <AppModal
    v-model:open="open"
    :title="t('profile.skills.shareTitle', { name })"
    :width="560"
    destroy-on-close
  >
    <p v-if="loadError" class="note error">
      {{ $t('profile.skills.shareLoadFailed', { reason: loadError }) }}
    </p>

    <template v-else-if="done">
      <p class="done-title">
        {{
          done.status === 'pending'
            ? $t('profile.skills.sharePending')
            : $t('profile.skills.sharePublished', { version: done.version })
        }}
      </p>
    </template>

    <template v-else-if="pack">
      <p class="note">{{ $t('profile.skills.shareNote') }}</p>

      <div class="field">
        <span class="label">{{ $t('profile.skills.shareFiles') }}</span>
        <ul class="files">
          <li v-for="file in pack.files" :key="file.path">{{ file.path }}</li>
        </ul>
        <p v-if="pack.skipped.length" class="note warn">
          {{ $t('profile.skills.shareSkipped', { list: pack.skipped.join('、') }) }}
        </p>
      </div>

      <div class="field">
        <span class="label">{{ $t('profile.skills.shareAccount') }}</span>
        <p v-if="pack.account" class="note">
          {{ $t('profile.skills.shareAsAccount', { account: pack.account }) }}
        </p>
        <template v-else>
          <p class="note">{{ $t('profile.skills.shareNeedAccount') }}</p>
          <p v-if="connectCode" class="note">
            {{ $t('profile.skills.shareConnectCode') }}
            <span class="code">{{ connectCode }}</span>
          </p>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="footer">
        <template v-if="done">
          <AppButton v-if="done.status === 'published'" @click="openPage">
            {{ $t('profile.skills.shareView') }}
          </AppButton>
          <AppButton variant="primary" @click="open = false">{{ $t('common.close') }}</AppButton>
        </template>
        <template v-else>
          <AppButton @click="open = false">{{ $t('common.cancel') }}</AppButton>
          <AppButton
            v-if="pack && !pack.account"
            variant="primary"
            :loading="connecting"
            @click="connect"
          >
            {{ $t('profile.skills.shareConnect') }}
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            :disabled="!pack"
            :loading="submitting"
            @click="submit"
          >
            {{ $t('profile.skills.shareSubmit') }}
          </AppButton>
        </template>
      </div>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.warn {
  color: var(--color-warning-text);
}

.error {
  color: var(--color-danger-text);
}

.done-title {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  line-height: 1.6;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-4);
}

.label {
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.files {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  list-style: none;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.8;
}

.code {
  margin-left: var(--space-1);
  font-family: var(--font-family-mono);
  color: var(--color-text-primary);
  letter-spacing: 0.08em;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
</style>
