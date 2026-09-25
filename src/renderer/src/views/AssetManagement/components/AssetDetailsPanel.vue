<template>
  <div class="asset-details-panel">
    <div class="panel-header">
      <span class="title">{{
        asset?.assetName || folder?.name || $t('assetLib.details.title')
      }}</span>
      <AppButton
        variant="text"
        size="small"
        shape="circle"
        class="close-btn"
        :aria-label="$t('common.close')"
        :title="$t('common.close')"
        @click="$emit('close')"
      >
        <template #icon><PhX /></template>
      </AppButton>
    </div>

    <div v-if="asset" class="panel-body">
      <!-- Header 容器：预览区 + 文件名 -->
      <div class="header-container">
        <div
          class="preview-wrapper"
          :class="{ 'drag-over': isDragOver }"
          @mouseenter="showEditIcon = true"
          @mouseleave="showEditIcon = false"
          @dragover.prevent="handleDragOver"
          @dragenter.prevent="handleDragEnter"
          @dragleave="handleDragLeave"
          @drop.prevent="handleDrop"
        >
          <!-- 拖拽悬浮提示 -->
          <div v-if="isDragOver" class="drop-overlay">
            <div class="drop-hint">
              <PhCamera class="drop-icon" />
              <span>{{ $t('assetDetailsPanel.preview.dropToSetThumbnail') }}</span>
            </div>
          </div>
          <!-- 统一预览逻辑：如果有预览图（customPoster 或 缩略图），优先显示图片 -->
          <div v-if="previewUrl" class="preview-box has-image" @click="handlePreviewImage">
            <video
              v-if="isPreviewVideo"
              ref="previewVideoRef"
              :src="previewUrl"
              class="preview-video"
              autoplay
              loop
              muted
              playsinline
              @click.stop="handleVideoFullscreen($event)"
            ></video>
            <img v-else :src="previewUrl" :alt="$t('assetLib.details.previewImage')" />
            <!-- 悬停时显示操作图标 -->
            <div v-if="showEditIcon && libraryCaps.canEditStructure" class="edit-icon-overlay">
              <PhVideoCamera
                class="record-icon"
                :title="$t('assetDetailsPanel.preview.recordCoverTitle')"
                @click.stop="handleOpenQuickRecorder"
              />
              <PhPencilSimple
                class="edit-icon"
                :title="$t('assetLib.details.changePreview')"
                @click.stop="handleOpenPoster"
              />
              <PhTrash
                v-if="hasCustomPoster"
                class="delete-icon"
                :title="$t('assetLib.details.resetPreview')"
                @click.stop="handleResetPoster"
              />
            </div>
            <!-- UE5 颜色条 -->
            <div
              v-if="isUAssetFile"
              class="preview-color-strip"
              :style="{ backgroundColor: getAssetTypeColor(asset?.className, asset?.assetName) }"
            ></div>
          </div>

          <!-- 文本/代码文件：没有预览图时显示文本预览 -->
          <div v-else-if="isTextFile || isCodeFile" class="text-preview-box">
            <div v-if="textPreviewLoading" class="text-preview-loading">
              <AppSpin size="small" />
              <span>{{ $t('common.loading') }}</span>
            </div>
            <div v-else-if="textPreviewError" class="text-preview-error">
              {{ textPreviewError }}
            </div>
            <div v-else-if="textPreviewContent" class="text-preview-content">
              <pre><code>{{ textPreviewContent }}</code></pre>
              <div v-if="textPreviewTruncated" class="text-preview-truncated">...</div>
            </div>
            <div v-else class="text-preview-empty">
              {{ $t('assetLib.details.previewUnavailable') }}
            </div>
            <!-- UE5 颜色条（如果有） -->
            <div
              v-if="isUAssetFile"
              class="preview-color-strip"
              :style="{ backgroundColor: getAssetTypeColor(asset?.className, asset?.assetName) }"
            ></div>
          </div>

          <!-- 其他情况：显示占位符或图标 -->
          <div v-else class="preview-box">
            <!-- 图片资产但加载失败或无预览图 -->
            <div v-if="isImageAsset" class="placeholder">
              {{ $t('assetLib.details.noPreview') }}
            </div>
            <!-- 虚幻资产或3D模型但无缩略图 -->
            <div v-else-if="isUnrealAssetFile || is3DModel" class="placeholder">
              {{ $t('assetLib.details.noThumbnail') }}
            </div>
            <!-- 其他文件显示图标 -->
            <div v-else class="file-icon-box-inner">
              <component :is="fileTypeIcon" class="file-type-icon" />
            </div>

            <!-- 悬停时显示编辑图标（允许为任何文件添加封面） -->
            <div v-if="showEditIcon && libraryCaps.canEditStructure" class="edit-icon-overlay">
              <PhVideoCamera
                class="record-icon"
                :title="$t('assetDetailsPanel.preview.recordCoverTitle')"
                @click.stop="handleOpenQuickRecorder"
              />
              <PhPencilSimple class="edit-icon" @click.stop="handleOpenPoster" />
            </div>

            <!-- UE5 颜色条 -->
            <div
              v-if="isUAssetFile"
              class="preview-color-strip"
              :style="{ backgroundColor: getAssetTypeColor(asset?.className, asset?.assetName) }"
            ></div>
          </div>
        </div>
        <h1 class="file-name">{{ asset?.assetName }}</h1>
        <div class="file-meta">
          {{ getFileTypeDisplay() }} ·
          {{ asset?.fileSize != null ? formatFileSize(asset.fileSize) : '—' }}
        </div>
      </div>

      <!-- UE5 资产特殊信息 -->
      <div v-if="isUAssetFile" class="inspector-group ue-asset-info">
        <div class="ue-section-header">
          <!-- 依赖图入口挪到了下面「导入依赖」那一组，跟依赖列表放在一起 -->
          <div class="ue-section-title">{{ $t('assetLib.details.assetInfo') }}</div>
        </div>
        <div class="ue-meta-grid">
          <div v-if="asset?.assetType" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.assetType') }}</label>
            <div class="ue-meta-value">{{ asset?.assetType }}</div>
          </div>
          <div v-if="asset?.classNameCn" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.classNameCn') }}</label>
            <div class="ue-meta-value">{{ asset?.classNameCn }}</div>
          </div>
          <div v-if="asset?.engineVersion" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.engineVersion') }}</label>
            <div class="ue-meta-value">{{ asset?.engineVersion }}</div>
          </div>
          <div v-if="asset?.className" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.className') }}</label>
            <div class="ue-meta-value">{{ asset?.className }}</div>
          </div>
          <div v-if="asset?.assetClass" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.assetClass') }}</label>
            <div class="ue-meta-value">{{ asset?.assetClass }}</div>
          </div>
          <div class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.format') }}</label>
            <div class="ue-meta-value">{{ asset?.fileExtension || '—' }}</div>
          </div>
          <div class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.created') }}</label>
            <div class="ue-meta-value">{{ asset?.created_at || '—' }}</div>
          </div>
          <div class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.modified') }}</label>
            <div class="ue-meta-value">{{ asset?.updated_at || '—' }}</div>
          </div>
          <!-- 软路径 -->
          <div v-if="asset?.softPath" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.softPath') }}</label>
            <div
              class="ue-meta-value soft-path clickable"
              :title="asset?.softPath + $t('assetLib.details.softPathTooltip')"
              @click="handleCopySoftPath"
            >
              {{ asset?.softPath }}
            </div>
          </div>
          <!-- 本地路径 -->
          <div v-if="localFilePath" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.localPath') }}</label>
            <div
              class="ue-meta-value soft-path clickable"
              :title="localFilePath + '\n\n' + $t('assetLib.details.localPathTooltip')"
              @click="handleCopyLocalPath"
            >
              {{ localFilePath }}
            </div>
          </div>
          <!-- 云端位置：百度网盘 -->
          <div v-if="(asset as any)?.baiduyunPath" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetDetailsPanel.cloud.baiduyunLabel') }}</label>
            <div
              class="ue-meta-value soft-path clickable"
              :title="
                (asset as any)?.baiduyunPath +
                '\n\n' +
                $t('assetDetailsPanel.cloud.baiduyunClickHint')
              "
              @click="handleGotoBaiduyun"
            >
              {{ (asset as any)?.baiduyunPath }}
            </div>
          </div>
          <!-- 云端位置：WebDAV -->
          <div v-if="(asset as any)?.webdavPath" class="ue-meta-row">
            <label class="ue-meta-label">{{ $t('assetLib.details.webdavPath', 'WebDAV') }}</label>
            <div
              class="ue-meta-value soft-path clickable"
              :title="
                (asset as any)?.webdavPath + '\n\n' + $t('assetDetailsPanel.cloud.webdavClickHint')
              "
              @click="handleGotoWebdav"
            >
              {{ (asset as any)?.webdavPath }}
            </div>
          </div>
        </div>
      </div>

      <!-- Meta Grid 容器：属性列表,使用分组块 -->
      <div v-if="!isUAssetFile" class="inspector-group">
        <div class="inspector-group-title">{{ $t('assetLib.details.fileInfo') }}</div>
        <div class="meta-grid-container">
          <div class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.format') }}</label>
            <div class="meta-value">{{ asset?.fileExtension || '—' }}</div>
          </div>
          <div class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.created') }}</label>
            <div class="meta-value">{{ asset?.created_at || '—' }}</div>
          </div>
          <div class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.modified') }}</label>
            <div class="meta-value">{{ asset?.updated_at || '—' }}</div>
          </div>
          <!-- 本地路径 -->
          <div v-if="localFilePath" class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.localPath') }}</label>
            <div
              class="meta-value soft-path clickable"
              :title="localFilePath + '\n\n' + $t('assetLib.details.localPathTooltip')"
              @click="handleCopyLocalPath"
            >
              {{ localFilePath }}
            </div>
          </div>
        </div>
      </div>

      <!-- 🔌 插件信息展示区域 -->
      <div v-if="isPluginFile && parsedPluginInfo" class="inspector-group plugin-info">
        <div class="inspector-group-title">{{ $t('assetDetailsPanel.plugin.infoTitle') }}</div>
        <div class="meta-grid-container">
          <div v-if="parsedPluginInfo.friendlyName" class="meta-row">
            <label class="meta-label">{{ $t('assetDetailsPanel.plugin.nameLabel') }}</label>
            <div class="meta-value plugin-name">{{ parsedPluginInfo.friendlyName }}</div>
          </div>
          <div v-if="parsedPluginInfo.versionName" class="meta-row">
            <label class="meta-label">{{ $t('assetDetailsPanel.plugin.versionLabel') }}</label>
            <div class="meta-value">
              <span>v{{ parsedPluginInfo.versionName }}</span>
              <span v-if="parsedPluginInfo.isBetaVersion" class="beta-badge">Beta</span>
              <span v-if="parsedPluginInfo.isExperimentalVersion" class="exp-badge">{{
                $t('assetDetailsPanel.plugin.experimentalBadge')
              }}</span>
            </div>
          </div>
          <div v-if="parsedPluginInfo.engineVersion" class="meta-row">
            <label class="meta-label">{{
              $t('assetDetailsPanel.plugin.engineVersionLabel')
            }}</label>
            <div class="meta-value">
              <span class="version-badge">UE {{ parsedPluginInfo.engineVersion }}</span>
            </div>
          </div>
          <div v-if="parsedPluginInfo.description" class="meta-row description-row">
            <label class="meta-label">{{ $t('assetDetailsPanel.plugin.descriptionLabel') }}</label>
            <div class="meta-value description">{{ parsedPluginInfo.description }}</div>
          </div>
          <div v-if="parsedPluginInfo.category" class="meta-row">
            <label class="meta-label">{{ $t('assetDetailsPanel.plugin.categoryLabel') }}</label>
            <div class="meta-value">{{ parsedPluginInfo.category }}</div>
          </div>
          <div v-if="parsedPluginInfo.createdBy" class="meta-row">
            <label class="meta-label">{{ $t('assetDetailsPanel.plugin.authorLabel') }}</label>
            <div class="meta-value">{{ parsedPluginInfo.createdBy }}</div>
          </div>
          <div v-if="parsedPluginInfo.canContainContent !== undefined" class="meta-row">
            <label class="meta-label">{{
              $t('assetDetailsPanel.plugin.canContainContentLabel')
            }}</label>
            <div class="meta-value">
              {{
                parsedPluginInfo.canContainContent
                  ? $t('assetDetailsPanel.plugin.yes')
                  : $t('assetDetailsPanel.plugin.no')
              }}
            </div>
          </div>
        </div>

        <!-- 模块列表 -->
        <div
          v-if="parsedPluginInfo.modules && parsedPluginInfo.modules.length > 0"
          class="plugin-modules"
        >
          <div class="module-title">
            {{
              $t('assetDetailsPanel.plugin.modulesTitle', {
                count: parsedPluginInfo.modules.length
              })
            }}
          </div>
          <div class="module-list">
            <div v-for="(mod, idx) in parsedPluginInfo.modules" :key="idx" class="module-item">
              <span class="module-name">{{ mod.Name }}</span>
              <span class="module-type">{{ mod.Type }}</span>
              <span v-if="mod.LoadingPhase" class="module-phase">{{ mod.LoadingPhase }}</span>
            </div>
          </div>
        </div>

        <!-- 依赖插件列表 -->
        <div
          v-if="parsedPluginInfo.plugins && parsedPluginInfo.plugins.length > 0"
          class="plugin-dependencies"
        >
          <div class="dep-title">
            {{
              $t('assetDetailsPanel.plugin.dependenciesTitle', {
                count: parsedPluginInfo.plugins.length
              })
            }}
          </div>
          <div class="dep-list">
            <div v-for="(dep, idx) in parsedPluginInfo.plugins" :key="idx" class="dep-item">
              <span class="dep-name">{{ dep.Name }}</span>
              <span :class="['dep-status', dep.Enabled ? 'enabled' : 'disabled']">
                {{
                  dep.Enabled
                    ? $t('assetDetailsPanel.plugin.enabledLabel')
                    : $t('assetDetailsPanel.plugin.disabledLabel')
                }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-group tag-container">
        <div class="inspector-group-title">{{ $t('assetLib.details.tags') }}</div>
        <div class="tag-list">
          <!-- 显示当前资产的标签列表 -->
          <AppTag
            v-for="tag in currentTags"
            :key="tag.id"
            size="medium"
            :removable="libraryCaps.tagModel !== 'none'"
            :title="tag.name"
            :remove-label="$t('common.remove')"
            @remove="removeTag(tag.id)"
          >
            {{ tag.name }}
          </AppTag>
          <AppTag
            v-if="libraryCaps.tagModel !== 'none'"
            size="medium"
            variant="dashed"
            interactive
            :icon="PhPlus"
            :title="$t('assetLib.details.addTag')"
            @click="handleOpenAssetTagModal"
          >
            {{ $t('assetLib.details.addTag') }}
          </AppTag>
          <span v-else class="capability-reason">{{ capabilityReason('tagModel') }}</span>
          <!-- 服务器库的标签按名字存：直接输入名字 -->
          <div v-if="nameTagInputOpen" class="name-tag-input">
            <a-input
              v-model:value="nameTagDraft"
              size="small"
              :placeholder="$t('catalogLibrary.detail.addTagPlaceholder')"
              @press-enter="confirmNameTag"
              @blur="confirmNameTag"
            />
          </div>

          <!-- 标签选择模态框 -->
          <TagSelectorModal
            v-model:open="tagModalOpen"
            :initial-selected-tag-ids="selectedTagIds"
            @confirm="handleTagSelectionConfirm"
          />
        </div>

        <!-- 智能标签区域（自动推断的隐式标签，只读 → outline 档） -->
        <div v-if="smartTags.length > 0 || pathTags.length > 0" class="smart-tags-section">
          <div class="smart-tags-label">
            <PhSparkle class="smart-tags-icon" />
            {{ $t('assetDetailsPanel.smartTags.label') }}
          </div>
          <div class="tag-list">
            <!-- 基于文件名规则推断的标签 -->
            <AppTag
              v-for="st in smartTags"
              :key="st.tag"
              size="medium"
              variant="outline"
              :dot="getSmartTagColor(st)"
              :title="$t('assetDetailsPanel.smartTags.autoDetectedTitle', { name: st.name })"
            >
              {{ st.tag }}
            </AppTag>
            <!-- 基于路径层级的标签 -->
            <AppTag
              v-for="pt in pathTags"
              :key="pt"
              size="medium"
              variant="outline"
              :icon="PhFolder"
              :title="$t('assetDetailsPanel.smartTags.pathTitle', { path: pt })"
            >
              {{ pt }}
            </AppTag>
          </div>
        </div>
      </div>

      <!-- Note 容器:备注 -->
      <NoteSection
        :note="noteContent"
        :note-id="assetNoteId"
        :default-title="asset?.assetName || ''"
        :save-note="handleSaveAssetNote"
        :save-note-id="handleSaveAssetNoteId"
        :readonly="!libraryCaps.canEditNotes"
        :readonly-reason="capabilityReason('canEditNotes')"
        :hide-rich-note="!libraryCaps.richNotes"
      />

      <!-- 导入依赖 -->
      <div v-if="isUAssetFile" class="inspector-group ue-imports-info">
        <div class="imports-header">
          <div class="ue-section-title">
            {{ $t('assetLib.details.dependencies') }}
            <span v-if="importTotal > 0" class="imports-count">{{ importTotal }}</span>
          </div>
          <span v-if="unresolvedCount > 0" class="imports-warning">
            {{ $t('assetLib.details.unresolvedCount', { count: unresolvedCount }) }}
          </span>
        </div>

        <div v-if="importsLoading" class="imports-loading">
          <AppSpin size="small" />
        </div>

        <template v-else-if="importTotal > 0">
          <div class="imports-list">
            <!-- 库里有的可以点开；库里没有的不给任何可点的暗示 -->
            <div
              v-for="item in visibleImportItems"
              :key="item.softPath"
              class="import-item"
              :class="{ resolved: item.status === 'in-vault', unresolved: item.isUnresolved }"
              :title="item.softPath"
              :role="item.status === 'in-vault' ? 'button' : undefined"
              :tabindex="item.status === 'in-vault' ? 0 : undefined"
              @click="handleImportClick(item)"
              @keydown.enter="handleImportClick(item)"
            >
              <span class="import-status-bar" :style="{ background: item.accentColor }"></span>
              <div class="import-text">
                <div class="import-name">{{ item.name }}</div>
                <div class="import-folder">{{ item.folder || '—' }}</div>
              </div>
              <PhWarningCircle v-if="item.isUnresolved" class="import-missing-icon" />
              <!-- 定位是第二个动作，给它自己的按钮。藏在双击里既不好发现，
                   又会和整行的单击打架 -->
              <AppTooltip
                v-else-if="item.folderKey"
                :title="$t('assetLib.details.locateDependency')"
              >
                <button
                  class="import-locate-btn"
                  :aria-label="$t('assetLib.details.locateDependency')"
                  @click.stop="handleImportLocate(item)"
                >
                  <PhExport />
                </button>
              </AppTooltip>
            </div>
          </div>

          <button v-if="canExpandImports" class="imports-expand" @click="importsExpanded = true">
            {{ $t('assetLib.details.showAllDependencies', { count: importTotal }) }}
          </button>

          <AppButton
            v-if="libraryCaps.dependencyGraph"
            variant="soft"
            size="small"
            block
            class="imports-graph-btn"
            @click="handleOpenDependencyGraph"
          >
            <template #icon><PhGraph /></template>
            {{ $t('assetLib.details.viewDependency') }}
          </AppButton>
        </template>

        <div v-else class="imports-empty">{{ $t('assetLib.details.noDependencies') }}</div>
      </div>

      <!-- Duplicate cropper modal removed -->
    </div>

    <div v-else-if="folder" class="panel-body">
      <!-- Header 容器：预览区 + 文件夹名称 -->
      <div class="header-container">
        <div
          class="preview-wrapper"
          :class="{ 'drag-over': isDragOver }"
          @mouseenter="showEditIcon = true"
          @mouseleave="showEditIcon = false"
          @dragover.prevent="handleDragOver"
          @dragenter.prevent="handleDragEnter"
          @dragleave="handleDragLeave"
          @drop.prevent="handleDrop"
        >
          <!-- 拖拽悬浮提示 -->
          <div v-if="isDragOver" class="drop-overlay">
            <div class="drop-hint">
              <PhCamera class="drop-icon" />
              <span>{{ $t('assetDetailsPanel.preview.dropToSetThumbnail') }}</span>
            </div>
          </div>
          <!-- 文件夹预览图逻辑 -->
          <div v-if="folderPreviewUrl" class="preview-box has-image" @click="handlePreviewImage">
            <video
              v-if="isFolderPreviewVideo"
              ref="previewVideoRef"
              :src="folderPreviewUrl"
              class="preview-video"
              autoplay
              loop
              muted
              playsinline
              @click.stop="handleVideoFullscreen($event)"
            ></video>
            <img v-else :src="folderPreviewUrl" :alt="folder.name" />
            <!-- 悬停时显示操作图标 -->
            <div v-if="showEditIcon && libraryCaps.canEditStructure" class="edit-icon-overlay">
              <PhVideoCamera
                class="record-icon"
                :title="$t('assetDetailsPanel.preview.recordCoverTitle')"
                @click.stop="handleOpenQuickRecorder"
              />
              <PhPencilSimple
                class="edit-icon"
                :title="$t('assetLib.details.changePreview')"
                @click.stop="handleOpenPoster"
              />
              <PhTrash
                v-if="hasFolderPoster"
                class="delete-icon"
                :title="$t('assetLib.details.resetPreview')"
                @click.stop="handleResetPoster"
              />
            </div>
          </div>

          <!-- 无预览图时显示默认图标 -->
          <div v-else class="preview-box">
            <div class="folder-icon-large">
              <PhFolder weight="fill" class="folder-icon-large-svg" />
            </div>
            <!-- 悬停时显示编辑图标 -->
            <div v-if="showEditIcon && libraryCaps.canEditStructure" class="edit-icon-overlay">
              <PhVideoCamera
                class="record-icon"
                :title="$t('assetDetailsPanel.preview.recordCoverTitle')"
                @click.stop="handleOpenQuickRecorder"
              />
              <PhPencilSimple class="edit-icon" @click.stop="handleOpenPoster" />
            </div>
          </div>
        </div>
        <h1 class="file-name">{{ folder.name }}</h1>
      </div>

      <!-- 统计信息卡片 -->
      <div class="folder-stats">
        <div class="stat-card">
          <div class="stat-value">{{ folder.foldersCount || 0 }}</div>
          <div class="stat-label">{{ $t('assetLib.details.subfolders') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ folder.filesCount || 0 }}</div>
          <div class="stat-label">{{ $t('assetLib.details.files') }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ (folder.foldersCount || 0) + (folder.filesCount || 0) }}</div>
          <div class="stat-label">{{ $t('assetLib.details.total') }}</div>
        </div>
      </div>

      <!-- Meta Grid 容器：属性列表，使用分组块 -->
      <div class="inspector-group">
        <div class="inspector-group-title">{{ $t('assetLib.details.details') }}</div>
        <div class="meta-grid-container">
          <div class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.path') }}</label>
            <div class="meta-value path-value" :title="folder.path">{{ folder.path }}</div>
          </div>
          <div class="meta-row">
            <label class="meta-label">{{ $t('assetLib.details.modified') }}</label>
            <div class="meta-value">—</div>
          </div>
        </div>
      </div>

      <!-- 文件夹标签容器（服务器库的文件夹只存颜色，没有标签和备注） -->
      <p v-if="libraryCaps.tagModel !== 'registry'" class="capability-reason folder-reason">
        {{ $t('catalogLibrary.reasons.folderAnnotations') }}
      </p>
      <div v-else class="inspector-group tag-container">
        <div class="inspector-group-title">{{ $t('assetLib.details.tags') }}</div>
        <div class="tag-list">
          <!-- 显示当前文件夹的标签列表 -->
          <AppTag
            v-for="tag in folderTags"
            :key="tag.id"
            size="medium"
            removable
            :title="tag.name"
            :remove-label="$t('common.remove')"
            @remove="removeFolderTag(tag.id)"
          >
            {{ tag.name }}
          </AppTag>
          <AppTag
            size="medium"
            variant="dashed"
            interactive
            :icon="PhPlus"
            :title="$t('assetLib.details.addTag')"
            @click="handleOpenFolderTagModal"
          >
            {{ $t('assetLib.details.addTag') }}
          </AppTag>

          <!-- 文件夹标签选择模态框 -->
          <TagSelectorModal
            v-model:open="folderTagModalOpen"
            :initial-selected-tag-ids="folderSelectedTagIds"
            @confirm="handleFolderTagSelectionConfirm"
          />
        </div>
      </div>

      <NoteSection
        v-if="libraryCaps.tagModel === 'registry'"
        :note="folderNoteContent"
        :note-id="folderNoteId"
        :default-title="folder?.name || ''"
        :save-note="handleSaveFolderNote"
        :save-note-id="handleSaveFolderNoteId"
      />
    </div>

    <div v-else class="empty">
      <div class="empty-state-content">
        <PhCursorClick class="empty-icon" />
        <div class="empty-text">{{ $t('assetLib.details.selectPrompt') }}</div>
        <div class="empty-desc">{{ $t('assetLib.details.selectPromptDesc') }}</div>
      </div>
    </div>

    <AppModal
      v-model:open="recordingModalOpen"
      :title="$t('assetDetailsPanel.preview.recordCoverTitle')"
      class="recording-cover-modal"
      :mask-closable="!exportingCover"
      :closable="!exportingCover"
      @cancel="handleCloseRecordingModal"
    >
      <div class="recording-cover-body">
        <video
          v-if="recordingPreviewUrl"
          class="recording-cover-video"
          controls
          :src="recordingPreviewUrl"
          @loadedmetadata="handleRecordingMetadata"
        />
        <div v-else class="recording-cover-empty">
          {{ $t('assetDetailsPanel.recording.notFound') }}
        </div>
      </div>
      <div class="recording-cover-options">
        <div class="recording-cover-label">
          {{ $t('assetDetailsPanel.recording.saveFormatLabel') }}
        </div>
        <a-radio-group
          v-model:value="recordingFormat"
          class="recording-cover-group"
          :disabled="exportingCover"
        >
          <a-radio-button value="gif">GIF</a-radio-button>
          <a-radio-button value="mp4">MP4</a-radio-button>
        </a-radio-group>
      </div>
      <template #footer>
        <AppButton :disabled="exportingCover" @click="handleCloseRecordingModal">{{
          $t('assetDetailsPanel.recording.cancel')
        }}</AppButton>
        <AppButton variant="primary" :loading="exportingCover" @click="handleConfirmRecordingCover">
          {{ $t('assetDetailsPanel.recording.confirm') }}
        </AppButton>
      </template>
    </AppModal>

    <!-- 图片裁剪弹窗 -->
    <ImageCropperModal
      v-model:open="cropperModalOpen"
      :image="cropperImage"
      :loading="posterUploading"
      @confirm="onCropConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import { ref, watch, computed, inject, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { AssetDetail } from '../types'
