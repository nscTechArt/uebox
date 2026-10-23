<template>
  <div
    class="submit-card"
    :class="{
      milestone: Boolean(submit.milestone),
      pending: submit.state === 'pending',
      expanded
    }"
    :data-submit="submit.number"
    @click="toggle"
  >
    <div class="submit-head">
      <TeamAvatar :name="submit.author.name" :online="authorOnline" />
      <span class="submit-author">{{ submit.author.name }}</span>
      <span class="submit-time">{{ formatTeamTime(submit.at, now, t) }}</span>
      <span
        class="submit-number"
        :title="t('teamProject.card.submitNo', { n: submit.number })"
        @click.stop="copyNumber"
      >
        <i v-if="submit.state === 'pending'" class="pending-dot" />#{{ submit.number }}
      </span>
      <span
        v-if="submit.milestone"
        class="milestone-tag"
        :title="
          t('teamProject.card.milestoneBy', {
            who: submit.milestone.by.name,
            date: formatTeamTime(submit.milestone.at, now, t)
          })
        "
        >{{ submit.milestone.name }}</span
      >
      <span v-if="waiting" class="state-tag waiting">{{ waiting }}</span>
      <span
        v-for="build in submit.builds"
        :key="build.machine"
        class="state-tag build"
        :title="
          t('teamProject.card.builtHover', {
            machine: build.machine,
            time: formatTeamTime(build.at, now, t)
          })
        "
        >{{ t('teamProject.card.built', { machine: build.machine }) }}</span
      >
      <span class="submit-counts">{{ countsText(submit.counts, t) }}</span>
      <AppDropdown v-if="showMenu" placement="bottomRight">
        <button class="submit-more" :aria-label="t('teamProject.card.setMilestone')" @click.stop>
          <PhDotsThree />
        </button>
        <template #overlay>
          <AppMenu @click="onMenu">
            <template v-if="submit.milestone">
              <AppMenuItem item-key="rename">{{ t('teamProject.card.rename') }}</AppMenuItem>
              <AppMenuItem item-key="remove">{{
                t('teamProject.card.removeMilestone')
              }}</AppMenuItem>
            </template>
            <AppMenuItem v-else item-key="set">{{
              t('teamProject.card.setMilestone')
            }}</AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
    </div>

    <div class="submit-message">{{ submit.message }}</div>
    <div v-if="submit.rejected" class="submit-rejected">
      {{
        t('teamProject.card.rejected', {
          reason: submit.rejected.reason,
          who: submit.rejected.by.name
        })
      }}
    </div>

    <div v-if="submit.preview.length > 0" class="thumb-strip">
      <TeamThumb
        v-for="hash in visiblePreview"
        :key="hash"
        :hash="hash"
        size="medium"
        @click.stop="emit('open-hash', hash)"
      />
      <span v-if="morePreview > 0" class="thumb-more">{{
        t('teamProject.card.more', { n: morePreview })
      }}</span>
    </div>

    <div v-if="canDecide" class="submit-decide" @click.stop>
      <AppButton size="small" variant="primary" :loading="deciding" @click="approve">
        {{ t('teamProject.card.approve') }}
      </AppButton>
      <AppButton size="small" @click="reject">{{ t('teamProject.card.reject') }}</AppButton>
    </div>

    <!-- 就地展开的文件列表（方案 2.8） -->
    <div v-if="expanded" class="submit-files" @click.stop>
      <div v-if="!files" class="skeleton-rows">
        <span v-for="n in 3" :key="n" class="skeleton-row" />
      </div>
      <template v-else>
        <div v-for="group in fileGroups" :key="group.key" class="file-row">
          <TeamThumb
            :hash="group.hash"
            :path="group.path"
            :deleted="group.action === 'deleted'"
            size="small"
          />
          <span class="file-name">{{ group.name }}</span>
          <span class="file-path">{{ group.folder }}</span>
          <span class="change-mark" :class="group.action">{{ actionText(group.action) }}</span>
        </div>
        <div class="submit-files-foot">
          <AppButton size="small" @click="copyLink">{{ t('teamProject.card.copyLink') }}</AppButton>
          <AppButton size="small" @click="emit('compare-from', submit.number)">
            {{ t('teamProject.card.compareFrom') }}
          </AppButton>
          <AppButton
            v-if="submit.milestone && previousMilestone !== null"
            size="small"
            @click="emit('compare-range', previousMilestone, submit.number)"
          >
            {{ t('teamProject.card.comparePrevMilestone') }}
          </AppButton>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 提交卡片（方案 2.8）：动态、对比的 [提交] 页、等你处理共用。
 * 点卡片空白处就地展开文件列表；管理员悬停出「⋯」（设为里程碑 / 改名 / 去掉里程碑）；
 * 能通过的人在等通过的卡片上看到 [通过] [打回]。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhDotsThree } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import type { ChangeAction, TeamSubmit, TeamSubmitFile } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import TeamAvatar from './TeamAvatar.vue'
