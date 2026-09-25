<template>
  <div class="ai-bubble">
    <div class="content">
      <!-- 没在时间线上记推理位置的老消息：整段推理还放在顶部 -->
      <ThinkingProcess
        v-if="thinking && !timelineHasThinking"
        :content="thinking"
        :is-thinking="status === 'typing' && !content.trim()"
      />
      <!--
        过程与正文**按发生顺序交替显示**。
        一段工具调用之后紧跟着模型对这一段的解说，再是下一段 —— 而不是把过程
        全折进顶部一个框、把所有解说挤成一坨挂在最底下。
      -->
      <template v-if="shouldShowAgentProcessLog">
        <template v-for="block in timelineBlocks" :key="block.key">
          <AgentProcessLog
            v-if="block.kind === 'process'"
            :items="block.items"
            :is-thinking="block.key === liveProcessBlockKey"
            :start-time="blockStartTime(block)"
          />
          <!-- 一轮推理一个框，显示在它发生的那一步 -->
          <ThinkingProcess
            v-else-if="block.kind === 'thinking'"
            :content="block.text"
            :is-thinking="block.key === liveBlockKey"
          />
          <!--
            用户在跑的途中插的那句话，就显示在它发生的位置。
            右对齐 + 用户气泡的底色，一眼能看出这句是「我说的」而不是 AI 的一步。
          -->
          <div v-else-if="block.kind === 'steer'" class="timeline-steer">
            <!--
              插话带的图。输入框发完就清空了，不画在这里的话，回头看只剩一句
              「照着这张改」，而「这张」是哪张再也说不清。
            -->
            <div v-if="block.images?.length" class="timeline-steer-images">
              <img
                v-for="(url, index) in block.images"
                :key="`${block.key}:img:${index}`"
                :src="url"
                class="timeline-steer-image"
                alt=""
              />
            </div>
            <div v-if="block.files?.length" class="timeline-steer-files">
              <AttachmentCard
                v-for="(file, index) in block.files"
                :key="`${block.key}:file:${index}`"
                :file-name="file.fileName"
                :kind="file.kind ?? 'excel'"
                :row-count="file.rowCount"
              />
            </div>
            <div class="timeline-steer-bubble" :class="{ cancelled: block.cancelled }">
              {{ block.text }}
            </div>
            <div
              class="timeline-steer-status"
              :class="{ applied: block.applied && !block.cancelled }"
            >
              <!--
                还排着的才给撤回：已生效的抽不回来（它在 transcript 里，
                抽掉等于篡改历史），跑完的那条也没有队可撤。
                没拿到号的同样不给 —— 画一个点了必然失败的按钮更糟。
              -->
              <button
                v-if="canCancelSteer(block)"
                type="button"
                class="timeline-steer-cancel"
                :title="t('assistant.steer.cancel')"
                :aria-label="t('assistant.steer.cancel')"
                @click="onCancelSteer(block)"
              >
                <PhX />
              </button>
              {{ steerStatusLabel(block) }}
            </div>
          </div>
          <!--
            agent 反问用户。就地长在时间线上，不弹模态 —— 答完之后它留在原地
            变成只读，用户回头能看到当时问了什么、自己选了什么。
          -->
          <AskUserCard
            v-else-if="block.kind === 'question'"
            :question="block.question"
            @answer="(action, answers) => onQuestionAnswer(block.question, action, answers)"
          />
          <MarkdownRenderer
            v-else
            class="timeline-text"
            :content="block.text"
            :streaming="status === 'typing'"
            @resize="emit('resize')"
          />
        </template>
      </template>
      <MarkdownRenderer
        v-if="showTrailingContent"
        :content="trailingContent"
        :is-thinking-placeholder="isThinkingPlaceholder"
        :streaming="status === 'typing'"
        @resize="emit('resize')"
      />
      <ChatAudioPlayer
        v-for="track in musicTracks"
        :key="track.path"
        :file-path="track.path"
        :title="track.title"
      />
      <!-- 资产列表展示 -->
      <AssetList
        v-if="assetSearchResult"
        :assets="assetSearchResult.assets"
        :total-count="assetSearchResult.totalCount"
        class="asset-list"
        @asset-click="handleAssetClick"
      />
      <!-- 3D模型预览：一个模型一个框 -->
      <ChatModelViewer
        v-for="(path, index) in modelPreviewPaths"
        :key="path"
        :file-path="path"
        :default-collapsed="index !== modelPreviewPaths.length - 1"
        class="model-preview"
        @resize="emit('resize')"
      />
      <!-- 导航按钮 -->
      <NavigationButton
        v-if="navigationResult"
        :button-text="navigationResult.buttonText"
        :description="navigationResult.description"
        :target="navigationResult.target"
      />

      <div
        v-if="
          status === 'done' &&
          responseMetadata?.usedSkills &&
          responseMetadata.usedSkills.length > 0
        "
        class="response-metadata"
      >
        <div class="response-metadata-label">{{ t('assistant.agentMode.usedSkills') }}</div>
        <div class="response-metadata-chips">
          <span
            v-for="skill in responseMetadata.usedSkills"
            :key="`${skill.source || 'unknown'}:${skill.name}`"
            class="response-metadata-chip"
          >
            <span class="response-metadata-chip-header">
              <span class="response-metadata-chip-source">
                {{ getSkillSourceLabel(skill.source) }}
              </span>
              <span class="response-metadata-chip-name">{{ skill.name }}</span>
            </span>
            <span v-if="skill.directory" class="response-metadata-chip-path">
              {{ skill.directory }}
            </span>
          </span>
        </div>
      </div>

      <!--
        本轮改动：这次真的动了哪些东西。只读操作不进这个清单。
        一行一个**被动过的东西**，不是一行一次工具调用 —— 施工步骤收在每行的展开区里
      -->
      <div
        v-if="status === 'done' && changeGroups.length > 0"
        class="response-changes"
        :class="{ collapsed: !changesExpanded }"
      >
        <div class="response-changes-top">
          <button type="button" class="response-changes-header" @click="toggleChanges">
            <PhCaretDown
              weight="fill"
              :class="['response-changes-caret', { collapsed: !changesExpanded }]"
            />
            <span>{{ changesTitle }}</span>
            <span v-if="irreversibleCount > 0" class="response-changes-warn">
              {{ t('assistant.changes.irreversibleCount', { count: irreversibleCount }) }}
            </span>
          </button>

          <!--
            审查：一次点击两件事 —— 机器查引擎里的事实（在不在、落盘没有、编译过不过），
            然后让模型回答机器答不了的那一半（这是不是用户要的东西）。
            拆成两个按钮的话，用户要点两次才知道一件事的全貌。

            它跟标题同一行、**在收起区外面**：收起的是施工明细，审查是个动作不是明细。
            2026-09-04 那次把清单改成默认收起时它被一起卷了进去，用户得先点开清单
            才知道有这么个东西 —— 而 AI 刚说完「改好了」正是最该一眼看见它的时候
          -->
          <div v-if="reviewTargets.length > 0" class="response-review">
            <button
              type="button"
              class="response-review-run"
              :disabled="reviewing"
              @click="runReview"
            >
              {{ reviewing ? t('assistant.review.running') : t('assistant.review.run') }}
            </button>
            <span v-if="reviewSummary" class="response-review-summary" :class="reviewSummaryTone">
              {{ reviewSummary }}
            </span>
            <!-- 自证请求已经作为一条消息发出去了，回复就在这条气泡下面 -->
            <span v-if="selfCheckSent" class="response-review-selfcheck">
              {{ t('assistant.selfCheck.sent') }}
            </span>
          </div>
        </div>

        <template v-if="changesExpanded">
          <!-- 文件清单直接提供每次编辑的对比，保留原来的打开入口。 -->
          <ul v-if="fileGroups.length > 0" class="response-file-list">
            <li
              v-for="group in fileReviewGroups"
              :key="`file-${group.key}`"
              class="response-file-item"
              :class="{ failed: isAllFailed(group) }"
            >
              <AppButton
                variant="text"
                class="response-file-review"
                :title="group.target"
                :disabled="!group.diffs.length || !openFileReview"
                @click="openFileReview?.(fileDiffs, group.diffs[0].path)"
              >
                <span class="response-file-path"
                  ><span class="response-file-dir">{{ group.directory }}</span
                  ><span class="response-file-name">{{ basenameOf(group.target) }}</span></span
                >
                <span v-if="failureTag(group)" class="response-changes-tag failed">{{
                  failureTag(group)
                }}</span>
                <span v-if="group.diffs.length" class="response-file-counts">
                  <span class="added">+{{ group.added }}</span>
                  <span class="removed">−{{ group.removed }}</span>
                </span>
              </AppButton>
              <AppDropdown :trigger="['click']" placement="bottomRight">
                <AppButton variant="soft" size="small" class="response-file-open">
                  {{ t('assistant.changes.openButton') }}
                  <PhCaretDown weight="fill" class="response-file-open-caret" />
                </AppButton>
                <template #overlay>
                  <AppMenu @click="({ key }) => runFilePathAction(String(key), group.target)">
                    <template v-for="(item, i) in filePathMenuItems" :key="item.key || `d-${i}`">
                      <AppMenuDivider v-if="item.type === 'divider'" />
                      <AppMenuItem v-else :key="item.key" :item-key="item.key">{{
                        item.label
                      }}</AppMenuItem>
                    </template>
                  </AppMenu>
                </template>
              </AppDropdown>
              <span v-if="group.diffs.length === 0" class="response-file-diff-missing">
                {{ t('assistant.fileDiff.notRecorded') }}
              </span>
            </li>
          </ul>

          <!--
            引擎里的改动：一行一个资产，说清「这是什么、叫什么、现在是新的还是改过的」。
            怎么改出来的（加了十个节点、连了九条线）点开才看 —— 那是排查用的，不是日常要读的
          -->
          <div v-if="engineGroups.length > 0" class="response-changes-engine">
            <div v-if="fileGroups.length > 0" class="response-changes-subtitle">
              {{ t('assistant.changes.engineTitle', { count: engineGroups.length }) }}
            </div>
            <ul class="response-changes-list">
              <li v-for="group in engineGroups" :key="`engine-${group.key}`">
                <div class="response-changes-item" :class="{ failed: isAllFailed(group) }">
                  <!--
                    箭头展开施工步骤。展开后说不出新东西的行（万能工具只调了一次）
                    不给箭头，免得点开还是同一行字
                  -->
                  <button
                    v-if="isExpandable(group)"
                    type="button"
                    class="response-changes-toggle"
                    @click="toggleGroup(group.key)"
                  >
                    <PhCaretDown
                      weight="fill"
                      :class="[
                        'response-changes-caret',
                        { collapsed: !expandedGroups.has(group.key) }
                      ]"
                    />
                  </button>
                  <span v-else class="response-changes-toggle-placeholder" />

                  <span v-if="group.kind" class="response-changes-kind">
                    {{ t(`assistant.changes.kinds.${group.kind}`) }}
                  </span>
                  <span class="response-changes-name" :title="group.target">
                    {{ groupName(group) }}
                  </span>
                  <span v-if="group.target" class="response-changes-target">
                    {{ shortDirOf(group.target) }}
                  </span>
                  <!-- 改成什么了。行上说得清就说，见 rowDetail -->
                  <code
                    v-if="rowDetail(group)"
                    class="response-changes-cmd"
                    :title="group.steps[0].detail"
                  >
                    {{ rowDetail(group) }}
                  </code>
                  <!-- 净结果。只有这一行确实指着一个东西时才说，见 showAction -->
                  <span
                    v-if="showAction(group)"
                    class="response-changes-tag"
                    :class="`action-${group.action}`"
                  >
                    {{ t(`assistant.changes.actions.${group.action}`) }}
                  </span>
                  <span v-if="failureTag(group)" class="response-changes-tag failed">
                    {{ failureTag(group) }}
                  </span>
                  <span v-if="group.irreversibleCount > 0" class="response-changes-tag warn">
                    {{ t('assistant.changes.irreversible') }}
                  </span>

                  <!-- 一行字说不清材质长什么样，剩下那一半交给编辑器本身 -->
                  <button
                    v-if="canOpenInEditor(group)"
                    type="button"
                    class="response-changes-open"
                    :disabled="openingAsset === group.key"
                    @click="openInEditor(group)"
                  >
                    {{ t('assistant.changes.openInEditor') }}
                  </button>
                </div>

                <ul v-if="expandedGroups.has(group.key)" class="response-changes-steps">
                  <li
                    v-for="step in group.steps"
                    :key="`${step.toolName}:${step.detail ?? ''}`"
                    class="response-changes-step"
                  >
                    <!-- 工具名对用户没有意义，显示这一步到底做了什么 -->
                    <span :title="step.toolName">{{ changeLabel(step) }}</span>
                    <!-- 改成什么了：属性键值对、变换参数。插件的启停方向除外，
                         那个已经由行上的动作标签说过一遍 -->
                    <code v-if="stepDetail(step)" class="response-changes-cmd" :title="step.detail">
                      {{ stepDetail(step) }}
                    </code>
                    <span v-if="step.count > 1" class="response-changes-repeat">
                      {{ t('assistant.changes.repeat', { count: step.count }) }}
                    </span>
                    <span v-if="step.failedCount > 0" class="response-changes-tag failed">
                      {{ t('assistant.changes.partialFailed', { count: step.failedCount }) }}
                    </span>
                  </li>
                </ul>
              </li>
            </ul>
          </div>

          <!--
            控制台命令 / Python 脚本：跑了什么就原样写什么。它们动的是引擎，
            却没有一个能打开的资产路径，混进上面任何一区都读不通；又恰恰是
            这一类最需要原样可见 —— 一段脚本改了什么，只有原文说得清。
            一行一条命令，重复跑同一条才合并计数。
            用户自己电脑上的命令行不在这里，它记进台账但不上面板
          -->
          <div v-if="shellGroups.length > 0" class="response-changes-engine">
            <div
              v-if="fileGroups.length > 0 || engineGroups.length > 0"
              class="response-changes-subtitle"
            >
              {{ t('assistant.changes.shellTitle', { count: shellGroups.length }) }}
            </div>
            <ul class="response-changes-list">
              <li v-for="group in shellGroups" :key="`shell-${group.key}`">
                <div class="response-changes-item" :class="{ failed: isAllFailed(group) }">
                  <button
                    v-if="isExpandable(group)"
                    type="button"
                    class="response-changes-toggle"
                    @click="toggleGroup(group.key)"
                  >
                    <PhCaretDown
                      weight="fill"
                      :class="[
                        'response-changes-caret',
                        { collapsed: !expandedGroups.has(group.key) }
                      ]"
                    />
                  </button>
                  <span v-else class="response-changes-toggle-placeholder" />

                  <code class="response-changes-cmd" :title="group.steps[0].detail">
                    {{ displayDetail(group.steps[0].detail) || changeLabel(group.steps[0]) }}
                  </code>
                  <span v-if="failureTag(group)" class="response-changes-tag failed">
                    {{ failureTag(group) }}
                  </span>
                  <span v-if="group.irreversibleCount > 0" class="response-changes-tag warn">
                    {{ t('assistant.changes.irreversible') }}
                  </span>
                </div>

                <ul v-if="expandedGroups.has(group.key)" class="response-changes-steps">
                  <li
                    v-for="step in group.steps"
                    :key="step.detail ?? step.toolName"
                    class="response-changes-step"
                  >
                    <span :title="step.toolName">{{ changeLabel(step) }}</span>
                    <code
                      v-if="displayDetail(step.detail)"
                      class="response-changes-cmd"
                      :title="step.detail"
                    >
                      {{ displayDetail(step.detail) }}
                    </code>
                    <span v-if="step.count > 1" class="response-changes-repeat">
                      {{ t('assistant.changes.repeat', { count: step.count }) }}
                    </span>
                    <span v-if="step.failedCount > 0" class="response-changes-tag failed">
                      {{ t('assistant.changes.partialFailed', { count: step.failedCount }) }}
                    </span>
                  </li>
                </ul>
              </li>
            </ul>
          </div>
        </template>

        <!-- 审查结论：可能好几条，单独占一块。清单收起着点的审查，结论一样得看得见 -->
        <ul v-if="reviewFindings.length > 0" class="response-review-list">
          <li
            v-for="(finding, index) in reviewFindings"
            :key="`${finding.target}-${finding.code}-${index}`"
            class="response-review-item"
            :class="`severity-${finding.severity}`"
          >
            <span class="response-review-dot" />
            <span class="response-review-name" :title="finding.target">
              {{ basenameOf(finding.target) }}
            </span>
            <span class="response-review-text">{{ findingText(finding) }}</span>
          </li>
        </ul>
      </div>

      <!-- 操作按钮。消息自带的动作（续跑、打开目录…） -->
      <div v-if="actionButtons && actionButtons.length > 0" class="action-buttons">
        <template v-for="btn in actionButtons" :key="`${btn.action}:${btn.label}`">
          <div v-if="isResumeAction(btn)" class="resume-action">
            <span class="resume-action-icon" aria-hidden="true">
              <PhWarning />
            </span>
            <span class="resume-action-copy">
              <span class="resume-action-title">{{ resumeTitle(btn) }}</span>
              <span class="resume-action-reason">{{ resumeReason(btn) }}</span>
            </span>
            <AppButton
              size="small"
              variant="primary"
              class="resume-action-cta"
              @click="emitAction(btn)"
            >
              {{ t('assistant.agentMode.resume') }}
            </AppButton>
          </div>
          <AppButton v-else size="small" variant="primary" ghost @click="emitAction(btn)">
            {{ btn.label }}
          </AppButton>
        </template>
      </div>

      <!-- 引用来源 -->
      <MessageSources
        v-if="status === 'done' && citations && citations.length > 0"
        :sources="citations"
        @click="emitSourceClick"
      />
    </div>

    <div
      class="tools"
      :class="[status, toolsMode === 'hover' && status === 'done' ? 'hover-done' : '']"
    >
      <PhCheck v-if="status === 'done' && isCopied" class="tool copied" />
      <PhCopy v-else-if="status === 'done'" class="tool" @click="emitCopy" />
      <PhArrowClockwise v-if="status === 'done'" class="tool" @click="emitRetry" />
      <AppTooltip v-if="status === 'done'" :title="t('assistant.branch.tooltip')">
        <PhGitBranch class="tool" @click="emitFork" />
      </AppTooltip>
      <AppTooltip v-if="status === 'done'" :title="readAloud.label.value">
        <AppButton
          variant="text"
          class="tool read-aloud-tool"
          :aria-label="readAloud.label.value"
          :aria-pressed="readAloud.active.value"
          :class="{ 'read-aloud-active': readAloud.active.value }"
          @click="readAloud.toggle(readableReply)"
        >
          <PhStop v-if="readAloud.active.value" />
          <PhSpeakerHigh v-else />
        </AppButton>
      </AppTooltip>
      <!-- 本轮 token 用量。跟在操作图标后面，不抢正文的位置 -->
      <AppTooltip v-if="status === 'done' && tokenUsage" placement="top">
        <template #title>
          <div class="token-usage-tip">
            <div class="token-usage-tip-title">{{ t('assistant.tokenUsage.title') }}</div>
            <div v-for="row in tokenUsageRows" :key="row.label" class="token-usage-tip-row">
              <span>{{ row.label }}</span>
              <span>{{ row.value }}</span>
            </div>
            <div class="token-usage-tip-hint">{{ t('assistant.tokenUsage.hint') }}</div>
          </div>
        </template>
        <span class="token-usage">{{ tokenUsageLabel }}</span>
      </AppTooltip>
    </div>
    <div v-if="status === 'done' && showFollowUps" class="follow-ups">
      <!-- Loading状态 -->
      <div v-if="suggestionsLoading" class="loading-container">
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
      </div>
      <!-- 建议列表 -->
      <template v-else>
        <AppButton
          v-for="s in suggestions"
          :key="s"
          size="small"
          shape="round"
          class="chip"
          @click="emitSuggest(s)"
        >
          <span>{{ s }}</span>
          <PhCaretRight />
        </AppButton>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { useReadAloud } from '../composables/useReadAloud'
