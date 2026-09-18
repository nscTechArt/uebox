<template>
  <AgentBrowserPane
    :session-id="sessionId"
    :open="open"
    :url="url"
    :navigation="navigation"
    :group="group"
    :visible="true"
    standalone
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import AgentBrowserPane from './components/AgentBrowserPane.vue'
import { useSessionBrowser } from './composables/useSessionBrowser'

const route = useRoute()
const { t } = useI18n()
const sessionId = computed(() =>
  typeof route.query.sessionId === 'string' ? route.query.sessionId : ''
)
const { open, url, navigation, group } = useSessionBrowser(
  sessionId,
  ref(true),
  () => {
    message.error(t('assistant.browserPane.restoreFailed'))
  },
  'window'
)
</script>
