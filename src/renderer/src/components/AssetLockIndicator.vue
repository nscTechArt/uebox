<template>
  <div v-if="locks.length > 0 || conflicts.length > 0" class="asset-lock-indicator">
    <!--
      冲突提示。用户必须看得见 —— 他可能开着两个窗口，以为两边在干不同的活；
      静默失败的话他只会看到一条会话莫名其妙地绕开了任务。
    -->
    <div v-for="(conflict, index) in conflicts" :key="`${conflict.path}-${index}`" class="conflict">
      <PhWarning class="conflict-icon" />
      <span class="conflict-text">
        {{
          t('assetLock.conflict', {
            path: shortPath(conflict.path),
            session: sessionLabel(conflict.owner)
          })
        }}
      </span>
      <button class="dismiss" :title="t('assetLock.dismiss')" @click="dismissConflict(index)">
        <PhX />
      </button>
    </div>

    <div v-if="locks.length > 0" class="summary">
      <PhLock class="summary-icon" />
      <button class="summary-text" @click="expanded = !expanded">
        {{ t('assetLock.summary', { count: locks.length }) }}
      </button>
      <!--
        逃生口。任何锁一旦因为 bug 卡死，用户的感受是「盒子把我工程搞坏了」
        而不是「有个 bug」—— 必须永远留一个看得见、点得到的出口。
      -->
      <button class="release" @click="releaseAll">{{ t('assetLock.releaseAll') }}</button>
    </div>

    <div v-if="expanded && locks.length > 0" class="lock-list">
      <!-- 按工程分组：开着两个 UE 工程时，光看资产名分不出是哪边被锁 -->
      <section v-for="group in lockGroups" :key="group.key" class="lock-group">
        <div v-if="group.projectName" class="lock-project" :title="group.projectPath">
          {{ group.projectName }}
        </div>
        <ul>
          <li v-for="lock in group.locks" :key="`${lock.connectionId ?? ''}-${lock.path}`">
            <span class="lock-path" :title="lockTitle(lock.path)">{{
              displayName(lock.path)
            }}</span>
            <button
              v-if="ownerSession(lock.owner)"
              class="lock-owner"
              :title="ownerSession(lock.owner)?.title"
              @click="openSession(lock.owner)"
            >
              {{ ownerSession(lock.owner)?.title }}
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { PhLock, PhWarning, PhX } from '@phosphor-icons/vue'

import { chatSessionRoute } from '@renderer/common/chatRoute'

import { useI18n } from '@renderer/hooks/useI18n'
import { useAssetLocks } from '@renderer/hooks/useAssetLocks'
import { useChatSessionsStore, type ChatSession } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { listConnectedProjects } from '@renderer/views/Assistant/composables/ueProjectContext'
import type { AssetLock } from '@renderer/hooks/useAssetLocks'

const { t } = useI18n()
const { locks, conflicts, releaseAll, dismissConflict } = useAssetLocks()

/**
 * 关卡锁用的是一个 NUL 开头的哨兵键，不是包路径 —— Actor 类工具的参数里
 * 没有资产路径，盒子并不知道被改的是哪张关卡。直接渲染会在列表里露出一串
 * 带控制字符的乱码。
 */
function isLevelSentinel(path: string): boolean {
  return path.charCodeAt(0) === 0
}

/** 列表里只给资产名，完整包路径留给 hover */
function displayName(path: string): string {
  return isLevelSentinel(path) ? t('assetLock.currentLevel') : shortPath(path)
}

function lockTitle(path: string): string | undefined {
  return isLevelSentinel(path) ? undefined : path
}
const chatSessions = useChatSessionsStore()
const tabsStore = useTabsStore()
const router = useRouter()

const expanded = ref(false)

/**
 * connectionId → 工程名。
 *
 * 锁是按连接记的，连接才是「锁在哪个工程」的真相；会话上盖的工程只是它第一次
 * 发消息时连着的那个，之后可能换过。只在展开、且锁涉及的连接变了时查一次。
 */