import { useFileReview } from '../composables/useFileReview'
import {
  readFileChange,
  mergeFileChanges,
  fileDiff,
  type FileChange
} from '../../../../../shared/fileChange'
import { computed, watch, onMounted, nextTick, ref, shallowRef, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from './MarkdownRenderer.vue'
import AgentProcessLog from './AgentProcessLog.vue'
import AskUserCard from './AskUserCard.vue'
import AttachmentCard from './AttachmentCard.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'
import ThinkingProcess from './ThinkingProcess.vue'
import ChatModelViewer from './ChatModelViewer.vue'
import AssetList from './AssetList.vue'
import MessageSources from './MessageSources.vue'
import NavigationButton from './NavigationButton.vue'
import type { ResponseMetadata } from '@renderer/store/modules/chatMessages'
import {
  PhArrowClockwise,
  PhCaretDown,
  PhCaretRight,
  PhCheck,
  PhCopy,
  PhGitBranch,
  PhSpeakerHigh,
  PhStop,
  PhWarning,
  PhX
} from '@phosphor-icons/vue'
import {
  changeLabelKey,
  groupChanges,
  isEngineAssetPath,
  isMcpChange
} from '../composables/changeSummary'
import type { ChangeGroup } from '../composables/changeSummary'
import ChatAudioPlayer from './ChatAudioPlayer.vue'
import {
  collectGeneratedMusic,
  collectGeneratedMediaFromAgentArtifacts
} from '../composables/agentGeneratedMedia'
import { reviewTargetsFrom } from '../composables/reviewTargets'
import { SELF_CHECK_ACTION } from '../composables/selfCheck'
import { AGENT_RESUME_ACTION } from '../composables/agentHandlerShared'
import { isCreatorPlanAction, runCreatorPlanAction } from '../composables/creatorPlanChatError'
import { routerKey } from 'vue-router'
import type { AgentReviewFinding } from '@core/shared/agentReview'
import type { AgentQuestionItem } from '@core/shared/agentQuestion'
import { answerAgentQuestion, cancelUserSteer } from '../composables/agentEventDispatcher'
import { agentV3API } from '@renderer/api/agentV3'
import { basenameOf, shortDirOf, useFilePathMenu } from '@renderer/composables/useFilePathMenu'
import {
  joinTimelineText,
  reconcileAgentTimeline,
  hasTimelineThinking,
  resolveTrailingContent,
  type AgentTimelineBlock,
  type AgentTimelineSteerBlock
} from '../composables/agentTimeline'
import { message } from '@renderer/utils/messageManager'
import { finalReplyText } from '../composables/finalReplyText'
import { isTypingPlaceholder } from '@renderer/utils/typingPlaceholder'
import { hasTurnUsage } from '@core/shared/agentUsage'
import {
  formatExactTokenCount,
  formatTokenCount,
  formatUsageCost
} from '../composables/tokenUsageFormat'

const { t } = useI18n()

/**
 * 工具调用结果接口
 */
export interface ToolResult {
  toolName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any
  // 3D 生成结果
  modelUrl?: string
  thumbnailUrl?: string
  taskId?: string
  // 视频生成的视频URL
  videoUrl?: string
}

/**
 * 消息自带的操作按钮。
 *
 * 数据结构和 ChatLog 的传递一直都在（`chatMessages` 上的 `actionButtons`），
 * 缺的只是这里的渲染 —— 3D 生成早就在设「查看」按钮，从来没显示出来过。
 */
export interface MessageActionButton {
  label: string
  action: string
  /** 动作参数。各动作自己解释，这里不该知道有哪些形状 */
  data?: Record<string, unknown>
}

/**
 * AI 气泡组件（极简版）：
 * 取消头像与卡片背景，使用工具图标与跟进建议。
 */
const props = defineProps<{
  id: string
  content: string
  status: 'typing' | 'done'
  outcome?: 'error' | 'stopped'
  actionButtons?: MessageActionButton[]
  showFollowUps?: boolean
  toolsMode?: 'hover' | 'always'
  externalSuggestions?: string[]
  suggestionsLoading?: boolean
  toolResults?: ToolResult[] // 工具调用结果
  agentProcess?: AgentProcessItem[] // Agent 思考过程
  thinking?: string // 思考过程内容
  startTime?: number // 消息开始时间（用于计算duration）
  citations?: Array<{
    id: string
    title: string
    url?: string
    filePath?: string
    content?: string
    sourceId: string
    type?: string
  }>
  responseMetadata?: ResponseMetadata
}>()

/**
 * 生图**不再**把整段过程日志藏起来，也不再另立一个「正在出图」的占位框。
 *
 * 那两样都是 V2 的做法：那时生图是一次「点按钮、出图」的独立操作，过程日志里
 * 除了一句 route_to_specialist 没别的可看，所以拿一个占位框顶上去不损失什么。
 *
 * 现在生图是工作流里的一环（搭白盒、对镜头、截图、出图），而且工具自己会边跑边
 * 报「正在出图（1 张，参考图 1 张）」，过程日志上还有计时。那个占位框因此
 * 只剩两个作用：把用户唯一能看的信息挡住，以及每来一条新日志闪一下 ——
 * 它的显隐挂在 `status === 'typing'` 上，而那一位被好几条写日志的路径反复改写。
 */
const shouldShowAgentProcessLog = computed(() => props.agentProcess !== undefined)

// ==================== 过程 / 正文交替时间线 ====================
const timelineBlocks = shallowRef<AgentTimelineBlock[]>([])

watch(
  () => [props.agentProcess, props.thinking] as const,
  ([items, thinking]) => {
    timelineBlocks.value = reconcileAgentTimeline(timelineBlocks.value, items || [], thinking)
  },
  { immediate: true }
)

const timelineHasThinking = computed(() => hasTimelineThinking(props.agentProcess))

/**
 * 还在跑的那一段过程。
 *
 * 只有最后一段该转圈、该计时、该显示排队信息 —— 前面那些已经跑完了，
 * 给它们也挂上转圈动画等于告诉用户「这里还在动」。
 *
 * 末尾的插话要跳过：用户插一句话不打断执行，刚才那一步还在跑，
 * 转圈却停了的话看起来像是「我一说话它就卡住了」。
 */
const liveBlockKey = computed<string | null>(() => {
  if (props.status !== 'typing') return null
  for (let i = timelineBlocks.value.length - 1; i >= 0; i--) {
    const block = timelineBlocks.value[i]
    // 提问卡片和插话一样跳过：agent 这会儿正阻塞在「等你回答」上，它确实还在跑，
    // 转圈停掉会让人以为出问题了
    if (block.kind === 'steer' || block.kind === 'question') continue
    return block.kind === 'process' || block.kind === 'thinking' ? block.key : null
  }
  return null
})

/** 正在想的时候转圈的是那一轮推理框，过程框这时已经跑完了 */
const liveProcessBlockKey = computed(() =>
  liveBlockKey.value?.startsWith('process:') ? liveBlockKey.value : null
)

/**
 * 每段过程的计时起点。
 *
 * 第一段从用户发消息算起（用户关心的是「等了多久」），后面几段从这一段
 * 自己的第一条事件算起 —— 否则第三段会显示成包含前两段的总时长。
 */
function blockStartTime(block: AgentTimelineBlock): number | undefined {
  if (block.kind !== 'process') return undefined
  if (timelineBlocks.value[0]?.key === block.key) return props.startTime
  return block.items[0]?.timestamp
}

/**
 * 用户答完了一张提问卡片。
 *
 * sessionId 从条目里取，不从 props 传：这张卡片嵌在时间线的第三层，
 * 靠 props 层层往下传的话中间每一层都要为它加一个自己用不上的参数
 * （见 `shared/agentQuestion.ts` 的说明）。取不到就只能放弃 ——
 * 主进程那边会等到超时按取消处理，但至少不会把答案送错会话。
 */
function onQuestionAnswer(
  question: AgentQuestionItem,
  action: 'accept' | 'decline',
  answers?: string[]
): void {
  if (!question.sessionId) {
    console.warn('[AIBubble] 提问卡片没有 sessionId，无法回传答案:', question.toolCallId)
    return
  }
  answerAgentQuestion(question.sessionId, question.toolCallId, action, answers)
}

/**
 * 这条插话现在还撤得回来吗。
 *
 * 三个条件缺一不可：这一轮还在跑（跑完了就没有队可撤）、内核还没读进上下文、
 * 手上有主进程给的号。少判一条就会画出一个点了必然失败的按钮。
 */
function canCancelSteer(block: AgentTimelineSteerBlock): boolean {
  return (
    props.status === 'typing' &&
    !block.applied &&
    !block.cancelled &&
    !!block.steerId &&
    !!block.sessionId
  )
}

function steerStatusLabel(block: AgentTimelineSteerBlock): string {
  if (block.cancelled) return t('assistant.steer.cancelled')
  if (block.applied) return t('assistant.steer.applied')
  return props.status === 'typing' ? t('assistant.steer.pending') : t('assistant.steer.notApplied')
}

/**
 * 撤回一条还排着的插话。
 *
 * 撤不掉是常态而不是故障 —— 用户点下去的那一刻内核可能刚好把它读走了。
 * 那时要如实说一句「晚了一步」：什么都不说的话，用户看着按钮点下去毫无反应，
 * 只会再点几次。
 */
async function onCancelSteer(block: AgentTimelineSteerBlock): Promise<void> {
  if (!block.steerId || !block.sessionId) return
  if (await cancelUserSteer(block.sessionId, block.steerId)) return
  message.info(t('assistant.steer.cancelTooLate'))
}

const timelineText = computed(() => joinTimelineText(props.agentProcess || []))

const hasTimelineText = computed(() => timelineText.value.trim().length > 0)

/** 时间线之外多出来的正文（报错、「用户已停止」的追加、没有时间线的老消息） */
const trailingContent = computed(() =>
  shouldShowAgentProcessLog.value
    ? resolveTrailingContent(props.content, timelineText.value)
    : props.content
)

const showTrailingContent = computed(() => {
  const text = trailingContent.value
  // 正文已经在时间线里逐段显示过了，这里只补差额，没差额就别开一个空块
  if (shouldShowAgentProcessLog.value && hasTimelineText.value) return text.trim().length > 0
  // 时间线上已经有东西在转圈了，就不再挂一行「思考中...」占位字
  if (props.status === 'typing' && timelineBlocks.value.length > 0 && isTypingPlaceholder(text)) {
    return false
  }
  return !(props.status === 'typing' && !text.trim() && props.agentProcess !== undefined)
})

/**
 * 判断是否是占位符状态（普通对话模式）
 * 条件：status为typing，content还是占位符，且没有agentProcess
 */
const isThinkingPlaceholder = computed(() => {
  return (
    props.status === 'typing' &&
    isTypingPlaceholder(props.content) &&
    props.agentProcess === undefined
  )
})

/*
 * 手动朗读。念的和自动朗读是同一份 —— 最终答复那一段，过程里的解说不念
 * （`finalReplyText` 上写着为什么）。
 *
 * 回复落定后的**自动**朗读不在这里：那件事归应用级的 `autoReadAloud`，用户切走
 * 页面（助手页没 keepAlive）也照念不误。那个文件的头部写着为什么不能长在气泡上。
 */
const readAloud = useReadAloud(() => props.id)
const readableReply = computed(() =>
  finalReplyText(
    props.content,
    props.agentProcess,
    props.actionButtons?.some((button) => button.action === AGENT_RESUME_ACTION)
  )
)
/*
 * 这一条又开始重跑了（重试、续跑）：正在念的是上一版的内容，掐掉。
 *
 * 只认 done → typing 这一个方向。反方向那次翻转正是自动朗读开念的时刻，
 * 在这儿顺手 stop 一下就会把它当场掐死。
 */
watch(
  () => props.status,
  (status, previous) => {
    if (status === 'typing' && previous === 'done') readAloud.stop()
  }
)

const emit = defineEmits<{
  (e: 'retry', payload: { id: string; content: string }): void
  (e: 'stop', payload: { id: string }): void
  (e: 'suggest', payload: { id: string; text: string }): void
  (e: 'copy', payload: { id: string; content: string }): void
  (e: 'fork', payload: { id: string }): void
  (e: 'followups-ready', payload: { id: string }): void
  (e: 'resize'): void
  (e: 'open-location', folderKey: string, assetKey?: string): void
  (e: 'source-click', source: any): void
  (e: 'action', payload: { id: string; action: string; data?: Record<string, unknown> }): void
}>()

// 带默认值注入：没挂路由的宿主（测试、独立窗口）里不报「找不到 router」
const router = inject(routerKey, null)

/**
 * 派发按钮动作。
 *
 * `open-location` 已经有专门的事件通路（导航到资产目录），走它而不是再造一条；
 * 其余动作统一冒到 `action`，由页面决定怎么处理。
 */
function emitAction(button: MessageActionButton): void {
  if (button.action === 'open-location') {
    emit('open-location', String(button.data?.folderKey ?? ''), button.data?.assetKey as string)
    return
  }
  // Box Plan 的错误提示（管理订阅、去重新连接）在这里就地处理，
  // 不冒到页面：气泡放在哪个宿主里都能用，不用每个宿主各接一遍
  if (isCreatorPlanAction(button.action)) {
    void runCreatorPlanAction(button.action, () =>
      router?.push({ path: '/preferences', query: { tab: 'models' } })
    )
    return
  }
  emit('action', { id: props.id, action: button.action, data: button.data })
}

function isResumeAction(button: MessageActionButton): boolean {
  return button.action === AGENT_RESUME_ACTION
}

function resumeTitle(button: MessageActionButton): string {
  const title = button.data?.recoveryTitle
  return typeof title === 'string' && title.trim()
    ? title
    : t('assistant.agentMode.agentExecFailed')
}

function resumeReason(button: MessageActionButton): string {
  const reason = button.data?.recoveryReason
  return typeof reason === 'string' && reason.trim()
    ? reason
    : t('assistant.agentMode.resumeReasonUnknown')
}

function getSkillSourceLabel(source?: 'project' | 'user' | 'builtin'): string {
  if (source === 'project') {
    return t('assistant.agentMode.projectSkill')
  }
  if (source === 'user') {
    return t('assistant.agentMode.userSkill')
  }

  return t('assistant.agentMode.builtinSkill')
}

// 复制成功状态
const isCopied = ref(false)
let copyTimeoutId: ReturnType<typeof setTimeout> | null = null

/**
 * 对话里那个能转着看的 3D 预览要显示谁。
 *
 * 生成的模型**必须**给人眼看：模型自己看不到网格（没有能进上下文的形式），
 * 拓扑、朝向、有没有穿模全靠用户判断，而一次生成要几十秒到几分钟、还扣额度。
 * 只留一行「已存进素材库 C:\...\战斧.glb」的话，用户得自己去翻文件夹。
 *
 * 两个来源都要看，理由见 `agentGeneratedMedia`：`toolResults` 只有 V2 时代的
 * 历史消息里还有值，V3 的完成事件不再回传整段 messages，那条路上它恒为空 ——
 * 这个预览器因此一次都没显示出来过。真正有值的是过程日志里的工具结果。
 *
 * 一轮里生成了几个就摆几个框，一个模型一个。以前是只把最后一个递给同一个预览器，
 * 用户只能看到最后那个。每个模型各挂各的实例，filePath 一辈子不变，就没这回事了。
 *
 * 每个预览器要占一个 WebGL 上下文、浏览器给的数量有限，所以除了最新的那个，
 * 其余默认收起（收起 = 卸载 loader = 把上下文还回去），标题栏还留着文件名。
 */
const musicTracks = computed(() =>
  collectGeneratedMusic({ toolResults: props.toolResults, agentProcess: props.agentProcess })
)

const modelPreviewPaths = computed<string[]>(() => {
  const { models } = collectGeneratedMediaFromAgentArtifacts({
    toolResults: props.toolResults,
    agentProcess: props.agentProcess
  })
  return models
})

/**
 * 从 toolResults 中提取资产搜索结果
 * 注意：使用最后一个资产搜索结果，以确保显示最新的搜索结果
 * 支持两种工具名称：
 * - 'asset-manager': Agent V1 使用的工具名
 * - 'search_assets': Agent V2 使用的工具名
 */
const assetSearchResult = computed<{ assets: any[]; totalCount: number } | null>(() => {
  if (!props.toolResults || props.toolResults.length === 0) {
    return null
  }

  // 资产搜索工具名称集合（兼容 V1 和 V2）
  const assetSearchToolNames = ['asset-manager', 'search_assets']

  // 从后往前查找，获取最后一个资产搜索结果
  let assetResult: ToolResult | undefined
  for (let i = props.toolResults.length - 1; i >= 0; i--) {
    if (assetSearchToolNames.includes(props.toolResults[i].toolName)) {
      assetResult = props.toolResults[i]
      break
    }
  }

  if (!assetResult || !assetResult.result) {
    return null
  }

  const result = assetResult.result
  // 检查是否是搜索操作且成功
  if (result.success && result.assets && Array.isArray(result.assets) && result.assets.length > 0) {
    return {
      assets: result.assets,
      totalCount: result.count || result.assets.length
    }
  }

  return null
})

/**
 * 从 toolResults 和 agentProcess 中提取导航结果
 * 用于渲染可交互的导航按钮
 */
const navigationResult = computed<{
  buttonText: string
  description: string
  target: {
    module: 'aigc' | 'asset' | 'notebook'
    tab?: 'image' | '3d'
    prompt?: string
    folderKey?: string
    assetKey?: string
    notebookId?: string
  }
} | null>(() => {
  // 1. 首先从 toolResults 查找
  if (props.toolResults && props.toolResults.length > 0) {
    for (const toolResult of props.toolResults) {
      const result = toolResult.result
      // 检查是否是导航结果（action === 'navigate'）
      if (result && result.action === 'navigate' && result.target) {
        console.log('[AIBubble] 从 toolResults 检测到导航结果:', result)
        return {
          buttonText: result.buttonText || '🚀 带我过去',
          description: result.description || '',
          target: result.target
        }
      }
    }
  }

  // 2. 然后从 agentProcess 查找 (route_to_specialist 返回的工具结果)
  if (props.agentProcess && props.agentProcess.length > 0) {
    for (const item of props.agentProcess) {
      if (item.type === 'tool-result' && item.data) {
        const { toolName, result } = item.data as { toolName?: string; result?: any }

        // 检查 route_to_specialist 工具返回的专家结果
        if (toolName === 'route_to_specialist' && result?.success && result?.data) {
          const specialistData = result.data
          const nestedToolResults = specialistData.toolResults as Array<any> | undefined

          if (Array.isArray(nestedToolResults)) {
            for (const nestedResult of nestedToolResults) {
              if (nestedResult && nestedResult.action === 'navigate' && nestedResult.target) {
                console.log(
                  '[AIBubble] 从 agentProcess (route_to_specialist) 检测到导航结果:',
                  nestedResult
                )
                return {
                  buttonText: nestedResult.buttonText || '🚀 带我过去',
                  description: nestedResult.description || '',
                  target: nestedResult.target
                }
              }
            }
          }
        }

        // 直接检查工具结果本身是否是导航结果
        if (result && result.action === 'navigate' && result.target) {
          console.log('[AIBubble] 从 agentProcess (直接工具) 检测到导航结果:', result)
          return {
            buttonText: result.buttonText || '🚀 带我过去',
            description: result.description || '',
            target: result.target
          }
        }
      }
    }
  }

  return null
})

/**
 * 处理资产点击事件
 * 传递完整的资产对象，包括 folderKey 和 assetKey
 */
function handleAssetClick(asset: any): void {
  // 如果有 folderKey，跳转到文件夹并选中资产
  if (asset.folderKey && asset.folderKey !== 'ALL') {
    emit('open-location', asset.folderKey, asset.assetKey)
  }
}

const suggestions = computed<string[]>(() => {
  // 只使用外部传入的建议，不使用模拟数据降级
  return props.externalSuggestions || []
})
const showFollowUps = computed<boolean>(() => !!props.showFollowUps)
const toolsMode = computed<'hover' | 'always'>(() => props.toolsMode || 'always')

/**
 * 当跟进建议准备好并显示时，通知上层进行滚动处理。
 */
function notifyFollowupsReady(): void {
  if (props.status === 'done' && showFollowUps.value && suggestions.value.length) {
    emit('followups-ready', { id: props.id })
  }
}

onMounted(async () => {
  await nextTick()
  notifyFollowupsReady()
})

watch([() => props.status, showFollowUps, () => suggestions.value.length], () => {
  notifyFollowupsReady()
})

/**
 * 触发重试操作事件。
 */
function emitRetry(): void {
  emit('retry', { id: props.id, content: props.content })
}

/**
 * 触发复制事件。
 */
function emitCopy(): void {
  emit('copy', { id: props.id, content: props.content })

  // 设置复制成功状态
  isCopied.value = true

  // 清除之前的定时器
  if (copyTimeoutId) {
    clearTimeout(copyTimeoutId)
  }

  // 2秒后恢复为复制图标
  copyTimeoutId = setTimeout(() => {
    isCopied.value = false
    copyTimeoutId = null
  }, 2000)
}

/**
 * 触发会话分支事件。分的是整个会话（内核 transcript），不是这条消息，
 * payload 里的 id 只是将来做「从某一轮分叉」时留下的锚点。
 */
function emitFork(): void {
  emit('fork', { id: props.id })
}

/**
 * 点击跟进建议。
 * @param text 建议文本
 */
function emitSuggest(text: string): void {
  emit('suggest', { id: props.id, text })
}

function emitSourceClick(source: any): void {
  emit('source-click', source)
}

// ==================== 本轮 token 用量 ====================
const tokenUsage = computed(() => {
  const usage = props.responseMetadata?.usage
  return hasTurnUsage(usage) ? usage : undefined
})

/** 图标行末尾那一小段。有价才带价 —— 自带模型（费用 0）不该显示「$0.00」 */
const tokenUsageLabel = computed(() => {
  const usage = tokenUsage.value
  if (!usage) return ''
  const total = formatTokenCount(usage.total)
  const cost = formatUsageCost(usage.cost)
  return cost
    ? t('assistant.tokenUsage.labelWithCost', { total, cost })
    : t('assistant.tokenUsage.label', { total })
})

/** 悬浮明细。缓存那两项为 0 时不列 —— 大多数厂商压根不报缓存 */
const tokenUsageRows = computed<Array<{ label: string; value: string }>>(() => {
  const usage = tokenUsage.value
  if (!usage) return []

  const rows = [
    { label: t('assistant.tokenUsage.input'), value: formatExactTokenCount(usage.input) },
    { label: t('assistant.tokenUsage.output'), value: formatExactTokenCount(usage.output) }
  ]
  if (usage.cacheRead > 0) {
    rows.push({
      label: t('assistant.tokenUsage.cacheRead'),
      value: formatExactTokenCount(usage.cacheRead)
    })
  }
  if (usage.cacheWrite > 0) {
    rows.push({
      label: t('assistant.tokenUsage.cacheWrite'),
      value: formatExactTokenCount(usage.cacheWrite)
    })
  }
  rows.push({ label: t('assistant.tokenUsage.total'), value: formatExactTokenCount(usage.total) })

  const cost = formatUsageCost(usage.cost)
  if (cost) rows.push({ label: t('assistant.tokenUsage.cost'), value: cost })

  return rows
})

// ==================== 本轮改动 ====================
/** 清单默认收起；标题保留摘要和不可回滚提醒，需要明细时再由用户展开 */
const changesExpanded = ref(false)

/** 展开了明细的行。收起是默认 —— 展开区是排查用的，不是日常要读的 */
const expandedGroups = ref(new Set<string>())

/**
 * 一行一个被动过的东西。
 *
 * 存进消息里的仍然是逐次调用的 `changes`（历史消息也是那个形状），
 * 聚合放在渲染这一侧做：老消息不用迁移，换了聚合规则也立刻对历史生效。
 */
const changeGroups = computed(() => groupChanges(props.responseMetadata?.changes ?? []))

/** 硬盘上的文件 —— 这些能打开、能定位、能复制路径 */
const fileGroups = computed(() => changeGroups.value.filter((group) => group.local))

const fileDiffs = computed(() => {
  const changes: FileChange[] = []
  for (const item of props.agentProcess ?? []) {
    if (item.type !== 'tool-result' || item.data?.isError) continue
    let result = item.data?.result
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result)
      } catch {
        continue
      }
    }
    const change = readFileChange((result as { fileChange?: unknown } | undefined)?.fileChange)
    if (change) changes.push(change)
  }
  return mergeFileChanges(changes)
})