import TagSelectorModal from '@renderer/components/TagSelector/TagSelectorModal.vue'
import NoteSection from './NoteSection.vue'
import ImageCropperModal from './modals/ImageCropperModal.vue'
import { confirmDialog } from '@renderer/utils/dialog'
import { message } from '@/utils/messageManager'
import { useVaultStore, VaultType } from '@renderer/store/modules/vaultStore'
import { buildThumbnailUrl, buildDirectFileUrl } from '@renderer/utils/thumbnails'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { listThumbnailUrl } from '@renderer/utils/listThumbnail'
import {
  fetchRemoteTextPreview,
  resolveAssetAccess,
  resolveAssetUrl,
  resolveAssetUrlWithFallback
} from '@renderer/utils/assetAccess'
import { formatFileSize, getAssetTypeColor } from '@renderer/utils/tool'
import {
  computeSmartTags,
  extractPathTags,
  getSmartTagColor,
  type SmartTagRule
} from '@renderer/utils/smartTags'
import { openImageViewer } from '@renderer/services/imageViewer'
import {
  PhCamera,
  PhCode,
  PhCursorClick,
  PhExport,
  PhFile,
  PhFilePdf,
  PhFileText,
  PhFileZip,
  PhFolder,
  PhGraph,
  PhPencilSimple,
  PhPlus,
  PhSparkle,
  PhTrash,
  PhVideoCamera,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue'
import type { AssetImportStatusSummary } from '@core/shared/assetDependency'
import folderTagAPI from '@renderer/api/folderTag'
import assetDataAPI from '@renderer/api/assetData'
import assetFolderAPI from '@renderer/api/assetFolder'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import { useWebdavStore } from '@renderer/store/modules/webdav'
import { useAssetViewStore } from '@renderer/store/modules/assetViewStore'
import { ensureFFmpeg } from '@renderer/utils/ffmpegGuard'
import { resolveErrorText } from '../utils/assetVaultHelpers'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import { getActiveLibrarySource } from '../data/activeLibrarySource'

const props = defineProps<{
  visible?: boolean
  asset?: AssetDetail | null
  folder?: {
    key: string
    name: string
    path: string
    foldersCount: number
    filesCount: number
    img?: string
  } | null
}>()
const emit = defineEmits(['close', 'updatePoster', 'folder-updated', 'locate-in-folder'])

const { t } = useI18n()
const router = useRouter()
const selectedAsset = inject('selectedAsset', null) as any
const showEditIcon = ref(false)
const isDragOver = ref(false)
let dragCounter = 0 // 用于处理子元素触发的 dragenter/dragleave 事件

// 视频预览相关
const previewVideoRef = ref<HTMLVideoElement | null>(null)
const recordingModalOpen = ref(false)
const recordingPreviewUrl = ref('')
const recordingFilePath = ref('')
const recordingDuration = ref(0)
const exportingCover = ref(false)
const exportingFormat = ref<'mp4' | 'gif' | ''>('')
const recordingFormat = ref<'mp4' | 'gif'>('gif')
let recordingChannel: BroadcastChannel | null = null

const handleOpenQuickRecorder = async (): Promise<void> => {
  try {
    window.api.screenRecorder.openQuickWindow()
  } catch (error) {
    message.error(resolveErrorText(error, t('assetDetailsPanel.recording.cannotRecord')))
  }
}

const handleRecordingMetadata = (event: Event): void => {
  const videoEl = event.target as HTMLVideoElement
  const duration = Number(videoEl?.duration || 0)
  recordingDuration.value = Number.isFinite(duration) ? duration : 0
}

const handleCloseRecordingModal = (): void => {
  if (exportingCover.value) return
  recordingModalOpen.value = false
}

const resetRecordingModalState = (): void => {
  recordingPreviewUrl.value = ''
  recordingFilePath.value = ''
  recordingDuration.value = 0
  exportingCover.value = false
  exportingFormat.value = ''
  recordingFormat.value = 'gif'
}

const handleApplyThumbnailFileName = async (fileName: string): Promise<boolean> => {
  if (!fileName) return false
  if (props.folder && !props.asset) {
    const folderKey = props.folder.key
    posterUploading.value = true
    try {
      const res = await assetFolderAPI.update(folderKey, { img: fileName })
      if (res.updated) {
        message.success(t('assetDetailsPanel.folderCover.updated'))
        emit('folder-updated', { key: folderKey, img: fileName })
        return true
      }
      message.error(t('assetDetailsPanel.folderCover.saveConfigFailed'))
      return false
    } catch (error) {
      console.error(error)
      message.error(resolveErrorText(error, t('assetDetailsPanel.common.saveFailed')))
      return false
    } finally {
      posterUploading.value = false
    }
  }

  const assetKey = (props.asset as { assetKey?: string })?.assetKey
  if (!assetKey) return false

  posterUploading.value = true
  try {
    const res = await (window as any).api.database.assetData.update(assetKey, {
      customPoster: fileName
    })
    if (res?.success) {
      message.success(t('assetDetailsPanel.preview.updated'))
      const sel = (selectedAsset as { value?: { assetKey?: string; customPoster?: string } })?.value
      if (sel && sel.assetKey === assetKey) {
        sel.customPoster = fileName
      }
      emit('updatePoster', fileName)
      return true
    }
    message.error(t('assetDetailsPanel.preview.saveConfigFailed'))
    return false
  } catch (error) {
    console.error(error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.common.saveFailed')))
    return false
  } finally {
    posterUploading.value = false
  }
}

const getRecordingThumbnailName = (format: 'mp4' | 'gif'): string => {
  const key = props.asset?.assetKey || props.folder?.key
  const safeKey = key || 'cover'
  return `custom-${safeKey}-${Date.now()}.${format}`
}

const handleSaveRecordingCover = async (format: 'mp4' | 'gif'): Promise<void> => {
  if (exportingCover.value) return
  if (!recordingFilePath.value) {
    message.error(t('assetDetailsPanel.recording.fileNotFound'))
    return
  }
  exportingCover.value = true
  exportingFormat.value = format
  const trimEnd = recordingDuration.value > 0 ? recordingDuration.value : 0
  try {
    const fileName = getRecordingThumbnailName(format)
    const pathResult = await window.api.path.getVaultThumbnailFilePath(fileName)
    if (!pathResult?.success || !pathResult.data) {
      message.error(pathResult?.error || t('assetDetailsPanel.recording.getThumbnailPathFailed'))
      return
    }
    // 没装 FFmpeg 就弹安装指引，别让用户拿到一句「导出失败」
    if (!(await ensureFFmpeg())) return

    const result = await window.api.screenRecorder.exportRecording({
      inputPath: recordingFilePath.value,
      format,
      quality: 'balanced',
      resolution: 'original',
      fps: 30,
      bitrate: 12,
      includeAudio: format === 'mp4',
      highQualityScale: true,
      trimStart: 0,
      trimEnd,
      outputPath: pathResult.data
    })
    if (!result?.success || !result.filePath) {
      message.error(result?.error || t('assetDetailsPanel.recording.exportFailed'))
      return
    }
    const saved = await handleApplyThumbnailFileName(fileName)
    if (!saved) return
    recordingModalOpen.value = false
    const originalFilePath = recordingFilePath.value
    confirmDialog({
      title: t('assetDetailsPanel.recording.deleteOriginalTitle'),
      content: t('assetDetailsPanel.recording.deleteOriginalContent'),
      okText: t('assetDetailsPanel.recording.deleteOriginalOk'),
      cancelText: t('assetDetailsPanel.recording.cancel'),
      centered: true,
      onOk: async () => {
        if (originalFilePath) {
          const res = await window.api.screenRecorder.deleteRecording(originalFilePath)
          if (res.success) {
            message.success(t('assetDetailsPanel.recording.originalDeleted'))
          } else {
            message.error(res.error || t('assetDetailsPanel.common.deleteFailed'))
          }
        }
      }
    })
  } catch (error) {
    console.error('导出失败:', error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.recording.exportFailed')))
  } finally {
    exportingCover.value = false
    exportingFormat.value = ''
  }
}

const handleConfirmRecordingCover = async (): Promise<void> => {
  await handleSaveRecordingCover(recordingFormat.value)
}

const handleRecordingMessage = (data: any): void => {
  if (!data || data.type !== 'recording-complete') return
  const filePath = typeof data.filePath === 'string' ? data.filePath : ''
  if (!filePath) return
  window.api.window.focus()
  recordingFilePath.value = filePath
  recordingPreviewUrl.value = toLocalResourceUrl(filePath) ?? ''
  recordingDuration.value = 0
  recordingFormat.value = 'gif'
  recordingModalOpen.value = true
}

onMounted(() => {
  recordingChannel = new BroadcastChannel('screen-recorder-cover')
  recordingChannel.onmessage = (event) => {
    handleRecordingMessage(event.data)
  }
})

watch(recordingModalOpen, (open) => {
  if (!open) {
    resetRecordingModalState()
  }
})

onUnmounted(() => {
  recordingChannel?.close()
  recordingChannel = null
})

/** 点击视频预览时全屏播放 */
const handleVideoFullscreen = (event: MouseEvent): void => {
  // 直接从事件目标获取视频元素，更可靠
  const videoEl = event.target as HTMLVideoElement
  if (!videoEl || videoEl.tagName !== 'VIDEO') {
    console.warn('[handleVideoFullscreen] 无法获取视频元素')
    return
  }

  console.log('[handleVideoFullscreen] 正在请求全屏...')

  try {
    if (videoEl.requestFullscreen) {
      videoEl.requestFullscreen()
    } else if ((videoEl as any).webkitRequestFullscreen) {
      ;(videoEl as any).webkitRequestFullscreen()
    } else if ((videoEl as any).msRequestFullscreen) {
      ;(videoEl as any).msRequestFullscreen()
    }
    // 全屏后显示控件（保持静音，用户可手动开启声音）
    videoEl.controls = true
  } catch (error) {
    console.error('无法进入全屏模式:', error)
  }
}

// 云端存储 store 实例（用于应用内跳转）
const baiduyunStore = useBaiduyunStore()
const webdavStore = useWebdavStore()
const assetViewStore = useAssetViewStore()

// 当前标签展示与选择
interface SimpleTag {
  id: number
  name: string
  color?: string
}
const currentTags = ref<SimpleTag[]>([])
const selectedTagIds = ref<number[]>([])
const tagModalOpen = ref(false)

// ==================== 更换预览图相关 ====================
// 裁剪弹窗状态
const cropperModalOpen = ref(false)
const cropperImage = ref<string>('')
const posterUploading = ref(false)
// 双图保存：待保存的原图 base64（用于空格预览）
const pendingOriginalBase64 = ref<string>('')

// 判断是否有自定义预览图
const hasCustomPoster = computed((): boolean => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  return !!(displayAsset as AssetDetail & { customPoster?: string }).customPoster
})

// 文件夹是否有自定义封面
const hasFolderPoster = computed(() => {
  return !!props.folder?.img
})

// 文件夹预览图
const folderPreviewUrl = computed(() => {
  if (!props.folder || !props.folder.img) return undefined
  const img = props.folder.img
  if (/^(http|file)/i.test(img)) {
    return toLocalResourceUrl(img)
  }
  const basePath = getThumbnailBasePath()
  const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
  return buildThumbnailUrl(basePath, img, isNetworkVault)
})

const isFolderPreviewVideo = computed(() => {
  if (!folderPreviewUrl.value) return false
  const url = folderPreviewUrl.value.toLowerCase().split('?')[0]
  // 检查 URL 结尾或 URL 解码后结尾
  if (['.mp4', '.webm', '.ogg', '.mov'].some((ext) => url.endsWith(ext))) {
    return true
  }
  // 尝试解码后检查
  try {
    const decoded = decodeURIComponent(url)
    return ['.mp4', '.webm', '.ogg', '.mov'].some((ext) => decoded.endsWith(ext))
  } catch {
    return false
  }
})

// 备注：一句话备注是纯文本，详细说明是挂在 note 表上的一篇富文本笔记。
// 编辑态归 NoteSection 自己管，这里只存「当前是什么」
const noteContent = ref('')
const assetNoteId = ref<number | null>(null)
const folderNoteContent = ref('')
const folderNoteId = ref<number | null>(null)

// 依赖关系图相关状态已移除，改为在新tab中显示

// 文本预览相关
const textPreviewContent = ref<string>('')
const textPreviewLoading = ref(false)
const textPreviewError = ref<string | null>(null)
const textPreviewTruncated = ref(false)
const textPreviewRequestId = ref(0)

const isPreviewVideo = computed(() => {
  // 检查 previewUrl 或 folderPreviewUrl（文件夹封面）
  const urlToCheck = previewUrl.value || folderPreviewUrl.value
  if (!urlToCheck) return false
  const url = urlToCheck.toLowerCase().split('?')[0]
  // 检查 URL 结尾或 URL 解码后结尾
  if (['.mp4', '.webm', '.ogg', '.mov'].some((ext) => url.endsWith(ext))) {
    return true
  }
  // 尝试解码后检查
  try {
    const decoded = decodeURIComponent(url)
    return ['.mp4', '.webm', '.ogg', '.mov'].some((ext) => decoded.endsWith(ext))
  } catch {
    return false
  }
})

// 判断是否为图片资产
const isImageAsset = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = displayAsset.assetName || ''
  const ext = displayAsset.fileExtension || ''
  const imageExts = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.svg',
    '.webp',
    '.tga',
    '.dds',
    '.texture',
    '.tif',
    '.tiff',
    '.avif'
  ]
  return imageExts.some(
    (e) => fileName.toLowerCase().endsWith(e) || ext.toLowerCase() === e.replace('.', '')
  )
})

