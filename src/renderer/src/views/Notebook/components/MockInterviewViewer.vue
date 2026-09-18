<template>
  <div class="interview-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-left">
        <button class="back-btn" @click="$emit('close')">
          <PhArrowLeft />
        </button>
        <div class="header-info">
          <div class="type-badge">
            <PhQuestion />
            <span>{{ $t('notebookMockInterviewViewer.common.mockInterviewLabel') }}</span>
          </div>
          <h2 class="title">
            {{ config?.topic || $t('notebookMockInterviewViewer.common.mockInterviewLabel') }}
          </h2>
        </div>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="interview-content">
      <!-- 准备开始状态 -->
      <div v-if="currentStatus === 'ready'" class="ready-state">
        <div class="ready-main">
          <div class="ready-info">
            <h3>{{ $t('notebookMockInterviewViewer.ready.topicLabel') }}</h3>
            <p>{{ config?.topic }}</p>
            <h3>{{ $t('notebookMockInterviewViewer.ready.questionCountLabel') }}</h3>
            <p>
              {{
                $t('notebookMockInterviewViewer.ready.questionCountValue', {
                  count: totalQuestions
                })
              }}
            </p>
          </div>
          <AppButton variant="primary" size="large" @click="startInterview">
            {{ $t('notebookMockInterviewViewer.ready.startButton') }}
          </AppButton>
        </div>

        <!-- 历史记录和错题本 tabs -->
        <div v-if="historyList.length > 0 || mistakeList.length > 0" class="history-section">
          <a-tabs v-model:active-key="activeTab" size="small">
            <a-tab-pane
              key="history"
              :tab="
                $t('notebookMockInterviewViewer.tabs.historyTab', { count: historyList.length })
              "
            >
              <div class="history-list">
                <div
                  v-for="item in historyList"
                  :key="item.id"
                  class="history-item"
                  :class="{ expanded: expandedHistoryId === item.id }"
                >
                  <div class="history-header" @click="toggleHistoryDetail(item.id)">
                    <div class="history-info">
                      <span class="history-topic">{{ item.topic }}</span>
                      <span class="history-date">{{ formatDate(item.createdAt) }}</span>
                    </div>
                    <div class="history-actions">
                      <div class="history-score" :class="getScoreClass(item.totalScore)">
                        {{
                          $t('notebookMockInterviewViewer.common.scoreSuffix', {
                            score: item.totalScore
                          })
                        }}
                      </div>
                      <AppButton
                        variant="text"
                        size="small"
                        class="delete-btn"
                        @click.stop="handleDeleteHistory(item.id)"
                      >
                        <template #icon>
                          <PhTrash />
                        </template>
                      </AppButton>
                      <span class="expand-icon">{{
                        expandedHistoryId === item.id ? '▲' : '▼'
                      }}</span>
                    </div>
                  </div>
                  <!-- 历史详情展开区域 -->
                  <div v-if="expandedHistoryId === item.id" class="history-detail">
                    <div class="detail-summary">
                      <span>{{
                        $t('notebookMockInterviewViewer.history.answeredSummary', {
                          answered: item.answeredCount,
                          total: item.totalQuestions
                        })
                      }}</span>
                      <span>{{
                        $t('notebookMockInterviewViewer.history.skippedSummary', {
                          count: item.skippedCount
                        })
                      }}</span>
                    </div>
                    <div class="detail-records">
                      <div
                        v-for="(record, idx) in item.answersRecord"
                        :key="idx"
                        class="detail-record-item"
                      >
                        <div class="record-header">
                          <span class="record-num">{{
                            $t('notebookMockInterviewViewer.history.questionNumber', {
                              num: idx + 1
                            })
                          }}</span>
                          <span v-if="record.skipped" class="record-skipped">{{
                            $t('notebookMockInterviewViewer.common.skippedTag')
                          }}</span>
                          <span
                            v-else-if="record.evaluation"
                            class="record-score"
                            :class="getScoreClass(record.evaluation.score)"
                          >
                            {{
                              $t('notebookMockInterviewViewer.common.scoreSuffixTight', {
                                score: record.evaluation.score
                              })
                            }}
                          </span>
                        </div>
                        <div class="record-question">{{ record.question }}</div>
                        <div v-if="!record.skipped && record.userAnswer" class="record-answer">
                          <strong>{{
                            $t('notebookMockInterviewViewer.history.yourAnswerLabel')
                          }}</strong
                          >{{ record.userAnswer }}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </a-tab-pane>
            <a-tab-pane
              key="mistakes"
              :tab="
                $t('notebookMockInterviewViewer.tabs.mistakesTab', { count: mistakeList.length })
              "
            >
              <div class="mistakes-list">
                <div
                  v-for="item in mistakeList"
                  :key="item.id"
                  class="mistake-item"
                  :class="{ reviewed: item.reviewed, expanded: expandedMistakeId === item.id }"
                >
                  <div class="mistake-header" @click="toggleMistakeDetail(item.id)">
                    <div class="mistake-question">{{ item.question }}</div>
                    <span class="expand-icon">{{ expandedMistakeId === item.id ? '▲' : '▼' }}</span>
                  </div>
                  <div class="mistake-meta">
                    <span class="mistake-score" :class="getScoreClass(item.score)">
                      {{
                        $t('notebookMockInterviewViewer.common.scoreSuffix', {
                          score: item.score
                        })
                      }}
                    </span>
                    <AppButton
                      v-if="!item.reviewed"
                      size="small"
                      variant="link"
                      @click.stop="markReviewed(item.id)"
                    >
                      {{ $t('notebookMockInterviewViewer.mistakes.markReviewedButton') }}
                    </AppButton>
                    <span v-else class="reviewed-tag">{{
                      $t('notebookMockInterviewViewer.mistakes.reviewedTag')
                    }}</span>
                    <AppButton
                      variant="text"
                      size="small"
                      class="delete-btn"
                      @click.stop="handleDeleteMistake(item.id)"
                    >
                      <template #icon>
                        <PhTrash />
                      </template>
                    </AppButton>
                  </div>
                  <!-- 错题详情展开区域 -->
                  <div v-if="expandedMistakeId === item.id" class="mistake-detail">
                    <div class="detail-row">
                      <span class="detail-label">{{
                        $t('notebookMockInterviewViewer.mistakes.yourAnswerLabel')
                      }}</span>
                      <span class="detail-value wrong">{{
                        formatMistakeAnswer(item, item.userAnswer)
                      }}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-label">{{
                        $t('notebookMockInterviewViewer.mistakes.correctAnswerLabel')
                      }}</span>
                      <span class="detail-value correct">{{
                        formatMistakeAnswer(item, item.referenceAnswer)
                      }}</span>
                    </div>
                    <div v-if="item.comment" class="detail-comment">
                      <strong>{{
                        $t('notebookMockInterviewViewer.mistakes.aiCommentLabel')
                      }}</strong>
                      <p>{{ item.comment }}</p>
                    </div>
                    <div class="detail-actions">
                      <AppButton size="small" @click="handleMistakeAskAI(item)">{{
                        $t('notebookMockInterviewViewer.mistakes.askAiButton')
                      }}</AppButton>
                    </div>
                  </div>
                </div>
              </div>
            </a-tab-pane>
          </a-tabs>
        </div>
      </div>

      <!-- 面试进行中 -->
      <div v-else-if="currentStatus === 'interviewing'" class="interview-area">
        <!-- 沉浸式问题卡片 -->
        <div class="immersive-question-card">
          <div class="progress-indicator">
            <div class="progress-ring">
              <svg viewBox="0 0 36 36">
                <circle class="ring-bg" cx="18" cy="18" r="16" />
                <circle
                  class="ring-progress"
                  cx="18"
                  cy="18"
                  r="16"
                  :stroke-dasharray="`${((currentQuestionIndex + 1) / totalQuestions) * 100.5} 100.5`"
                />
              </svg>
              <span class="progress-text">{{ currentQuestionIndex + 1 }}</span>
            </div>
            <span class="progress-total">/ {{ totalQuestions }}</span>
          </div>
          <h2 class="question-text">{{ currentQuestion?.question }}</h2>
        </div>

        <!-- 选择题选项 -->
        <div v-if="currentQuestion?.questionType === 'choice'" class="choice-options">
          <div
            v-for="option in currentQuestion.options"
            :key="option.id"
            class="choice-option"
            :class="{
              selected: selectedOption === option.id,
              correct: showAnswer && option.id === currentQuestion.correctAnswer,
              wrong:
                showAnswer &&
                selectedOption === option.id &&
                option.id !== currentQuestion.correctAnswer
            }"
            @click="selectOption(option.id)"
          >
            <span class="option-id">{{ option.id }}</span>
            <span class="option-text">{{ option.text }}</span>
            <span
              v-if="showAnswer && option.id === currentQuestion.correctAnswer"
              class="correct-mark"
              >✓</span
            >
          </div>

          <!-- 提示按钮 -->
          <div v-if="!showAnswer && !showHint" class="hint-trigger">
            <AppButton variant="link" size="small" @click="showHint = true">
              {{ $t('notebookMockInterviewViewer.interview.hintTriggerButton') }}
            </AppButton>
          </div>
          <div v-if="showHint && !showAnswer" class="hint-box">
            <strong>{{ $t('notebookMockInterviewViewer.interview.hintLabel') }}</strong>
            <p>
              {{ currentQuestion.hint || $t('notebookMockInterviewViewer.interview.hintFallback') }}
            </p>
          </div>
        </div>

        <!-- 答案解释和操作按钮 -->
        <div v-if="showAnswer" class="answer-feedback">
          <div class="feedback-header" :class="{ correct: isCorrect, wrong: !isCorrect }">
            {{
              isCorrect
                ? $t('notebookMockInterviewViewer.interview.correctFeedback')
                : $t('notebookMockInterviewViewer.interview.wrongFeedback')
            }}
          </div>
          <div class="explanation-box">
            <strong>{{ $t('notebookMockInterviewViewer.interview.explanationLabel') }}</strong>
            <p>
              {{
                currentQuestion?.explanation ||
                $t('notebookMockInterviewViewer.interview.explanationFallback')
              }}
            </p>
          </div>
          <!-- 追问区域 -->
          <div v-if="followUpQuestion" class="follow-up-section">
            <div class="follow-up-question">
              <strong>{{ $t('notebookMockInterviewViewer.interview.followUpLabel') }}</strong>
              <p>{{ followUpQuestion }}</p>
            </div>
            <div v-if="!followUpEvaluation" class="follow-up-input">
              <a-textarea
                v-model:value="followUpAnswer"
                :placeholder="$t('notebookMockInterviewViewer.interview.followUpPlaceholder')"
                :rows="3"
                :disabled="isEvaluatingFollowUp"
              />
              <AppButton
                variant="primary"
                :loading="isEvaluatingFollowUp"
                :disabled="!followUpAnswer.trim()"
                @click="submitFollowUp"
              >
                {{ $t('notebookMockInterviewViewer.common.submitAnswerButton') }}
              </AppButton>
            </div>
            <div v-else class="follow-up-result">
              <div class="follow-up-score" :class="getScoreClass(followUpEvaluation.score)">
                {{
                  $t('notebookMockInterviewViewer.common.scoreSuffix', {
                    score: followUpEvaluation.score
                  })
                }}
              </div>
              <div class="follow-up-comment">
                <strong>{{
                  $t('notebookMockInterviewViewer.interview.followUpCommentLabel')
                }}</strong>
                <p>{{ followUpEvaluation.comment }}</p>
              </div>
              <div v-if="followUpEvaluation.referenceAnswer" class="follow-up-reference">
                <strong>{{
                  $t('notebookMockInterviewViewer.interview.followUpReferenceLabel')
                }}</strong>
                <p>{{ followUpEvaluation.referenceAnswer }}</p>
              </div>
            </div>
          </div>

          <div class="feedback-actions">
            <AppButton @click="handleAskAI">{{
              $t('notebookMockInterviewViewer.interview.deepExplainButton')
            }}</AppButton>
            <AppButton
              v-if="!followUpQuestion"
              :loading="isGeneratingFollowUp"
              @click="handleFollowUp"
            >
              {{ $t('notebookMockInterviewViewer.interview.followUpAcceptButton') }}
            </AppButton>
            <AppButton
              variant="primary"
              :disabled="!!followUpQuestion && !followUpEvaluation"
              @click="goToNextQuestion"
            >
              {{
                currentQuestionIndex < totalQuestions - 1
                  ? $t('notebookMockInterviewViewer.common.nextQuestionButton')
                  : $t('notebookMockInterviewViewer.common.finishInterviewButton')
              }}
            </AppButton>
          </div>
        </div>

        <!-- 开放题回答（保留旧逻辑作为备选） -->
        <div v-else-if="currentQuestion?.questionType !== 'choice'" class="answer-box">
          <a-textarea
            v-model:value="userAnswer"
            :placeholder="$t('notebookMockInterviewViewer.interview.answerPlaceholder')"
            :rows="4"
            :disabled="isEvaluating"
          />
          <div class="answer-actions">
            <AppButton @click="skipQuestion">{{
              $t('notebookMockInterviewViewer.interview.skipButton')
            }}</AppButton>
            <AppButton variant="primary" :loading="isEvaluating" @click="submitAnswer">
              {{ $t('notebookMockInterviewViewer.common.submitAnswerButton') }}
            </AppButton>
          </div>
        </div>

        <!-- 开放题评估结果 -->
        <div
          v-if="lastEvaluation && currentQuestion?.questionType !== 'choice'"
          class="evaluation-box"
        >
          <div class="eval-header">
            <div class="score-badge" :class="getScoreClass(lastEvaluation.score)">
              {{
                $t('notebookMockInterviewViewer.common.scoreSuffix', {
                  score: lastEvaluation.score
                })
              }}
            </div>
            <AppButton variant="primary" size="small" @click="goToNextQuestion">
              {{
                currentQuestionIndex < totalQuestions - 1
                  ? $t('notebookMockInterviewViewer.common.nextQuestionButton')
                  : $t('notebookMockInterviewViewer.common.finishInterviewButton')
              }}
            </AppButton>
          </div>
          <div class="eval-comment">
            <strong>{{ $t('notebookMockInterviewViewer.interview.aiCommentLabel') }}</strong>
            <p>{{ lastEvaluation.comment }}</p>
          </div>
          <div v-if="lastEvaluation.referenceAnswer" class="eval-reference">
            <strong>{{ $t('notebookMockInterviewViewer.interview.referenceAnswerLabel') }}</strong>
            <p>{{ lastEvaluation.referenceAnswer }}</p>
          </div>
        </div>
      </div>

      <!-- 完成状态 - 面试报告 -->
      <div v-else-if="currentStatus === 'completed'" class="completed-state">
        <!-- 成就徽章式头部 -->
        <div class="achievement-header">
          <div class="score-ring-container">
            <svg class="score-ring" viewBox="0 0 120 120">
              <circle class="ring-bg" cx="60" cy="60" r="54" />
              <circle
                class="ring-progress"
                :class="getScoreClass(totalScore)"
                cx="60"
                cy="60"
                r="54"
                :stroke-dasharray="`${totalScore * 3.39} 339.3`"
              />
            </svg>
            <div class="score-center">
              <span class="score-value">{{ totalScore }}</span>
              <span class="score-label">{{
                $t('notebookMockInterviewViewer.completed.scoreUnit')
              }}</span>
            </div>
          </div>
          <div class="emotional-feedback">
            <span class="emoji">{{ scoreEmoji }}</span>
            <h3 class="message">{{ scoreMessage }}</h3>
          </div>
        </div>

        <div class="report-summary">
          <div class="summary-item">
            <span class="value"
              >{{ answersRecord.filter((r) => !r.skipped).length }} / {{ totalQuestions }}</span
            >
            <span class="label">{{
              $t('notebookMockInterviewViewer.completed.answeredLabel')
            }}</span>
          </div>
          <div class="summary-item">
            <span class="value correct-count">{{
              answersRecord.filter((r) => r.evaluation?.score === 100).length
            }}</span>
            <span class="label">{{
              $t('notebookMockInterviewViewer.completed.correctLabel')
            }}</span>
          </div>
          <div class="summary-item">
            <span class="value wrong-count">{{
              answersRecord.filter((r) => r.evaluation?.score === 0).length
            }}</span>
            <span class="label">{{ $t('notebookMockInterviewViewer.completed.wrongLabel') }}</span>
          </div>
        </div>

        <div class="answers-review">
          <h4>{{ $t('notebookMockInterviewViewer.completed.reviewTitle') }}</h4>
          <div v-for="record in answersRecord" :key="record.questionIndex" class="review-item">
            <div class="review-header">
              <span class="q-num">{{
                $t('notebookMockInterviewViewer.completed.questionNumberLabel', {
                  num: record.questionIndex + 1
                })
              }}</span>
              <span v-if="record.skipped" class="skipped-tag">{{
                $t('notebookMockInterviewViewer.common.skippedTag')
              }}</span>
              <span
                v-else-if="record.evaluation"
                class="score-tag"
                :class="getScoreClass(record.evaluation.score)"
              >
                {{
                  $t('notebookMockInterviewViewer.common.scoreSuffix', {
                    score: record.evaluation.score
                  })
                }}
              </span>
            </div>
            <p class="q-text">{{ record.question }}</p>
            <div v-if="!record.skipped && record.evaluation" class="review-detail">
              <div class="your-answer">
                <strong>{{ $t('notebookMockInterviewViewer.completed.yourAnswerLabel') }}</strong
                >{{ record.userAnswer }}
              </div>
            </div>
          </div>
        </div>

        <AppButton variant="primary" size="large" @click="$emit('close')">{{
          $t('notebookMockInterviewViewer.completed.backButton')
        }}</AppButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowLeft, PhQuestion, PhTrash } from '@phosphor-icons/vue'