function diffsForPath(path: string): FileChange[] {
  const key = (value: string): string => {
    const normalized = value.replace(/\\/g, '/')
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
  }
  return fileDiffs.value.filter((change) => key(change.path) === key(path))
}

/**
 * 这批快照的「指纹」—— 内容真的变了才会变。
 *
 * `fileDiffs` 挂在 `props.agentProcess` 上，而那个数组在一次回答里**每来一段流
 * 就变一次**。下面那份计数要跑完整的 LCS（`fileDiff` 允许 n*m 到一百万，也就是
 * 一次四兆的 Uint32Array 加一百万次循环），直接写成 computed 的话，流式输出期间
 * 每收一批 token 就把每个改过的文件重算一遍 —— 全在主线程上，而算出来的东西
 * 只是文件名旁边那两个数字。
 *
 * 指纹只看路径和两端长度：这几样一样就说明还是那一批快照，没必要重算。
 */
const fileDiffSignature = computed(() =>
  fileDiffs.value.map((c) => `${c.path}:${c.before.length}:${c.after.length}`).join('|')
)

function computeReviewGroups(): ((typeof fileGroups.value)[number] & {
  directory: string
  diffs: FileChange[]
  added: number
  removed: number
})[] {
  return fileGroups.value.map((group) => {
    const diffs = diffsForPath(group.target)
    // 一趟数完，不为 add / remove 各把整份 diff 再走一遍
    let added = 0
    let removed = 0
    for (const change of diffs) {
      for (const row of fileDiff(change.before, change.after)) {
        if (row.kind === 'add') added++
        else if (row.kind === 'remove') removed++
      }
    }
    const normalized = group.target.replace(/\\/g, '/')
    return {
      ...group,
      directory: normalized.slice(0, normalized.lastIndexOf('/') + 1),
      diffs,
      added,
      removed
    }
  })
}

