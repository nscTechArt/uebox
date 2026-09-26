<template>
  <div class="add-catalog">
    <!-- 第一步：地址 + 信任 -->
    <section v-if="step === 'address'" class="add-step">
      <p class="add-lead">{{ t('catalogLibrary.add.addressLead') }}</p>
      <label class="add-field">
        <span>{{ t('catalogLibrary.add.address') }}</span>
        <a-input
          v-model:value="address"
          :placeholder="t('catalogLibrary.add.addressPlaceholder')"
          @press-enter="probe"
        />
      </label>
      <label class="add-field">
        <span>{{ t('catalogLibrary.add.fingerprint') }}</span>
        <a-input
          v-model:value="fingerprint"
          :placeholder="t('catalogLibrary.add.fingerprintPlaceholder')"
        />
      </label>
      <div class="add-row">
        <AppButton size="small" @click="pickCa">
          <template #icon><PhShieldCheck /></template>
          {{ caPem ? t('catalogLibrary.add.caLoaded') : t('catalogLibrary.add.caFile') }}
        </AppButton>
        <span class="add-hint">{{ t('catalogLibrary.add.trustHint') }}</span>
      </div>
      <AppAlert v-if="probeError" type="error" :message="probeError" show-icon />
      <footer class="add-footer">
        <AppButton @click="close">{{ t('common.cancel') }}</AppButton>
        <AppButton variant="primary" :loading="busy" :disabled="!address.trim()" @click="probe">
          {{ t('catalogLibrary.add.next') }}
        </AppButton>
      </footer>
    </section>

    <!-- 第二步：登录 -->
    <section v-else-if="step === 'auth'" class="add-step">
      <div class="add-trust">
        <PhShieldCheck class="trust-icon" />
        <div>
          <div class="trust-line">{{ trustSummary }}</div>
          <div v-if="probeResult?.pinnedFingerprint" class="add-hint mono">
            {{ shortFingerprint(probeResult.pinnedFingerprint) }}
          </div>
        </div>
      </div>
      <AppSegmented
        v-if="probeResult?.kind === 'member'"
        v-model="authMode"
        :options="authModes"
        :aria-label="t('catalogLibrary.add.authMode')"
      >
        <template #default="{ option }">{{ t(`catalogLibrary.add.mode.${option}`) }}</template>
      </AppSegmented>

      <template v-if="authMode === 'password'">
        <label class="add-field">
          <span>{{ t('catalogLibrary.add.member') }}</span>
          <a-input v-model:value="member" autocomplete="username" />
        </label>
        <label class="add-field">
          <span>{{ t('catalogLibrary.add.password') }}</span>
          <a-input-password
            v-model:value="password"
            autocomplete="current-password"
            @press-enter="connect"
          />
        </label>
      </template>
      <template v-else-if="authMode === 'invite'">
        <label class="add-field">
          <span>{{ t('catalogLibrary.add.inviteCode') }}</span>
          <a-input v-model:value="inviteCode" />
        </label>
        <label class="add-field">
          <span>{{ t('catalogLibrary.add.newPassword') }}</span>
          <a-input-password
            v-model:value="password"
            autocomplete="new-password"
            @press-enter="connect"
          />
        </label>
      </template>
      <template v-else>
        <label class="add-field">
          <span>{{ t('catalogLibrary.add.token') }}</span>
          <a-textarea
            v-model:value="identityToken"
            :auto-size="{ minRows: 2, maxRows: 4 }"
            :placeholder="t('catalogLibrary.add.tokenPlaceholder')"
          />
        </label>
        <p class="add-hint">{{ t('catalogLibrary.add.tokenHint') }}</p>
      </template>

      <label v-if="!probeResult?.wellKnown?.lore?.remote" class="add-field">
        <span>{{ t('catalogLibrary.add.loreRemote') }}</span>
        <a-input v-model:value="loreRemote" placeholder="lores://host:8441" />
      </label>

      <AppAlert v-if="connectError" type="error" :message="connectError" show-icon />
      <footer class="add-footer">
        <AppButton @click="step = 'address'">{{ t('catalogLibrary.add.back') }}</AppButton>
        <AppButton variant="primary" :loading="busy" :disabled="!canConnect" @click="connect">
          {{ t('catalogLibrary.add.signIn') }}
        </AppButton>
      </footer>
    </section>

    <!-- 第三步：选库 -->
    <section v-else class="add-step">
      <p class="add-lead">
        {{
          connected?.server.member
            ? t('catalogLibrary.add.chooseLead', { member: connected.server.member })
            : t('catalogLibrary.add.chooseLeadAnonymous')
        }}
      </p>
      <AppEmpty
        v-if="remoteLibraries.length === 0"
        :description="t('catalogLibrary.add.noLibraries')"
      />
      <ul v-else class="add-libraries">
        <li v-for="library in remoteLibraries" :key="library.id">
          <AppCheckbox
            :checked="chosen.has(library.id)"
            @update:checked="(value: boolean) => toggleChoice(library.id, value)"
          >
            <span class="library-name">{{ library.name || library.id }}</span>
            <span class="add-hint">
              {{
                t('catalogLibrary.add.libraryCounts', {
                  assets: formatCount(library.counts?.assets ?? 0),
                  state: library.state
                })
              }}
            </span>
          </AppCheckbox>
        </li>
      </ul>
      <AppAlert v-if="connectError" type="error" :message="connectError" show-icon />
      <footer class="add-footer">
        <AppButton @click="close">{{ t('common.cancel') }}</AppButton>
        <AppButton
          variant="primary"
          :loading="busy"
          :disabled="chosen.size === 0"
          @click="addChosen"
        >
          {{ t('catalogLibrary.add.addLibraries', { count: chosen.size }) }}
        </AppButton>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 添加服务端资产库：地址（或邀请链接）→ 信任 → 登录 → 选库。
 *
 * 信任：只按带外给的指纹（邀请链接里的、管理员给的 CA 文件）由程序比对后固定部署 CA；
 * 没有这两样时只接受系统信任库本来就认的证书。不做"弹个指纹让你点确认"——
 * 理由见 src/main/libraryV3/tlsTrust.ts。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhShieldCheck } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppAlert from '@renderer/components/AppAlert.vue'
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppSegmented from '@renderer/components/AppSegmented.vue'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import {
  parseInvite,
  type CatalogConnectResult,
  type CatalogProbeResult,
  type CatalogRemoteLibrary
} from '@core/shared/catalogLibrary'
import { shortFingerprint } from './catalogDisplay'
import { catalogErrorText } from './catalogErrors'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'added', keys: string[]): void
}>()

