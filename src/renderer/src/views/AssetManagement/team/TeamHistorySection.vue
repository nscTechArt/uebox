<template>
  <!-- 外包：参考的最近一次改动写发来时那句话（方案 4.12） -->
  <div v-if="path && teamStore.isOutsourcer" class="team-history inspector-group">
    <span class="inspector-group-title">{{ t('teamProject.history.title') }}</span>
    <template v-if="reference">
      <div class="latest-line">
        {{
          t('teamProject.outsource.sentBy', {
            who: reference.by.name,
            time: formatTeamTime(reference.at, now, t)
          })
        }}
      </div>
      <div class="latest-message">{{ reference.note }}</div>
    </template>
    <div v-else class="history-empty">{{ t('teamProject.history.none') }}</div>
  </div>
  <div v-else-if="path" class="team-history inspector-group" data-testid="team-history">
    <div class="history-header" @click="collapsed = !collapsed">
      <button
        v-if="expanded"
        class="history-back"
        :title="t('teamProject.history.back')"
        @click.stop="expanded = false"
      >
        <PhCaretLeft />
      </button>
      <span class="inspector-group-title">{{ t('teamProject.history.title') }}</span>
      <PhCaretDown class="history-caret" :class="{ collapsed }" />
    </div>

    <template v-if="!collapsed">
      <!-- 签出行（按需）：别人签出 / 你签出 / 源文件没人签出 -->
      <div v-if="checkout" class="checkout-row">
        <span class="checkout-text">{{ checkoutText }}</span>
        <template v-if="!mine">
          <AppButton
            size="small"
            :disabled="Boolean(askedText)"
            :title="askedText ?? undefined"
            @click="teamAsset.ask([path])"
          >
            {{ askedText ?? t('teamProject.history.askDone') }}
          </AppButton>
          <AppButton
            v-if="askedText && holderNotToday"
            size="small"
            variant="link"
            @click="teamAsset.escalate(path)"
          >
            {{ t('teamProject.ask.requestTakeBack') }}
          </AppButton>
          <AppButton v-if="teamStore.isAdmin" size="small" @click="teamAsset.takeBack([path])">
            {{ t('teamProject.history.takeBack') }}
          </AppButton>
        </template>
        <!-- 你签出：[取消签出]；改过的话问 [留着改动] [不要改动]，和 UE 一样（方案 3.7） -->
        <AppButton v-else-if="teamStore.isLocal" size="small" @click="cancelCheckout">
          {{ t('teamProject.history.cancelCheckout') }}
        </AppButton>
      </div>
      <!-- 有人问你改完没（方案 2.16）：[取消签出] [还在改 ▾]；提交在 UE 里做 -->
      <div v-if="mine && receivedAsk" class="ask-row">
        <span class="checkout-text">
          {{
            t('teamProject.notify.askReceived', {
              who: receivedAsk.from.name,
              name: assetNameOf(path)
            })
          }}
        </span>
        <AppDropdown placement="bottomRight">
          <AppButton size="small">{{ t('teamProject.ask.stillEditing') }} ▾</AppButton>
          <template #overlay>
            <AppMenu @click="(info) => answerStill(info.key)">
              <AppMenuItem v-for="eta in ETAS" :key="eta" :item-key="eta">
                {{ t(`teamProject.notify.eta.${eta}`) }}
              </AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>
      </div>

      <div v-if="loading" class="skeleton-rows">
        <span v-for="n in 3" :key="n" class="skeleton-row" />
      </div>
      <div v-else-if="failed" class="history-empty">{{ t('teamProject.history.offline') }}</div>
      <div v-else-if="items.length === 0" class="history-empty">
        {{ t('teamProject.history.none') }}
      </div>

      <!-- 默认：最近一次改动 + 历史条 -->
      <template v-else-if="!expanded">
        <div class="latest-line">
          {{ latest.author.name }} · {{ formatTeamTime(latest.at, now, t) }} · #{{ latest.number }}
        </div>
        <div class="latest-message">{{ latest.message }}</div>
        <!-- 历史条：只有一版时不显示；新的在左；悬停一张，上面的预览临时换成那一版 -->
        <div v-if="items.length > 1" class="history-strip" @mouseleave="emit('preview', null)">
          <button
            v-for="item in stripItems"
            :key="item.number"
            class="strip-item"
            :title="
              t('teamProject.history.hoverVersion', {
                number: item.number,
                who: item.author.name,
                date: formatTeamTime(item.at, now, t)
              })
            "
            @mouseenter="hover(item.hash)"
            @click="expanded = true"
          >
            <TeamThumb :hash="item.hash" :path="path" size="small" />
          </button>
          <button v-if="stripMore > 0" class="strip-more" @click="expanded = true">
            {{ t('teamProject.card.more', { n: stripMore }) }}
          </button>
        </div>
        <div v-if="hoverLabel" class="hover-label">{{ hoverLabel }}</div>
      </template>

      <!-- 展开历史：就地展开，不弹窗 -->
      <div v-else class="history-list">
        <div
          v-for="item in items"
          :key="`${item.number}-${item.action}`"
          class="history-row"
          :class="{ selected: selectedNumber === item.number, moved: item.action === 'moved' }"
          @click="selectedNumber = item.number"
        >
          <TeamThumb
            v-if="item.action !== 'moved'"
            :hash="item.hash"
            :path="path"
            :deleted="item.action === 'deleted'"
            size="small"
          />
          <div class="history-row-main">
            <div class="history-row-head">
              <span class="history-number">#{{ item.number }}</span>
              <template v-if="item.action === 'moved'">
                <span class="history-muted">{{
                  t('teamProject.history.moved', { path: folderOf(path) })
                }}</span>
              </template>
              <template v-else>
                <span>{{ item.author.name }}</span>
                <span class="history-muted">{{ formatTeamTime(item.at, now, t) }}</span>
                <span v-if="item.milestone" class="milestone-tag">{{ item.milestone }}</span>
                <span v-if="item === latest" class="history-muted">{{
                  t('teamProject.history.latest')
                }}</span>
              </template>
            </div>
            <div class="history-muted history-message">{{ item.message }}</div>
            <div
              v-if="selectedNumber === item.number && item.action !== 'moved'"
              class="history-actions"
              @click.stop
            >
              <AppButton size="small" @click="viewThis(item)">{{
                t('teamProject.history.viewThis')
              }}</AppButton>
              <AppButton size="small" :disabled="item === latest" @click="compareLatest(item)">
                {{ t('teamProject.history.compareLatest') }}
              </AppButton>
              <!-- 工程不在你电脑上时不出现；别人签出时变灰，旁边「小王 已签出」[问他改完没] -->
              <template v-if="teamStore.isLocal && item !== latest">
                <AppButton
                  size="small"
                  variant="primary"
                  :disabled="Boolean(checkout && !mine)"
                  :loading="restoring"
                  @click="restore(item)"
                >
                  {{ t('teamProject.history.restore') }}
                </AppButton>
                <span v-if="checkout && !mine" class="history-muted">
                  {{ t('teamProject.history.heldBy', { who: checkout.holder.name }) }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 详情 · 「历史」段（方案 4.6）：插在预览下面，可以折叠，默认展开。
 *
 * - 有人签出才有签出行；[收回] 只给管理员；
 * - 最近一次改动 + 提交说明 + 历史条（只有一版时不显示），悬停换预览；
 * - 点历史条就地展开历史：[看这一版] [和最新对比] [回到这一版]。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhCaretLeft } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import type { TeamHistory } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import TeamThumb from './TeamThumb.vue'