import type { StudioOutput, InterviewConfig } from '@renderer/store/modules/studioOutputStore'
import {
  useMockInterviewStore,
  type InterviewHistory
} from '@renderer/store/modules/mockInterviewStore'
import { createMockInterviewService } from '@renderer/services/mockInterview'
import type { QuestionEvaluation } from '@renderer/services/mockInterview'

/**
 * Props
 */
const props = defineProps<{
  output: StudioOutput
  notebookId: string
}>()

/**
 * 面试历史Store
 */
const interviewStore = useMockInterviewStore()

/**
 * 面试配置
 */
const config = computed<InterviewConfig | undefined>(() => props.output.interviewConfig)
const totalQuestions = computed(() => config.value?.questions?.length || 0)

/**
 * 历史记录和错题本
 */
const activeTab = ref<'history' | 'mistakes'>('history')
const historyList = computed(() => interviewStore.getHistoriesByNotebook(props.notebookId))
const mistakeList = computed(() => interviewStore.getMistakesByNotebook(props.notebookId))

/**
 * 展开状态
 */
const expandedHistoryId = ref<string | null>(null)
const expandedMistakeId = ref<string | null>(null)

/**
 * 切换历史记录详情展开/折叠
 */
function toggleHistoryDetail(historyId: string): void {
  if (expandedHistoryId.value === historyId) {
    expandedHistoryId.value = null
  } else {
    expandedHistoryId.value = historyId
  }
}