// 判断是否为 .uasset 或 .umap 文件
const isUAssetFile = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()
  return (
    fileName.endsWith('.uasset') ||
    fileName.endsWith('.umap') ||
    ext === 'uasset' ||
    ext === 'umap' ||
    (displayAsset as any).classKey === 'uasset' ||
    (displayAsset as any).classKey === 'umap'
  )
})

// 判断是否为虚幻资产文件（uasset 或 umap）
const isUnrealAssetFile = computed(() => {
  return isUAssetFile.value
})

// 🔌 判断是否为插件文件 (.uplugin)
const isPluginFile = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()
  return fileName.endsWith('.uplugin') || ext === 'uplugin'
})

// 🔌 解析插件信息
interface PluginModule {
  Name: string
  Type: string
  LoadingPhase?: string
}
interface PluginDependency {
  Name: string
  Enabled: boolean
}
interface ParsedPluginInfo {
  friendlyName?: string
  description?: string
  category?: string
  createdBy?: string
  versionName?: string
  version?: number
  engineVersion?: string
  isBetaVersion?: boolean
  isExperimentalVersion?: boolean
  canContainContent?: boolean
  modules?: PluginModule[]
  plugins?: PluginDependency[]
}
const parsedPluginInfo = computed((): ParsedPluginInfo | null => {
  const displayAsset = props.asset
  if (!displayAsset || !isPluginFile.value) {
    console.log(
      '🔌 [parsedPluginInfo] 跳过: displayAsset=',
      !!displayAsset,
      'isPluginFile=',
      isPluginFile.value
    )
    return null
  }

  const pluginInfoStr = (displayAsset as any).pluginInfo
  console.log('🔌 [parsedPluginInfo] 资产数据:', {
    assetName: displayAsset.assetName,
    fileExtension: displayAsset.fileExtension,
    hasPluginInfo: !!pluginInfoStr,
    pluginInfoLength: pluginInfoStr?.length,
    pluginInfoPreview: pluginInfoStr?.substring(0, 100)
  })

  if (!pluginInfoStr) {
    console.log('🔌 [parsedPluginInfo] pluginInfo 为空')
    return null
  }

  try {
    const parsed = JSON.parse(pluginInfoStr) as ParsedPluginInfo
    console.log('🔌 [parsedPluginInfo] 解析成功:', parsed)
    return parsed
  } catch (err) {
    console.error('解析插件信息失败:', err)
    return null
  }
})

