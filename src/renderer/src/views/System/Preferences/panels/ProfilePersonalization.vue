<script setup lang="ts">
/**
 * 个性化：用户写给助手的一段常驻说明。**这一页只有这一件事。**
 *
 * 「技能沉淀」原来也在这儿（开关 + 清单 + 删除），理由是「说明和技能都是
 * 『这个助手有多懂我』的一半」。那个归类是错的 —— 技能在「技能」页也列着，
 * 于是同一个东西有了两个入口：在那边看，回这边删。现在开关、清单、删除
 * 全在「技能」页，这一页只管「我是谁」。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from '@renderer/components/AppButton.vue'
import { personalizationAPI } from '@renderer/api/personalization'
import { message } from '@renderer/utils/messageManager'

const { t } = useI18n()

const instructions = ref('')
/** 盘上那份。用来判断「改过没有」—— 没改过就不给保存按钮，免得用户以为自己漏保存了 */
const savedInstructions = ref('')
const instructionsLimit = ref(4000)
const instructionsPath = ref('')
const savingInstructions = ref(false)

const instructionsDirty = computed(() => instructions.value !== savedInstructions.value)
const instructionsOverLimit = computed(() => instructions.value.length > instructionsLimit.value)

async function saveInstructions(): Promise<void> {
  savingInstructions.value = true
  try {
    await personalizationAPI.setInstructions(instructions.value)
    savedInstructions.value = instructions.value
    message.success(t('profile.personalization.instructionsSaved'))
  } catch (error) {
    console.error('保存常驻说明失败:', error)
    message.error(t('profile.personalization.instructionsSaveFailed'))
  } finally {
    savingInstructions.value = false
  }
}

/** 用别的编辑器改。这是用户自己的文件，不该只能从这个文本框进出 */
async function openInstructionsFile(): Promise<void> {
  // 返回值必须看：shell:* 失败时是 return {success:false}，不抛
  const res = await window.api.invoke('shell:openPath', instructionsPath.value)
  if (!res?.success) {
    message.error(`打不开这个文件：${instructionsPath.value}（${res?.error || ''}）`, 8)
  }
}

onMounted(async () => {
  try {
    const loaded = await personalizationAPI.getInstructions()
    instructions.value = loaded.text
    savedInstructions.value = loaded.text
    instructionsLimit.value = loaded.limit
    instructionsPath.value = loaded.path
  } catch (error) {
    console.error('读取常驻说明失败:', error)
  }
})
</script>

<template>
  <div class="settings-content">
    <!-- 常驻说明 -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.personalization.instructionsTitle') }}</h4>
      <div class="settings-list">
        <div class="setting-info">
          <div class="setting-desc">{{ $t('profile.personalization.instructionsDesc') }}</div>
        </div>

        <a-textarea
          v-model:value="instructions"
          :rows="8"
          :placeholder="$t('profile.personalization.instructionsPlaceholder')"
          :status="instructionsOverLimit ? 'error' : undefined"
        />

        <div class="instructions-footer">
          <span class="counter" :class="{ over: instructionsOverLimit }">
            {{ instructions.length }} / {{ instructionsLimit }}
          </span>
          <div class="instructions-actions">
            <AppButton variant="soft" @click="openInstructionsFile">
              {{ $t('profile.personalization.openInstructionsFile') }}
            </AppButton>
            <AppButton
              variant="primary"
              :disabled="!instructionsDirty || instructionsOverLimit"
              :loading="savingInstructions"
              @click="saveInstructions"
            >
              {{ $t('common.save') }}
            </AppButton>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.setting-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.instructions-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.instructions-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}

.counter {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;

  &.over {
    color: var(--color-danger-text);
  }
}
</style>