/**
 * 切换错题详情展开/折叠
 */
function toggleMistakeDetail(mistakeId: string): void {
  if (expandedMistakeId.value === mistakeId) {
    expandedMistakeId.value = null
  } else {
    expandedMistakeId.value = mistakeId
  }
}

/**
 * 删除历史记录
 */
function handleDeleteHistory(historyId: string): void {
  interviewStore.removeHistory(historyId)
  if (expandedHistoryId.value === historyId) {
    expandedHistoryId.value = null
  }
}

/**
 * 删除错题
 */
function handleDeleteMistake(mistakeId: string): void {
  interviewStore.removeMistake(mistakeId)
  if (expandedMistakeId.value === mistakeId) {
    expandedMistakeId.value = null
  }
}

/**
 * 错题问AI解释
 */
import type { MistakeRecord } from '@renderer/store/modules/mockInterviewStore'

function handleMistakeAskAI(mistake: MistakeRecord): void {
  // 构建选项内容字符串
  let optionsText = ''
  if (mistake.options && mistake.options.length > 0) {
    optionsText = `\n**选项：**\n${mistake.options.map((o) => `${o.id}. ${o.text}`).join('\n')}\n`
  }

  // 构建用户答案和正确答案的显示
  let userAnswerDisplay = mistake.userAnswer
  let correctAnswerDisplay = mistake.referenceAnswer

  // 如果有选项，尝试找到选项文本
  if (mistake.options && mistake.options.length > 0) {
    const userOption = mistake.options.find((o) => o.id === mistake.userAnswer)
    const correctOption = mistake.options.find((o) => o.id === mistake.referenceAnswer)
    if (userOption) {
      userAnswerDisplay = `${mistake.userAnswer}. ${userOption.text}`
    }
    if (correctOption) {
      correctAnswerDisplay = `${mistake.referenceAnswer}. ${correctOption.text}`
    }
  }

  const context = `我在复习错题，需要你帮我解释这道题：

**题目：** ${mistake.question}
${optionsText}
**我的答案：** ${userAnswerDisplay}
**正确答案：** ${correctAnswerDisplay}

请详细解释这道题的正确答案，以及为什么其他选项是错误的，帮助我理解这个知识点。`

  emit('askAI', context)
}