const fileReviewGroups = shallowRef<ReturnType<typeof computeReviewGroups>>([])

watch([fileGroups, fileDiffSignature], () => (fileReviewGroups.value = computeReviewGroups()), {
  immediate: true
})
const openFileReview = useFileReview()

/**
 * 控制台命令 / Python 脚本单独成区。
 *
 * 它们动的是引擎，但没有一个能打开、能审查的资产路径，混进「引擎里的改动」
 * 那一区会变成一堆没有名字的行；又恰恰是这一类最需要原样展示 —— 一段脚本
 * 干了什么，只有原文说得清。一个工具一类步骤，组的 steps 同名同 detail 才
 * 合并，所以每一行天然只对应一条命令。
 *
 * **本地命令行不在这里**：它记进台账（「用量」页照常统计），但不上面板，
 * 见 `changeSummary.ts` 的 `PANEL_HIDDEN_TOOLS`。
 */
const SHELL_TOOLS = new Set(['ue_run_python_script', 'ue_run_console_command'])

function isShellGroup(group: ChangeGroup): boolean {
  return SHELL_TOOLS.has(group.steps[0]?.toolName ?? '')
}

const shellGroups = computed(() =>
  changeGroups.value.filter((group) => !group.local && isShellGroup(group))
)

/** 引擎里的改动（蓝图 / 材质 / Actor / 插件），没有对应的磁盘文件可打开 */
const engineGroups = computed(() =>
  changeGroups.value.filter((group) => !group.local && !isShellGroup(group))
)

