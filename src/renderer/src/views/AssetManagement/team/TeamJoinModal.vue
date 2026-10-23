<template>
  <AppModal
    :open="open"
    :width="420"
    hide-footer
    destroy-on-close
    class="team-join-modal"
    @update:open="(value: boolean) => !value && emit('close')"
  >
    <template #title>
      <div class="join-title">
        <span>{{ t('teamProject.join.title') }}</span>
        <span v-if="projectName" class="join-project">{{ projectName }}</span>
      </div>
    </template>

    <div v-if="noProjectsAccount" class="join-body">
      <p class="join-lead">{{ t('teamProject.join.noProjects') }}</p>
      <div class="join-row">
        <span class="join-muted">{{
          t('teamProject.join.sendAccount', { account: noProjectsAccount })
        }}</span>
        <AppButton size="small" @click="copyAccount">{{
          t('teamProject.join.copyAccount')
        }}</AppButton>
      </div>
    </div>

    <form v-else class="join-body" @submit.prevent="submit">
      <!-- 还不知道要连哪个团队时才有：填一次就记住，下次不再出现 -->
      <label v-if="needsLink" class="field">
        <span>{{ t('teamProject.join.link') }}</span>
        <a-input
          v-model:value="linkText"
          :placeholder="t('teamProject.join.linkPlaceholder')"
          :disabled="busy"
          data-testid="team-join-link"
          @blur="readLink"
        />
      </label>
      <label class="field">
        <span>{{ t('teamProject.join.account') }}</span>
        <a-input
          v-model:value="member"
          autocomplete="username"
          :disabled="busy"
          data-testid="team-join-account"
        />
      </label>
      <label class="field">
        <span>{{ t('teamProject.join.password') }}</span>
        <a-input-password
          v-model:value="password"
          autocomplete="current-password"
          :disabled="busy"
          data-testid="team-join-password"
          @press-enter="submit"
        />
      </label>
      <div v-if="error" class="join-error" role="alert">{{ error }}</div>
      <div class="join-actions">
        <AppButton :disabled="busy" @click="emit('close')">{{ t('teamProject.cancel') }}</AppButton>
        <AppButton
          variant="primary"
          html-type="submit"
          :disabled="!canSubmit"
          data-testid="team-join-submit"
        >
          {{ busy ? t('teamProject.join.signingIn') : t('teamProject.join.signIn') }}
        </AppButton>
      </div>
    </form>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 加入团队（界面方案 4.1 B）。三个来路：
 *
 * - 邀请链接「用虚幻盒子打开」：`link` 已给好，标题下一行灰字写工程名；
 * - 新建资产库弹窗里的「加入团队」卡片：还不知道连哪个团队，多一个「邀请链接」输入框；
 * - 切换器右键「重新登录」：`relogin` 给了服务器，账号已填好，只登录不重新加库。
 *
 * 成功后账号所在的工程和资产库全部进切换器，链接指的那个直接打开 —— 没有「选择工程」这一步。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { teamAPI } from '@renderer/api/team'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import type { TeamJoinLink } from '@core/shared/teamProject'
import type { CatalogServerView } from '@core/shared/catalogLibrary'
import { message } from '@renderer/utils/messageManager'

const props = defineProps<{
  open: boolean
  link?: TeamJoinLink | null
  relogin?: CatalogServerView | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'joined', payload: { keys: string[]; openKey: string | null }): void
  (e: 'signed-in'): void
}>()
const { t } = useI18n()

const linkText = ref('')
const parsedLink = ref<TeamJoinLink | null>(null)
const projectName = ref<string | null>(null)
const member = ref('')
const password = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const noProjectsAccount = ref<string | null>(null)

const needsLink = computed(() => !props.relogin && !props.link)
const canSubmit = computed(
  () =>
    !busy.value &&
    member.value.trim().length > 0 &&
    password.value.length > 0 &&
    (Boolean(props.relogin) || Boolean(props.link) || linkText.value.trim().length > 0)
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    linkText.value = ''
    parsedLink.value = props.link ?? null
    projectName.value = null
    member.value = props.relogin?.member ?? ''
    password.value = ''
    error.value = null
    noProjectsAccount.value = null
    if (props.link) void peek(props.link)
    if (props.relogin) projectName.value = props.relogin.label
  },
  { immediate: true }
)

async function peek(link: TeamJoinLink): Promise<void> {
  const result = await teamAPI.peek(link)
  if (result.success) projectName.value = result.data?.projectName ?? null
}

async function readLink(): Promise<TeamJoinLink | null> {
  const raw = linkText.value.trim()
  if (!raw) return null
  const link = await teamAPI.parseLink(raw).catch(() => null)
  parsedLink.value = link
  if (link) void peek(link)
  return link
}

/** 主进程的错误码 → 4.1 B 的三句话 */
function errorFor(code: string | undefined): string {
  if (code === 'unauthorized' || code === 'signed-out' || code === 'bad-request')
    return t('teamProject.join.errors.credentials')
  if (code === 'forbidden' || code === 'not-allowed') return t('teamProject.join.errors.disabled')
  return t('teamProject.join.errors.unreachable')
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = null
  try {
    if (props.relogin) {
      const result = await catalogLibraryAPI.signIn(props.relogin.id, {
        member: member.value.trim(),
        password: password.value
      })
      if (!result.success) {
        error.value = errorFor(result.errorCode)
        return
      }
      void teamAPI.restartStream(props.relogin.id)
      emit('signed-in')
      emit('close')
      return
    }
    const link = parsedLink.value ?? (await readLink())
    if (!link) {
      error.value = t('teamProject.join.errors.badLink')
      return
    }
    const result = await teamAPI.join({
      server: link.server,
      caFingerprint: link.caFingerprint,
      project: link.project,
      member: member.value.trim(),
      password: password.value
    })
    if (!result.success || !result.data) {
      error.value = errorFor(result.errorCode)
      return
    }
    if (result.data.noProjects) {
      noProjectsAccount.value = result.data.member || member.value.trim()
      return
    }
    emit('joined', { keys: result.data.keys, openKey: result.data.openKey })
    emit('close')
  } finally {
    password.value = ''
    busy.value = false
  }
}

async function copyAccount(): Promise<void> {
  if (!noProjectsAccount.value) return
  await navigator.clipboard.writeText(noProjectsAccount.value).catch(() => undefined)
  message.success(t('teamProject.join.accountCopied'))
}
</script>

<style scoped lang="less">
.join-title {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.join-project {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-weight: normal;
}

.join-body {
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

.join-error {
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}

.join-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.join-lead {
  margin: 0;
  color: var(--color-text-primary);
}

.join-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.join-muted {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}
</style>
