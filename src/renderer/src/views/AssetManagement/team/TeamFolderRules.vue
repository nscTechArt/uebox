<template>
  <div
    v-if="path !== null && (deliveryState || rules)"
    class="team-folder inspector-group"
    data-testid="team-folder-rules"
  >
    <!-- 外包：交付的一批在文件夹详情里写状态（方案 4.12） -->
    <div v-if="deliveryState" class="folder-row">
      <span class="row-value">{{ deliveryState }}</span>
    </div>

    <template v-else-if="rules">
      <!-- 谁能提交（所有人看得到这一行；管理员点这一行就地编辑） -->
      <div
        v-if="!editingSubmit"
        class="folder-row"
        :class="{ editable: rules.canEdit }"
        data-testid="team-who-can-submit"
        @click="rules.canEdit && startEditSubmit()"
      >
        <span class="row-label">{{ t('teamProject.folder.whoCanSubmit') }}：</span>
        <span class="row-value">{{ whoCanSubmitText }}</span>
      </div>
      <div v-else class="submit-editor">
        <div class="row-label">{{ t('teamProject.folder.whoCanSubmit') }}</div>
        <label v-if="path !== ''" class="radio-row">
          <input v-model="submitMode" type="radio" value="inherit" />
          {{ t('teamProject.folder.modeInherit', { what: parentText }) }}
        </label>
        <label class="radio-row">
          <input v-model="submitMode" type="radio" value="all" />
          {{ t('teamProject.folder.modeAll') }}
        </label>
        <label class="radio-row">
          <input v-model="submitMode" type="radio" value="only" />
          {{ t('teamProject.folder.modeOnly') }}
        </label>
        <template v-if="submitMode === 'only'">
          <a-select
            v-model:value="submitPeople"
            mode="multiple"
            size="small"
            :placeholder="t('teamProject.folder.pickPeople')"
            :options="peopleOptions"
            class="people-select"
          />
          <div class="row-hint">{{ t('teamProject.folder.othersWait') }}</div>
        </template>
        <div class="editor-actions">
          <AppButton size="small" @click="editingSubmit = false">{{
            t('teamProject.cancel')
          }}</AppButton>
          <AppButton
            size="small"
            variant="primary"
            :loading="saving"
            :disabled="submitMode === 'only' && submitPeople.length === 0"
            @click="saveSubmit"
          >
            {{ t('teamProject.folder.save') }}
          </AppButton>
        </div>
      </div>

      <!-- 提交前检查（只有管理员看得到这一段） -->
      <template v-if="rules.canEdit && rules.effective.checks.length > 0">
        <div class="inspector-group-title checks-title">
          {{ t('teamProject.folder.checksTitle') }}
        </div>
        <div v-for="rule in TEAM_RULES" :key="rule" class="check-row">
          <button class="rule-name" @click="toggleParams(rule)">{{ ruleName(rule) }}</button>
          <a-select
            :value="levelOf(rule)"
            size="small"
            class="level-select"
            :options="levelOptions(rule)"
            :data-testid="`team-check-${rule}`"
            @change="(value: string) => setLevel(rule, value)"
          />
          <!-- 点规则名，就地改参数 -->
          <div v-if="paramsOpen === rule" class="rule-params">
            <template v-if="rule === 'name-prefix'">
              <div v-for="(row, index) in prefixRows" :key="index" class="prefix-row">
                <span v-if="row.known" class="prefix-type">{{ prefixTypeName(row.type) }}</span>
                <a-input v-else v-model:value="row.type" size="small" class="prefix-type" />
                <a-input v-model:value="row.prefix" size="small" class="prefix-input" />
                <AppButton size="small" variant="text" @click="prefixRows.splice(index, 1)">
                  <PhX />
                </AppButton>
              </div>
              <AppButton size="small" variant="dashed" @click="addPrefixRow">
                {{ t('teamProject.folder.addPrefix') }}
              </AppButton>
            </template>
            <label v-else-if="rule === 'texture-max-size'" class="param-row">
              <span>{{ t('teamProject.folder.maxSide') }}</span>
              <a-input-number v-model:value="maxSide" size="small" :min="1" :step="1024" />
            </label>
            <label v-else-if="rule === 'file-max-size'" class="param-row">
              <span>{{ t('teamProject.folder.maxFile') }}</span>
              <a-input-number v-model:value="maxFileGb" size="small" :min="0.1" :step="0.5" />
            </label>
            <div v-if="hasParams(rule)" class="editor-actions">
              <AppButton size="small" @click="paramsOpen = null">{{
                t('teamProject.cancel')
              }}</AppButton>
              <AppButton size="small" variant="primary" :loading="saving" @click="saveParams(rule)">
                {{ t('teamProject.folder.save') }}
              </AppButton>
            </div>
          </div>
        </div>
        <div class="row-hint">{{ t('teamProject.folder.checksFoot') }}</div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件夹详情：谁能提交、提交前检查（方案 4.7），外包的交付状态（4.12）。
 * 追加在现有文件夹详情（路径、子文件夹数、文件数）后面。规则只在服务端判断，这里只读写设置。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhX } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import {
  TEAM_RULES,
  type RuleLevel,
  type TeamDelivery,
  type TeamFolderRules,
  type TeamRuleId
} from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import { getActiveLibrarySource } from '../data/activeLibrarySource'
import { formatSize, peopleText } from './teamFormat'

