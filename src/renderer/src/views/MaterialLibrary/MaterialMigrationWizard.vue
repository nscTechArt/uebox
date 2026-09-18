<script setup lang="ts">
import LibraryMigrationWizard from '@renderer/views/library-common/components/LibraryMigrationWizard.vue'
import type { LegacyImportReport } from '@renderer/views/library-common/services/legacyImport'
import { previewMigration, executeMigration } from './services/legacyImportService'

/** 从旧版导入材质：LibraryMigrationWizard 的领域包装。 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', report: LegacyImportReport): void
}>()

const service = { preview: previewMigration, execute: executeMigration }
</script>

<template>
  <LibraryMigrationWizard
    i18n-prefix="materialMigration"
    :service="service"
    @close="emit('close')"
    @done="(report: LegacyImportReport) => emit('done', report)"
  />
</template>
