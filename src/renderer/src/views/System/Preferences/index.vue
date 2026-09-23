<script setup lang="ts">
import { MINI_CHAT_SETTINGS_ENABLED } from '../../../../../shared/miniChatPreferences'
/**
 * 偏好设置主入口
 * 原型风格：玻璃面板 + 顶部Header + 内容区
 */
import { ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import PreferencesSidebar from './components/PreferencesSidebar.vue'
import ProfileGeneral from './panels/ProfileGeneral.vue'
import ProfileShortcuts from './panels/ProfileShortcuts.vue'
import ProfileAppearance from './panels/ProfileAppearance.vue'
import ProfileAI from './panels/ProfileAI.vue'
import ProfilePersonalization from './panels/ProfilePersonalization.vue'
import ProfileSkills from './panels/ProfileSkills.vue'
import ProfileTools from './panels/ProfileTools.vue'
import ProfileUsage from './panels/Usage/ProfileUsage.vue'
import AIProviderSettings from './panels/AIProviders/AIProviderSettings.vue'
import AgentV3DebugPanel from './panels/AgentV3Debug/AgentV3DebugPanel.vue'
import McpSettings from './panels/Mcp/McpSettings.vue'
import ProfileProject from './panels/ProfileProject.vue'
import ProfilePlugin from './panels/ProfilePlugin.vue'
import ProfileCli from './panels/ProfileCli.vue'
import ProfileObjectStorage from './panels/ProfileObjectStorage.vue'
import ProfileAsset from './panels/ProfileAsset.vue'
import ProfileNotebook from './panels/ProfileNotebook.vue'
import ProfileNamingRules from './panels/ProfileNamingRules.vue'
import ProfileAbout from './panels/ProfileAbout.vue'
import ProfileMiniChat from './panels/ProfileMiniChat.vue'
import ProfileVoice from './panels/ProfileVoice.vue'
import ScreenRecorderLibrary from '../../ScreenRecorder/ScreenRecorderLibrary.vue'

const { t } = useI18n()

// 当前激活的菜单 key
const activeKey = ref<string>('general')
const route = useRoute()

/**
 * 页面标题和描述配置。
 *
 * `descKey` 是可选的：页名本身已经说清楚的页面（常规、外观、快捷键、录屏、资产）
 * 不写副标题。原先每页都硬凑一句，凑出来的是「管理应用通用设置」这类空话，
 * 占着每页顶部最贵的位置却不提供任何信息。
 */
const pageHeaders: Record<string, { titleKey: string; descKey?: string }> = {
  general: {
    titleKey: 'profile.general.title'
  },
  appearance: {
    titleKey: 'profile.appearance.title'
  },
  shortcuts: {
    titleKey: 'profile.shortcuts.title'
  },
  ai: {
    titleKey: 'profile.ai.title'
  },
  personalization: {
    titleKey: 'profile.personalization.title',
    descKey: 'profile.personalization.description'
  },
  skills: {
    titleKey: 'profile.skills.title'
  },
  tools: {
    titleKey: 'profile.tools.title',
    descKey: 'profile.tools.description'
  },
  usage: {
    titleKey: 'profile.usage.title',
    descKey: 'profile.usage.description'
  },
  models: {
    titleKey: 'profile.models.title'
  },
  // 面板里已经有「对外暴露虚幻引擎能力」这个小标题，页面 Header 用
  // client 的标题会在同一屏出现两次一模一样的文字（上一版就是这样）。
  mcp: {
    titleKey: 'mcp.client.title',
    descKey: 'mcp.client.shortDescription'
  },
  agentV3Debug: {
    titleKey: 'agentV3Debug.title',
    descKey: 'agentV3Debug.description'
  },
  project: {
    titleKey: 'profile.project.title'
  },
  plugin: {
    titleKey: 'profile.plugin.title',
    descKey: 'profile.plugin.description'
  },
  cli: {
    titleKey: 'profile.cli.title',
    descKey: 'profile.cli.description'
  },
  objectStorage: {
    titleKey: 'profile.objectStorage.title'
  },
  asset: {
    titleKey: 'profile.asset.title'
  },
  notebook: {
    titleKey: 'profile.notebook.title',
    descKey: 'profile.notebook.description'
  },
  namingRules: {
    titleKey: 'profile.namingRules.title',
    descKey: 'profile.namingRules.description'
  },
  screenRecorder: {
    titleKey: 'profile.screenRecorder.title'
  },
  miniChat: {
    titleKey: 'profile.miniChat.title'
  },
  voice: {
    titleKey: 'profile.voice.title'
  },
  about: {
    titleKey: 'profile.about.title',
    descKey: 'profile.about.description'
  }
}

/**
 * 当前页面标题
 */
const currentTitle = computed(() => {
  const header = pageHeaders[activeKey.value]
  return header ? t(header.titleKey) : ''
})

/**
 * 当前页面描述。没配 `descKey` 就返回空串，模板那边整个 <p> 都不渲染 ——
 * 留一个空段落会在标题下方撑出一条对不上任何东西的空隙
 */
const currentDesc = computed(() => {
  const header = pageHeaders[activeKey.value]
  return header?.descKey ? t(header.descKey) : ''
})

// 监听路由参数，支持从外部跳转到特定设置项
watch(
  () => route.query.tab,
  (requestedTab) => {
    if (
      typeof requestedTab === 'string' &&
      requestedTab in pageHeaders &&
      (requestedTab !== 'miniChat' || MINI_CHAT_SETTINGS_ENABLED)
    ) {
      activeKey.value = requestedTab
    }
  },
  { immediate: true }
)

/**
 * 处理菜单切换
 * @param key 菜单项 Key
 */
function handleMenuChange(key: string): void {
  activeKey.value = key
}
</script>

<template>
  <div class="preferences-page">
    <div class="preferences-layout">
      <!-- 左侧菜单 -->
      <PreferencesSidebar :active-key="activeKey" @change="handleMenuChange" />

      <!-- 右侧主内容区 -->
      <main class="preferences-main glass-panel">
        <!-- 顶部 Header -->
        <header class="preferences-header">
          <div>
            <h2 class="header-title">{{ currentTitle }}</h2>
            <p v-if="currentDesc" class="header-desc">{{ currentDesc }}</p>
          </div>
        </header>

        <!-- 内容滚动区 -->
        <div class="preferences-scroll" :class="{ 'is-full-view': activeKey === 'screenRecorder' }">
          <div
            class="preferences-content"
            :class="{ 'full-width': activeKey === 'screenRecorder' }"
          >
            <!-- 常规设置 -->
            <ProfileGeneral v-if="activeKey === 'general'" />

            <!-- 外观设置 -->
            <ProfileAppearance v-else-if="activeKey === 'appearance'" />

            <!-- 快捷设置 -->
            <ProfileShortcuts v-else-if="activeKey === 'shortcuts'" />

            <!-- 录屏管理 -->
            <div v-else-if="activeKey === 'screenRecorder'" class="screen-recorder-wrapper">
              <ScreenRecorderLibrary />
            </div>

            <!-- MiniChat 设置 -->
            <ProfileMiniChat v-else-if="activeKey === 'miniChat' && MINI_CHAT_SETTINGS_ENABLED" />

            <!-- 语音助手 -->
            <ProfileVoice v-else-if="activeKey === 'voice'" />

            <!-- AI 助手 -->
            <ProfileAI v-else-if="activeKey === 'ai'" />

            <!-- 个性化：我写给它的那段常驻说明。技能在「技能」页 -->
            <ProfilePersonalization v-else-if="activeKey === 'personalization'" />

            <!-- 技能：它会做哪些事。搜索、按来源筛、自己的那些就地删 -->
            <ProfileSkills v-else-if="activeKey === 'skills'" />

            <!-- 工具：它手上有哪些工具，按大类折叠开关；工具搜索开关也在这儿 -->
            <ProfileTools v-else-if="activeKey === 'tools'" />

            <!-- 用量：从已有的对话记录里算，不上报、不落第二份账 -->
            <ProfileUsage v-else-if="activeKey === 'usage'" />

            <!-- 模型：服务商与默认模型，内容多，单独一页 -->
            <AIProviderSettings v-else-if="activeKey === 'models'" />
            <McpSettings v-else-if="activeKey === 'mcp'" />
            <ProfileCli v-else-if="activeKey === 'cli'" />
            <AgentV3DebugPanel v-else-if="activeKey === 'agentV3Debug'" />

            <!-- 项目设置 -->
            <ProfileProject v-else-if="activeKey === 'project'" />

            <!-- 插件设置 -->
            <ProfilePlugin v-else-if="activeKey === 'plugin'" />

            <!-- 资产设置 -->
            <ProfileAsset v-else-if="activeKey === 'asset'" />

            <!-- 对象存储：聊天里的音视频传上去换链接，模型直接看 -->
            <ProfileObjectStorage v-else-if="activeKey === 'objectStorage'" />

            <!-- 知识库设置 -->
            <ProfileNotebook v-else-if="activeKey === 'notebook'" />

            <!-- 命名规则设置 -->
            <ProfileNamingRules v-else-if="activeKey === 'namingRules'" />

            <!-- 关于 -->
            <ProfileAbout v-else-if="activeKey === 'about'" />

            <!-- 底部留白 -->
            <div class="bottom-spacer"></div>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped lang="less">
.preferences-page {
  height: 100%;
  overflow: hidden;
}

.preferences-layout {
  display: flex;
  height: 100%;
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
  gap: var(--space-8);
  padding: var(--space-6);
}

/* 配置主面板 */
.preferences-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* 顶部 Header */
.preferences-header {
  padding: var(--space-6) var(--space-8);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}

.header-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.header-desc {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-light);
}

/* 内容滚动区 */
.preferences-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-8) var(--space-10);

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 4px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
  }

  &.is-full-view {
    overflow: hidden;
    padding: 0;
  }
}

.preferences-content {
  width: 100%;
  max-width: 768px;
  margin: 0 auto;
  min-height: 500px;

  &.full-width {
    max-width: 100%;
    height: 100%;
    margin: 0;
  }
}

.screen-recorder-wrapper {
  height: 100%;
  padding: 0;
  /* 确保内部组件能撑开 */
  display: flex;
  flex-direction: column;
}

.bottom-spacer {
  height: var(--space-10);
}
</style>