/**
 * 格式化错题答案显示（将选项ID转换为完整选项内容）
 */
function formatMistakeAnswer(mistake: MistakeRecord, answerId: string): string {
  if (!answerId) return '未作答'
  // 如果有选项，查找对应的选项文本
  if (mistake.options && mistake.options.length > 0) {
    const option = mistake.options.find((o) => o.id === answerId)
    if (option) {
      return `${option.id}. ${option.text}`
    }
  }
  // 没有选项或未找到，直接返回原值（可能是开放题答案）
  return answerId
}

/**
 * 格式化日期
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 标记错题为已复习
 */
function markReviewed(mistakeId: string): void {
  interviewStore.markMistakeReviewed(mistakeId)
}

/**
 * 面试状态
 */
const currentStatus = ref<'ready' | 'interviewing' | 'completed'>('ready')
const currentQuestionIndex = ref(0)
const userAnswer = ref('')
const isEvaluating = ref(false)
const lastEvaluation = ref<QuestionEvaluation | null>(null)

/**
 * 选择题状态
 */
const selectedOption = ref<string | null>(null)
const showAnswer = ref(false)
const showHint = ref(false)

/**
 * 追问相关状态
 */
const followUpQuestion = ref<string | null>(null)
const followUpAnswer = ref('')
const isGeneratingFollowUp = ref(false)
const isEvaluatingFollowUp = ref(false)
const followUpEvaluation = ref<QuestionEvaluation | null>(null)

/**
 * 判断选择是否正确
 */
const isCorrect = computed(() => {
  return selectedOption.value === currentQuestion.value?.correctAnswer
})

/**
 * 面试结果记录接口
 */
interface AnswerRecord {
  questionIndex: number
  question: string
  userAnswer: string
  evaluation: QuestionEvaluation | null
  skipped: boolean
}

/**
 * 面试结果记录
 */
const answersRecord = ref<AnswerRecord[]>([])

/**
 * 计算总分
 */
const totalScore = computed(() => {
  const validAnswers = answersRecord.value.filter((r) => r.evaluation && !r.skipped)
  if (validAnswers.length === 0) return 0
  const sum = validAnswers.reduce((acc, r) => acc + (r.evaluation?.score || 0), 0)
  return Math.round(sum / validAnswers.length)
})

/**
 * 情感化反馈 - Emoji
 */
const scoreEmoji = computed(() => {
  if (totalScore.value >= 90) return '🏆'
  if (totalScore.value >= 70) return '💪'
  if (totalScore.value >= 50) return '📚'
  return '🌱'
})

/**
 * 情感化反馈 - 消息
 */
const scoreMessage = computed(() => {
  if (totalScore.value >= 90) return '虚幻大师！Epic 都要来挖你了'
  if (totalScore.value >= 70) return '表现不错！继续保持'
  if (totalScore.value >= 50) return '再接再厉，多刷文档哦'
  return '别灰心，知识需要一点点积累'
})

/**
 * 当前问题
 */
const currentQuestion = computed(() => {
  return config.value?.questions?.[currentQuestionIndex.value]
})

/**
 * 面试服务
 */
const interviewService = createMockInterviewService()

/**
 * 选择答案
 */
function selectOption(optionId: string): void {
  if (showAnswer.value) return // 已经回答过了
  selectedOption.value = optionId
  showAnswer.value = true

  // 记录答案
  answersRecord.value.push({
    questionIndex: currentQuestionIndex.value,
    question: currentQuestion.value?.question || '',
    userAnswer: optionId,
    evaluation: {
      score: isCorrect.value ? 100 : 0,
      referenceAnswer: currentQuestion.value?.correctAnswer || '',
      comment: currentQuestion.value?.explanation || '',
      dimensions: {
        conceptUnderstanding: isCorrect.value ? 100 : 0,
        methodMastery: isCorrect.value ? 100 : 0,
        toolUsage: isCorrect.value ? 100 : 0,
        logicClarity: isCorrect.value ? 100 : 0,
        practicalExperience: isCorrect.value ? 100 : 0
      }
    },
    skipped: false
  })
}

/**
 * 定义emit来触发AI对话
 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'askAI', context: string): void
}>()

/**
 * 跳转AI解释
 */
function handleAskAI(): void {
  const context = `我在做知识测试，遇到了这道题想请你解释：

**问题：** ${currentQuestion.value?.question}

**选项：**
${currentQuestion.value?.options?.map((o) => `${o.id}. ${o.text}`).join('\n')}

**正确答案是：** ${currentQuestion.value?.correctAnswer}
**我选择的是：** ${selectedOption.value}

请帮我详细解释这道题的正确答案，以及为什么其他选项是错误的。`

  emit('askAI', context)
}