const { t, locale } = useI18n()

type Step = 'address' | 'auth' | 'libraries'
const authModes = ['password', 'invite', 'token'] as const
type AuthChoice = (typeof authModes)[number]

const step = ref<Step>('address')
const address = ref('')
const fingerprint = ref('')
const caPem = ref<string | null>(null)
const probeResult = ref<CatalogProbeResult | null>(null)
const probeError = ref<string | null>(null)
const authMode = ref<AuthChoice>('password')
const member = ref('')
const password = ref('')
const inviteCode = ref('')
const identityToken = ref('')
const loreRemote = ref('')
const connectError = ref<string | null>(null)
const connected = ref<CatalogConnectResult | null>(null)
const remoteLibraries = ref<CatalogRemoteLibrary[]>([])
const chosen = reactive(new Set<string>())
const busy = ref(false)

function reset(): void {
  step.value = 'address'
  address.value = ''
  fingerprint.value = ''
  caPem.value = null
  probeResult.value = null
  probeError.value = null
  authMode.value = 'password'
  member.value = ''
  password.value = ''
  inviteCode.value = ''
  identityToken.value = ''
  loreRemote.value = ''
  connectError.value = null
  connected.value = null
  remoteLibraries.value = []
  chosen.clear()
}

onMounted(reset)

// 贴进来的是邀请链接：拆出地址、指纹、邀请码
watch(address, (value) => {
  const invite = parseInvite(value)
  if (!invite || invite.server === value.trim()) return
  if (invite.caFingerprint || invite.code) {
    address.value = invite.server
    if (invite.caFingerprint) fingerprint.value = invite.caFingerprint
    if (invite.code) {
      inviteCode.value = invite.code
      authMode.value = 'invite'
    }
  }
})