const props = defineProps<{ folderKey: string | null }>()
const { t } = useI18n()
const teamStore = useTeamStore()

const path = ref<string | null>(null)
const rules = ref<TeamFolderRules | null>(null)
const delivery = ref<TeamDelivery | null>(null)
const editingSubmit = ref(false)
const submitMode = ref<'inherit' | 'all' | 'only'>('all')
const submitPeople = ref<string[]>([])
const saving = ref(false)
const paramsOpen = ref<TeamRuleId | null>(null)
const prefixRows = ref<Array<{ type: string; prefix: string; known: boolean }>>([])
const maxSide = ref(4096)
const maxFileGb = ref(2)

async function load(): Promise<void> {
  const key = teamStore.key
  rules.value = null
  delivery.value = null
  editingSubmit.value = false
  paramsOpen.value = null
  path.value = null
  if (!key || !props.folderKey) return
  const folder = (await getActiveLibrarySource()
    .folders.getByKey(props.folderKey)
    .catch(() => null)) as { catalogPath?: string } | null
  const projectPath = props.folderKey === 'ALL' ? '' : (folder?.catalogPath ?? null)
  if (projectPath === null) return
  path.value = projectPath
  if (teamStore.isOutsourcer) {
    const match = /^delivery\/(\d+)$/.exec(projectPath)
    if (!match) return
    const list = await teamAPI.deliveries(key).catch(() => null)
    delivery.value = list?.items.find((item) => item.folder === projectPath) ?? null
    return
  }
  rules.value = await teamAPI.folderRules(key, projectPath).catch(() => null)
}

watch(
  () => [props.folderKey, teamStore.key, teamStore.revision],
  () => void load(),
  {
    immediate: true
  }
)

const deliveryState = computed(() => {
  const d = delivery.value
  if (!d) return null
  if (d.state === 'uploading') return t('teamProject.outsource.state.uploading', { p: 0 })
  if (d.state === 'waiting' || d.counts.waiting > 0) return t('teamProject.outsource.state.waiting')
  return t('teamProject.outsource.state.done', { a: d.counts.approved, r: d.counts.rejected })
})

const whoCanSubmitText = computed(() => {
  const submit = rules.value?.effective.submit
  if (!submit || submit.mode === 'all') return t('teamProject.folder.all')
  return t('teamProject.folder.only', {
    people: peopleText(submit.people, t('teamProject.nameSep'))
  })
})

/** 「跟上级一样（所有成员）」括号里写上级实际是什么 */
const parentText = computed(() => {
  const submit = rules.value?.effective.submit
  if (!submit) return t('teamProject.folder.all')
  if (submit.from === path.value && rules.value?.own.submit?.mode !== 'inherit')
    return t('teamProject.folder.all')
  return submit.mode === 'all'
    ? t('teamProject.folder.all')
    : peopleText(submit.people, t('teamProject.nameSep'))
})

const peopleOptions = computed(() => {
  const people = teamStore.project?.people ?? []
  const groups = [...new Set(people.map((p) => p.group).filter((g): g is string => Boolean(g)))]
  return [
    ...groups.map((group) => ({ label: group, value: `group:${group}` })),
    ...people.filter((p) => p.role !== 'build').map((p) => ({ label: p.name, value: p.id }))
  ]
})

function startEditSubmit(): void {
  const own = rules.value?.own.submit
  submitMode.value = own?.mode ?? (path.value === '' ? 'all' : 'inherit')
  if (path.value === '' && submitMode.value === 'inherit') submitMode.value = 'all'
  submitPeople.value = (own?.people ?? rules.value?.effective.submit.people ?? []).map((p) =>
    'group' in p ? `group:${p.group}` : p.id
  )
  editingSubmit.value = true
}

async function save(input: {
  submit?: unknown
  checks?: Record<string, unknown>
}): Promise<boolean> {
  const key = teamStore.key
  if (!key || path.value === null) return false
  saving.value = true
  const result = await teamAPI.putFolderRules(key, { path: path.value, ...input })
  saving.value = false
  if (!result.success || !result.data) {
    message.error(
      result.errorCode === 'not-allowed'
        ? t('teamProject.dialogs.notAllowed')
        : t('teamProject.dialogs.failed')
    )
    return false
  }
  rules.value = result.data
  message.success(t('teamProject.folder.saved'))
  void teamStore.loadRestricted()
  return true
}

async function saveSubmit(): Promise<void> {
  const people = submitPeople.value.map((value) =>
    value.startsWith('group:') ? { group: value.slice(6) } : value
  )
  const ok = await save({
    submit: { mode: submitMode.value, people: submitMode.value === 'only' ? people : [] }
  })
  if (ok) editingSubmit.value = false
}

// ---- 提交前检查