const projectNames = ref<Record<string, { name: string; path?: string }>>({})
const connectionKey = computed(() =>
  [...new Set(locks.value.map((lock) => lock.connectionId ?? ''))].sort().join('|')
)
watch(
  [expanded, connectionKey],
  async ([open]) => {
    if (!open || !connectionKey.value) return
    try {
      const projects = listConnectedProjects(
        (await window.api.websocket.getProjects()) as unknown[]
      )
      projectNames.value = Object.fromEntries(
        projects.map((p) => [p.connectionId, { name: p.projectName, path: p.projectPath }])
      )
    } catch {
      // 查不到就退回会话上记的工程
    }
  },
  { immediate: true }
)

function ownerSession(owner: string): ChatSession | undefined {
  return chatSessions.sessionByAgentSessionId(owner) || chatSessions.sessionById(owner) || undefined
}

function lockProject(lock: AssetLock): { name: string; path?: string } {
  const connected = lock.connectionId ? projectNames.value[lock.connectionId] : undefined
  if (connected) return connected
  const stamped = ownerSession(lock.owner)?.project
  return { name: stamped?.projectName ?? '', path: stamped?.projectPath }
}

const lockGroups = computed(() => {
  type Group = { key: string; projectName: string; projectPath?: string; locks: AssetLock[] }
  const groups = new Map<string, Group>()
  for (const lock of locks.value) {
    const project = lockProject(lock)
    // 按连接分组：同名工程（同一个 .uproject 拷在两个目录）也要分得开
    const key = lock.connectionId ? `conn:${lock.connectionId}` : `name:${project.name}`
    const group = groups.get(key) ?? {
      key,
      projectName: project.name,
      projectPath: project.path,
      locks: []
    }
    group.locks.push(lock)
    groups.set(key, group)
  }
  return [...groups.values()]
})

function openSession(owner: string): void {
  const session = ownerSession(owner)
  if (!session) return
  expanded.value = false
  router.push(
    chatSessionRoute(
      session.id,
      tabsStore.historyTabs.map((tab) => tab.path)
    )
  )
}

/** 完整包路径太长，只留末段 —— 想看全的 hover */
const shortPath = (path: string): string => path.split('/').pop() || path

/**
 * 锁主的 sessionId → 会话标题。
 *
 * 主进程那边只有 id（会话标题存在渲染层的 chatSessions store 里），所以这一步
 * 只能在这儿做 —— 而它必须做：真机上用户看到的是「被会话 b04ba478… 占用」，
 * 一串 uuid 既不告诉他是自己哪个窗口，也不告诉他该做什么。
 *
 * **先按 `agentSessionId` 查。** 锁主是内核那边的会话 id（`agent-v3:execute`
 * 收到的那个），跟界面这边的会话 `id` 不是一回事。原来直接拿它去 `sessionById`，
 * 于是**每一把锁都查不到**，全部显示成「另一条对话」—— 包括用户自己此刻正在
 * 用的这条。再退回按界面 id 查一次，是因为小窗口那类入口两个 id 可能同源。
 */
const sessionLabel = (owner: string): string => {
  const session =
    chatSessions.sessionByAgentSessionId(owner) || chatSessions.sessionById(owner) || null
  return session?.title || t('assetLock.unknownChat')
}
</script>

<style scoped lang="less">
.asset-lock-indicator {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 340px;
  font-size: 12px;
}

.conflict,
.summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
}

.conflict {
  border-color: var(--color-warning-border);
}

.conflict-icon {
  color: var(--color-warning-text);
  flex-shrink: 0;
}

.conflict-text {
  color: var(--color-text-primary);
  flex: 1;
  min-width: 0;
}

.summary-icon {
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.summary-text {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-primary);
}

.release,
.dismiss {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-secondary);
  flex-shrink: 0;

  &:hover {
    color: var(--color-text-primary);
  }
}

.lock-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  max-height: 220px;
  overflow-y: auto;

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }
}

.lock-project {
  color: var(--color-text-muted);
  font-size: 11px;
  padding-bottom: 2px;
}

.lock-path {
  color: var(--color-text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lock-owner {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-muted);

  &:hover {
    color: var(--color-text-primary);
    text-decoration: underline;
  }
}
</style>
