<script setup lang="ts">
/**
 * 共享技能的安装确认框。挂在 App 根上：网页唤起、Agent 工具、命令行三条入口都会让主进程
 * 推一条安装请求过来，用户在这里看全文、点安装才写盘（见 src/main/ipc/share.ts）。
 *
 * 同时来了几条就排队，一次只弹一个。冷启动从网页唤起时请求比界面先到，挂载时补取一次。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { shareAPI } from '@renderer/api/share'
import { message } from '@renderer/utils/messageManager'
import type { SharedSkillInstallRequest } from '@core/shared/share'

const { t } = useI18n()

const queue = ref<SharedSkillInstallRequest[]>([])
const current = computed(() => queue.value[0] ?? null)
const open = computed({
  get: () => current.value !== null,
  // 点遮罩、按 Esc、点右上角关闭都算「不装」
  set: (value: boolean) => {
    if (!value) void decide(false)
  }
})
const fileIndex = ref(0)
const busy = ref(false)

/** SKILL.md 排第一，其余按路径 */
const files = computed(() =>
  [...(current.value?.skill.files ?? [])].sort((a, b) =>
    a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)
  )
)

const conflictText = computed(() => {
  const req = current.value
  if (!req || req.conflict.kind === 'none') return ''
  if (req.conflict.kind === 'update') {
    return t('profile.skills.installConflict.update', {
      from: req.conflict.fromVersion,
      to: req.skill.version
    })
  }
  return t(`profile.skills.installConflict.${req.conflict.kind}`)
})

function enqueue(request: SharedSkillInstallRequest): void {
  if (queue.value.some((r) => r.requestId === request.requestId)) return
  queue.value.push(request)
  if (queue.value.length === 1) fileIndex.value = 0
}

async function decide(approve: boolean): Promise<void> {
  const req = current.value
  if (!req || busy.value) return
  busy.value = true
  try {
    const outcome = await shareAPI.installReply(req.requestId, approve)
    if (outcome.status === 'installed') {
      message.success(t('profile.skills.installed', { name: outcome.id }))
    } else if (outcome.status === 'failed') {
      message.error(t('profile.skills.installFailed', { reason: outcome.error }))
    }
  } catch (error) {
    message.error(
      t('profile.skills.installFailed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  } finally {
    busy.value = false
    queue.value.shift()
    fileIndex.value = 0
  }
}

function openPage(): void {
  if (current.value) void shareAPI.openPage(current.value.pageUrl).catch(() => undefined)
}

const unsubscribers: Array<() => void> = []
onMounted(async () => {
  unsubscribers.push(shareAPI.onInstallRequest(enqueue))
  unsubscribers.push(
    shareAPI.onInstallFailed((failure) =>
      message.error(t('profile.skills.installFailed', { reason: failure.error }))
    )
  )
  try {
    for (const request of await shareAPI.pendingInstalls()) enqueue(request)
  } catch {
    // 取不到挂着的请求不影响别的；发起方那头会按超时收到「未安装」
  }
})
onUnmounted(() => unsubscribers.forEach((off) => off()))
</script>

<template>
  <AppModal
    v-model:open="open"
    :title="$t('profile.skills.installTitle')"
    :width="760"
    :mask-closable="false"
  >
    <template v-if="current">
      <div class="head">
        <div class="name">{{ current.skill.id }}</div>
        <div class="meta">
          {{
            $t('profile.skills.installMeta', {
              author: current.skill.author,
              version: current.skill.version,
              date: current.skill.updatedAt.slice(0, 10)
            })
          }}
        </div>
        <p class="desc">{{ current.skill.description }}</p>
      </div>

      <p class="note">
        {{ $t(`profile.skills.installFrom.${current.origin}`) }}
        {{ $t('profile.skills.installReview') }}
      </p>
      <p v-if="conflictText" class="note warn">{{ conflictText }}</p>

      <div v-if="files.length > 1" class="tabs" role="tablist">
        <button
          v-for="(file, i) in files"
          :key="file.path"
          type="button"
          role="tab"
          class="tab"
          :aria-selected="i === fileIndex"
          @click="fileIndex = i"
        >
          {{ file.path }}
        </button>
      </div>
      <pre class="file">{{ files[fileIndex]?.content }}</pre>
    </template>

    <template #footer>
      <div class="footer">
        <AppButton variant="text" @click="openPage">{{
          $t('profile.skills.installPage')
        }}</AppButton>
        <div class="actions">
          <AppButton :disabled="busy" @click="decide(false)">{{ $t('common.cancel') }}</AppButton>
          <AppButton variant="primary" :loading="busy" @click="decide(true)">
            {{ $t('profile.skills.install') }}
          </AppButton>
        </div>
      </div>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.name {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-md);
  color: var(--color-text-primary);
}

.meta,
.note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.desc {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.note {
  margin-top: var(--space-3);
}

.warn {
  color: var(--color-warning-text);
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-3);
}

.tab {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  cursor: pointer;

  &[aria-selected='true'] {
    border-color: var(--color-border-focus);
    color: var(--color-text-primary);
  }
}

/* 等宽、原样显示：用户要看的就是会装进去的那份文字 */
.file {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: 1.7;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.actions {
  display: flex;
  gap: var(--space-2);
}
</style>