const trustSummary = computed(() => {
  const result = probeResult.value
  if (!result) return ''
  if (result.pinnedFingerprint) return t('catalogLibrary.add.trustPinned')
  if (result.url.startsWith('http:')) return t('catalogLibrary.add.trustLoopback')
  return t('catalogLibrary.add.trustSystem')
})

const canConnect = computed(() => {
  if (authMode.value === 'token') return identityToken.value.trim().length > 0
  if (authMode.value === 'invite')
    return inviteCode.value.trim().length > 0 && password.value.length > 0
  return member.value.trim().length > 0 && password.value.length > 0
})

function formatCount(value: number): string {
  return new Intl.NumberFormat(locale.value).format(value)
}

async function pickCa(): Promise<void> {
  const result = await catalogLibraryAPI.pickCaFile()
  if (result.success && result.data) caPem.value = result.data
  else if (!result.success) probeError.value = catalogErrorText(t, result.errorCode, result.error)
}

async function probe(): Promise<void> {
  if (!address.value.trim()) return
  busy.value = true
  probeError.value = null
  try {
    const result = await catalogLibraryAPI.probe(
      address.value.trim(),
      fingerprint.value.trim() || null,
      caPem.value
    )
    if (!result.success || !result.data) {
      probeError.value = catalogErrorText(t, result.errorCode, result.error)
      return
    }
    if (result.data.error) {
      probeError.value = catalogErrorText(t, result.data.error.split(':')[0], result.data.error)
      return
    }
    if (result.data.kind === 'unknown') {
      probeError.value = t('catalogLibrary.errors.not-a-catalog')
      return
    }
    probeResult.value = result.data
    // 只有目录服务、没有成员面：只能粘贴令牌
    if (result.data.kind === 'catalog') authMode.value = 'token'
    step.value = 'auth'
  } finally {
    busy.value = false
  }
}

async function connect(): Promise<void> {
  if (!canConnect.value || !probeResult.value) return
  busy.value = true
  connectError.value = null
  try {
    const result = await catalogLibraryAPI.connect({
      address: probeResult.value.url,
      caFingerprint: fingerprint.value.trim() || null,
      caPem: caPem.value,
      authMode: authMode.value === 'token' ? 'token' : 'password',
      member: member.value.trim() || null,
      password: password.value || null,
      inviteCode: authMode.value === 'invite' ? inviteCode.value.trim() : null,
      identityToken: authMode.value === 'token' ? identityToken.value.trim() : null,
      loreRemote: loreRemote.value.trim() || null
    })
    password.value = ''
    if (!result.success || !result.data) {
      connectError.value = catalogErrorText(t, result.errorCode, result.error)
      return
    }
    connected.value = result.data
    remoteLibraries.value = result.data.libraries
    for (const library of result.data.libraries) chosen.add(library.id)
    step.value = 'libraries'
  } finally {
    busy.value = false
  }
}

function toggleChoice(id: string, value: boolean): void {
  if (value) chosen.add(id)
  else chosen.delete(id)
}

async function addChosen(): Promise<void> {
  if (!connected.value) return
  busy.value = true
  connectError.value = null
  try {
    const libraries = remoteLibraries.value
      .filter((library) => chosen.has(library.id))
      .map((library) => ({ id: library.id, name: library.name || library.id }))
    const result = await catalogLibraryAPI.add(connected.value.server.id, libraries)
    if (!result.success) {
      connectError.value = catalogErrorText(t, result.errorCode, result.error)
      return
    }
    const keys = libraries.map((library) => `${connected.value!.server.id}:${library.id}`)
    emit('added', keys)
    emit('close')
  } finally {
    busy.value = false
  }
}

function close(): void {
  password.value = ''
  emit('close')
}
</script>

<style scoped lang="less">
.add-catalog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.add-step {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.add-lead {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.add-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  > span {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
}

.add-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.add-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.mono {
  font-family: var(--font-mono);
}

.add-trust {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: var(--font-size-sm);
}

.trust-icon {
  flex: none;
  margin-top: 2px;
}

.add-libraries {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.library-name {
  margin-right: var(--space-2);
  color: var(--color-text-primary);
}

.add-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