const { menuItems: filePathMenuItems, runFilePathAction } = useFilePathMenu({ includeOpen: false })

/**
 * 全是文件时按图里的说法写「N 个文件已更改」，混着引擎改动或命令行就退回总数。
 *
 * 这个数现在是**东西的个数**，不是工具调用次数 —— 做一个材质是 1，不是 36。
 * 前者是用户工程里的事实，后者是 agent 的施工步数，只有前者值得放进标题。
 */
const changesTitle = computed(() =>
  engineGroups.value.length === 0 && shellGroups.value.length === 0
    ? t('assistant.changes.fileCount', { count: fileGroups.value.length })
    : t('assistant.changes.title', { count: changeGroups.value.length })
)

/** 有几步是撤不回去的（网页交互、换流送方式这类），单独提示 */
const irreversibleCount = computed(() =>
  changeGroups.value.reduce((sum, group) => sum + group.irreversibleCount, 0)
)

/** 整组都没生效才算「未生效」—— 二十步里错一步不该把整行划掉 */
function isAllFailed(group: ChangeGroup): boolean {
  return group.failedCount > 0 && group.failedCount === group.stepCount
}

/** 失败标记：全挂了说「未生效」，挂了一部分要说清是几步 */
function failureTag(group: ChangeGroup): string {
  if (group.failedCount === 0) return ''
  if (isAllFailed(group)) return t('assistant.changes.failed')
  return t('assistant.changes.partialFailed', { count: group.failedCount })
}