import { assetNameOf, checkoutLine, folderOf, formatTeamTime, onlineState } from './teamFormat'
import { factOf, loadFacts } from './teamFacts'
import { useTeamAsset } from './useTeamAsset'
import { openTeamDialog } from './teamDialogs'

type HistoryItem = TeamHistory['items'][number]

const props = defineProps<{ path: string | null }>()
const emit = defineEmits<{
  (e: 'preview', url: string | null): void
  (e: 'compare', pair: { from: string | null; to: string | null } | null): void
}>()

const { t } = useI18n()
const teamStore = useTeamStore()
const teamAsset = useTeamAsset()

const collapsed = ref(false)
const expanded = ref(false)
const loading = ref(false)
const failed = ref(false)
const items = ref<HistoryItem[]>([])
const selectedNumber = ref<number | null>(null)
const hoverLabel = ref<string | null>(null)
const restoring = ref(false)
const now = ref(Date.now())

const checkout = computed(() => teamStore.checkoutOf(props.path))
const ETAS = ['30m', '1h', 'today', 'tomorrow'] as const
const receivedAsk = computed(() => (props.path ? teamStore.receivedAsks[props.path] : undefined))

/** [还在改 ▾]：回给问的人「小王：还在改，大概 1 小时。」 */
async function answerStill(eta: string): Promise<void> {
  const key = teamStore.key
  const ask = receivedAsk.value
  if (!key || !ask) return
  const result = await teamAPI.answerAsk(key, ask.id, { kind: 'still-editing', eta })
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  forgetAsk()
}