// 判断是否为文本文件
const isTextFile = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()
  const textExts = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.scss', '.less', '.log']
  return textExts.some((e) => fileName.endsWith(e) || ext === e.replace('.', ''))
})

// 判断是否为代码文件
const isCodeFile = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()
  const codeExts = [
    '.ts',
    '.js',
    '.jsx',
    '.tsx',
    '.vue',
    '.cpp',
    '.h',
    '.cs',
    '.java',
    '.py',
    '.go',
    '.rs',
    '.php',
    '.rb',
    '.swift',
    '.kt'
  ]
  return codeExts.some((e) => fileName.endsWith(e) || ext === e.replace('.', ''))
})

// 判断是否为 3D 模型文件
const is3DModel = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return false
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()
  const modelExts = ['.fbx', '.obj', '.glb', '.gltf']
  return modelExts.some((e) => fileName.endsWith(e) || ext === e.replace('.', ''))
})

/**
 * 导入依赖。
 *
 * 以前这里是把 asset.imports 这个 JSON 字符串就地拆成字符串数组铺出来 ——
 * 展示的是解析器的输入。现在改成问主进程要解析后的结果：每条依赖在不在
 * 当前保管库里。用户看依赖是想知道「这资产搬走了会不会坏」，不是想读路径。
 */
const IMPORTS_COLLAPSED_COUNT = 8

const importStatus = ref<AssetImportStatusSummary | null>(null)
const importsLoading = ref(false)
const importsExpanded = ref(false)
let importStatusRequestId = 0

const importTotal = computed(() => importStatus.value?.total ?? 0)
const unresolvedCount = computed(() => importStatus.value?.unresolvedCount ?? 0)

/** 给每条依赖补上渲染要用的派生字段，模板里就不用再算了 */
const importItems = computed(() =>
  (importStatus.value?.items ?? []).map((item) => ({
    ...item,
    isUnresolved: item.status === 'unresolved',
    accentColor:
      item.status === 'unresolved'
        ? 'var(--color-warning-solid)'
        : getAssetTypeColor(item.className, item.name)
  }))
)

const canExpandImports = computed(
  () => !importsExpanded.value && importTotal.value > IMPORTS_COLLAPSED_COUNT
)

const visibleImportItems = computed(() =>
  importsExpanded.value ? importItems.value : importItems.value.slice(0, IMPORTS_COLLAPSED_COUNT)
)

const loadImportStatus = async (assetKey: string | undefined): Promise<void> => {
  const requestId = ++importStatusRequestId
  importsExpanded.value = false

  if (!assetKey) {
    importStatus.value = null
    importsLoading.value = false
    return
  }

  importsLoading.value = true
  try {
    const summary = await getActiveLibrarySource().assets.getImportStatus(assetKey)
    // 用户可能已经点到别的资产上了，迟到的结果直接丢掉
    if (requestId !== importStatusRequestId) return
    importStatus.value = summary
  } catch (error) {
    if (requestId !== importStatusRequestId) return
    console.error('获取导入依赖失败:', error)
    importStatus.value = null
  } finally {
    if (requestId === importStatusRequestId) importsLoading.value = false
  }
}

watch(
  () => [props.asset?.assetKey, isUAssetFile.value] as const,
  ([assetKey, isUAsset]) => {
    void loadImportStatus(isUAsset ? (assetKey as string | undefined) : undefined)
  },
  { immediate: true }
)

/** 单击库里有的依赖：面板内切过去看它 */
const handleImportClick = async (item: (typeof importItems.value)[number]): Promise<void> => {
  if (item.status !== 'in-vault' || !item.assetKey) return
  try {
    const target = await getActiveLibrarySource().assets.getById(item.assetKey)
    if (!target) {
      message.warning(t('assetLib.details.dependencyNotFound'))
      return
    }
    if (selectedAsset) selectedAsset.value = target
  } catch (error) {
    console.error('打开依赖资产失败:', error)
    message.warning(t('assetLib.details.dependencyNotFound'))
  }
}

/**
 * 跳到这条依赖所在的文件夹。
 * 把 assetKey 一起给出去 —— 只跳到目录、让用户在一屏文件里自己找，等于没跳。
 */
const handleImportLocate = (item: (typeof importItems.value)[number]): void => {
  if (item.status !== 'in-vault' || !item.folderKey || !item.assetKey) return
  emit('locate-in-folder', item.folderKey, item.assetKey)
}

/**
 * 智能标签：根据文件名自动推断的分类标签
 * 例如 T_Hero_D.uasset -> Texture, Diffuse
 */
const smartTags = computed((): SmartTagRule[] => {
  if (!props.asset?.assetName) return []
  return computeSmartTags(props.asset.assetName)
})

/**
 * 路径标签：从 softPath 中提取的目录层级
 * 例如 /Game/Characters/Hero/Textures/T_Hero_D -> ['Characters', 'Hero', 'Textures']
 */
const pathTags = computed((): string[] => {
  const softPath = (props.asset as { softPath?: string })?.softPath
  if (!softPath) return []
  return extractPathTags(softPath)
})

/**
 * 辅助函数：解析相对路径
 */
const resolveRelativePath = (basePath: string, relativePath: string): string => {
  if (!basePath || !relativePath) return relativePath

  // 统一转为 POSIX 风格
  const normalize = (p: string) => p.replace(/\\/g, '/')
  const base = normalize(basePath)
  const rel = normalize(relativePath)

  // 如果已经是绝对路径，直接返回
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
    return rel
  }

  const baseParts = base.split('/').filter((p) => p && p !== '.')
  const relParts = rel.split('/').filter((p) => p && p !== '.')

  for (const part of relParts) {
    if (part === '..') {
      if (baseParts.length > 0) baseParts.pop()
    } else {
      baseParts.push(part)
    }
  }

  return baseParts.join('/')
}

/**
 * 本地路径：从 asset 中提取本地文件路径
 * 优先使用 originPath，其次使用 filePath
 * 如果是相对路径（如 ../../Data），则结合 Vault 路径计算出绝对路径
 */
const localFilePath = computed((): string | undefined => {
  const displayAsset = props.asset
  if (!displayAsset) return undefined

  let pathStr = (displayAsset as any)?.originPath || (displayAsset as any)?.filePath
  if (!pathStr) return undefined

  // 尝试解析相对路径
  const isAbsolute =
    /^[a-zA-Z]:/.test(pathStr) || pathStr.startsWith('/') || pathStr.startsWith('\\')

  if (!isAbsolute && currentVault.value?.path) {
    pathStr = resolveRelativePath(currentVault.value.path, pathStr)
  }

  // 统一显示为系统风格（Windows 下用反斜杠）
  return pathStr.replace(/\//g, '\\')
})

// 获取文件类型图标
const fileTypeIcon = computed(() => {
  if (!props.asset) return PhFile
  const ext = (props.asset.fileExtension || '').toLowerCase()
  const fileName = (props.asset.assetName || '').toLowerCase()

  // 代码文件
  if (
    ['.ts', '.js', '.jsx', '.tsx', '.vue', '.cpp', '.h', '.cs', '.java', '.py'].some(
      (e) => fileName.endsWith(e) || ext === e.replace('.', '')
    )
  ) {
    return PhCode
  }
  // 文本文件
  if (
    ['.txt', '.md', '.json', '.xml', '.html', '.css', '.scss', '.less'].some(
      (e) => fileName.endsWith(e) || ext === e.replace('.', '')
    )
  ) {
    return PhFileText
  }
  // PDF
  if (fileName.endsWith('.pdf') || ext === 'pdf') {
    return PhFilePdf
  }
  // 压缩文件
  if (
    ['.zip', '.rar', '.7z', '.tar', '.gz'].some(
      (e) => fileName.endsWith(e) || ext === e.replace('.', '')
    )
  ) {
    return PhFileZip
  }
  // 默认
  return PhFile
})

// 预览图完整链接
// 优先级：customPoster > imgLocalPath > 图片文件路径 (originPath/filePath) > thumbnail
const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)

// ---- 当前数据源能做什么（服务器库：标签和备注按名字存在服务端，没有封面编辑和依赖图）
const libraryStore = useAssetLibraryStore()
const libraryCaps = computed(() => libraryStore.capabilities)
const capabilityReason = (name: string): string => {
  const key = libraryCaps.value.reasons[name]
  return key ? t(key) : ''
}
const nameTagInputOpen = ref(false)
const nameTagDraft = ref('')

/** 按名字的标签（服务器库）：写到服务端，再按回来的结果显示 */
const editNameTags = async (op: { addTags?: string[]; removeTags?: string[] }): Promise<void> => {
  const assetKey = props.asset?.assetKey
  const annotations = getActiveLibrarySource().annotations
  if (!assetKey || !annotations) return
  const result = await annotations.edit({ assetKey }, op)
  if (!result.ok) {
    message.error(t('catalogLibrary.detail.editFailed', { reason: result.error ?? '' }))
    return
  }
  await loadAssetTags(String(assetKey))
}

const confirmNameTag = async (): Promise<void> => {
  const tag = nameTagDraft.value.trim()
  nameTagInputOpen.value = false
  nameTagDraft.value = ''
  if (!tag || currentTags.value.some((existing) => existing.name === tag)) return
  await editNameTags({ addTags: [tag] })
}
// 获取缩略图基础路径：网络库使用 networkPath，其他类型使用本地 path
const getThumbnailBasePath = (): string | undefined => {
  const vault = currentVault.value
  if (!vault) return undefined
  // 网络类型保管库使用 networkPath，缩略图存储在 .thumbnails 目录
  if (vault.vaultType === VaultType.NETWORK && vault.networkPath) {
    return vault.networkPath
  }
  return vault.path
}