/** 行上显示的名字：资产路径的最后一段；万能工具没有路径，退回那一步做了什么 */
function groupName(group: ChangeGroup): string {
  return group.target ? basenameOf(group.target) : changeLabel(group.steps[0])
}

/**
 * 这一行要不要标「新建 / 删除」。
 *
 * **「修改」不标。** 这个面板叫「本轮改动」，里面每一行本来就是改动，
 * 再给每行挂一个「修改」等于把标题重复 N 遍 —— 用户刚让 agent 改的材质，
 * 标一个「修改」告诉不了他任何新东西。留下的两个标签因此才有意义：
 * 看见「新建」就是工程里多了个东西，看见「删除」就是少了个。
 *
 * 另外两种情况也不标，因为这行没指着一个具体的东西：
 * - 取不到目标的万能工具（`ue_run_python_script`）—— 说不清是「谁」被新建了；
 * - 经引擎工具集（MCP）做的 —— 那里的 target 是派发过去的工具名，不是资产，
 *   「EditorAppToolset.select_actors 修改」读起来像病句。
 */
function showAction(group: ChangeGroup): boolean {
  return group.action !== 'modified' && group.target !== '' && !isMcpChange(group.steps[0])
}

/**
 * 展开能不能多说出点东西。
 *
 * 有目标的行一定能（行上只有资产名，展开才知道对它做了什么）；没目标的行
 * 名字就是那一步本身，只调用过一次的话展开还是同一行字，那就别给箭头。
 */
function isExpandable(group: ChangeGroup): boolean {
  return group.target !== '' || group.steps.length > 1 || group.steps[0].count > 1
}

function toggleGroup(key: string): void {
  if (expandedGroups.value.has(key)) expandedGroups.value.delete(key)
  else expandedGroups.value.add(key)
}

// ==================== 审查本轮改动 ====================

/**
 * 能送去审查的目标。
 *
 * 有它才显示审查入口：全是本地文件、或者全是取不到路径的万能调用时，
 * 引擎那边一个问题都答不上来，给个按钮只会让人白点一次。
 */
const reviewTargets = computed(() => reviewTargetsFrom(changeGroups.value))

const reviewing = ref(false)
const reviewFindings = ref<AgentReviewFinding[]>([])
const reviewSummary = ref('')
/** 结论那句话的颜色：查出问题是红的，没查出问题是绿的，没查全是黄的 */
const reviewSummaryTone = ref<'ok' | 'warn' | 'bad'>('ok')
/** 自证请求发出去了没有。发过就在结论后面挂一句「回复在下面」 */
const selfCheckSent = ref(false)

