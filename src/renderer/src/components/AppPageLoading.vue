<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppPageSkeleton from './AppPageSkeleton.vue'
import AssetLoadingContent from '@renderer/views/AssetManagement/components/AssetLoadingContent.vue'
import LibraryBrowser from '@renderer/views/library-common/browser/LibraryBrowser.vue'
import type { BrowserScope } from '@renderer/views/library-common/browser/types'
import banner from '@renderer/assets/imgs/header-image.png'

const props = defineProps<{ path: string }>()
const { t } = useI18n()
const page = computed(() => {
  if (props.path === '/') return 'projects'
  if (props.path === '/aigc-studio') return 'studio'
  if (props.path.startsWith('/asset-management')) return 'assets'
  if (props.path === '/blueprint-library') return 'blueprint'
  if (props.path === '/material-library') return 'material'
  if (props.path === '/notebooks') return 'notebooks'
  return 'editor'
})
const scope = computed<BrowserScope>(() => ({
  id: page.value,
  title: `${page.value}Gallery.header.title`,
  kinds: [page.value],
  density: 'light',
  facets:
    page.value === 'material'
      ? [
          { key: 'entryType', label: 'materialGallery.list.colType', options: [] },
          { key: 'blendMode', label: 'libraryBrowser.facetBlendMode', options: [] },
          { key: 'shadingModel', label: 'libraryBrowser.facetShadingModel', options: [] }
        ]
      : [{ key: 'blueprintType', label: 'blueprintGallery.list.colType', options: [] }]
}))

// Read the same existing UI preferences as the destination. Never persist preview state.
const dimensions = computed(() => {
  // Reread when switching destinations, including consecutive pending navigations.
  void props.path
  let tree = 300
  let size = 120
  let history = 300
  let details = true
  try {
    tree = Number.parseInt(localStorage.getItem('assetManagement.treePanelWidth') || '300', 10)
    size = Number.parseInt(localStorage.getItem('assetManagement.displaySize') || '120', 10)
    history = Number.parseInt(localStorage.getItem('aigc-studio-history-panel-width') || '300', 10)
    details = localStorage.getItem('assetManagement.detailsPanel.visible') !== 'false'
  } catch {
    /* Defaults also work when storage is unavailable. */
  }
  return {
    tree: Number.isFinite(tree) ? Math.max(250, Math.min(800, tree)) : 300,
    size: Number.isFinite(size) ? Math.max(80, Math.min(200, size)) : 120,
    history: Number.isFinite(history) ? Math.max(300, Math.min(600, history)) : 300,
    details
  }
})
</script>

<template>
  <section
    class="page-loading"
    :class="page"
    role="status"
    :aria-label="t('common.loading')"
    aria-busy="true"
  >
    <template v-if="page === 'projects'">
      <div class="project-banner"><img :src="banner" alt="" /></div>
      <section class="project-section">
        <header>
          <h2>{{ t('page.home.engine.title') }}</h2>
          <span class="control"></span><span class="control"></span>
        </header>
        <AppPageSkeleton variant="engines" :count="10" />
      </section>
      <section class="project-section">
        <header>
          <h2>{{ t('page.home.project.title') }}</h2>
          <span class="control"></span><span class="control"></span><span class="spacer"></span
          ><span class="search"></span>
        </header>
        <AppPageSkeleton variant="projects" :count="24" />
      </section>
    </template>

    <!-- Use the actual gallery shell, with its persisted width, search, sort and view mode. -->
    <div v-else-if="page === 'blueprint' || page === 'material'" class="gallery-shell" inert>
      <LibraryBrowser :key="page" :scope="scope" :items="[]" :folders="[]" loading>
        <template #toolbar
          ><span class="control"></span><span class="control"></span
          ><span class="create-placeholder control"></span
        ></template>
      </LibraryBrowser>
    </div>

    <template v-else-if="page === 'assets'">
      <aside class="asset-tree" :style="{ width: `${dimensions.tree}px` }" aria-hidden="true">
        <span class="search"></span>
        <div v-for="group in 3" :key="group" class="tree-group">
          <span v-for="row in 4" :key="row" class="tree-row"
            ><i class="control"></i><i class="line"></i
          ></span>
        </div>
      </aside>
      <main class="asset-main" :style="{ '--asset-loading-size': `${dimensions.size}px` }">
        <header class="asset-toolbar">
          <span class="control"></span><span class="control"></span
          ><span class="search spacer"></span><span class="search"></span>
        </header>
        <header class="asset-toolbar">
          <span class="control"></span><span class="line"></span>
        </header>
        <div class="asset-content">
          <AssetLoadingContent />
        </div>
      </main>
      <aside v-if="dimensions.details" class="asset-details" aria-hidden="true">
        <div class="detail-preview block"></div>
        <span class="line"></span>
        <div class="detail-stats block"></div>
        <div class="detail-stats block"></div>
      </aside>
    </template>

    <template v-else-if="page === 'notebooks'">
      <header>
        <h2>{{ t('menu.notebooks') }}</h2>
        <span class="spacer"></span><span class="search"></span
        ><span class="create-placeholder control"></span>
      </header>
      <AppPageSkeleton variant="notebooks" />
    </template>

    <!-- Studio and detail pages are workspaces, never gallery grids. -->
    <template v-else>
      <aside class="workspace-input" aria-hidden="true">
        <span class="search"></span>
        <div class="prompt block"></div>
        <span class="line"></span>
        <div class="reference block"></div>
        <span class="search"></span><span class="search"></span><span class="spacer"></span
        ><span class="search"></span>
      </aside>
      <main class="workspace-preview">
        <header>
          <span class="spacer"></span><span class="control"></span><span class="control"></span
          ><span class="control"></span>
        </header>
        <div class="preview-space">
          <span>{{ t('common.loading') }}</span>
        </div>
        <footer><span class="line"></span></footer>
      </main>
      <aside
        class="workspace-history"
        :style="{ width: `${dimensions.history}px` }"
        aria-hidden="true"
      >
        <h2 v-if="page === 'studio'">{{ t('aigcImageHistoryPanel.header.title') }}</h2>
        <span v-else class="line"></span>
        <span class="search"></span><span class="line"></span>
        <div class="history-grid">
          <div v-for="row in 8" :key="row" class="history-preview block"></div>
        </div>
      </aside>
    </template>
  </section>