function ruleName(rule: TeamRuleId): string {
  const effective = rules.value?.effective.checks.find((check) => check.rule === rule)
  if (rule === 'texture-max-size')
    return t(`teamProject.folder.rules.${rule}`, {
      max: (effective?.params as { max?: number } | undefined)?.max ?? 4096
    })
  if (rule === 'file-max-size')
    return t(`teamProject.folder.rules.${rule}`, {
      size: formatSize(
        Number((effective?.params as { maxBytes?: number } | undefined)?.maxBytes ?? 2 * 1024 ** 3)
      )
    })
  return t(`teamProject.folder.rules.${rule}`)
}

function levelOf(rule: TeamRuleId): string {
  const own = rules.value?.own.checks?.[rule]?.level
  if (own) return own
  return path.value === '' ? (effectiveLevel(rule) ?? 'warn') : 'inherit'
}

function effectiveLevel(rule: TeamRuleId): RuleLevel | null {
  return rules.value?.effective.checks.find((check) => check.rule === rule)?.level ?? null
}

/** 下拉三档：不查 / 提醒 / 拦住；子文件夹多一档「跟上级一样（提醒）」 */
function levelOptions(rule: TeamRuleId): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = (['off', 'warn', 'block'] as const).map(
    (level) => ({ label: t(`teamProject.folder.levels.${level}`), value: level })
  )
  if (path.value !== '') {
    const inherited = inheritedLevel(rule)
    options.unshift({
      label: t('teamProject.folder.levels.inherit', {
        level: t(`teamProject.folder.levels.${inherited}`)
      }),
      value: 'inherit'
    })
  }
  return options
}

/** 上级实际生效的档位：自己设了的话，effective 里是自己的；这里退回 effective 或「提醒」 */
function inheritedLevel(rule: TeamRuleId): RuleLevel {
  const effective = rules.value?.effective.checks.find((check) => check.rule === rule)
  if (effective && effective.from !== path.value) return effective.level
  return rule === 'no-broken-references' ? 'block' : 'warn'
}

async function setLevel(rule: TeamRuleId, level: string): Promise<void> {
  const current = rules.value?.own.checks?.[rule]
  await save({
    checks: { [rule]: { level, ...(current?.params ? { params: current.params } : {}) } }
  })
}

function hasParams(rule: TeamRuleId): boolean {
  return rule === 'name-prefix' || rule === 'texture-max-size' || rule === 'file-max-size'
}

function toggleParams(rule: TeamRuleId): void {
  if (!hasParams(rule)) return
  if (paramsOpen.value === rule) {
    paramsOpen.value = null
    return
  }
  const params = (rules.value?.effective.checks.find((check) => check.rule === rule)?.params ??
    {}) as Record<string, unknown>
  if (rule === 'name-prefix') {
    const prefixes = (params.prefixes ?? {}) as Record<string, string>
    prefixRows.value = Object.entries(prefixes).map(([type, prefix]) => ({
      type,
      prefix,
      known: true
    }))
  }
  if (rule === 'texture-max-size') maxSide.value = Number(params.max ?? 4096)
  if (rule === 'file-max-size')
    maxFileGb.value = Math.round((Number(params.maxBytes ?? 2 * 1024 ** 3) / 1024 ** 3) * 10) / 10
  paramsOpen.value = rule
}

function prefixTypeName(type: string): string {
  const key = `teamProject.folder.prefixTypes.${type}`
  const name = t(key)
  return name === key ? type : name
}

function addPrefixRow(): void {
  prefixRows.value.push({ type: '', prefix: '', known: false })
}

async function saveParams(rule: TeamRuleId): Promise<void> {
  let params: Record<string, unknown> = {}
  if (rule === 'name-prefix')
    params = {
      prefixes: Object.fromEntries(
        prefixRows.value
          .filter((row) => row.type.trim() && row.prefix.trim())
          .map((row) => [row.type.trim(), row.prefix.trim()])
      )
    }
  if (rule === 'texture-max-size') params = { max: Number(maxSide.value) || 4096 }
  if (rule === 'file-max-size')
    params = { maxBytes: Math.round(Number(maxFileGb.value) * 1024 ** 3) }
  const own = rules.value?.own.checks?.[rule]?.level
  const level = own && own !== 'inherit' ? own : (effectiveLevel(rule) ?? 'warn')
  if (await save({ checks: { [rule]: { level, params } } })) paramsOpen.value = null
}
</script>

<style scoped lang="less">
.team-folder {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.folder-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-sm);

  &.editable {
    cursor: pointer;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

.row-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.row-value {
  color: var(--color-text-primary);
}

.row-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.submit-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
}

.radio-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.people-select {
  width: 100%;
}

.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.checks-title {
  margin-top: var(--space-2);
}

.check-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--space-1) var(--space-2);
}

.rule-name {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;

  &:hover {
    color: var(--color-accent-text);
  }
}

.level-select {
  min-width: 150px;
}

.rule-params {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-soft);
}

.prefix-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.prefix-type {
  flex: 1;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.prefix-input {
  width: 80px;
}

.param-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}
</style>