/**
 * 审查一次 —— **一次点击，两件事**。
 *
 * 先问引擎事实（在不在、落盘没有、编译过不过、引用断没断），紧接着把这份
 * 结论摆到模型面前要它自证。两件事拆成两个按钮的话，用户得点两次才知道
 * 一件事的全貌，而中间那个状态（查完了但还没让它解释）对谁都没有用。
 *
 * 机器的结论只留在这条气泡上，不写进消息 —— 引擎状态是**此刻**的事实，
 * 存进历史的话下次打开这条对话，会看到一份早就过期的「已保存」。
 * 模型的自证反过来是要留下的，它作为一条正常的对话消息发出去。
 */
async function runReview(): Promise<void> {
  if (reviewing.value) return

  reviewing.value = true
  reviewFindings.value = []
  reviewSummary.value = ''
  selfCheckSent.value = false

  try {
    const result = await agentV3API.reviewChanges(reviewTargets.value)
    reviewFindings.value = result?.findings ?? []

    if (!result?.engineChecked) {
      // 引擎没连上时**必须**说出来：这时候「没查出问题」只代表命名没问题，
      // 而落盘、编译、断引用这些真正会咬人的检查一项都没跑。
      //
      // 这种情况下也**不发自证**：未连接引擎时内核根本不注册 ue.* 只读工具
      // （见 createAgent.ts 的 resolveTools），模型手上一个能核实的工具都没有，
      // 那时候要它「用工具重新查一遍」，只能换回一段凭记忆编的话 ——
      // 而凭记忆正是自证要禁掉的东西。
      reviewSummaryTone.value = 'warn'
      reviewSummary.value = t('assistant.review.engineOffline')
      return
    }

    if (reviewFindings.value.length === 0) {
      reviewSummaryTone.value = 'ok'
      reviewSummary.value = t('assistant.review.clean', { count: result.checked })
    } else {
      reviewSummaryTone.value = reviewFindings.value.some((item) => item.severity === 'error')
        ? 'bad'
        : 'warn'
      reviewSummary.value = t('assistant.review.found', { count: reviewFindings.value.length })
    }

    // 机器查干净了也照样要它自证 —— 那正是自证最有用的时候：
    // 所有事实都对，但东西不是用户要的
    requestSelfCheck(result.checked)
  } catch (error) {
    reviewSummaryTone.value = 'bad'
    reviewSummary.value = error instanceof Error ? error.message : t('assistant.review.failed')
  } finally {
    reviewing.value = false
  }
}

/** 一条结论的说法。`detail` 是引擎给的具体内容（断掉的引用、建议的前缀） */
function findingText(finding: AgentReviewFinding): string {
  return t(`assistant.review.codes.${finding.code}`, { detail: finding.detail ?? '' })
}

/**
 * 让它自证 —— 审查的后半程，由 `runReview` 自己接着调，不是一个独立入口。
 *
 * 把机器的结论摆到模型面前，要它用只读工具重新核实一遍，并回答机器答不了的
 * 那一半：「这是不是我要的东西」。规矩写在 `composables/selfCheck.ts`。
 *
 * 气泡只负责把数据冒上去：拼话要用户最初那句要求，而那在页面手上（整段消息列表），
 * 这里只看得见自己这一条。
 */
function requestSelfCheck(checked: number): void {
  selfCheckSent.value = true

  emit('action', {
    id: props.id,
    action: SELF_CHECK_ACTION,
    data: {
      // 响应式代理过不了 IPC/结构化克隆那道坎，深拷成普通对象再往上冒
      findings: JSON.parse(JSON.stringify(reviewFindings.value)),
      checked,
      engineChecked: true
    }
  })
}

/** 正在打开的那一行，防止连点 —— 引擎那边要跑一段 Python，不是瞬时的 */
const openingAsset = ref('')

/**
 * 这一行能不能在编辑器里打开。
 *
 * 两道门：得是引擎内的资产路径（Actor 名和万能工具的行都不是），
 * 而且不能是关卡 —— 引擎的定位 API 对 level 类型无效，而「打开关卡」是
 * 切换用户当前的关卡，他只是想看一眼，不该被切走。
 */
function canOpenInEditor(group: ChangeGroup): boolean {
  return group.kind !== 'level' && isEngineAssetPath(group.target)
}

async function openInEditor(group: ChangeGroup): Promise<void> {
  openingAsset.value = group.key
  try {
    const result = await agentV3API.openAsset(group.target)
    if (!result?.success) {
      message.warning(result?.error || t('assistant.changes.openFailed'))
    }
  } catch (error) {
    message.warning(error instanceof Error ? error.message : t('assistant.changes.openFailed'))
  } finally {
    openingAsset.value = ''
  }
}

/**
 * 命令原文可能多行也可能很长：行上只放第一行的前 80 字，
 * 完整原文挂在 title 里，鼠标停上去能看全。
 */
function displayDetail(detail: string | undefined): string {
  const firstLine = String(detail ?? '')
    .split('\n')[0]
    .trim()
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/**
 * 展开区里那一步的差异信息。
 *
 * 插件的 detail 是启停方向（`Enable`），已经变成了这一步的文案（「启用插件」）
 * 和行上的动作标签 —— 再原样印一个英文单词只是噪音。
 */
function stepDetail(step: { toolName: string; detail?: string }): string {
  if (step.toolName === 'ue_manage_plugin') return ''
  return displayDetail(step.detail)
}

/**
 * 行上直接显示的差异信息。
 *
 * 「改了哪个 Actor」在行上，「改成什么」原来只藏在展开区里 —— 而后者恰恰是
 * 用户第一眼要问的：一行「Actor 修改属性」等于没说。
 *
 * 只在这一行确实只做了一件事时才放上去。二十多步搭出来的材质，挑哪一步的
 * detail 放到行上都是以偏概全，那种情况仍旧展开了看。
 */
function rowDetail(group: ChangeGroup): string {
  if (group.steps.length !== 1 || group.steps[0].count !== 1) return ''
  return stepDetail(group.steps[0])
}

/**
 * 一条改动显示成什么。
 *
 * 原来直接印工具名，于是清单长这样：
 *
 *   ue_run_python_script  未生效
 *   ue_run_python_script
 *   ue_save
 *
 * **对用户完全没有意义** —— 他不知道 `ue_run_python_script` 干了什么，
 * 也不知道六条一模一样的记录之间有什么区别。这个面板的存在意义是
 * 「让我知道刚才我的工程被改了什么」，印工具名回答不了这个问题。
 *
 * 有中文文案就用中文；没有就退回工具名（新增工具忘配文案时退化成今天的
 * 样子，而不是显示 undefined）。MCP 来的另走一套说法，见 isMcpChange。
 */
function changeLabel(change: { toolName: string; detail?: string }): string {
  if (isMcpChange(change)) return t('assistant.changes.tools.mcpEngineToolset')

  // 插件管理的启停方向在参数里，一个工具拆成两句话说清「到底启了还是停了」。
  // 查不到方向（历史旧消息存的条目没有 detail）才退回含糊的「启用/停用插件」
  if (change.toolName === 'ue_manage_plugin' && change.detail) {
    return t(
      change.detail === 'Disable'
        ? 'assistant.changes.tools.ue_manage_plugin_disable'
        : 'assistant.changes.tools.ue_manage_plugin_enable'
    )
  }

  const key = changeLabelKey(change.toolName)
  const label = t(key)
  // vue-i18n 查不到 key 时原样回 key 本身
  return label === key ? change.toolName : label
}

function toggleChanges(): void {
  changesExpanded.value = !changesExpanded.value
}
</script>

<style scoped lang="less">
.ai-bubble {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: 100%;
  color: var(--color-text-primary);
}

.content {
  width: 100%;
  font-size: 14px;
  line-height: 1.6;
  user-select: text !important;
  -webkit-user-select: text !important;
  -moz-user-select: text !important;
  -ms-user-select: text !important;
}

// 确保内容区域内的所有元素都可以选择
.content * {
  user-select: text !important;
  -webkit-user-select: text !important;
  -moz-user-select: text !important;
  -ms-user-select: text !important;
}

// 交替时间线里的正文段：和上下两侧的过程框留出一点距离，
// 免得读起来像是过程框自己的一部分
.timeline-text {
  display: block;
  margin-bottom: 10px;
}

// 时间线里的插话：靠右显示成用户气泡，底下一行小字说它到底生效没有
.timeline-steer {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
  margin-bottom: 10px;
}

.timeline-steer-bubble {
  max-width: 72%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
  word-break: break-word;

  // 撤回掉的那条留在原地，但要一眼看出它没算数
  &.cancelled {
    color: var(--color-text-muted);
    text-decoration: line-through;
  }
}

// 缩略图跟着气泡右对齐，尺寸压到刚够认出画的是什么 —— 它是佐证，不是主角
.timeline-steer-images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
  max-width: 72%;
}