const previewUrl = computed(() => {
  const displayAsset = props.asset
  if (!displayAsset) return undefined
  // 数据源直接给了地址（服务器库：uebox-preview://）
  const readyUrl = (displayAsset as { thumbnailUrl?: string | null }).thumbnailUrl
  if (readyUrl) return readyUrl

  const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK

  // 1. 优先使用 customPoster
  const customPoster = (displayAsset as any)?.customPoster as string | undefined
  if (customPoster) {
    // 本地 file URL 必须转换为应用协议，开发模式下才能加载。
    if (customPoster.startsWith('http') || customPoster.startsWith('file:')) {
      return toLocalResourceUrl(customPoster)
    }
    // 否则视为本地文件名，构建完整路径
    const basePath = getThumbnailBasePath()
    // 🔧 传入 isNetworkVault 以使用正确的缩略图目录
    return buildThumbnailUrl(basePath, customPoster, isNetworkVault)
  }

  if (isImageAsset.value && currentVault.value?.vaultType === VaultType.REFERENCE) {
    return listThumbnailUrl(
      resolveAssetUrl({
        vaultType: currentVault.value.vaultType,
        vaultPath: currentVault.value.path,
        originPath: displayAsset.originPath,
        filePath: displayAsset.filePath
      })
    )
  }

  // 2. 使用 imgLocalPath（如 uasset 的缩略图）
  const imgLocalPath = displayAsset.imgLocalPath
  if (imgLocalPath) {
    // 🔧 统一使用 buildThumbnailUrl，传入 isNetworkVault
    const basePath = getThumbnailBasePath()
    return buildThumbnailUrl(basePath, imgLocalPath, isNetworkVault)
  }

  // 3. 如果是图片文件，使用 originPath 或 filePath 直接加载
  // 🔧 使用 buildDirectFileUrl：图片文件本身就是预览资源，不在 .thumbnails 目录下
  if (isImageAsset.value) {
    // 网络库优先用 filePath（相对路径），本地库优先用 originPath（绝对路径）
    const filePath = isNetworkVault
      ? (displayAsset as any)?.filePath || (displayAsset as any)?.originPath
      : (displayAsset as any)?.originPath || (displayAsset as any)?.filePath
    if (filePath) {
      const basePath = getThumbnailBasePath()
      return buildDirectFileUrl(basePath, filePath, isNetworkVault)
    }
  }

  // 4. 回退到 thumbnail 字段
  return toLocalResourceUrl((displayAsset as AssetDetail & { thumbnail?: string }).thumbnail)
})

// 获取文件类型显示文本
const getFileTypeDisplay = () => {
  const displayAsset = props.asset
  if (!displayAsset) return t('assetLib.details.file')
  const ext = displayAsset.fileExtension || ''
  if (ext) {
    return ext.toUpperCase() + t('assetLib.details.fileSuffix')
  }
  return t('assetLib.details.file')
}

// 直接上传（跳过裁剪，用于GIF/视频）
const handleDirectUpload = async (filePath: string): Promise<boolean> => {
  // 1. Folder
  if (props.folder && !props.asset) {
    const folderKey = props.folder.key
    posterUploading.value = true
    try {
      const result = await (window as any).api.asset.saveThumbnailFile(filePath, folderKey)
      if (result.success && result.data) {
        const fileName = result.data
        const res = await assetFolderAPI.update(folderKey, { img: fileName })
        if (res.updated) {
          message.success(t('assetDetailsPanel.folderCover.updated'))
          emit('folder-updated', { key: folderKey, img: fileName })
          return true
        } else {
          message.error(t('assetDetailsPanel.folderCover.saveConfigFailed'))
          return false
        }
      } else {
        message.error(result.error || t('assetDetailsPanel.folderCover.saveFileFailed'))
        return false
      }
    } catch (e) {
      console.error(e)
      message.error(resolveErrorText(e, t('assetDetailsPanel.common.saveFailed')))
      return false
    } finally {
      posterUploading.value = false
    }
    return false
  }

  // 2. Asset
  const assetKey = (props.asset as { assetKey?: string })?.assetKey
  if (!assetKey) return false

  posterUploading.value = true
  try {
    const result = await (window as any).api.asset.saveThumbnailFile(filePath, assetKey)
    if (result.success && result.data) {
      const fileName = result.data
      const res = await (window as any).api.database.assetData.update(assetKey, {
        customPoster: fileName
      })
      if (res?.success) {
        message.success(t('assetDetailsPanel.preview.updated'))
        const sel = (selectedAsset as { value?: { assetKey?: string; customPoster?: string } })
          ?.value
        if (sel && sel.assetKey === assetKey) {
          sel.customPoster = fileName
        }
        emit('updatePoster', fileName)
        return true
      } else {
        message.error(t('assetDetailsPanel.preview.saveConfigFailed'))
        return false
      }
    } else {
      message.error(result.error || t('assetDetailsPanel.preview.saveFileFailed'))
      return false
    }
  } catch (e) {
    console.error(e)
    message.error(resolveErrorText(e, t('assetDetailsPanel.common.saveFailed')))
    return false
  } finally {
    posterUploading.value = false
  }
}

// 打开文件选择器选择预览图
const handleOpenPoster = async (): Promise<void> => {
  try {
    const result = await (window as any).api.dialog.showOpenDialog({
      title: t('assetLib.details.selectPreview'),
      properties: ['openFile'],
      filters: [
        {
          name: t('assetLib.details.previewFile', 'Image/Video'),
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'ogg', 'mov']
        }
      ]
    })
    if (result?.canceled || !result?.filePaths?.[0]) return

    const filePath = result.filePaths[0]
    const ext = filePath.split('.').pop()?.toLowerCase() || ''

    // GIF 和视频文件：跳过裁剪，直接保存
    const skipCropExts = ['gif', 'mp4', 'webm', 'ogg', 'mov']
    if (skipCropExts.includes(ext)) {
      // 读取文件并直接保存
      const fileData = await (window as any).api.fs.readFile(filePath, {
        encoding: 'base64',
        maxLines: -1,
        maxBytes: -1
      })
      if (fileData?.success && fileData.content) {
        const mimeMap: Record<string, string> = {
          gif: 'image/gif',
          mp4: 'video/mp4',
          webm: 'video/webm',
          ogg: 'video/ogg',
          mov: 'video/quicktime'
        }
        const mimeType = mimeMap[ext] || 'application/octet-stream'
        const dataUrl = `data:${mimeType};base64,${fileData.content}`
        await saveDroppedImage(dataUrl)
      } else {
        message.error(t('assetDetailsPanel.preview.readFileFailed'))
      }
      return
    }

    // 其他图片文件：打开裁剪器
    const fileData = await (window as any).api.fs.readFile(filePath, {
      encoding: 'base64',
      maxLines: -1,
      maxBytes: -1
    })
    if (fileData?.success && fileData.content) {
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      const originalDataUrl = `data:${mimeType};base64,${fileData.content}`
      // 保存原图 base64，待裁剪确认后一起双图保存
      pendingOriginalBase64.value = originalDataUrl
      cropperImage.value = originalDataUrl
      cropperModalOpen.value = true
    } else {
      message.error(t('assetDetailsPanel.preview.readImageFailed'))
    }
  } catch (error: unknown) {
    message.error(resolveErrorText(error, t('assetDetailsPanel.preview.selectFileFailed')))
  }
}

// ==================== 拖拽设置缩略图 ====================
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']

