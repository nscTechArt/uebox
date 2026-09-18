<script setup lang="ts">
/**
 * 蓝图库 / 材质库共用的网格卡片。
 *
 * 结构固定：封面 → 悬停才显形的「⋯」菜单 → 名称/次要信息/统计/脚注。
 * 领域差异全部走插槽：
 *   - `cover`    封面内容（蓝图放类型图标或录屏，材质放缩略图或首字母）
 *   - `menu`     「⋯」下拉里的菜单项，不给这个插槽就整个不长按钮
 *   - `footnote` 卡片底部一行（蓝图放标签，材质放资产路径）
 *   - `body`     给出时**整块替换**封面+信息（合并预览就是这么用的），
 *                调用方用 `<template #body v-if="...">` 按需挂上
 *   - 默认插槽   仅 `create` 模式下用作按钮文案
 *
 * 点击、拖放这些监听不用在这里声明：Vue 会把 attrs 落到根节点上。
 */
withDefaults(
  defineProps<{
    /** 卡片主标题 */
    name?: string
    /** 第二行：类型 / 引擎版本这类 */
    meta?: string
    /** 第三行：统计信息 */
    stats?: string
    /** 虚线「新建」卡：没有封面与信息区，只有一个加号 */
    create?: boolean
  }>(),
  { name: '', meta: '', stats: '', create: false }
)
</script>

<template>
  <div class="library-card" :class="{ 'is-create': create }">
    <template v-if="create">
      <div class="create-icon">+</div>
      <div class="create-text"><slot /></div>
    </template>

    <template v-else-if="$slots.body">
      <slot name="body" />
    </template>

    <template v-else>
      <slot name="cover" />

      <!-- 菜单挂在卡片上而不是封面里：封面 overflow:hidden，下拉会被裁掉 -->
      <div v-if="$slots.menu" class="card-menu" @click.stop>
        <button class="menu-trigger" @click.stop>⋯</button>
        <div class="menu-dropdown">
          <slot name="menu" />
        </div>
      </div>

      <div class="card-info">
        <div class="card-name" :title="name">{{ name }}</div>
        <div v-if="meta" class="card-meta">{{ meta }}</div>
        <div v-if="stats" class="card-stats">{{ stats }}</div>
        <slot name="footnote" />
      </div>
    </template>
  </div>
</template>

<style scoped lang="less">
.library-card {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 230px;
  border-radius: var(--radius-xl);
  // 不能 hidden：菜单下拉要溢出卡片
  overflow: visible;
  z-index: 0;
  background: var(--color-bg-surface-hover);
  // 和项目库的卡片同一套：不画描边，靠投影分层，悬停抬 1px
  border: 0;
  box-shadow: 0 16px 35px var(--shadow-color);
  cursor: pointer;
  transition: all 0.25s ease;
  -webkit-user-drag: element !important;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 25px var(--shadow-color-strong);

    .menu-trigger {
      opacity: 1;
    }
  }

  &:hover,
  &:focus-within {
    z-index: 20;
  }
}

// ===== 拖放状态 =====
// 这三个类由调用方通过 :class 落到根节点上
.library-card.drop-target-entry {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 12px var(--color-accent-border);
}

.library-card.merging {
  border-color: var(--color-success-border);
  box-shadow: 0 0 16px var(--color-success-border);
  transform: scale(1.02);
}

.library-card.drop-target {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 16px var(--color-accent-border);
  transform: scale(1.03);
}

// ===== 新建卡 =====
.is-create {
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--color-border-strong);
  background: transparent;

  &:hover {
    border-color: var(--color-accent-border);
    background: var(--color-accent-bg);
  }
}

.create-icon {
  font-size: 32px;
  color: var(--color-text-muted);
  margin-bottom: 8px;
}

.create-text {
  font-size: 13px;
  color: var(--color-text-muted);
}

// ===== 「⋯」菜单 =====
.card-menu {
  position: absolute;
  top: 6px;
  right: 6px;
}

.menu-trigger {
  // 常驻的「⋯」会让整片网格很吵，悬停或聚焦才显形
  opacity: 0;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  cursor: pointer;
  font-size: 16px;
  transition: opacity 0.2s;

  &:focus-visible {
    opacity: 1;
  }
}

