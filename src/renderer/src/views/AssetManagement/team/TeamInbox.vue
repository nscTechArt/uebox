<template>
  <div class="team-page team-inbox" data-testid="team-inbox">
    <div v-if="loading && !inbox" class="skeleton-rows">
      <span v-for="n in 3" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ t('teamProject.activity.error') }}
      <AppButton size="small" @click="load">{{ t('teamProject.retry') }}</AppButton>
    </div>
    <div v-else-if="inbox && allDone" class="page-state">{{ t('teamProject.inbox.allDone') }}</div>
    <template v-else-if="inbox">
      <!-- 等你通过：冻结期间的提交、受限文件夹的提交、外包交付，按时间混排；哪类没内容就整类不显示 -->
      <section v-if="inbox.approvals.length > 0" class="inbox-section">
        <div class="section-title">{{ t('teamProject.inbox.approvals') }}</div>
        <template v-for="item in inbox.approvals" :key="itemKey(item)">
          <SubmitCard
            v-if="item.type === 'submit'"
            :submit="item.submit"
            :now="now"
            @changed="load"
          />
          <div v-else class="row-card">
            <span class="row-text">
              {{
                t('teamProject.inbox.deliveryRow', {
                  company: item.delivery.company.name,
                  n: item.delivery.n,
                  count: item.delivery.counts.total,
                  time: formatTeamTime(item.delivery.at, now, t)
                })
              }}
            </span>
            <AppButton
              size="small"
              @click="teamStore.openView('delivery', { deliveryId: item.delivery.id })"
            >
              {{ t('teamProject.inbox.goSee') }}
            </AppButton>
          </div>
        </template>
      </section>

      <!-- 请你收回：UE 里有人点了「请管理员收回」 -->
      <section v-if="inbox.takeBack.length > 0" class="inbox-section">
        <div class="section-title">{{ t('teamProject.inbox.takeBack') }}</div>
        <div v-for="item in inbox.takeBack" :key="item.ask.id" class="row-card">
          <span class="row-text">
            {{
              t('teamProject.inbox.takeBackRow', {
                asker: item.ask.from.name,
                label: item.label,
                holder: checkoutLine(item.holder, sinceOf(item), now, teamStore.me, t)
              })
            }}
          </span>
          <AppButton size="small" variant="primary" @click="takeBack(item)">
            {{ t('teamProject.history.takeBack') }}
          </AppButton>
          <AppButton size="small" @click="teamAsset.ask(item.paths)">
            {{ t('teamProject.history.askDone') }}
          </AppButton>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 等你处理（方案 4.11）：只列你此刻能处理的。[通过] 不弹确认；[打回] 写原因（必填）。
 * 全部处理完「都处理完了。」，离开这一页后左栏这一项消失。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import type { TeamInbox } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import SubmitCard from './SubmitCard.vue'
import { checkoutLine, formatTeamTime } from './teamFormat'
import { loadFacts } from './teamFacts'
import { openTeamDialog } from './teamDialogs'
import { useTeamAsset } from './useTeamAsset'

const { t } = useI18n()
const teamStore = useTeamStore()
const teamAsset = useTeamAsset()

const inbox = ref<TeamInbox | null>(null)
const loading = ref(false)
const error = ref(false)
const now = ref(Date.now())

const allDone = computed(
  () => (inbox.value?.approvals.length ?? 0) + (inbox.value?.takeBack.length ?? 0) === 0
)

function itemKey(item: TeamInbox['approvals'][number]): string {
  return item.type === 'submit' ? `s${item.submit.number}` : `d${item.delivery.id}`
}

function sinceOf(item: TeamInbox['takeBack'][number]): number {
  const checkout = teamStore.checkoutOf(item.paths[0])
  return checkout?.since ?? item.ask.at
}

async function load(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  now.value = Date.now()
  loading.value = true
  error.value = false
  try {
    inbox.value = await teamAPI.inbox(key)
    teamStore.inboxCount = inbox.value.approvals.length + inbox.value.takeBack.length
    void loadFacts(
      key,
      inbox.value.approvals.flatMap((item) => (item.type === 'submit' ? item.submit.preview : []))
    )
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

async function takeBack(item: TeamInbox['takeBack'][number]): Promise<void> {
  const done = await openTeamDialog({
    kind: 'takeBack',
    holder: { id: item.holder.id, name: item.holder.name },
    paths: item.paths,
    count: item.paths.length,
    askId: item.ask.id
  })
  if (done) void load()
}

watch(
  () => teamStore.revision,
  () => void load()
)
onMounted(() => void load())
</script>

<style scoped lang="less">
@import './teamPage.less';

.inbox-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
