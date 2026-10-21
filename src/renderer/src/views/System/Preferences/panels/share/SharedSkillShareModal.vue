<script setup lang="ts">
/**
 * 把自己的一个技能提交到官网共享库。
 *
 * 打开时主进程先打包一遍，列出会提交哪些文件、哪些不符合要求被跳过；提交时主进程按盘上
 * 的文件重新打包，不用这里显示的内容。署名和主页记在本机，下次自动填好。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { shareAPI } from '@renderer/api/share'
import { message } from '@renderer/utils/messageManager'
import type { SharedSkillPack, SharedSkillSubmitResult } from '@core/shared/share'

const props = defineProps<{ name: string }>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()

const pack = ref<SharedSkillPack | null>(null)
const loadError = ref('')
const author = ref('')
const authorLink = ref('')
const note = ref('')
const submitting = ref(false)
const done = ref<SharedSkillSubmitResult | null>(null)

watch(open, async (value) => {
  if (!value) return
  pack.value = null
  loadError.value = ''
  note.value = ''
  done.value = null
  try {
    pack.value = await shareAPI.packSkill(props.name)
    author.value = pack.value.author
    authorLink.value = pack.value.authorLink
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  }
})

async function submit(): Promise<void> {
  submitting.value = true
  try {
    done.value = await shareAPI.submitSkill({
      name: props.name,
      author: author.value,
      authorLink: authorLink.value,
      note: note.value
    })
  } catch (error) {
    message.error(
      t('profile.skills.shareFailed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  } finally {
    submitting.value = false
  }
}

function openStatus(): void {
  if (done.value) void shareAPI.openPage(done.value.statusUrl).catch(() => undefined)
}
</script>

<template>
  <AppModal
    v-model:open="open"
    :title="t('profile.skills.shareTitle', { name })"
    :width="560"
    destroy-on-close
  >
    <p v-if="loadError" class="note error">
      {{ $t('profile.skills.shareLoadFailed', { reason: loadError }) }}
    </p>

    <template v-else-if="done">
      <p class="done-title">{{ $t('profile.skills.shareDoneTitle') }}</p>
      <p class="note">{{ $t('profile.skills.shareDone') }}</p>
    </template>

    <template v-else-if="pack">
      <p class="note">
        {{ $t(pack.isUpdate ? 'profile.skills.shareUpdateNote' : 'profile.skills.shareNote') }}
      </p>

      <div class="field">
        <span class="label">{{ $t('profile.skills.shareFiles') }}</span>
        <ul class="files">
          <li v-for="file in pack.files" :key="file.path">{{ file.path }}</li>
        </ul>
        <p v-if="pack.skipped.length" class="note warn">
          {{ $t('profile.skills.shareSkipped', { list: pack.skipped.join('、') }) }}
        </p>
      </div>

      <label class="field">
        <span class="label">{{ $t('profile.skills.shareAuthor') }}</span>
        <a-input v-model:value="author" :maxlength="40" />
        <span class="note">{{ $t('profile.skills.shareAuthorHint') }}</span>
      </label>
      <label class="field">
        <span class="label">{{ $t('profile.skills.shareLink') }}</span>
        <a-input v-model:value="authorLink" :maxlength="200" placeholder="https://" />
      </label>
      <label class="field">
        <span class="label">{{ $t('profile.skills.shareNoteLabel') }}</span>
        <a-input v-model:value="note" :maxlength="500" />
      </label>
    </template>

    <template #footer>
      <div class="footer">
        <template v-if="done">
          <AppButton @click="openStatus">{{ $t('profile.skills.shareStatus') }}</AppButton>
          <AppButton variant="primary" @click="open = false">{{ $t('common.close') }}</AppButton>
        </template>
        <template v-else>
          <AppButton @click="open = false">{{ $t('common.cancel') }}</AppButton>
          <AppButton
            variant="primary"
            :disabled="!pack || !author.trim()"
            :loading="submitting"
            @click="submit"
          >
            {{ $t('profile.skills.shareSubmit') }}
          </AppButton>
        </template>
      </div>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.warn {
  color: var(--color-warning-text);
}

.error {
  color: var(--color-danger-text);
}

.done-title {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-4);
}

.label {
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.files {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  list-style: none;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.8;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
</style>