/** 处理 dragover —— 检测是否为图片文件 */
const handleDragOver = (event: DragEvent): void => {
  // 检查是否包含文件
  if (event.dataTransfer?.types.includes('Files')) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

/** 处理 dragenter —— 显示拖拽状态 */
const handleDragEnter = (event: DragEvent): void => {
  dragCounter++
  // 检查是否是文件拖拽
  if (event.dataTransfer?.types.includes('Files')) {
    isDragOver.value = true
  }
}

/** 处理 dragleave —— 隐藏拖拽状态 */
const handleDragLeave = (): void => {
  dragCounter--
  if (dragCounter === 0) {
    isDragOver.value = false
  }
}

/** 处理 drop —— 直接保存图片为缩略图（跳过裁剪） */
const handleDrop = async (event: DragEvent): Promise<void> => {
  // 重置拖拽状态
  isDragOver.value = false
  dragCounter = 0

  // 并发守卫：上一次操作还在进行中时忽略新的拖入，
  // 避免连续拖入多个文件导致大量并行 IPC 调用卡死
  if (posterUploading.value) {
    message.warning(t('assetLib.details.thumbnailBusy', '正在保存上一张缩略图…'))
    return
  }

  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return

  const file = files[0]

  // 验证是否为图片或视频文件
  const isImage = SUPPORTED_IMAGE_TYPES.includes(file.type)
  const isVideo = SUPPORTED_VIDEO_TYPES.includes(file.type)
  if (!isImage && !isVideo) {
    message.warning(t('assetLib.details.unsupportedMediaType', '请拖放图片或视频文件'))
    return
  }

  // 使用 Electron File 对象的 .path 属性获取本地路径，
  // 避免在渲染进程中用 FileReader.readAsDataURL 读取整个文件（大文件会导致卡死）
  let filePath = await (window as any).api.getPathForFile(file)
  if (!filePath) {
    filePath = (file as any).path
  }

  if (!filePath) {
    message.error(t('assetLib.details.readFileFailed', '无法获取文件路径'))
    return
  }

  // 直接使用文件路径保存，IPC 只传路径字符串而非整个文件内容
  await handleDirectUpload(filePath)
}

/** 直接保存拖拽的图片为缩略图（跳过裁剪） */
const saveDroppedImage = async (dataUrl: string): Promise<void> => {
  // 1. 文件夹
  if (props.folder && !props.asset) {
    const folderKey = props.folder.key
    try {
      posterUploading.value = true
      const result = await (window as any).api.asset.saveThumbnail(dataUrl, folderKey)
      if (result.success && result.data) {
        const fileName = result.data
        const res = await assetFolderAPI.update(folderKey, { img: fileName })
        if (res.updated) {
          message.success(t('assetDetailsPanel.folderCover.updated'))
          emit('folder-updated', { key: folderKey, img: fileName })
        } else {
          message.error(t('assetDetailsPanel.folderCover.saveConfigFailed'))
        }
      } else {
        message.error(result.error || t('assetDetailsPanel.folderCover.saveFileFailed'))
      }
    } catch (e) {
      console.error(e)
      message.error(resolveErrorText(e, t('assetDetailsPanel.common.saveFailed')))
    } finally {
      posterUploading.value = false
    }
    return
  }

  // 2. 资产
  const assetKey = (props.asset as { assetKey?: string })?.assetKey
  if (!assetKey) return

  try {
    posterUploading.value = true
    const result = await (window as any).api.asset.saveThumbnail(dataUrl, assetKey)
    if (result.success && result.data) {
      const fileName = result.data
      const res = await (window as any).api.database.assetData.update(assetKey, {
        customPoster: fileName
      })
      if (res?.success) {
        message.success(t('assetDetailsPanel.preview.thumbnailUpdated'))
        // 同步更新注入的 selectedAsset
        const sel = (selectedAsset as { value?: { assetKey?: string; customPoster?: string } })
          ?.value
        if (sel && sel.assetKey === assetKey) {
          sel.customPoster = fileName
        }
        emit('updatePoster', fileName)
      } else {
        message.error(t('assetDetailsPanel.preview.saveConfigFailed'))
      }
    } else {
      message.error(result.error || t('assetDetailsPanel.preview.saveFileFailed'))
    }
  } catch (error: unknown) {
    console.error('保存预览图失败:', error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.preview.saveFailed')))
  } finally {
    posterUploading.value = false
  }
}

/**
 * 处理文件夹封面上传
 */
const handleFolderCropConfirm = async (dataUrl: string) => {
  const folderKey = props.folder?.key
  if (!folderKey) return

  try {
    posterUploading.value = true
    // 双图保存：原图 + 裁剪压缩图
    const originalData = pendingOriginalBase64.value
    let result: { success: boolean; data?: string; error?: string }

    if (originalData) {
      result = await (window as any).api.asset.saveOriginalAndCroppedThumbnail(
        originalData,
        dataUrl,
        folderKey
      )
    } else {
      result = await (window as any).api.asset.saveThumbnail(dataUrl, folderKey)
    }

    if (result.success && result.data) {
      const fileName = result.data
      // 更新文件夹数据
      const res = await assetFolderAPI.update(folderKey, { img: fileName })
      if (res.updated) {
        message.success(t('assetDetailsPanel.folderCover.updated'))
        // 通知父组件
        emit('folder-updated', { key: folderKey, img: fileName })
      } else {
        message.error(t('assetDetailsPanel.folderCover.saveConfigFailed'))
      }
    } else {
      message.error(result.error || t('assetDetailsPanel.folderCover.saveFileFailed'))
    }
  } catch (error: unknown) {
    console.error('保存文件夹封面失败:', error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.folderCover.saveFailed')))
  } finally {
    posterUploading.value = false
    cropperModalOpen.value = false
    cropperImage.value = ''
    pendingOriginalBase64.value = ''
  }
}

/**
 * 确认裁剪并上传保存资产/文件夹预览图
 */
const onCropConfirm = async (dataUrl: string): Promise<void> => {
  // 1. 如果是文件夹
  if (props.folder && !props.asset) {
    await handleFolderCropConfirm(dataUrl)
    return
  }

  // 2. 如果是资产
  const assetKey = (props.asset as { assetKey?: string })?.assetKey
  if (!assetKey) {
    cropperModalOpen.value = false
    return
  }

  try {
    posterUploading.value = true
    // 双图保存：原图 + 裁剪压缩图
    const originalData = pendingOriginalBase64.value
    let result: { success: boolean; data?: string; error?: string }

    if (originalData) {
      // 新流程：同时保存原图和裁剪压缩图
      result = await (window as any).api.asset.saveOriginalAndCroppedThumbnail(
        originalData,
        dataUrl,
        assetKey
      )
    } else {
      // 兼容回退：没有原图数据时仅保存裁剪图
      result = await (window as any).api.asset.saveThumbnail(dataUrl, assetKey)
    }

    if (result.success && result.data) {
      const fileName = result.data

      // 保存文件名到数据库
      const res = await (window as any).api.database.assetData.update(assetKey, {
        customPoster: fileName
      })

      if (res?.success) {
        message.success(t('assetDetailsPanel.preview.updated'))
        // 同步更新
        const sel = (selectedAsset as { value?: { assetKey?: string; customPoster?: string } })
          ?.value
        if (sel && sel.assetKey === assetKey) {
          sel.customPoster = fileName
        }

        emit('updatePoster', fileName)
      } else {
        message.error(t('assetDetailsPanel.preview.saveConfigFailed'))
      }
    } else {
      message.error(result.error || t('assetDetailsPanel.preview.saveFileFailed'))
    }
  } catch (error: unknown) {
    console.error('保存预览图失败:', error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.preview.saveFailed')))
  } finally {
    posterUploading.value = false
    cropperModalOpen.value = false
    cropperImage.value = ''
    pendingOriginalBase64.value = ''
  }
}

// handleCropCancel removed (handled by ImageCropperModal)

/**
 * 重置自定义预览图（恢复默认）
 */
const handleResetPoster = async (): Promise<void> => {
  // 1. 文件夹
  if (props.folder && !props.asset) {
    const folderKey = props.folder.key
    try {
      const res = await assetFolderAPI.update(folderKey, { img: '' })
      if (res.updated) {
        message.success(t('assetDetailsPanel.folderCover.removed'))
        emit('folder-updated', { key: folderKey, img: '' })
      } else {
        message.error(t('assetDetailsPanel.common.resetFailed'))
      }
    } catch (e) {
      console.error(e)
      message.error(resolveErrorText(e, t('assetDetailsPanel.common.resetFailed')))
    }
    return
  }

  // 2. 资产
  const assetKey = (props.asset as { assetKey?: string })?.assetKey
  if (!assetKey) return

  try {
    // 将 customPoster 设为空字符串
    const res = await (window as any).api.database.assetData.update(assetKey, { customPoster: '' })
    if (res?.success) {
      message.success(t('assetDetailsPanel.preview.resetDone'))
      // 同步更新注入的 selectedAsset
      const sel = (selectedAsset as { value?: { assetKey?: string; customPoster?: string } })?.value
      if (sel && sel.assetKey === assetKey) {
        sel.customPoster = ''
      }
      emit('updatePoster', '')
    } else {
      message.error(t('assetDetailsPanel.preview.resetFailed'))
    }
  } catch (error: unknown) {
    console.error('重置预览图失败:', error)
    message.error(resolveErrorText(error, t('assetDetailsPanel.preview.resetFailed')))
  }
}

/**
 * 点击预览图放大查看
 * 如果是视频则全屏播放，如果是图片则打开图片查看器
 */
const handlePreviewImage = (): void => {
  // 如果是视频预览，触发全屏播放
  if (isPreviewVideo.value) {
    const videoEl = previewVideoRef.value
    if (videoEl) {
      console.log('[handlePreviewImage] 检测到视频，触发全屏播放')

      // 监听全屏退出事件，退出时恢复静音和隐藏控件
      const handleFullscreenChange = (): void => {
        const isFullscreen = !!(
          document.fullscreenElement ||
          (document as any).webkitFullscreenElement ||
          (document as any).msFullscreenElement
        )
        if (!isFullscreen) {
          // 退出全屏：静音并隐藏控件
          videoEl.muted = true
          videoEl.controls = false
          console.log('[handlePreviewImage] 退出全屏，恢复静音和隐藏控件')
          // 移除监听器
          document.removeEventListener('fullscreenchange', handleFullscreenChange)
          document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
          document.removeEventListener('msfullscreenchange', handleFullscreenChange)
        }
      }

      // 添加全屏变化监听器
      document.addEventListener('fullscreenchange', handleFullscreenChange)
      document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
      document.addEventListener('msfullscreenchange', handleFullscreenChange)

      try {
        if (videoEl.requestFullscreen) {
          videoEl.requestFullscreen()
        } else if ((videoEl as any).webkitRequestFullscreen) {
          ;(videoEl as any).webkitRequestFullscreen()
        } else if ((videoEl as any).msRequestFullscreen) {
          ;(videoEl as any).msRequestFullscreen()
        }
        // 全屏后显示控件（保持静音，用户可手动开启声音）
        videoEl.controls = true
      } catch (error) {
        console.error('无法进入全屏模式:', error)
        // 失败时移除监听器
        document.removeEventListener('fullscreenchange', handleFullscreenChange)
        document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
        document.removeEventListener('msfullscreenchange', handleFullscreenChange)
      }
    }
    return
  }

  // 图片预览逻辑
  const extension = String(
    props.asset?.fileExtension || props.asset?.assetName?.split('.').pop() || ''
  ).toLowerCase()
  // Keep the converted preview for formats the browser cannot decode directly.
  const needsConversion = ['tga', 'dds', 'tif', 'tiff', 'texture'].includes(extension)
  const original =
    isImageAsset.value && !needsConversion
      ? resolveAssetUrl({
          vaultType: currentVault.value?.vaultType,
          vaultPath: currentVault.value?.path,
          networkPath: currentVault.value?.networkPath,
          originPath: props.asset?.originPath,
          filePath: props.asset?.filePath
        })
      : undefined
  const src = original || previewUrl.value || folderPreviewUrl.value
  const alt = String(
    props.asset?.assetName || props.folder?.name || t('assetDetailsPanel.preview.alt')
  )

  if (src) {
    void openImageViewer({
      items: [
        {
          src,
          alt
        }
      ],
      index: 0
    })
  }
}

let tagsRequestId = 0
let noteRequestId = 0

// 加载资产的标签ID并转换为标签对象
const loadAssetTags = async (assetKey: string) => {
  if (props.asset?.assetKey !== assetKey) return
  const requestId = ++tagsRequestId
  const annotations = getActiveLibrarySource().annotations
  if (libraryCaps.value.tagModel !== 'registry' && annotations) {
    try {
      const { tags } = await annotations.get({ assetKey })
      if (requestId !== tagsRequestId) return
      selectedTagIds.value = []
      // 名字标签没有 id：用负数占位，删除时按名字找回
      currentTags.value = tags.map((name, index) => ({ id: -(index + 1), name }))
    } catch {
      if (requestId === tagsRequestId) currentTags.value = []
    }
    return
  }
  try {
    const resp = await (window as any).api.database.assetTag.getTagIdsByAssetKey(assetKey)
    if (requestId !== tagsRequestId) return
    const ids: number[] = resp?.success ? resp.data || [] : []
    selectedTagIds.value = ids
    if (ids.length === 0) {
      currentTags.value = []
      return
    }
    const tagPromises = ids.map(async (id) => {
      const tr = await (window as any).api.database.tag.getById(id)
      if (tr?.success && tr.data) {
        return {
          id: tr.data.id as number,
          name: tr.data.name as string,
          color: tr.data.color as string | undefined
        }
      }
      return null
    })
    const results = await Promise.all(tagPromises)
    if (requestId !== tagsRequestId) return
    currentTags.value = results.filter(Boolean) as SimpleTag[]
  } catch (err) {
    if (requestId !== tagsRequestId) return
    console.error('加载资产标签失败', err)
    currentTags.value = []
    selectedTagIds.value = []
  }
}

// 加载资产的一句话备注和详细说明关联
const loadAssetNote = async (assetKey: string) => {
  if (props.asset?.assetKey !== assetKey) return
  const requestId = ++noteRequestId
  const annotations = getActiveLibrarySource().annotations
  if (libraryCaps.value.tagModel !== 'registry' && annotations) {
    try {
      const { note } = await annotations.get({ assetKey })
      if (requestId !== noteRequestId) return
      noteContent.value = note
      assetNoteId.value = null
    } catch {
      if (requestId === noteRequestId) noteContent.value = ''
    }
    return
  }
  try {
    const resp = await (window as any).api.database.assetData.getById(assetKey)
    if (requestId !== noteRequestId) return
    noteContent.value = resp?.data?.note || ''
    assetNoteId.value = resp?.data?.noteId ?? null
  } catch (err) {
    if (requestId !== noteRequestId) return
    console.error('加载资产笔记失败', err)
    noteContent.value = ''
    assetNoteId.value = null
  }
}

/**
 * 加载文件夹的一句话备注和详细说明关联。
 * 声明位置必须在下面那个 immediate watch 之前，否则 setup 阶段就是 TDZ。
 */
const loadFolderNote = async (folderKey: string): Promise<void> => {
  const requestId = noteRequestId
  try {
    const found = await assetFolderAPI.getByKey(folderKey)
    if (requestId !== noteRequestId) return
    folderNoteContent.value = (found?.note as string) || ''
    folderNoteId.value = (found?.noteId as number | null) ?? null
  } catch (err) {
    if (requestId !== noteRequestId) return
    console.error('加载文件夹备注失败', err)
    folderNoteContent.value = ''
    folderNoteId.value = null
  }
}

// 加载文本预览
// 修复Vite解析错误尝试
const loadTextPreview = async (asset: any) => {
  const requestId = ++textPreviewRequestId.value
  if (!asset) {
    textPreviewContent.value = ''
    textPreviewError.value = null
    textPreviewTruncated.value = false
    return
  }

  // 检查是否为文本或代码文件
  const displayAsset = asset
  const fileName = (displayAsset.assetName || '').toLowerCase()
  const ext = (displayAsset.fileExtension || '').toLowerCase()

  const textExts = ['.txt', '.md', '.json', '.xml', '.html', '.css', '.scss', '.less', '.log']
  const codeExts = [
    '.ts',
    '.js',
    '.jsx',
    '.tsx',
    '.vue',
    '.cpp',
    '.h',
    '.cs',
    '.java',
    '.py',
    '.go',
    '.rs',
    '.php',
    '.rb',
    '.swift',
    '.kt'
  ]
  const isText = textExts.some((e) => fileName.endsWith(e) || ext === e.replace('.', ''))
  const isCode = codeExts.some((e) => fileName.endsWith(e) || ext === e.replace('.', ''))

  if (!isText && !isCode) {
    textPreviewContent.value = ''
    textPreviewError.value = null
    textPreviewTruncated.value = false
    return
  }

  const access = resolveAssetAccess({
    vaultType: currentVault.value?.vaultType,
    vaultPath: currentVault.value?.path,
    networkPath: currentVault.value?.networkPath,
    originPath: (displayAsset as any)?.originPath,
    filePath: (displayAsset as any)?.filePath
  })
  const fallbackUrl = await resolveAssetUrlWithFallback({
    vaultType: currentVault.value?.vaultType,
    vaultPath: currentVault.value?.path,
    networkPath: currentVault.value?.networkPath,
    originPath: (displayAsset as any)?.originPath,
    filePath: (displayAsset as any)?.filePath,
    assetKey: (displayAsset as any)?.assetKey,
    assetName: (displayAsset as any)?.assetName,
    fileExtension: (displayAsset as any)?.fileExtension,
    folderKey: (displayAsset as any)?.folderKey,
    resolveAssetByKey: async (assetKey: string) => {
      try {
        return await assetDataAPI.getById(assetKey)
      } catch (error) {
        console.warn('[AssetDetailsPanel] 获取资产详情失败，回退为当前详情数据:', error)
        return undefined
      }
    },
    resolveFolderRelativePath: async (folderKey: string) => {
      try {
        const folder = await assetFolderAPI.getByKey(folderKey)
        return folder?.fullPath
      } catch (error) {
        console.warn('[AssetDetailsPanel] 获取文件夹路径失败，回退为文件名:', error)
        return undefined
      }
    }
  })
  if (requestId !== textPreviewRequestId.value) return

  if (!access.localPath && !access.fileUrl && !fallbackUrl) {
    textPreviewContent.value = ''
    textPreviewError.value = t('assetDetailsPanel.textPreview.pathFailed')
    textPreviewTruncated.value = false
    return
  }

  textPreviewLoading.value = true
  textPreviewError.value = null

  try {
    if (access.isRemoteHttp && (access.fileUrl || fallbackUrl)) {
      const result = await fetchRemoteTextPreview(access.fileUrl || fallbackUrl || '', {
        maxBytes: 5000
      })
      if (requestId !== textPreviewRequestId.value) return
      textPreviewContent.value = result.content || ''
      textPreviewTruncated.value = result.truncated || false
    } else {
      const result = await (window as any).api.fs.readFile(access.localPath, {
        encoding: 'utf8',
        maxLines: 10,
        maxBytes: 5000
      })
      if (requestId !== textPreviewRequestId.value) return

      if (result?.success) {
        textPreviewContent.value = result.content || ''
        textPreviewTruncated.value = result.truncated || false
      } else {
        textPreviewContent.value = ''
        textPreviewError.value = result?.error || t('assetDetailsPanel.textPreview.readFailed')
        textPreviewTruncated.value = false
      }
    }
  } catch (err) {
    if (requestId !== textPreviewRequestId.value) return
    console.error('加载文本预览失败', err)
    textPreviewContent.value = ''
    textPreviewError.value = (err as Error).message || t('assetDetailsPanel.textPreview.readFailed')
    textPreviewTruncated.value = false
  } finally {
    if (requestId !== textPreviewRequestId.value) return
    textPreviewLoading.value = false
  }
}

// 切换资产或保管库时立即作废旧详情，避免晚返回的备注和标签串台。
watch(
  [() => props.asset?.assetKey, () => currentVault.value?.id],
  ([newKey]) => {
    tagsRequestId++
    noteRequestId++
    currentTags.value = []
    selectedTagIds.value = []
    noteContent.value = ''
    assetNoteId.value = null
    if (newKey) {
      void loadAssetTags(newKey)
      void loadAssetNote(newKey)
    }
  },
  { immediate: true, flush: 'sync' }
)

// 文件夹侧同理：换文件夹先把旧备注作废，免得晚返回的结果串台
watch(
  [() => props.folder?.key, () => currentVault.value?.id],
  ([newKey]) => {
    noteRequestId++
    folderNoteContent.value = ''
    folderNoteId.value = null
    if (newKey) void loadFolderNote(newKey as string)
  },
  { immediate: true, flush: 'sync' }
)

// 监听资产对象变化，更新文本预览
watch(
  () => props.asset,
  async (newAsset) => {
    if (newAsset) {
      await loadTextPreview(newAsset)
    } else {
      textPreviewContent.value = ''
      textPreviewError.value = null
      textPreviewTruncated.value = false
    }
  },
  { immediate: true }
)

/**
 * 落一次备注相关的字段。
 *
 * 资产和文件夹的 update 接口返回的形状不一样（一个 `{ success }`、一个
 * `{ updated }`），所以判成没成交给调用方；这里只管「存上了才改本地状态、
 * 没存上要说出来」。乐观更新在备注上是有害的 —— 用户会以为写上了。
 */
const persistNoteField = async (
  save: () => Promise<boolean>,
  onSuccess: () => void
): Promise<boolean> => {
  const requestId = noteRequestId
  try {
    const ok = await save()
    // 用户可能已经点到别的东西上了，迟到的结果不该改现在的界面
    if (requestId !== noteRequestId) return false
    if (!ok) {
      message.error(t('assetDetailsPanel.common.saveFailed'))
      return false
    }
    onSuccess()
    return true
  } catch (e) {
    if (requestId !== noteRequestId) return false
    console.error('保存备注失败', e)
    message.error(resolveErrorText(e, t('assetDetailsPanel.common.saveFailed')))
    return false
  }
}

const updateAssetFields = async (updates: Record<string, unknown>): Promise<boolean> => {
  const assetKey = (props.asset as any)?.assetKey
  if (!assetKey) return false
  const res = await (window as any).api.database.assetData.update(assetKey, updates)
  return res?.success === true
}

const updateFolderFields = async (updates: Record<string, unknown>): Promise<boolean> => {
  const folderKey = props.folder?.key
  if (!folderKey) return false
  const res = await assetFolderAPI.update(folderKey, updates)
  return res?.updated === true
}

const handleSaveAssetNote = (note: string): Promise<boolean> =>
  persistNoteField(
    async () => {
      const annotations = getActiveLibrarySource().annotations
      const assetKey = props.asset?.assetKey
      if (libraryCaps.value.tagModel !== 'registry' && annotations && assetKey) {
        const result = await annotations.edit({ assetKey }, { note })
        return result.ok
      }
      return await updateAssetFields({ note })
    },
    () => {
      noteContent.value = note
    }
  )

const handleSaveAssetNoteId = (noteId: number | null): Promise<boolean> =>
  persistNoteField(
    () => updateAssetFields({ noteId }),
    () => {
      assetNoteId.value = noteId
    }
  )

const handleSaveFolderNote = (note: string): Promise<boolean> =>
  persistNoteField(
    () => updateFolderFields({ note }),
    () => {
      folderNoteContent.value = note
    }
  )

const handleSaveFolderNoteId = (noteId: number | null): Promise<boolean> =>
  persistNoteField(
    () => updateFolderFields({ noteId }),
    () => {
      folderNoteId.value = noteId
    }
  )

// ==================== 文件夹标签相关 ====================
/**
 * 文件夹标签展示与选择
 */
const folderTags = ref<SimpleTag[]>([])
const folderSelectedTagIds = ref<number[]>([])
const folderTagModalOpen = ref(false)

/**
 * 加载文件夹的标签
 * @param folderKey 文件夹键值
 */
const loadFolderTags = async (folderKey: string): Promise<void> => {
  try {
    const ids = await folderTagAPI.getTagIdsByFolderKey(folderKey)
    if (!ids) {
      folderTags.value = []
      folderSelectedTagIds.value = []
      return
    }
    folderSelectedTagIds.value = ids

    // 获取标签详情
    const tagPromises = ids.map(async (id) => {
      const tr = await (
        window as unknown as {
          api: {
            database: {
              tag: {
                getById: (id: number) => Promise<{
                  success: boolean
                  data?: { id: number; name: string; color?: string }
                }>
              }
            }
          }
        }
      ).api.database.tag.getById(id)
      if (tr?.success && tr.data) {
        return {
          id: tr.data.id,
          name: tr.data.name,
          color: tr.data.color
        }
      }
      return null
    })
    const results = await Promise.all(tagPromises)
    folderTags.value = results.filter(Boolean) as SimpleTag[]
  } catch (err) {
    console.error('加载文件夹标签失败', err)
    folderTags.value = []
    folderSelectedTagIds.value = []
  }
}

/**
 * 确认文件夹标签选择
 * @param tagIds 选中的标签ID数组
 */
const handleOpenFolderTagModal = async (): Promise<void> => {
  try {
    folderTagModalOpen.value = true
  } catch (error) {
    message.error(resolveErrorText(error, t('assetDetailsPanel.tags.cannotEditFolderTags')))
  }
}

const handleFolderTagSelectionConfirm = async (tagIds: number[]): Promise<void> => {
  const folderKey = props.folder?.key
  if (!folderKey) return
  try {
    const cleanTagIds = Array.isArray(tagIds)
      ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []
    const res = await folderTagAPI.setTagsForFolder(String(folderKey), cleanTagIds)
    if (res) {
      message.success(t('assetDetailsPanel.tags.updated'))
      await loadFolderTags(String(folderKey))
    } else {
      message.error(t('assetDetailsPanel.tags.updateFailed'))
    }
  } catch (err) {
    console.error('更新文件夹标签异常', err)
    message.error(resolveErrorText(err, t('assetDetailsPanel.tags.updateFailed')))
  }
}

/**
 * 移除文件夹的某个标签
 * @param tagId 标签ID
 */
const removeFolderTag = async (tagId: number): Promise<void> => {
  const folderKey = props.folder?.key
  if (!folderKey) return
  try {
    const res = await folderTagAPI.remove(folderKey, tagId)
    if (res) {
      message.success(t('assetDetailsPanel.tags.removed'))
      await loadFolderTags(folderKey)
    } else {
      message.error(t('assetDetailsPanel.tags.removeFailed'))
    }
  } catch (err) {
    console.error('移除文件夹标签异常', err)
    message.error(resolveErrorText(err, t('assetDetailsPanel.tags.removeFailed')))
  }
}

// 监听文件夹变化并加载标签
watch(
  () => props.folder?.key,
  async (newKey) => {
    if (newKey) {
      await loadFolderTags(newKey)
    } else {
      folderTags.value = []
      folderSelectedTagIds.value = []
    }
  },
  { immediate: true }
)

// 弹窗确认：设置资产的标签集合
const handleOpenAssetTagModal = async (): Promise<void> => {
  if (libraryCaps.value.tagModel === 'names') {
    nameTagInputOpen.value = true
    return
  }
  try {
    tagModalOpen.value = true
  } catch (error) {
    message.error(resolveErrorText(error, t('assetDetailsPanel.tags.cannotEditTags')))
  }
}

const handleTagSelectionConfirm = async (tagIds: number[]) => {
  const assetKey = props.asset?.assetKey
  if (!assetKey) return
  try {
    const cleanTagIds = Array.isArray(tagIds)
      ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []
    const res = await (window as any).api.database.assetTag.setTagsForAsset(
      String(assetKey),
      cleanTagIds
    )
    if (res?.success) {
      message.success(t('assetDetailsPanel.tags.updated'))
      await loadAssetTags(String(assetKey))
    } else {
      message.error(t('assetDetailsPanel.tags.updateFailed'))
    }
  } catch (err) {
    console.error('更新标签异常', err)
    message.error(resolveErrorText(err, t('assetDetailsPanel.tags.updateFailed')))
  }
}
const removeTag = async (tagId: number) => {
  const assetKey = (props.asset as any)?.assetKey
  if (!assetKey) return
  if (libraryCaps.value.tagModel === 'names') {
    const name = currentTags.value.find((tag) => tag.id === tagId)?.name
    if (name) await editNameTags({ removeTags: [name] })
    return
  }
  try {
    const res = await (window as any).api.database.assetTag.remove(assetKey, tagId)
    if (res?.success) {
      message.success(t('assetDetailsPanel.tags.removed'))
      await loadAssetTags(assetKey)
    } else {
      message.error(t('assetDetailsPanel.tags.removeFailed'))
    }
  } catch (err) {
    console.error('移除标签异常', err)
    message.error(resolveErrorText(err, t('assetDetailsPanel.tags.removeFailed')))
  }
}

/**
 * 复制软路径到剪贴板
 */
const handleCopySoftPath = async (): Promise<void> => {
  const softPath = props.asset?.softPath
  if (!softPath) {
    message.warning(t('assetDetailsPanel.softPath.empty'))
    return
  }

  try {
    await navigator.clipboard.writeText(softPath)
    message.success(t('assetDetailsPanel.softPath.copied'))
  } catch (err) {
    console.error('复制软路径失败', err)
    message.error(t('assetDetailsPanel.common.copyFailed'))
  }
}

/**
 * 复制本地路径到剪贴板
 */
const handleCopyLocalPath = async (): Promise<void> => {
  if (!localFilePath.value) {
    message.warning(t('assetLib.details.localPathEmpty'))
    return
  }

  try {
    await navigator.clipboard.writeText(localFilePath.value)
    message.success(t('assetLib.details.localPathCopied'))
  } catch (err) {
    console.error('复制本地路径失败', err)
    message.error(t('common.copyFailed'))
  }
}

/**
 * 跳转到百度网盘查看资产
 * 切换侧边栏到百度网盘模式并导航到对应目录
 */
const handleGotoBaiduyun = async (): Promise<void> => {
  const baiduyunPath = (props.asset as any)?.baiduyunPath
  if (!baiduyunPath) {
    message.warning(t('assetDetailsPanel.cloudPath.empty'))
    return
  }

  try {
    // 提取目录路径（去掉文件名）
    const dirPath = baiduyunPath.substring(0, baiduyunPath.lastIndexOf('/')) || '/apps/unreal-agent'

    // 切换到百度网盘模式并导航到目录
    assetViewStore.setMode('baiduyun')
    baiduyunStore.setCurrentDir(dirPath)

    // 关闭详情面板
    emit('close')

    // 复制路径到剪贴板
    await navigator.clipboard.writeText(baiduyunPath)
    message.success(t('assetDetailsPanel.cloudPath.gotoBaiduyunDone'))
  } catch (err) {
    console.error('跳转失败', err)
    message.error(t('assetDetailsPanel.cloudPath.gotoFailed'))
  }
}

/**
 * 跳转到 WebDAV 查看资产
 * 切换侧边栏到 WebDAV 模式并导航到对应目录
 */
const handleGotoWebdav = async (): Promise<void> => {
  const webdavPath = (props.asset as any)?.webdavPath
  if (!webdavPath) {
    message.warning(t('assetDetailsPanel.cloudPath.empty'))
    return
  }

  try {
    // 提取目录路径（去掉文件名）
    const dirPath = webdavPath.substring(0, webdavPath.lastIndexOf('/')) || '/unreal-agent'

    // 切换到 WebDAV 模式并导航到目录
    assetViewStore.setMode('webdav')
    webdavStore.setCurrentDir(dirPath)

    // 关闭详情面板
    emit('close')

    // 复制路径到剪贴板
    await navigator.clipboard.writeText(webdavPath)
    message.success(t('assetDetailsPanel.cloudPath.gotoWebdavDone'))
  } catch (err) {
    console.error('跳转失败', err)
    message.error(t('assetDetailsPanel.cloudPath.gotoFailed'))
  }
}

// 打开依赖关系图(在新tab中)
const handleOpenDependencyGraph = () => {
  const assetKey = (props.asset as any)?.assetKey
  if (!assetKey) {
    message.warning(t('assetDetailsPanel.assetInfoFailed'))
    return
  }

  // 打开新tab显示依赖关系图
  router.push({
    name: 'AssetDependencyGraph',
    query: {
      assetKey
    }
  })
}

// 依赖关系图相关功能已移至新tab页面
</script>

<style lang="less" scoped>
.tag-selector-popover {
  width: 300px;
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
}
.asset-details-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  // 与资产库顶部导航栏 .navigation-section 等高，两条底边连成一条
  height: 56px;
  flex-shrink: 0;
  // 左侧与 .panel-body 的 16px 对齐；右侧留 12px，加上圆形按钮自身留白后视觉也是 16px
  padding: 0 12px 0 16px;
  background: var(--color-bg-page);
  border-bottom: 1px solid var(--color-border-subtle);
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.close-btn {
  color: var(--color-text-secondary);
  font-size: 16px;

  &:hover {
    color: var(--color-text-primary);
  }
}

.panel-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px; // 减少间距，因为分组块内部已有间距
}

// Header 容器：预览区 + 文件名
.header-container {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.preview-wrapper {
  position: relative;
  width: 100%;
  display: flex;
  justify-content: center;
  margin-top: 32px;
  margin-bottom: 16px;
}

.preview-box {
  width: 240px;
  height: 240px;
  border-radius: var(--radius-sm);
  // 空预览是个「凹槽」，不是强调态。以前这里是强调色浅底 ——
  // 深色下强调浅底本来就近乎黑，跟凹槽长得一样，看不出问题；
  // 换到浅色主题就是一块淡蓝，读起来像「这张图被选中了」。
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;

  // UE5 颜色条
  .preview-color-strip {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    z-index: 2;
  }
}

.preview-box.has-image {
  background: none;
  border: none;
}

.preview-box img,
.preview-video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  object-position: center;
  border-radius: var(--radius-sm);
}

// 隐藏视频控件，点击全屏播放
.preview-video {
  cursor: pointer;

  // 隐藏 Chromium 默认控件（非全屏时）
  &:not(:fullscreen) {
    &::-webkit-media-controls {
      display: none !important;
    }

    &::-webkit-media-controls-enclosure {
      display: none !important;
    }

    &::-webkit-media-controls-panel {
      display: none !important;
    }
  }

  // 全屏时显示控件
  &:fullscreen {
    &::-webkit-media-controls {
      display: flex !important;
    }

    &::-webkit-media-controls-enclosure {
      display: flex !important;
    }

    &::-webkit-media-controls-panel {
      display: flex !important;
    }
  }
}

.placeholder {
  color: var(--color-text-muted);
}

// 编辑图标覆盖层
.edit-icon-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 8px;
  align-items: center;

  .edit-icon,
  .delete-icon,
  .record-icon {
    width: 28px;
    height: 28px;
    background: var(--color-bg-overlay);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s ease;
    backdrop-filter: blur(4px);
    font-size: 14px;
    color: var(--color-text-on-solid);

    &:hover {
      background: var(--color-bg-overlay);
      transform: scale(1.1);
    }
  }

  .delete-icon:hover {
    background: var(--color-danger-solid);
  }
}

.recording-cover-modal {
  :deep(.app-modal__panel) {
    background: var(--color-bg-surface);
    border-radius: 12px;
  }

  :deep(.app-modal__header) {
    background: transparent;
    border-bottom: none;
    padding: 16px 20px 0;
  }

  :deep(.app-modal__body) {
    padding: 12px 20px 16px;
  }

  :deep(.app-modal__footer) {
    padding: 0 20px 16px;
    border-top: none;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
}

.recording-cover-body {
  min-height: 220px;
  border-radius: 10px;
  background: var(--color-bg-page);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.recording-cover-options {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.recording-cover-label {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.recording-cover-group {
  :deep(.ant-radio-button-wrapper) {
    background: transparent;
    border-color: var(--color-border);
    color: var(--color-text-secondary);
  }
  :deep(.ant-radio-button-wrapper-checked) {
    background: var(--color-accent-bg);
    border-color: transparent;
    color: var(--color-text-primary);
  }
}

.recording-cover-video {
  width: 100%;
  max-height: 360px;
  background: var(--color-bg-page);
  border-radius: 10px;
}

.recording-cover-empty {
  color: var(--color-text-secondary);
  font-size: 13px;
}

// 拖拽状态样式
.preview-wrapper.drag-over {
  .preview-box {
    border: 2px dashed var(--color-border) !important;
    background: var(--color-accent-bg) !important;
  }
}

.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  background: var(--color-accent-bg);
  border-radius: var(--radius-sm);
  backdrop-filter: blur(4px);
  pointer-events: none;

  .drop-hint {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--color-text-primary);
    text-shadow: 0 1px 3px var(--shadow-color);

    .drop-icon {
      font-size: 32px;
    }

    span:last-child {
      font-size: 13px;
      font-weight: 500;
    }
  }
}

// 预览图点击提示
.preview-box.has-image {
  cursor: zoom-in;
}

// 文件类型图标容器
.file-icon-box {
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-subtle);
  position: relative;
  overflow: hidden;

  // UE5 颜色条
  .preview-color-strip {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    z-index: 2;
  }
}

// 文本预览容器
.text-preview-box {
  width: 100%;
  max-width: 400px;
  min-height: 120px;
  max-height: 240px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-page);
  border: 1px solid var(--color-border-subtle);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  .text-preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 20px;
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .text-preview-error {
    padding: 12px;
    color: var(--color-danger-text);
    font-size: 12px;
    text-align: center;
  }

  .text-preview-content {
    flex: 1;
    overflow: auto;
    padding: 12px;
    position: relative;

    pre {
      margin: 0;
      padding: 0;
      font-family: 'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 11px;
      line-height: 1.6;
      color: var(--color-text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;

      code {
        font-family: inherit;
        font-size: inherit;
        color: inherit;
        background: transparent;
        padding: 0;
        border: none;
      }
    }

    .text-preview-truncated {
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      height: 20px;
      background: linear-gradient(to bottom, transparent, var(--color-bg-page));
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding-bottom: 4px;
      color: var(--color-text-secondary);
      font-size: 12px;
      pointer-events: none;
    }
  }

  .text-preview-empty {
    padding: 20px;
    color: var(--color-text-secondary);
    font-size: 12px;
    text-align: center;
  }

  // UE5 颜色条
  .preview-color-strip {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    z-index: 2;
  }
}

.file-type-icon {
  font-size: 48px;
  color: var(--color-accent-text);
  filter: drop-shadow(0 2px 4px var(--color-accent-border));
}

.file-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text-primary);
  text-align: center;
  word-break: break-word;
  margin-bottom: 4px;
  margin: 0 0 4px 0;
}

.file-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
}