</template>

<style scoped>
.page-loading {
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
  color: var(--color-text-secondary);
}
header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--color-text-primary);
}
.spacer {
  flex: 1;
}
.control,
.search,
.line {
  display: inline-block;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface-hover);
}
.control {
  width: var(--space-8);
  height: var(--space-8);
  border: 1px solid var(--color-border-subtle);
}
.search {
  width: calc(var(--space-9) * 6);
  height: var(--space-8);
  border: 1px solid var(--color-border-subtle);
}
.line {
  width: 55%;
  height: var(--space-3);
}
.block {
  border-radius: var(--radius-container);
  background: var(--color-bg-surface-hover);
}
.create-placeholder {
  width: var(--space-24);
}
.page-loading.projects {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.project-banner {
  padding: var(--space-7) var(--space-7) 0;
}
.project-banner img {
  display: block;
  width: 100%;
  height: calc(var(--space-9) * 4 + var(--space-5));
  object-fit: cover;
  border-radius: var(--radius-xl);
}
.project-section {
  padding: var(--section-padding, var(--space-7));
  background: var(--color-bg-surface);
}
.gallery-shell {
  display: flex;
  height: 100%;
  box-sizing: border-box;
  padding: var(--space-4) var(--space-1);
}
.page-loading.assets,
.page-loading.studio,
.page-loading.editor {
  display: flex;
  overflow: hidden;
}
.asset-tree {
  flex-shrink: 0;
  padding: var(--space-6);
  border-right: 1px solid var(--color-border-subtle);
  box-sizing: border-box;
}
.asset-tree > .search {
  width: 100%;
}
.tree-group {
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.tree-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-4);
}
.tree-row .control {
  width: var(--space-4);
  height: var(--space-4);
}
.asset-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.asset-toolbar {
  padding: var(--space-2) var(--space-4);
  margin: 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.asset-content {
  padding: var(--space-4);
  overflow: auto;
}
.asset-details {
  width: calc(var(--space-9) * 8 - var(--space-1));
  flex-shrink: 0;
  box-sizing: border-box;
  border-left: 1px solid var(--color-border-subtle);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.detail-preview {
  aspect-ratio: 1;
}
.detail-stats {
  height: var(--space-24);
}
.page-loading.notebooks {
  padding: var(--space-6) var(--space-8);
}
.page-loading.notebooks > header {
  margin-bottom: var(--space-6);
}
.workspace-input {
  width: calc(var(--space-9) * 8 + var(--space-2) + var(--space-1) / 2);
  flex-shrink: 0;
  box-sizing: border-box;
  padding: var(--space-4);
  border-right: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.workspace-input .search {
  width: 100%;
}
.prompt {
  height: calc(var(--space-9) * 6);
}
.reference {
  width: var(--space-16);
  height: var(--space-16);
}
.workspace-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.workspace-preview header,
footer {
  padding: var(--space-4);
  margin: 0;
}
.preview-space {
  flex: 1;
  display: grid;
  place-content: center;
}
.workspace-history {
  flex-shrink: 0;
  box-sizing: border-box;
  padding: var(--space-4);
  border-left: 1px solid var(--color-border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  overflow: hidden;
}
.workspace-history .search {
  width: 100%;
}
.history-preview {
  aspect-ratio: 16 / 9;
  flex-shrink: 0;
}
.history-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-9) * 6), 1fr));
  gap: var(--space-3);
}
.gallery-shell :deep(.tree-count) {
  visibility: hidden;
}
.page-loading.editor .workspace-input {
  width: calc(var(--space-9) * 7);
}
</style>