import TeamThumb from './TeamThumb.vue'
import { assetNameOf, countsText, folderOf, formatTeamTime, waitingText } from './teamFormat'
import { loadFacts } from './teamFacts'
import { openTeamDialog } from './teamDialogs'

const props = withDefaults(
  defineProps<{
    submit: TeamSubmit
    now: number
    initiallyExpanded?: boolean
    previousMilestone?: number | null
  }>(),
  { initiallyExpanded: false, previousMilestone: null }
)
const emit = defineEmits<{
  (e: 'changed'): void
  (e: 'compare-from', number: number): void
  (e: 'compare-range', from: number, to: number): void
  (e: 'open-hash', hash: string): void
}>()

const { t } = useI18n()
const teamStore = useTeamStore()
const expanded = ref(props.initiallyExpanded)
const files = ref<TeamSubmitFile[] | null>(null)
const deciding = ref(false)

const MAX_STRIP = 7
const visiblePreview = computed(() => props.submit.preview.slice(0, MAX_STRIP))
const morePreview = computed(() => {
  const total = Array.isArray(props.submit.files)
    ? props.submit.files.length
    : props.submit.files.total
  return Math.max(0, total - visiblePreview.value.length)
})
const waiting = computed(() =>
  props.submit.state === 'pending' ? waitingText(props.submit, t) : null
)
const canDecide = computed(
  () => props.submit.state === 'pending' && (props.submit.can.approve || props.submit.can.reject)
)
const showMenu = computed(() => props.submit.can.milestone && props.submit.state === 'landed')
const authorOnline = computed(
  () => teamStore.project?.people?.find((p) => p.id === props.submit.author.id)?.online ?? false
)

watch(
  () => props.initiallyExpanded,
  (value) => {
    if (value) expanded.value = true
  }
)
watch(expanded, (value) => value && void loadFiles(), { immediate: true })

async function loadFiles(): Promise<void> {
  const key = teamStore.key
  if (!key || files.value) return
  const detail = await teamAPI.submit(key, props.submit.number).catch(() => null)
  files.value = detail?.files ?? []
  void loadFacts(
    key,
    files.value.map((file) => file.hash)
  )
}

function toggle(): void {
  expanded.value = !expanded.value
}

interface FileGroup {
  key: string
  name: string
  folder: string
  path: string
  hash: string | null
  action: ChangeAction
}

/**
 * 每行缩略图、名字、灰色路径、改动标记；Actor 写所在地图（「L_North · 3 个 Actor」）；
 * 超过 50 个按文件夹折叠。
 */
const fileGroups = computed<FileGroup[]>(() => {
  const list = files.value ?? []
  const actors = new Map<string, TeamSubmitFile[]>()
  const plain: TeamSubmitFile[] = []
  for (const file of list) {
    if (file.ofpa?.map) actors.set(file.ofpa.map, [...(actors.get(file.ofpa.map) ?? []), file])
    else plain.push(file)
  }
  const out: FileGroup[] = []
  if (plain.length > 50) {
    const byFolder = new Map<string, TeamSubmitFile[]>()
    for (const file of plain)
      byFolder.set(folderOf(file.path), [...(byFolder.get(folderOf(file.path)) ?? []), file])
    for (const [folder, items] of byFolder)
      out.push({
        key: `folder:${folder}`,
        name: t('teamProject.card.filesFolded', { folder: folder || '/', n: items.length }),
        folder: '',
        path: items[0].path,
        hash: items[0].hash,
        action: items[0].action
      })
  } else {
    for (const file of plain)
      out.push({
        key: file.path,
        name: assetNameOf(file.path),
        folder: file.action === 'moved' && file.pathFrom ? file.pathFrom : folderOf(file.path),
        path: file.path,
        hash: file.hash,
        action: file.action
      })
  }
  for (const [map, items] of actors)
    out.push({
      key: `map:${map}`,
      name: t('teamProject.card.ofpa', { map: assetNameOf(map), n: items.length }),
      folder: folderOf(map),
      path: map,
      hash: items[0].hash,
      action: items.every((item) => item.action === 'added') ? 'added' : 'modified'
    })
  return out
})

