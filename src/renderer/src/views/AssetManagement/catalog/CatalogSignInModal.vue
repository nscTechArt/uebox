<template>
  <AppModal
    :open="open"
    :title="t('catalogLibrary.signIn.title', { server: server?.label ?? '' })"
    :width="440"
    :ok-text="t('catalogLibrary.add.signIn')"
    :confirm-loading="busy"
    :ok-disabled="!canSubmit"
    destroy-on-close
    @ok="submit"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <div class="sign-in">
      <template v-if="server?.authMode === 'token'">
        <label class="field">
          <span>{{ t('catalogLibrary.add.token') }}</span>
          <a-textarea
            v-model:value="identityToken"
            :auto-size="{ minRows: 2, maxRows: 4 }"
            :placeholder="t('catalogLibrary.add.tokenPlaceholder')"
          />
        </label>
      </template>
      <template v-else>
        <label class="field">
          <span>{{ t('catalogLibrary.add.member') }}</span>
          <a-input v-model:value="member" autocomplete="username" />
        </label>
        <label class="field">
          <span>{{ t('catalogLibrary.add.password') }}</span>
          <a-input-password
            v-model:value="password"
            autocomplete="current-password"
            @press-enter="submit"
          />
        </label>
      </template>
      <AppAlert v-if="error" type="error" :message="error" show-icon />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/** 会话过期、令牌过期、被吊销时重新登录（刷新令牌只存在主进程的加密文件里） */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppAlert from '@renderer/components/AppAlert.vue'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type { CatalogServerView } from '@core/shared/catalogLibrary'
import { catalogErrorText } from './catalogErrors'

const props = defineProps<{ open: boolean; server: CatalogServerView | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'signed-in'): void }>()
const { t } = useI18n()

const member = ref('')
const password = ref('')
const identityToken = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    member.value = props.server?.member ?? ''
    password.value = ''
    identityToken.value = ''
    error.value = null
  }
)

const canSubmit = computed(() =>
  props.server?.authMode === 'token'
    ? identityToken.value.trim().length > 0
    : member.value.trim().length > 0 && password.value.length > 0
)

async function submit(): Promise<void> {
  if (!props.server || !canSubmit.value) return
  busy.value = true
  error.value = null
  try {
    const result = await catalogLibraryAPI.signIn(props.server.id, {
      member: member.value.trim() || null,
      password: password.value || null,
      identityToken: identityToken.value.trim() || null
    })
    password.value = ''
    if (!result.success) {
      error.value = catalogErrorText(t, result.errorCode, result.error)
      return
    }
    emit('signed-in')
    emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped lang="less">
.sign-in {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  > span {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
}
</style>