function forgetAsk(): void {
  const path = props.path
  if (!path) return
  const next = { ...teamStore.receivedAsks }
  delete next[path]
  teamStore.receivedAsks = next
}
/** 外包区里 `reference/Content/…` 对应的那次「发参考」（新的在前） */
const reference = computed(() => {
  const plain = (props.path ?? '').replace(/^reference\//, '')
  return (
    [...teamStore.references]
      .sort((a, b) => b.at - a.at)
      .find((item) => item.paths.includes(plain)) ?? null
  )
})
const mine = computed(() => checkout.value?.holder.id === teamStore.me)
const checkoutText = computed(() =>
  checkout.value
    ? checkoutLine(checkout.value.holder, checkout.value.since, now.value, teamStore.me, t)
    : ''
)
const askedText = computed(() => (props.path ? teamAsset.askedLabel(props.path) : null))
const holderNotToday = computed(() =>
  checkout.value ? onlineState(checkout.value.holder, now.value) === 'notToday' : false
)
const landed = computed(() => items.value.filter((item) => item.action !== 'moved'))
const latest = computed(() => landed.value[0])
const MAX_STRIP = 5
const stripItems = computed(() => landed.value.slice(0, MAX_STRIP))
const stripMore = computed(() => Math.max(0, landed.value.length - MAX_STRIP))

async function load(): Promise<void> {
  const key = teamStore.key
  const path = props.path
  expanded.value = false
  selectedNumber.value = null
  emit('preview', null)
  emit('compare', null)
  if (!key || !path || teamStore.isOutsourcer) return
  now.value = Date.now()
  loading.value = true
  failed.value = false
  try {
    const history = await teamAPI.history(key, path)
    if (props.path !== path) return
    items.value = history.items
    void loadFacts(
      key,
      history.items.map((item) => item.hash)
    )
    if (checkout.value) void teamAsset.refreshAsked([path])
  } catch {
    if (props.path === path) {
      failed.value = true
      items.value = []
    }
  } finally {
    if (props.path === path) loading.value = false
  }
}

watch(
  () => [props.path, teamStore.key],
  () => void load(),
  { immediate: true }
)

function hover(hash: string | null): void {
  const item = landed.value.find((candidate) => candidate.hash === hash)
  const fact = factOf(teamStore.key, hash)
  emit('preview', fact?.previewLarge ?? fact?.preview ?? null)
  hoverLabel.value = item
    ? t('teamProject.history.hoverVersion', {
        number: item.number,
        who: item.author.name,
        date: formatTeamTime(item.at, now.value, t)
      })
    : null
}

/** [看这一版]：面包屑胶囊和横幅跟着变（整个工程那时的样子要目录服务按修订浏览，服务端还没有） */
function viewThis(item: HistoryItem): void {
  teamStore.viewingOld = { name: item.milestone, number: item.number }
}

/** [和最新对比]：预览区变成左右两张图 */
function compareLatest(item: HistoryItem): void {
  const toFact = factOf(teamStore.key, latest.value?.hash)
  const fromFact = factOf(teamStore.key, item.hash)
  emit('compare', {
    from: fromFact?.previewLarge ?? fromFact?.preview ?? null,
    to: toFact?.previewLarge ?? toFact?.preview ?? null
  })
}

async function cancelCheckout(): Promise<void> {
  const key = teamStore.key
  const path = props.path
  if (!key || !path) return
  const modified = await teamAPI.isModified(key, path)
  if (modified.success && modified.data) {
    await openTeamDialog({ kind: 'cancelCheckout', path, name: assetNameOf(path) })
    return
  }
  // 没改过：直接取消，不问
  const result = await teamAPI.cancelCheckout(key, path, false)
  if (!result.success) message.error(t('teamProject.dialogs.failed'))
  else await answerReleased()
  void teamStore.loadCheckouts()
}

/** 有人在等这个文件：取消签出之后告诉服务端，服务端替他签出（「SK_Hero 已为你签出。」） */
async function answerReleased(): Promise<void> {
  const key = teamStore.key
  const ask = receivedAsk.value
  if (!key || !ask) return
  await teamAPI.answerAsk(key, ask.id, { kind: 'released' })
  forgetAsk()
}

/** [回到这一版]：和 UE 里的同一件事 —— 在你电脑上换好，提交后别人才拿到 */
async function restore(item: HistoryItem): Promise<void> {
  const key = teamStore.key
  const path = props.path
  if (!key || !path) return
  restoring.value = true
  const result = await teamAPI.restore(key, path, item.number)
  restoring.value = false
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  message.success(t('teamProject.history.restored', { name: assetNameOf(path), n: item.number }))
  void teamStore.loadCheckouts()
}
</script>

<style scoped lang="less">
.team-history {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  user-select: none;
}

.history-back {
  display: inline-flex;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.history-caret {
  margin-left: auto;
  color: var(--color-text-muted);
  transition: transform var(--motion-fast) var(--easing-standard);

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.checkout-row,
.ask-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.checkout-text {
  flex: 1;
  min-width: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.latest-line {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.latest-message {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.history-strip {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.strip-item,
.strip-more {
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.strip-more {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.hover-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.history-row {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.selected {
    background: var(--color-bg-selected);
  }

  &.moved {
    color: var(--color-text-muted);
  }
}

.history-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.history-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.history-number {
  color: var(--color-text-muted);
  font-family: var(--font-family-numeric);
}

.history-muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.history-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.milestone-tag {
  padding: 0 var(--space-2);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-full);
  color: var(--color-warning-text);
  font-size: var(--font-size-xs);
}

.history-empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.skeleton-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skeleton-row {
  height: 18px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-soft);
}
</style>
