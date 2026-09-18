import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/layout/components/ChatSessionList.vue'),
  'utf8'
)

describe('ChatSessionList row actions', () => {
  it('normalizes the session context-menu icon slots and label alignment', () => {
    expect(source).toMatch(
      /\.chat-session-context-menu-entry\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*gap:\s*var\(--space-2\);/s
    )
    // 18 而不是 16：Phosphor 墨迹占框比 antd 小约一成七，px 写死的地方要自己补回来
    expect(source).toMatch(
      /\.chat-session-context-menu-entry :deep\(svg\)\s*\{[^}]*flex:\s*0 0 18px;[^}]*width:\s*18px;[^}]*height:\s*18px;[^}]*margin-inline-end:\s*0;[^}]*font-size:\s*18px;/s
    )
    // 三个弹窗共用同一格图标槽：整理/排序 5 条 + 工程分组 5 条 + 会话右键 4 条
    expect(source.match(/<span class="chat-session-context-menu-entry">/g)).toHaveLength(14)
  })

  // Ant Design 的 inbox/folder 是宽扁的、pencil/trash 是高窄的，同一列里视觉大小对不齐；
  // Phosphor 全套 256 网格 + 同一笔画宽度，换过去才是「看着也一样大」
  it('draws every menu and row icon from the Phosphor family', () => {
    expect(source).not.toMatch(
      /<(Form|Inbox|Delete|Folder|FolderOpen|Pushpin|More|Plus|Check|Close)\w*Outlined|<PushpinFilled/
    )
    expect(source).toContain("} from '@phosphor-icons/vue'")
  })

  it('keeps the running-session icon spinning', () => {
    expect(source).toMatch(
      /<PhCircleNotch\s+v-else-if="activityOf\(entry\.session\) === 'running'"\s+class="chat-item-running icon-spin"/
    )
  })

  it('keeps the project tooltip clear of the row actions', () => {
    // antd 那边写 :align="{ offset: [60, 0] }"，AppTooltip 收成一个数
    expect(source).toContain(':offset="60"')
  })

  it('uses the full title width until hover or keyboard focus reveals the actions', () => {
    expect(source).toMatch(/\.chat-item-actions\s*\{[^}]*width:\s*0;[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(
      /\.chat-item:hover \.chat-item-actions,\s*\.chat-item:focus-within \.chat-item-actions\s*\{[^}]*width:\s*auto;[^}]*overflow:\s*visible;[^}]*opacity:\s*1;/s
    )
  })

  it('opens the same project-scoped new chat after adding a project', () => {
    expect(source).toMatch(
      /function handleAddProject\(project: SidebarProject\): void \{\s*sidebarStore\.addManualProject\(project\)\s*sidebarStore\.expandGroup\(SECTION_PROJECTS_KEY\)\s*startNewChat\(project\.projectName\)\s*\}/s
    )
  })
})
