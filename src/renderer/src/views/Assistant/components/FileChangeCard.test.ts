import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { snapshotAgentProcess } from '@renderer/utils/agentProcessSnapshot'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import FileChangeCard from './FileChangeCard.vue'
import FileDiffView from './FileDiffView.vue'
import { fileReviewKey } from '../composables/useFileReview'
import AgentProcessLog from './AgentProcessLog.vue'
import AIBubble from './AIBubble.vue'
import type { AgentProcessItem } from './AgentProcessLog.types'

vi.mock('@renderer/services/imageViewer', () => ({ openSingleImage: vi.fn() }))

describe('file change cards', () => {
  it('opens the diff directly from the changed files panel in the reply', async () => {
    const openReview = vi.fn()
    const wrapper = mount(AIBubble, {
      props: {
        id: 'diff-reply',
        content: 'Done',
        status: 'done',
        responseMetadata: {
          changes: [
            {
              toolName: 'edit_local_file',
              risk: 'destructive',
              target: 'C:/work/test.js',
              reversible: false,
              failed: false
            }
          ]
        },
        agentProcess: [
          {
            type: 'tool-result',
            timestamp: 1,
            data: {
              toolName: 'edit_local_file',
              result: {
                message: 'Edited',
                fileChange: {
                  path: 'C:\\work\\test.js',
                  before: 'old\n',
                  after: 'new\n',
                  created: false
                }
              }
            }
          }
        ]
      },
      global: {
        provide: { [fileReviewKey as symbol]: openReview },
        stubs: { AgentProcessLog: true, MarkdownRenderer: true }
      }
    })
    await wrapper.find('.response-changes-header').trigger('click')
    expect(wrapper.find('.response-file-counts .added').text()).toBe('+1')
    expect(wrapper.find('.response-file-review').text()).not.toContain('审查')
    expect(wrapper.find('.response-file-path').text()).toBe('C:/work/test.js')
    expect(wrapper.find('.response-file-open').classes()).toContain('app-button--soft')
    await wrapper.find('.response-file-counts').trigger('click')
    expect(openReview).toHaveBeenCalledWith(
      [expect.objectContaining({ before: 'old\n', after: 'new\n' })],
      'C:\\work\\test.js'
    )
    expect(wrapper.find('.diff-body').exists()).toBe(false)
    openReview.mockClear()
    await wrapper.find('.response-file-open').trigger('click')
    expect(openReview).not.toHaveBeenCalled()
  })
  it('expands with counts, line numbers and safely renders source text', async () => {
    const wrapper = mount(FileDiffView, {
      props: {
        change: {
          path: 'test.cpp',
          before: 'old\n',
          after: '<script>new</script>\n',
          created: false
        }
      }
    })
    expect(wrapper.find('.added').text()).toBe('+1')
    expect(wrapper.find('.removed').text()).toBe('−1')
    expect(wrapper.find('.diff-body').exists()).toBe(true)
    expect(wrapper.find('.remove code').text()).toBe('old')
    expect(wrapper.find('.add code').text()).toBe('<script>new</script>')
    expect(wrapper.find('.add script').exists()).toBe(false)
    expect(wrapper.find('.add .line-number:nth-child(2)').text()).toBe('1')
    await wrapper.find('button').trigger('click')
    expect(wrapper.find('.diff-body').exists()).toBe(false)
  })
  it('folds long unchanged context and batches large additions', async () => {
    const unchanged = 'context\n'.repeat(50)
    const wrapper = mount(FileDiffView, {
      props: {
        change: {
          path: 'x',
          before: unchanged,
          after: unchanged + 'new\n'.repeat(300),
          created: false
        }
      }
    })
    expect(wrapper.find('.fold').exists()).toBe(true)
    expect(wrapper.findAll('.diff-line').length).toBeLessThanOrEqual(200)
    await wrapper.find('.diff-body button').trigger('click')
    expect(wrapper.findAll('.add')).toHaveLength(300)
  })
  it('survives message persistence and does not deduplicate separate edits', async () => {
    const openReview = vi.fn()
    const change = { path: 'x.cpp', before: 'a', after: 'b', created: false }
    const items: AgentProcessItem[] = [1, 2].map((timestamp) => ({
      type: 'tool-result',
      timestamp,
      data: { toolName: 'edit_local_file', result: { message: 'Edited file', fileChange: change } }
    }))
    const store = useChatMessagesStore()
    store.hydrateChatMessagesPersistence({
      messagesBySid: {
        diff: [
          {
            id: 'one',
            role: 'assistant',
            content: 'Done',
            status: 'done',
            agentProcess: snapshotAgentProcess(items)
          }
        ]
      }
    })
    const persisted = JSON.parse(JSON.stringify(store.exportChatMessagesPersistence()))
    store.hydrateChatMessagesPersistence(persisted)
    const restored = store.getMessages('diff')[0].agentProcess!
    const wrapper = mount(AgentProcessLog, {
      props: { items: restored, isThinking: false },
      global: { provide: { [fileReviewKey as symbol]: openReview } }
    })
    expect(wrapper.findAllComponents(FileChangeCard)).toHaveLength(2)
    await wrapper.find('.change-toggle').trigger('click')
    expect(openReview).toHaveBeenCalledWith([change], 'x.cpp')
    expect(wrapper.find('.diff-body').exists()).toBe(false)
  })
})