/**
 * 开始面试
 */
function startInterview(): void {
  currentStatus.value = 'interviewing'
  currentQuestionIndex.value = 0
  userAnswer.value = ''
  lastEvaluation.value = null
  // 重置选择题状态
  selectedOption.value = null
  showAnswer.value = false
  showHint.value = false
}

/**
 * 提交回答
 */
async function submitAnswer(): Promise<void> {
  if (!userAnswer.value.trim() || !currentQuestion.value || !config.value) return

  isEvaluating.value = true

  // 找到对应的知识点
  const knowledgePoint = config.value.knowledgePoints?.find(
    (kp) => kp.id === currentQuestion.value?.sourceId
  )

  if (knowledgePoint) {
    const evaluation = await interviewService.evaluateAnswer(
      currentQuestion.value as never,
      knowledgePoint,
      userAnswer.value
    )
    lastEvaluation.value = evaluation

    // 记录答案
    answersRecord.value.push({
      questionIndex: currentQuestionIndex.value,
      question: currentQuestion.value?.question || '',
      userAnswer: userAnswer.value,
      evaluation,
      skipped: false
    })
  }

  isEvaluating.value = false
  // 用户可以查看反馈后手动点击下一题
}

/**
 * 根据分数返回样式类名
 */
function getScoreClass(score: number): string {
  if (score >= 80) return 'high'
  if (score >= 60) return 'medium'
  return 'low'
}

/**
 * 跳过问题
 */
function skipQuestion(): void {
  // 记录跳过的答案
  answersRecord.value.push({
    questionIndex: currentQuestionIndex.value,
    question: currentQuestion.value?.question || '',
    userAnswer: '',
    evaluation: null,
    skipped: true
  })
  goToNextQuestion()
}

/**
 * 保存面试历史记录
 */
