import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AddProjectModal from './AddProjectModal.vue'

const modalStub = {
  props: { open: Boolean },
  template: '<section v-if="open"><slot /></section>'
}

const buttonStub = {
  inheritAttrs: false,
  template: '<button v-bind="$attrs"><slot /></button>'
}

const spinStub = { template: '<div><slot /></div>' }

function mountModal(): VueWrapper {
  return mount(AddProjectModal, {
    props: { open: true },
    global: {
      stubs: {
        AppModal: modalStub,
        'a-button': buttonStub,
        'a-spin': spinStub
      }
    }
  })
}

async function openImportedList(): Promise<VueWrapper> {
  const wrapper = mountModal()
  await wrapper.findAll('.add-project-card')[1].trigger('click')
  await wrapper.get('.add-project-footer button').trigger('click')
  await flushPromises()
  return wrapper
}

describe('AddProjectModal imported project picker', () => {
  beforeEach(() => {
    window.api.database = {
      project: {
        getAll: vi.fn().mockResolvedValue({
          success: true,
          data: [
            {
              projectKey: 'link',
              projectName: 'UALinkDev55',
              projectPath: 'I:/UnrealAgent/UALinkDev55',
              EngineAssociation: '5.5',
              image: 'link-cover.jpg'
            },
            {
              projectKey: 'human',
              projectName: 'SampleProject',
              projectPath: 'I:/UE Project/SampleProject_archive_5_5',
              EngineAssociation: '5.8',
              image: null
            }
          ]
        })
      }
    } as unknown as typeof window.api.database
    window.api.path = {
      getPublicThumbnailUrl: vi.fn().mockResolvedValue({
        success: true,
        data: 'file:///C:/thumbnails/link-cover.jpg'
      })
    } as unknown as typeof window.api.path
    window.api.unrealPath = {
      resolveEngineAssociations: vi.fn().mockResolvedValue({
        success: true,
        data: { '5.5': '5.5', '5.8': '5.8' }
      })
    } as unknown as typeof window.api.unrealPath
  })

  it('shows compact covers and filters projects by both name and path', async () => {
    const wrapper = await openImportedList()

    expect(wrapper.findAll('.add-project-row')).toHaveLength(2)
    expect(wrapper.get('.add-project-cover img').attributes('src')).toBe(
      'local-resource://C:/thumbnails/link-cover.jpg'
    )
    expect(wrapper.find('.add-project-cover-fallback').exists()).toBe(true)

    await wrapper.get('input[type="search"]').setValue('archive')

    expect(wrapper.findAll('.add-project-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('SampleProject')
  })

  it('keeps the list usable when a stored cover cannot be resolved', async () => {
    ;(window.api.path.getPublicThumbnailUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false
    })

    const wrapper = await openImportedList()

    expect(wrapper.findAll('.add-project-row')).toHaveLength(2)
    expect(wrapper.findAll('.add-project-cover-fallback')).toHaveLength(2)
  })

  it('emits the selected project only after the user confirms it', async () => {
    const wrapper = await openImportedList()

    await wrapper.findAll('.add-project-row')[1].trigger('click')
    expect(wrapper.findAll('.add-project-row')[1].classes()).toContain('selected')

    await wrapper.findAll('.add-project-footer button')[1].trigger('click')

    expect(wrapper.emitted('confirm')).toEqual([
      [
        {
          projectName: 'SampleProject',
          projectPath: 'I:/UE Project/SampleProject_archive_5_5',
          engineVersion: '5.8'
        }
      ]
    ])
  })
})