.timeline-steer-files {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
  max-width: 72%;
}

.timeline-steer-image {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-subtle);
}

.timeline-steer-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);

  &.applied {
    color: var(--color-success-text);
  }
}

// 撤回按钮平时是灰的，鼠标扫过整条才亮起来 —— 它不该抢「排队中」这行字的注意力
.timeline-steer-cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  transition:
    opacity 0.15s ease,
    color 0.15s ease;

  &:hover {
    opacity: 1;
    color: var(--color-danger-text);
  }
}

.timeline-steer:hover .timeline-steer-cancel {
  opacity: 1;
}

// 3D模型预览样式
.model-preview {
  margin-top: 12px;
  width: 100%;
}

.response-metadata {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.response-metadata-label {
  font-size: 12px;
  color: var(--color-text-muted);
}

.response-metadata-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.response-metadata-chip {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  background: var(--color-bg-surface);
  font-size: 12px;
  line-height: 1.4;
  max-width: 100%;
}

.response-metadata-chip-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.response-metadata-chip-source {
  color: var(--color-accent-text);
  font-weight: 600;
}

.response-metadata-chip-name {
  color: var(--color-text-primary);
}

.response-metadata-chip-path {
  color: var(--color-text-muted);
  font-size: 11px;
  word-break: break-all;
}

// 资产列表样式
.asset-list {
  margin-top: 12px;
  margin-bottom: 12px;
}

.tools {
  padding-left: 3px;
  display: inline-flex;
  align-items: center;
  gap: 18px;
  color: var(--color-text-primary);
}

.read-aloud-tool {
  padding: 0;
  min-width: 0;
  height: auto;
  line-height: 1;
}

.read-aloud-active {
  color: var(--color-text-primary);
}

.tool {
  font-size: 14px;
  cursor: pointer;
}

.token-usage {
  font-size: var(--font-size-xs);
  // 比左边那排图标再淡一档：它是参考信息，不该和「复制 / 重试」抢注意力。
  // 用 muted 而不是同文件里那几处 tertiary —— 后者主题里压根没定义，取不到值。
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: default;
}

.token-usage-tip {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 160px;
}

.token-usage-tip-title {
  font-weight: 600;
}

.token-usage-tip-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-variant-numeric: tabular-nums;
}

.token-usage-tip-hint {
  margin-top: var(--space-1);
  opacity: 0.7;
}

.action-buttons {
  margin-top: var(--space-3);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.resume-action {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-lg);
  background: var(--color-accent-bg);
  color: var(--color-text-primary);
}

.resume-action-icon {
  flex: none;
  width: var(--space-10);
  height: var(--space-10);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-warning-solid);
  color: var(--color-warning-on-solid);
  font-size: var(--font-size-lg);
}

.resume-action-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.resume-action-title {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.resume-action-reason {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.resume-action-cta {
  flex: none;
  height: 28px;
}

.follow-ups {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: auto;
  height: 38px;
  border-radius: 16px !important;
  border: 0;
  background: var(--color-bg-surface-hover) !important;
  color: var(--color-text-primary);

  &:hover {
    background: var(--color-bg-surface-hover) !important;
  }
}

.tools.hover-done {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.ai-bubble:hover .tools.hover-done {
  opacity: 1;
  pointer-events: auto;
}

.loading-container {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
}

.loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #cfcfd6;
  animation: loading-pulse 1.4s infinite ease-in-out;
}

.loading-dot:nth-child(1) {
  animation-delay: -0.32s;
}

.loading-dot:nth-child(2) {
  animation-delay: -0.16s;
}

@keyframes loading-pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.response-changes {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

/* 标题行：左边是展开开关，右边是「审查」。审查不进收起区，见模板里的注释 */
.response-changes-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* 审查摘要可能是一整句（「没有连接的虚幻引擎项目」），宁可折行也别挤标题 */
  flex-wrap: wrap;
}

.response-changes-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.response-changes-caret {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.response-changes-caret.collapsed {
  transform: rotate(-90deg);
}

.response-changes-warn {
  margin-left: auto;
  color: var(--color-warning-text);
}

.response-file-list {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.response-file-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
}

.response-file-item.failed {
  opacity: 0.55;
}

.response-file-review {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.response-file-review :deep(.app-button__label) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}

.response-file-path {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.response-file-diff-missing {
  flex-basis: 100%;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.response-file-name {
  flex: none;
  color: var(--color-text-primary);
  font-weight: 600;
}

.response-file-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-muted);
}

.response-file-counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-2);
  white-space: nowrap;
  font-size: var(--font-size-xs);

  .added {
    color: var(--color-success-text);
  }
  .removed {
    color: var(--color-danger-text);
  }
}

.response-changes-open {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    color: var(--color-text-primary);
    border-color: var(--color-text-muted);
  }

  /* 打开要跑一段引擎 Python，不是瞬时的 —— 期间置灰，避免连点开出一排窗口 */
  &:disabled {
    color: var(--color-text-disabled);
    cursor: default;
  }
}

/* 没有路径可显示的行里没有会伸缩的元素，靠它把按钮顶到右边缘对齐 */
.response-changes-open {
  margin-left: auto;
}

.response-file-open-caret {
  font-size: 9px;
}

.response-changes-engine {
  margin-top: var(--space-2);
}

.response-changes-subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.response-changes-list {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.response-changes-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.response-changes-item.failed {
  color: var(--color-text-muted);
}

.response-changes-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

/* 没有箭头的行也要跟有箭头的对齐，否则清单左边缘是锯齿状的 */
.response-changes-toggle-placeholder {
  flex: none;
  width: 10px;
}

/* 类型标签：材质 / 蓝图 / 关卡。窄且安静，让名字当主角 */
.response-changes-kind {
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.response-changes-name {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-primary);
  font-weight: 500;
}

/* 路径只是定位用的辅助信息，让它先被挤掉 */
.response-changes-target {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/*
 * 命令原文。等宽字体让人一眼认出「这是可以在终端里对得上号的东西」；
 * 行上只放一行，完整原文（含多行命令）挂在 title 里
 */
.response-changes-cmd {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

/* 展开区：这个资产上到底做了哪几件事，同名的合并计数 */
.response-changes-steps {
  margin: 0 0 var(--space-1) var(--space-4);
  padding: 0 0 0 var(--space-2);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 1px solid var(--color-border);
}

.response-changes-step {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.response-changes-repeat {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.response-changes-tag {
  flex: none;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);
  line-height: 16px;
}

.response-changes-tag.warn {
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
}

.response-changes-tag.failed {
  color: var(--color-text-muted);
  background: var(--color-bg-surface-hover);
}

/* 净结果。新建是好消息、删除要显眼、修改最常见所以最安静 */
.response-changes-tag.action-created {
  color: var(--color-success-text);
  background: var(--color-success-bg);
}

.response-changes-tag.action-deleted {
  color: var(--color-danger-text);
  background: var(--color-danger-bg);
}

.response-changes-tag.action-modified {
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
}

/* 插件启停：启用是好消息（跟「新建」同色），停用是中性操作（跟「修改」同色） */
.response-changes-tag.action-enabled {
  color: var(--color-success-text);
  background: var(--color-success-bg);
}

.response-changes-tag.action-disabled {
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
}

/* ==================== 审查 ==================== */

/* 审查条现在是标题行右端的一块，不再是明细下面的一栏，所以没有上边框 */
.response-review {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin-left: auto;
}

.response-review-run {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover:not(:disabled) {
    color: var(--color-text-primary);
    border-color: var(--color-text-muted);
  }

  /* 引擎那边要 load 一遍资产再遍历依赖，不是瞬时的 */
  &:disabled {
    color: var(--color-text-disabled);
    cursor: default;
  }
}

/* 自证的去向提示 —— 它不是按钮，是一句「回复在下面」 */
.response-review-selfcheck {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.response-review-summary {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);

  &.ok {
    color: var(--color-success-text);
  }

  &.warn {
    color: var(--color-warning-text);
  }

  &.bad {
    color: var(--color-danger-text);
  }
}

.response-review-list {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.response-review-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 2px 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/* 严重程度只用一个小圆点表示 —— 三行不同底色的横条会把整个面板变成红绿灯 */
.response-review-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
}

.response-review-item.severity-error .response-review-dot {
  background: var(--color-danger-text);
}

.response-review-item.severity-warning .response-review-dot {
  background: var(--color-warning-text);
}

.response-review-name {
  flex: none;
  color: var(--color-text-primary);
}

.response-review-text {
  min-width: 0;
  word-break: break-word;
}
</style>