function saveInterviewHistory(): void {
  if (!config.value || !props.notebookId) return

  const history: InterviewHistory = {
    id: `interview-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    notebookId: props.notebookId,
    topic: config.value.topic,
    createdAt: new Date().toISOString(),
    totalScore: totalScore.value,
    totalQuestions: totalQuestions.value,
    answeredCount: answersRecord.value.filter((r) => !r.skipped).length,
    skippedCount: answersRecord.value.filter((r) => r.skipped).length,
    answersRecord: answersRecord.value,
    knowledgePoints: config.value.knowledgePoints || [],
    questions: config.value.questions || []
  }

  interviewStore.addHistory(history)
}

/**
 * 进入下一题
 */
function goToNextQuestion(): void {
  if (currentQuestionIndex.value < totalQuestions.value - 1) {
    currentQuestionIndex.value++
    userAnswer.value = ''
    lastEvaluation.value = null
    // 重置选择题状态
    selectedOption.value = null
    showAnswer.value = false
    showHint.value = false
    // 重置追问状态
    followUpQuestion.value = null
    followUpAnswer.value = ''
    followUpEvaluation.value = null
  } else {
    currentStatus.value = 'completed'
    // 保存面试历史
    saveInterviewHistory()
  }
}

/**
 * 触发追问
 */
async function handleFollowUp(): Promise<void> {
  if (!currentQuestion.value || isGeneratingFollowUp.value) return

  isGeneratingFollowUp.value = true
  try {
    const question = await interviewService.generateFollowUpQuestion(
      currentQuestion.value as never,
      selectedOption.value || '',
      isCorrect.value
    )
    if (question) {
      followUpQuestion.value = question
    }
  } catch (error) {
    console.error('[MockInterviewViewer] 生成追问失败:', error)
  } finally {
    isGeneratingFollowUp.value = false
  }
}

/**
 * 提交追问回答
 */
async function submitFollowUp(): Promise<void> {
  if (!followUpQuestion.value || !followUpAnswer.value.trim() || !currentQuestion.value) return

  isEvaluatingFollowUp.value = true
  try {
    const evaluation = await interviewService.evaluateFollowUpAnswer(
      followUpQuestion.value,
      followUpAnswer.value,
      currentQuestion.value as never
    )
    if (evaluation) {
      followUpEvaluation.value = evaluation
    }
  } catch (error) {
    console.error('[MockInterviewViewer] 评估追问回答失败:', error)
  } finally {
    isEvaluatingFollowUp.value = false
  }
}
</script>

<style scoped lang="less">
.interview-viewer {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: radial-gradient(circle at 50% 0%, var(--color-bg-surface), rgba(10, 10, 10, 0.95));
  border-radius: 12px;
  overflow: hidden;
  position: relative;

  // Ambient light effect
  &::before {
    content: '';
    position: absolute;
    top: -20%;
    left: 20%;
    width: 60%;
    height: 60%;
    background: radial-gradient(circle, rgba(13, 122, 255, 0.08), transparent 70%);
    pointer-events: none;
    z-index: 0;
  }
}

.viewer-header {
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  background: var(--color-bg-sunken);
  backdrop-filter: blur(24px);
  border-bottom: 1px solid var(--color-border-subtle);
  z-index: 10;
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: 20px;

    .back-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 1px solid var(--color-border-subtle);
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.2, 0, 0, 1);

      &:hover {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border);
        color: var(--color-text-primary);
        box-shadow: 0 0 16px var(--shadow-highlight);
      }
    }

    .header-info {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .type-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.5px;
        color: var(--color-accent-text);
        background: var(--color-accent-bg);
        padding: 2px 8px;
        border-radius: 12px;
        width: fit-content;
        border: 1px solid var(--color-accent-border);
      }

      .title {
        font-size: 18px;
        font-weight: 600;
        color: var(--color-text-primary);
        margin: 4px 0 0;
        line-height: 1.2;
        letter-spacing: -0.01em;
      }
    }
  }
}

.interview-content {
  flex: 1;
  overflow-y: auto;
  padding: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 1;
}

// 通用卡片样式 mixin
.glass-card {
  background: var(--color-bg-sunken);
  backdrop-filter: blur(32px);
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 8px 32px var(--shadow-color-weak);
  border-radius: 16px;
}

.ready-state {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 32px;
  animation: fadeIn 0.4s ease-out;

  .ready-main {
    text-align: center;

    .ready-info {
      .glass-card;
      padding: 40px;
      margin-bottom: 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;

      h3 {
        color: var(--color-text-primary);
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin: 0;
      }

      p {
        color: var(--color-text-primary);
        font-size: 24px;
        font-weight: 600;
        margin: 0 0 16px;

        &:last-child {
          margin-bottom: 0;
        }
      }
    }
  }

  .history-section {
    .glass-card;
    padding: 24px;
    background: var(--color-bg-surface-hover);

    :deep(.ant-tabs-nav) {
      margin-bottom: 20px;
      &::before {
        border-bottom: 1px solid var(--color-border-subtle);
      }
    }

    :deep(.ant-tabs-tab) {
      color: var(--color-text-primary);
      font-size: 14px;
      transition: color 0.3s;

      &:hover {
        color: var(--color-text-primary);
      }
    }

    :deep(.ant-tabs-tab-active .ant-tabs-tab-btn) {
      color: var(--color-text-selected);
      text-shadow: 0 0 12px var(--color-accent-border);
    }

    :deep(.ant-tabs-ink-bar) {
      background: var(--color-accent-solid);
      height: 3px;
      border-radius: 3px;
      box-shadow: 0 0 8px var(--color-accent-border);
    }

    .history-list,
    .mistakes-list {
      max-height: 400px;
      overflow-y: auto;
      padding-right: 4px;

      &::-webkit-scrollbar {
        width: 4px;
      }
      &::-webkit-scrollbar-thumb {
        background: var(--color-bg-surface-hover);
        border-radius: 4px;
      }
    }

    .history-item {
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      border-radius: 12px;
      margin-bottom: 12px;
      transition: all 0.25s cubic-bezier(0.2, 0, 0, 1);

      &:hover {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border-subtle);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px var(--shadow-color-weak);
      }

      &.expanded {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border);
        box-shadow: 0 8px 24px var(--shadow-color-weak);
      }

      .history-header {
        padding: 16px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .history-info {
        display: flex;
        flex-direction: column;
        gap: 4px;

        .history-topic {
          color: var(--color-text-primary);
          font-weight: 500;
          font-size: 15px;
        }

        .history-date {
          color: var(--color-text-primary);
          font-size: 12px;
          margin-top: 4px;
        }
      }

      .history-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .history-score {
        font-size: 13px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 6px;

        &.high {
          background: var(--color-success-bg);
          color: var(--color-success-text);
        }
        &.medium {
          background: var(--color-warning-bg);
          color: var(--color-warning-text);
        }
        &.low {
          background: var(--color-danger-bg);
          color: var(--color-danger-text);
        }
      }

      .expand-icon {
        color: var(--color-text-primary);
        font-size: 12px;
      }

      .delete-btn {
        color: var(--color-text-muted);
        &:hover {
          color: var(--color-danger-text);
        }
      }

      .history-detail {
        padding: 16px;
        border-top: 1px solid var(--color-border-subtle);
        background: var(--color-bg-surface-hover);

        .detail-summary {
          display: flex;
          gap: 16px;
          color: var(--color-text-primary);
          font-size: 12px;
          margin-bottom: 12px;
        }

        .detail-records {
          max-height: 200px;
          overflow-y: auto;
        }

        .detail-record-item {
          padding: 12px;
          background: var(--color-bg-surface-hover);
          border-radius: 8px;
          margin-bottom: 8px;

          .record-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;

            .record-num {
              color: var(--color-text-primary);
              font-size: 12px;
            }

            .record-skipped {
              color: var(--color-text-primary);
              font-size: 11px;
            }

            .record-score {
              font-size: 11px;
              padding: 1px 6px;
              border-radius: 3px;

              &.high {
                background: var(--color-success-bg);
                color: var(--color-success-text);
              }
              &.medium {
                background: var(--color-warning-bg);
                color: var(--color-warning-text);
              }
              &.low {
                background: var(--color-danger-bg);
                color: var(--color-danger-text);
              }
            }
          }

          .record-question {
            color: var(--color-text-primary);
            font-size: 13px;
            line-height: 1.4;
          }

          .record-answer {
            margin-top: 6px;
            color: var(--color-text-primary);
            font-size: 12px;

            strong {
              color: var(--color-text-primary);
            }
          }
        }
      }
    }

    .mistake-item {
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      border-radius: 12px;
      margin-bottom: 12px;
      transition: all 0.25s cubic-bezier(0.2, 0, 0, 1);
      border-left: 3px solid transparent;

      &:not(.reviewed) {
        border-left-color: var(--color-danger-border);
        background: var(--color-danger-bg);
      }

      &.reviewed {
        opacity: 0.7;
      }

      &.expanded {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border);
        box-shadow: 0 8px 24px var(--shadow-color-weak);
      }

      &:hover {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border-subtle);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px var(--shadow-color-weak);
      }

      .mistake-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 16px;
        cursor: pointer;
        gap: 12px;

        .expand-icon {
          color: var(--color-text-primary);
          font-size: 12px;
          flex-shrink: 0;
          margin-top: 4px;
        }
      }

      .mistake-question {
        color: var(--color-text-primary);
        font-size: 15px;
        line-height: 1.5;
        font-weight: 500;
        flex: 1;
      }

      .mistake-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 16px 16px;

        .mistake-score {
          font-size: 12px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: 4px;

          &.high {
            background: var(--color-success-bg);
            color: var(--color-success-text);
          }
          &.medium {
            background: var(--color-warning-bg);
            color: var(--color-warning-text);
          }
          &.low {
            background: var(--color-danger-bg);
            color: var(--color-danger-text);
          }
        }

        .reviewed-tag {
          color: var(--color-text-primary);
          font-size: 12px;
        }

        .delete-btn {
          color: var(--color-text-muted);
          &:hover {
            color: var(--color-danger-text);
          }
        }
      }

      .mistake-detail {
        padding: 20px;
        background: var(--color-bg-surface-hover);
        border-top: 1px solid var(--color-border-subtle);

        .detail-row {
          display: flex;
          gap: 8px;
          padding: 8px 0;
          border-bottom: 1px dashed var(--color-border-subtle);
          font-size: 13px;

          &:last-of-type {
            border-bottom: none;
          }

          .detail-label {
            color: var(--color-text-primary);
            flex-shrink: 0;
          }

          .detail-value {
            &.wrong {
              color: var(--color-danger-text);
            }
            &.correct {
              color: var(--color-success-text);
            }
          }
        }

        .detail-comment {
          margin-top: 16px;
          padding: 16px;
          background: var(--color-accent-bg);
          border: 1px solid var(--color-accent-border);
          border-radius: 8px;

          strong {
            color: var(--color-accent-text);
            display: block;
            margin-bottom: 6px;
          }

          p {
            color: var(--color-text-primary);
            font-size: 13px;
            line-height: 1.6;
            margin: 0;
          }
        }

        .detail-actions {
          margin-top: 16px;
          display: flex;
          gap: 8px;
        }
      }
    }
  }
}

.interview-area {
  width: 100%;
  max-width: 760px;
  animation: slideUp 0.5s cubic-bezier(0.2, 0, 0, 1);

  // 沉浸式问题卡片 - Fluent Style
  .immersive-question-card {
    .glass-card;
    padding: 48px;
    margin-bottom: 32px;
    text-align: center;
    border-top: 1px solid var(--color-border);

    .progress-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 32px;

      .progress-ring {
        position: relative;
        width: 56px;
        height: 56px;

        svg {
          width: 100%;
          height: 100%;
          transform: rotate(-90deg);
        }

        .ring-bg {
          fill: none;
          stroke: var(--color-border);
          stroke-width: 3;
        }

        .ring-progress {
          fill: none;
          stroke: var(--color-accent-text);
          stroke-width: 3;
          stroke-linecap: round;
          transition: stroke-dasharray 0.5s ease;
          filter: drop-shadow(0 0 6px var(--color-accent-border));
        }

        .progress-text {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: var(--color-text-primary);
          font-size: 18px;
          font-weight: 700;
        }
      }

      .progress-total {
        color: var(--color-text-primary);
        font-size: 18px;
        font-weight: 500;
      }
    }

    .question-text {
      color: var(--color-text-primary);
      font-size: 26px;
      font-weight: 600;
      line-height: 1.5;
      letter-spacing: -0.015em;
      margin: 0;
      text-shadow: 0 4px 12px var(--shadow-color-strong);
    }
  }

  // 选择题样式 - 毛玻璃悬浮卡片
  .choice-options {
    display: flex;
    flex-direction: column;
    gap: 16px;

    .choice-option {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 24px 28px;
      background: var(--color-bg-sunken);
      backdrop-filter: blur(20px);
      border: 1px solid var(--color-border-subtle);
      border-radius: 16px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
      position: relative;
      overflow: hidden;

      // Hover Light Effect
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(
          120deg,
          rgba(255, 255, 255, 0) 0%,
          rgba(255, 255, 255, 0.03) 50%,
          rgba(255, 255, 255, 0) 100%
        );
        transform: translateX(-100%);
        transition: transform 0.5s;
      }

      &:hover:not(.correct):not(.wrong) {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-border);
        transform: translateY(-2px);
        box-shadow: 0 8px 24px var(--shadow-color-weak);

        &::before {
          transform: translateX(100%);
        }

        .option-id {
          background: var(--color-bg-surface-hover);
          transform: scale(1.1);
        }
      }

      // Selected State
      &.selected:not(.correct):not(.wrong) {
        background: var(--color-bg-selected);
        border-color: var(--color-accent-border);
        box-shadow: 0 0 24px var(--color-accent-border);

        .option-id {
          background: var(--color-accent-solid);
          color: var(--color-text-on-solid);
          box-shadow: 0 0 12px var(--color-accent-border);
        }
      }

      // Correct State
      &.correct {
        background: var(--color-success-bg);
        border-color: var(--color-success-border);
        box-shadow: 0 0 32px var(--color-success-border);

        .option-id {
          background: var(--color-success-solid);
          color: var(--color-text-on-solid);
          box-shadow: 0 0 16px var(--color-success-border);
        }
      }

      &.wrong {
        background: var(--color-danger-bg);
        border-color: var(--color-danger-border);

        .option-id {
          background: var(--color-danger-solid);
          color: var(--color-text-primary);
        }
      }

      .option-id {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-surface-hover);
        border-radius: 12px;
        font-weight: 700;
        font-size: 16px;
        color: var(--color-text-primary);
        transition: all 0.3s;
        flex-shrink: 0;
      }

      .option-text {
        font-size: 17px;
        color: var(--color-text-primary);
        font-weight: 500;
        flex: 1;
        line-height: 1.5;
      }

      .correct-mark {
        color: var(--color-success-text);
        font-size: 20px;
        font-weight: bold;
        text-shadow: 0 0 10px var(--color-success-border);
      }
    }

    // 动画定义
    @keyframes correctPulse {
      0% {
        transform: scale(1);
      }
      30% {
        transform: scale(1.02);
      }
      60% {
        transform: scale(0.99);
      }
      100% {
        transform: scale(1);
      }
    }

    @keyframes wrongShake {
      0%,
      100% {
        transform: translateX(0);
      }
      20% {
        transform: translateX(-8px);
      }
      40% {
        transform: translateX(8px);
      }
      60% {
        transform: translateX(-6px);
      }
      80% {
        transform: translateX(6px);
      }
    }

    .hint-trigger {
      text-align: center;
      margin-top: 12px;
    }

    .hint-box {
      margin-top: 12px;
      padding: 12px 16px;
      background: var(--color-warning-bg);
      border: 1px solid var(--color-warning-border);
      border-radius: 8px;

      strong {
        color: var(--color-warning-text);
      }

      p {
        color: var(--color-text-primary);
        margin: 8px 0 0;
        font-size: 14px;
      }
    }
  }

  // 答案反馈样式 - 毛玻璃效果
  .answer-feedback {
    .glass-card;
    margin-top: 32px;
    padding: 24px;
    background: var(--color-bg-sunken);

    .feedback-header {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;

      &.correct {
        background: var(--color-success-bg);
        color: var(--color-success-text);
        border-left: 4px solid var(--color-success-border);
      }

      &.wrong {
        background: var(--color-danger-bg);
        color: var(--color-danger-text);
        border-left: 4px solid var(--color-danger-border);
      }
    }

    .explanation-box {
      background: var(--color-accent-bg);
      border: 1px solid var(--color-accent-border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;

      strong {
        color: var(--color-accent-text);
        display: block;
        margin-bottom: 8px;
        font-size: 14px;
      }

      p {
        color: var(--color-text-primary);
        line-height: 1.6;
        font-size: 15px;
        margin: 0;
      }
    }

    // 追问区域样式
    .follow-up-section {
      background: var(--color-accent-bg);
      border: 1px solid var(--color-accent-border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;

      .follow-up-question {
        margin-bottom: 16px;

        strong {
          color: var(--color-accent-text);
          display: block;
          margin-bottom: 8px;
          font-size: 14px;
        }

        p {
          color: var(--color-text-primary);
          line-height: 1.6;
          font-size: 16px;
          margin: 0;
          font-weight: 500;
        }
      }

      .follow-up-input {
        display: flex;
        flex-direction: column;
        gap: 12px;

        :deep(.ant-input) {
          background: var(--color-bg-surface-hover);
          border-color: var(--color-accent-border);
          color: var(--color-text-primary);
          border-radius: 8px;
          padding: 12px;

          &:focus {
            border-color: var(--color-accent-border);
            box-shadow: 0 0 0 2px var(--color-accent-border);
          }

          &::placeholder {
            color: var(--color-text-disabled);
          }
        }

        .app-button {
          align-self: flex-end;
        }
      }

      .follow-up-result {
        .follow-up-score {
          display: inline-block;
          font-size: 18px;
          font-weight: 700;
          padding: 6px 16px;
          border-radius: 20px;
          margin-bottom: 16px;

          &.high {
            background: var(--color-success-bg);
            color: var(--color-success-text);
          }
          &.medium {
            background: var(--color-warning-bg);
            color: var(--color-warning-text);
          }
          &.low {
            background: var(--color-danger-bg);
            color: var(--color-danger-text);
          }
        }

        .follow-up-comment,
        .follow-up-reference {
          background: var(--color-bg-surface-hover);
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 12px;

          strong {
            color: var(--color-accent-text);
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
          }

          p {
            color: var(--color-text-primary);
            line-height: 1.5;
            font-size: 14px;
            margin: 0;
          }
        }
      }
    }

    .feedback-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
  }

  .answer-box {
    :deep(.ant-input) {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-border-subtle);
      color: var(--color-text-primary);
      border-radius: 8px;
      padding: 12px;

      &:focus {
        border-color: var(--color-accent-border);
        box-shadow: 0 0 0 2px var(--color-accent-border);
      }

      &::placeholder {
        color: var(--color-text-disabled);
      }
    }

    .answer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 16px;
    }
  }

  .evaluation-box {
    margin-top: 24px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 12px;
    padding: 24px;

    .eval-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;

      .score-badge {
        font-size: 20px;
        font-weight: 700;
        padding: 4px 16px;
        border-radius: 20px;

        &.high {
          background: var(--color-success-bg);
          color: var(--color-success-text);
        }
        &.medium {
          background: var(--color-warning-bg);
          color: var(--color-warning-text);
        }
        &.low {
          background: var(--color-danger-bg);
          color: var(--color-danger-text);
        }
      }
    }

    .eval-comment,
    .eval-reference {
      margin-bottom: 16px;

      strong {
        display: block;
        color: var(--color-text-primary);
        font-size: 13px;
        margin-bottom: 8px;
      }

      p {
        color: var(--color-text-primary);
        line-height: 1.6;
        margin: 0;
      }
    }

    .eval-reference {
      margin-bottom: 0;
      padding-top: 16px;
      border-top: 1px solid var(--color-border-subtle);
    }
  }
}

.completed-state {
  width: 100%;
  max-width: 800px;
  animation: fadeIn 0.6s ease-out;

  // 成就徽章式头部
  .achievement-header {
    .glass-card;
    padding: 48px;
    margin-bottom: 32px;
    text-align: center;
    background: radial-gradient(circle at 50% 0%, var(--color-bg-surface), var(--color-bg-page));

    .score-ring-container {
      position: relative;
      width: 140px;
      height: 140px;
      margin: 0 auto 24px;

      .score-ring {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);

        .ring-bg {
          fill: none;
          stroke: var(--color-border);
          stroke-width: 8;
        }

        .ring-progress {
          fill: none;
          stroke-width: 8;
          stroke-linecap: round;
          transition: stroke-dasharray 1s cubic-bezier(0.4, 0, 0.2, 1);

          &.high {
            stroke: var(--color-success-text);
            filter: drop-shadow(0 0 12px var(--color-success-border));
          }
          &.medium {
            stroke: var(--color-warning-text);
            filter: drop-shadow(0 0 12px var(--color-warning-border));
          }
          &.low {
            stroke: var(--color-danger-text);
            filter: drop-shadow(0 0 12px var(--color-danger-border));
          }
        }
      }

      .score-center {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;

        .score-value {
          display: block;
          font-size: 56px;
          font-weight: 800;
          color: var(--color-text-primary);
          line-height: 1;
          letter-spacing: -2px;
          text-shadow: 0 0 24px var(--shadow-highlight);
        }

        .score-label {
          font-size: 14px;
          color: var(--color-text-primary);
        }
      }
    }

    .emotional-feedback {
      .emoji {
        font-size: 36px;
        display: block;
        margin-bottom: 12px;
      }

      .message {
        font-size: 24px;
        font-weight: 500;
        margin: 16px 0 0;
        background: linear-gradient(to right, #fff, #a5b4fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
    }
  }

  .report-summary {
    display: flex;
    justify-content: center;
    gap: 20px;
    margin-bottom: 32px;

    .summary-item {
      .glass-card;
      flex: 1;
      text-align: center;
      padding: 24px;
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      min-width: 80px;
      max-width: 180px;
      transition: transform 0.3s;

      &:hover {
        transform: translateY(-4px);
      }

      .value {
        display: block;
        color: var(--color-text-primary);
        font-size: 32px;
        font-weight: 700;
        margin-bottom: 8px;

        &.correct-count {
          color: var(--color-success-text);
        }

        &.wrong-count {
          color: var(--color-danger-text);
        }
      }

      .label {
        display: block;
        color: var(--color-text-primary);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
    }
  }

  .answers-review {
    .glass-card;
    background: var(--color-bg-sunken);
    padding: 32px;
    margin-bottom: 24px;
    text-align: left;

    h4 {
      color: var(--color-text-primary);
      font-size: 16px;
      margin: 0 0 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .review-item {
      padding: 16px;
      background: var(--color-bg-surface-hover);
      border-radius: 12px;
      margin-bottom: 12px;
      transition: all 0.2s ease;

      &:last-child {
        margin-bottom: 0;
      }

      &:hover {
        background: var(--color-bg-surface-hover);
      }

      .review-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;

        .q-num {
          color: var(--color-text-primary);
          font-size: 13px;
          font-weight: 500;
        }

        .skipped-tag {
          background: var(--color-bg-surface-hover);
          color: var(--color-text-primary);
          padding: 3px 10px;
          border-radius: 6px;
          font-size: 12px;
        }

        .score-tag {
          padding: 3px 10px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;

          &.high {
            background: var(--color-success-bg);
            color: var(--color-success-text);
          }
          &.medium {
            background: var(--color-warning-bg);
            color: var(--color-warning-text);
          }
          &.low {
            background: var(--color-danger-bg);
            color: var(--color-danger-text);
          }
        }
      }

      .q-text {
        color: var(--color-text-primary);
        margin: 0 0 8px;
        font-size: 14px;
      }

      .review-detail {
        .your-answer {
          color: var(--color-text-primary);
          font-size: 13px;
          line-height: 1.5;

          strong {
            color: var(--color-text-primary);
          }
        }
      }
    }
  }
}

// Animations
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