function actionText(action: ChangeAction): string {
  if (action === 'added') return t('teamProject.card.actionAdded')
  if (action === 'deleted') return t('teamProject.card.actionDeleted')
  return t('teamProject.card.actionModified')
}

async function copyNumber(): Promise<void> {
  await navigator.clipboard.writeText(`#${props.submit.number}`).catch(() => undefined)
  message.success(t('teamProject.card.copied', { n: props.submit.number }))
}

async function copyLink(): Promise<void> {
  await navigator.clipboard
    .writeText(teamStore.webLink(`/submits/${props.submit.number}`))
    .catch(() => undefined)
  message.success(t('teamProject.card.linkCopied'))
}

/** [通过] 不弹确认（方案 2.13） */
async function approve(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  deciding.value = true
  const result = await teamAPI.approve(key, props.submit.number)
  deciding.value = false
  if (!result.success) {
    message.error(
      result.errorCode === 'not-allowed'
        ? t('teamProject.dialogs.notAllowed')
        : t('teamProject.dialogs.failed')
    )
    return
  }
  message.success(t('teamProject.card.approved', { n: props.submit.number }))
  emit('changed')
  void teamStore.refresh(['inbox'])
}

async function reject(): Promise<void> {
  if (await openTeamDialog({ kind: 'reject', number: props.submit.number })) emit('changed')
}

async function onMenu(info: { key: string }): Promise<void> {
  const key = info.key
  const k = teamStore.key
  if (!k) return
  if (key === 'set' || key === 'rename') {
    const done = await openTeamDialog({
      kind: 'milestone',
      number: props.submit.number,
      name: key === 'rename' ? (props.submit.milestone?.name ?? null) : null
    })
    if (done) emit('changed')
    return
  }
  if (key === 'remove' && props.submit.milestone) {
    // 去掉里程碑不弹确认，撤了可以再设（方案 7.2）
    const name = props.submit.milestone.name
    const result = await teamAPI.removeMilestone(k, props.submit.number)
    if (result.success) {
      message.success(t('teamProject.card.removedMilestone', { name, n: props.submit.number }))
      emit('changed')
      void teamStore.refresh(['milestones'])
    } else message.error(t('teamProject.dialogs.failed'))
  }
}
</script>

<style scoped lang="less">
.submit-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  cursor: pointer;
  transition: background var(--motion-fast) var(--easing-standard);

  &:hover {
    background: var(--color-bg-surface-hover);

    .submit-more {
      opacity: 1;
    }
  }

  &.milestone {
    border-left: 3px solid var(--color-warning-solid);
  }

  &.pending {
    opacity: 0.8;
  }
}

.submit-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.submit-author {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
}

.submit-time {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.submit-number {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-family: var(--font-family-numeric);
  font-size: var(--font-size-sm);
  cursor: copy;
}

.pending-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-warning-solid);
}

.milestone-tag {
  padding: 0 var(--space-2);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-full);
  color: var(--color-warning-text);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.state-tag {
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  line-height: 1.6;

  &.waiting {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  &.build {
    background: var(--color-bg-soft);
    color: var(--color-text-secondary);
  }
}

.submit-counts {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.submit-more {
  display: inline-flex;
  padding: var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  opacity: 0;

  &:hover {
    background: var(--color-bg-soft-hover);
  }
}

.submit-message {
  color: var(--color-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.submit-rejected {
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}

.thumb-strip {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.thumb-more {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  padding: 0 var(--space-2);
}

.submit-decide {
  display: flex;
  gap: var(--space-2);
}

.submit-files {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border-subtle);
  cursor: default;
}

.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.file-name {
  color: var(--color-text-primary);
  white-space: nowrap;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.change-mark {
  font-size: var(--font-size-xs);

  &.added {
    color: var(--color-success-text);
  }

  &.modified,
  &.moved {
    color: var(--color-accent-text);
  }

  &.deleted {
    color: var(--color-danger-text);
  }
}

.submit-files-foot {
  display: flex;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.skeleton-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skeleton-row {
  height: 20px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-soft);
}
</style>
