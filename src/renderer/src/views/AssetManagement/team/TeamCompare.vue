<template>
  <div class="team-page team-compare" data-testid="team-compare">
    <!-- 顶部：「从 [M3 提审版 ▾] 到 [最新 ▾]」 -->
    <div class="compare-head">
      <span class="muted">{{ t('teamProject.compare.from') }}</span>
      <TeamVersionSelect v-model="from" :milestones="teamStore.milestones" :recent="recent" />
      <span class="muted">{{ t('teamProject.compare.to') }}</span>
      <TeamVersionSelect v-model="to" :milestones="teamStore.milestones" :recent="recent" />
    </div>

    <div v-if="loading" class="skeleton-rows">
      <span v-for="n in 3" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ error }}
      <AppButton v-if="!notFound" size="small" @click="load">{{
        t('teamProject.retry')
      }}</AppButton>
    </div>
    <template v-else-if="result">
      <!-- 汇总：「6 次提交 · 新增 3 · 修改 44 · 删除 1」；从里程碑对比时「M2 → M3 提审版：88 次提交」 -->
      <div class="compare-summary">
        <span v-if="result.from.milestone && result.to.milestone" class="summary-title">
          {{
            t('teamProject.compare.milestoneTitle', {
              from: result.from.milestone,
              to: result.to.milestone,
              n: result.submits
            })
          }}
        </span>
        <span v-else class="summary-title">{{
          t('teamProject.compare.summary', { submits: result.submits })
        }}</span>
        <span v-if="countsText(result.counts, t)" class="muted">
          · {{ countsText(result.counts, t) }}</span
        >
        <span v-if="result.swapped" class="muted">{{ t('teamProject.compare.swapped') }}</span>
      </div>

      <div class="toolbar-row">
        <button class="pill-btn" :class="{ active: tab === 'files' }" @click="tab = 'files'">
          {{ t('teamProject.compare.files') }}
        </button>
        <button class="pill-btn" :class="{ active: tab === 'submits' }" @click="tab = 'submits'">
          {{ t('teamProject.compare.submits') }}
        </button>
        <AppDropdown placement="bottomLeft">
          <button class="pill-btn" :class="{ active: folder }">
            {{ folder || t('teamProject.activity.folder') }} <PhCaretDown />
          </button>
          <template #overlay>
            <AppMenu :selected-keys="[folder ?? '']" @click="(info) => setFolder(info.key)">
              <AppMenuItem item-key="">{{ t('teamProject.activity.allFolders') }}</AppMenuItem>
              <AppMenuItem v-for="f in folderChoices" :key="f" :item-key="f">{{ f }}</AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>
      </div>

      <div v-if="!result.complete" class="muted">{{ t('teamProject.compare.incomplete') }}</div>

      <!-- 文件：用网格，卡片右上角是改动标记；写是哪次改的 -->
      <template v-if="tab === 'files'">
        <div v-if="result.files.length === 0" class="page-state">
          {{ t('teamProject.compare.empty') }}
        </div>
        <div v-else class="card-grid">
          <div
            v-for="file in result.files"
            :key="file.path"
            class="asset-card"
            :class="{ selected: selectedPath === file.path }"
            :title="file.path"
            @click="selectFile(file)"
          >
            <span class="change-mark corner" :class="file.action">{{
              actionText(file.action)
            }}</span>
            <TeamThumb
              :hash="file.hash"
              :path="file.path"
              :deleted="file.action === 'deleted'"
              size="large"
            />
            <div class="card-name">{{ assetNameOf(file.path) }}</div>
            <div class="card-sub">
              {{
                t('teamProject.compare.fileRow', {
                  action: actionText(file.action),
                  n: file.number,
                  who: file.author.name
                })
              }}
            </div>
          </div>
        </div>
      </template>
      <template v-else>
        <div v-if="submits.length === 0" class="page-state">
          {{ t('teamProject.compare.empty') }}
        </div>
        <SubmitCard
          v-for="submit in submits"
          :key="submit.number"
          :submit="submit"
          :now="now"
          @changed="load"
          @compare-from="(n) => ((from = n), (to = 'latest'))"
        />
      </template>

      <!-- 底部固定一行：「还是找不到原因？」[找出是哪次提交弄坏的] -->
      <div class="stuck-row">
        <span class="muted">{{ t('teamProject.compare.stuck') }}</span>
        <AppButton size="small" data-testid="team-open-bisect" @click="openBisect">
          {{ t('teamProject.compare.bisect') }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 对比（方案 5.12，盒子里 4.8）：从 ▾ 到 ▾、汇总、[文件]（网格）/ [提交]、[文件夹 ▾]、
 * 底部「还是找不到原因？」[找出是哪次提交弄坏的]。填反了服务端自动换过来，提示「已按先后排好。」
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import type { ChangeAction, TeamCompare, TeamSubmit } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import SubmitCard from './SubmitCard.vue'
import TeamThumb from './TeamThumb.vue'
import TeamVersionSelect from './TeamVersionSelect.vue'
import { assetNameOf, countsText, folderOf } from './teamFormat'
import { loadFacts } from './teamFacts'

const emit = defineEmits<{ (e: 'open-path', path: string, hash: string | null): void }>()
const { t } = useI18n()
const teamStore = useTeamStore()

const from = ref<number | 'latest'>(
  (teamStore.params.from as number | 'latest' | null) ?? teamStore.milestones[0]?.number ?? 1
)
const to = ref<number | 'latest'>((teamStore.params.to as number | 'latest' | null) ?? 'latest')
const tab = ref<'files' | 'submits'>('files')
const folder = ref<string | null>(null)
const result = ref<TeamCompare | null>(null)
const submits = ref<TeamSubmit[]>([])
const recent = ref<Array<Pick<TeamSubmit, 'number' | 'message'>>>([])
const loading = ref(false)
const error = ref<string | null>(null)
const notFound = ref(false)
const selectedPath = ref<string | null>(null)
const now = ref(Date.now())

const folderChoices = computed(() => {
  const all = new Set<string>()
  for (const file of result.value?.files ?? []) {
    const parts = folderOf(file.path).split('/')
    if (parts[0]) all.add(parts[0])
    if (parts.length > 1) all.add(parts.slice(0, 2).join('/'))
  }
  return [...all].sort()
})

async function load(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  now.value = Date.now()
  loading.value = true
  error.value = null
  notFound.value = false
  try {
    const compared = await teamAPI.compare(key, from.value, to.value, folder.value ?? undefined)
    result.value = compared
    void loadFacts(
      key,
      compared.files.map((file) => file.hash)
    )
    const page = await teamAPI.submits(key, {
      from: compared.from.number,
      to: compared.to.number,
      folder: folder.value ?? undefined,
      limit: 200
    })
    submits.value = page.items
    void loadFacts(
      key,
      page.items.flatMap((item) => item.preview)
    )
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'not-found') {
      notFound.value = true
      const missing = [from.value, to.value].find((value) => value !== 'latest')
      error.value = t('teamProject.compare.noSuch', { n: missing ?? '' })
    } else error.value = t('teamProject.activity.error')
    result.value = null
  } finally {
    loading.value = false
  }
}

async function loadRecent(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  const page = await teamAPI.submits(key, { limit: 10 }).catch(() => null)
  recent.value = (page?.items ?? []).filter((item) => item.state === 'landed')
}

function setFolder(key: string): void {
  folder.value = key || null
  void load()
}

function actionText(action: ChangeAction): string {
  if (action === 'added') return t('teamProject.card.actionAdded')
  if (action === 'deleted') return t('teamProject.card.actionDeleted')
  return t('teamProject.card.actionModified')
}

/** 点一个资产：详情预览变成「起点 / 终点」左右两张图（交给资产库页处理） */
function selectFile(file: TeamCompare['files'][number]): void {
  selectedPath.value = file.path
  emit('open-path', file.path, file.hash)
}

function openBisect(): void {
  if (!result.value) return
  teamStore.openView('bisect', { good: result.value.from.number, bad: result.value.to.number })
}

watch([from, to], () => void load())
onMounted(() => {
  void load()
  void loadRecent()
})
</script>

<style scoped lang="less">
@import './teamPage.less';

.compare-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.compare-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1);
}

.summary-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.toolbar-row {
  display: flex;
  gap: var(--space-2);
}

.corner {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 1;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--color-bg-raised);
}

.stuck-row {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-bg-page);
}
</style>