// 属性分组容器 (Group Box)
.inspector-group {
  background-color: var(--color-bg-surface-hover); // 极淡的背景
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border-subtle);

  .inspector-group-title {
    font-size: 12px;
    color: var(--color-text-secondary);
    font-weight: bold;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
}

// Meta Grid 容器：属性列表，左右对齐
.meta-grid-container {
  display: grid;
  grid-template-columns: 80px 1fr;
  row-gap: 12px;
  margin-top: 24px;
  padding: 0;
}

.meta-row {
  display: contents;
}

.meta-label {
  font-size: 12px;
  color: var(--color-text-secondary); // 次要文字灰一点
  text-align: left;
}

.meta-value {
  font-size: 12px;
  color: var(--color-text-primary); // 主要文字亮一点
  font-family:
    'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', monospace; // 数字和时间用等宽字体
  word-break: break-word;

  &.soft-path {
    font-size: 11px;
    color: var(--color-accent-text);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;

    &.clickable {
      cursor: pointer;
      transition: all 0.2s ease;

      &:hover {
        color: var(--color-accent-text);
        background: var(--color-accent-bg);
        border-radius: 4px;
        padding: 0 4px;
      }

      &:active {
        transform: scale(0.98);
      }
    }
  }
}

// Tag 容器：标签流。标签本身的长相全在 AppTag 里，这里只管排布
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// 智能标签区域样式
.smart-tags-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--color-border-subtle);
}