.menu-dropdown {
  display: none;
  position: absolute;
  top: 32px;
  right: 0;
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: 4px;
  min-width: 140px;
  box-shadow: var(--shadow-menu);
  z-index: 10;
}

// 只认 :focus-within 的话必须先点一下才出得来，加上 hover
.card-menu:hover .menu-dropdown,
.card-menu:focus-within .menu-dropdown {
  display: block;
}

// ===== 信息区 =====
.card-info {
  padding: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex: 1;
}

.card-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.card-stats {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin-bottom: 6px;
}

// ===== 插槽内容的统一外观 =====
// 封面、菜单项、脚注都由调用方渲染（带的是调用方的 scope id），只能 :deep() 穿透。
.library-card :deep(.card-cover) {
  height: 130px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  overflow: hidden;
}

.library-card :deep(.cover-media) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.library-card :deep(.cover-type-icon) {
  width: 48px;
  height: 48px;
  fill: var(--color-text-muted);
  transition: transform 0.3s ease;
}

.library-card:hover :deep(.cover-type-icon) {
  transform: scale(1.08);
}

.library-card :deep(.cover-text-placeholder) {
  font-size: 28px;
  font-weight: var(--font-weight-bold);
  color: var(--color-text-secondary);
  letter-spacing: 2px;
}

.library-card :deep(.fav-badge) {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: var(--font-size-base);
  color: var(--color-warning-text);
  line-height: 1;
  z-index: 3;
}

.library-card :deep(.status-badge) {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.3px;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
  background: var(--color-bg-raised);
  color: var(--color-text-muted);
  z-index: 3;

  &.status-success,
  &.verified {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  &.status-warning {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  &.status-error {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

.library-card :deep(.menu-item) {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--color-bg-raised);
    color: var(--color-text-primary);
  }

  &.danger {
    color: var(--color-danger-text);
  }
}

.library-card :deep(.card-tags) {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: auto;

  .tag {
    font-size: var(--font-size-xs);
    padding: 2px 8px;
    // 和项目库版本号、对话页模式胶囊同一形状
    border-radius: var(--radius-full);
    background: var(--color-bg-raised);
    color: var(--color-text-secondary);
    // 一个标签宁可省略号也不要折行：折行会把整张卡片撑高，同一行卡片就不齐了
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.library-card :deep(.card-path) {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: auto;
}

// ===== 集合封面（LibraryFolderCover 的结构）=====
// 放在这里而不是那个组件里：悬停放大是由**卡片**的 :hover 驱动的，
// 拆两处写会让这一组规则互相看不见。
.library-card :deep(.collection-cover.ios-folder) {
  background-size: cover;
  background-position: center;
  position: relative;

  .folder-glass-overlay {
    position: absolute;
    inset: 0;
    backdrop-filter: blur(28px) saturate(180%);
    background: var(--color-bg-overlay);
    z-index: 1;
    transition: all 0.4s ease;
  }

  .folder-grid {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    padding: 8px;
    width: 64px;
    height: 64px;
    background: var(--color-bg-raised);
    // Squircle 手感
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-border);
    transition:
      transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
      box-shadow 0.4s ease;
  }

  .folder-icon-slot {
    background: var(--color-bg-raised);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;

    svg {
      width: 14px;
      height: 14px;
      fill: var(--color-text-primary);
    }

    &.placeholder {
      background: var(--color-bg-surface-hover);

      svg {
        fill: var(--color-text-muted);
      }
    }
  }

  .collection-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    background: var(--color-bg-overlay);
    backdrop-filter: blur(8px);
    border: 1px solid var(--color-border-strong);
    color: var(--color-text-on-solid);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-medium);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
    z-index: 5;
  }

  .folder-icon {
    width: 10px;
    height: 10px;
    fill: currentColor;
  }
}

.library-card:hover :deep(.collection-cover.ios-folder) {
  .folder-glass-overlay {
    backdrop-filter: blur(16px) saturate(150%);
    background: var(--color-bg-overlay);
  }

  .folder-grid {
    transform: scale(1.1) translateY(-2px);
  }
}
</style>