.smart-tags-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  letter-spacing: 1px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;

  .smart-tags-icon {
    font-size: 13px;
  }
}

// 备注那一整块的样式已经跟着搬进 NoteSection.vue

// UE5 资产特殊信息
.ue-asset-info {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 0;
  padding: 12px;
}

.ue-section-title {
  font-size: 12px;
  font-weight: bold;
  color: var(--color-text-secondary);
  letter-spacing: 1px;
  margin-bottom: 8px;
}

.ue-meta-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ue-meta-row {
  display: grid;
  grid-template-columns: 95px 1fr;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border-subtle);

  &:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
}

.ue-meta-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: left;
  font-weight: 500;
}

.ue-meta-value {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: monospace;
  word-break: break-word;
  text-align: right;

  &.soft-path {
    font-size: 11px;
    color: var(--color-accent-text);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;

    &.clickable {
      cursor: pointer;
      transition: all 0.2s ease;

      &:hover {
        color: var(--color-accent-text);
        background: var(--color-accent-bg);
        border-radius: 4px;
        padding: 0 4px;
      }

      &:active {
        transform: scale(0.98);
      }
    }
  }
}

.ue-imports-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border-subtle);
}

.ue-imports-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.ue-section-header {
  margin-bottom: 12px;

  .ue-section-title {
    margin-bottom: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
  }
}

.view-graph-icon-simple {
  font-size: 14px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    color: var(--color-accent-text);
    transform: scale(1.1);
  }
}

// 导入依赖
// 外层不再套背景和边框：容器和条目原来用的是同一个背景 token、同一个边框
// token，盒中盒且零对比，外面那圈纯属白给。现在只有条目有底色。
.ue-imports-info {
  // 上下间距交给 .panel-body 的 gap 和 .inspector-group 的 margin-bottom，
  // 这里再加 margin-top 会让这一组和上面那组的缝比别处宽一截
  margin-top: 0;
}

.imports-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;

  .ue-section-title {
    margin-bottom: 0;
  }
}

.imports-count {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--color-bg-sunken);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
}

.imports-warning {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 11px;
  font-weight: 500;
}

.imports-loading {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}

.imports-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.import-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
  // 纵向内边距放在 .import-text 上，好让左边那条状态色顶天立地
  padding: 0 8px 0 0;
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  overflow: hidden;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;

  // 库里有的才可点。库里没有的不给 hover 变化、不给手型 ——
  // 点不了就不许给点的暗示
  &.resolved {
    cursor: pointer;

    &:hover {
      background: var(--color-bg-raised);

      .import-name {
        color: var(--color-accent-text);
      }

      .import-locate-btn {
        opacity: 1;
      }
    }

    &:focus-visible {
      outline: 2px solid var(--color-border-focus);
      outline-offset: -2px;
    }
  }

  &.unresolved {
    cursor: default;

    .import-name {
      color: var(--color-text-muted);
      text-decoration: line-through;
      text-decoration-color: var(--color-border-strong);
    }
  }
}

// 左边那条状态色：库里有=类型色，库里没有=警示色。一列扫下来就知道哪条断了
.import-status-bar {
  flex-shrink: 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
}

.import-text {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
}

// 资产名在上，正常字体、看得清。这才是用户要找的东西
.import-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s ease;
}

// 目录在下，等宽小字。放不下就截，完整路径在 title 里
.import-folder {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: 'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', monospace;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 定位按钮：平时不显示，鼠标移到这一行才露出来
.import-locate-btn {
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-accent-text);
  }

  &:focus-visible {
    opacity: 1;
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.import-missing-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--color-warning-text);
}

.imports-expand {
  margin-top: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent-text);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.imports-graph-btn {
  margin-top: 10px;
}

.imports-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 8px 0;
}

// 空状态样式
.empty {
  height: 100%;
  display: flex;
  // 顶部对齐：面板很高，居中会让提示飘到离用户刚点的位置半屏远
  align-items: flex-start;
  justify-content: center;
  padding: 48px 20px;

  .empty-state-content {
    text-align: center;
    color: var(--color-text-muted);

    .empty-icon {
      display: block;
      margin: 0 auto 16px;
      font-size: 48px;
      color: var(--color-text-muted);
      opacity: 0.5;
    }

    .empty-text {
      font-size: 16px;
      font-weight: 500;
      color: var(--color-text-secondary);
      margin-bottom: 8px;
    }

    .empty-desc {
      font-size: 13px;
      color: var(--color-text-muted);
      opacity: 0.8;
    }
  }
}

// 文件夹详情页样式优化
.folder-icon-large {
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 32px auto 16px;
  border-radius: var(--radius-sm);
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);

  .folder-icon-large-svg {
    font-size: 48px;
    color: var(--color-warning-text); // Amber-400: 温暖的黄色实心文件夹
    filter: drop-shadow(0 2px 4px var(--shadow-color)); // 给图标一点立体投影
  }
}

.folder-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 24px 20px;
  padding: 16px;
  background: var(--color-bg-surface-hover);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-subtle);

  .stat-card {
    text-align: center;

    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--color-text-primary);
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 11px;
      color: var(--color-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
  }
}

.path-value {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

/* 🔌 插件信息样式 */
.plugin-info {
  .plugin-name {
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .version-badge {
    display: inline-block;
    padding: 2px 8px;
    background: var(--gradient-accent);
    color: var(--color-text-primary);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    margin-right: 6px;
  }

  .beta-badge {
    display: inline-block;
    padding: 2px 6px;
    background: var(--color-warning-solid);
    color: var(--color-warning-on-solid);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    margin-right: 6px;
  }

  .exp-badge {
    display: inline-block;
    padding: 2px 6px;
    background: var(--color-danger-solid);
    color: var(--color-text-primary);
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
  }

  .description-row {
    .description {
      font-size: 12px;
      color: var(--color-text-secondary);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
}

.plugin-modules,
.plugin-dependencies {
  margin-top: 12px;
  padding: 12px;
  // 只是一块嵌套的信息区，不是强调态
  background: var(--color-bg-sunken);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-subtle);

  .module-title,
  .dep-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-secondary);
    margin-bottom: 8px;
  }

  .module-list,
  .dep-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .module-item,
  .dep-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--color-bg-surface-hover);
    border-radius: 4px;
    font-size: 12px;
  }

  .module-name,
  .dep-name {
    flex: 1;
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .module-type {
    padding: 2px 6px;
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
    border-radius: 3px;
    font-size: 10px;
    font-weight: 500;
  }

  .module-phase {
    padding: 2px 6px;
    background: var(--color-success-bg);
    color: var(--color-success-text);
    border-radius: 3px;
    font-size: 10px;
    font-weight: 500;
  }

  .dep-status {
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 500;

    &.enabled {
      background: var(--color-success-bg);
      color: var(--color-success-text);
    }

    &.disabled {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-secondary);
    }
  }
}

.capability-reason {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.folder-reason {
  margin: var(--space-2) 0;
}

.name-tag-input {
  width: 100%;
  margin-top: var(--space-1);
}
</style>
