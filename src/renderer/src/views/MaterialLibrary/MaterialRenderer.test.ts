import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoredEntry } from '../../../../../tests/material-library/fixtures'
import MaterialRenderer from './MaterialRenderer.vue'

const rendererMocks = vi.hoisted(() => ({
  focusOnNodeByMatchers: vi.fn(),
  getSelectedNodesInfo: vi.fn()
}))

vi.mock('@renderer/views/BlueprintLibrary/BlueprintRenderer.vue', () => ({
  default: {
    name: 'BlueprintRenderer',
    props: ['code', 'name'],
    emits: ['content-change'],
    setup(_props: unknown, { expose }: { expose: (exposed: unknown) => void }) {
      expose({
        focusOnNodeByMatchers: rendererMocks.focusOnNodeByMatchers,
        getSelectedNodesInfo: rendererMocks.getSelectedNodesInfo
      })
      return {}
    },
    template:
      '<button class="blueprint-renderer-stub" type="button" @click="$emit(\'content-change\', \'Begin Object\\nEnd Object\')">{{ code }}</button>'
  }
}))

describe('MaterialRenderer', () => {
  beforeEach(() => {
    rendererMocks.focusOnNodeByMatchers.mockReset()
    rendererMocks.getSelectedNodesInfo.mockReset()
  })

  it('uses the blueprint node renderer for material graph code', async () => {
    const wrapper = mount(MaterialRenderer, {
      props: {
        mode: 'graph',
        entry: createStoredEntry({
          name: 'M_NodeDraft',
          graphBlueprintCode: 'Begin Object Class=/Script/Engine.MaterialGraphNode\nEnd Object',
          graphSummary: {
            nodeCount: 1,
            connectionCount: 0,
            keyNodeClasses: [],
            textureNodeCount: 0,
            functionCallCount: 0
          }
        })
      }
    })

    const renderer = wrapper.find('.blueprint-renderer-stub')
    expect(renderer.exists()).toBe(true)
    expect(renderer.text()).toContain('Begin Object Class=/Script/Engine.MaterialGraphNode')

    await renderer.trigger('click')
    expect(wrapper.emitted('content-change')?.[0]).toEqual(['Begin Object\nEnd Object'])
  })

  it('exposes material parameter focusing through blueprint renderer node matching', () => {
    rendererMocks.focusOnNodeByMatchers.mockReturnValue({ current: 1, total: 1 })

    const wrapper = mount(MaterialRenderer, {
      props: {
        mode: 'graph',
        entry: createStoredEntry({
          name: 'M_NodeDraft',
          graphBlueprintCode:
            'Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate Name="MaterialExpressionTextureCoordinate_0"\nEnd Object'
        })
      }
    })

    const result = (
      wrapper.vm as unknown as {
        focusOnMaterialParameter: (
          parameterName: string
        ) => { current: number; total: number } | null
      }
    ).focusOnMaterialParameter('TextureCoordinate_0.U Tiling')

    expect(result).toEqual({ current: 1, total: 1 })
    expect(rendererMocks.focusOnNodeByMatchers).toHaveBeenCalledWith(
      expect.arrayContaining([
        'TextureCoordinate_0',
        'MaterialExpressionTextureCoordinate_0',
        'Name="MaterialExpressionTextureCoordinate_0"'
      ])
    )
  })

  it('exposes selected material graph nodes from the blueprint renderer', () => {
    const selectedNodes = [
      {
        nodeName: 'TextureCoordinate_0',
        displayName: 'Texture Coordinate',
        serializedText: 'Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate'
      }
    ]
    rendererMocks.getSelectedNodesInfo.mockReturnValue(selectedNodes)

    const wrapper = mount(MaterialRenderer, {
      props: {
        mode: 'graph',
        entry: createStoredEntry({
          name: 'M_NodeDraft',
          graphBlueprintCode:
            'Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate Name="MaterialExpressionTextureCoordinate_0"\nEnd Object'
        })
      }
    })

    const result = (
      wrapper.vm as unknown as {
        getSelectedNodesInfo: () => typeof selectedNodes
      }
    ).getSelectedNodesInfo()

    expect(result).toEqual(selectedNodes)
  })

  it('renders material parameters by domain type with values and source labels', () => {
    const wrapper = mount(MaterialRenderer, {
      props: {
        mode: 'parameters',
        entry: createStoredEntry({
          scalarParameters: [
            { name: 'Roughness', type: 'scalar', overrideValue: 0.4 },
            {
              name: 'TextureCoordinate_0.Coordinate Index',
              type: 'scalar',
              overrideValue: 0,
              source: 'nodeProperty'
            },
            {
              name: 'TextureCoordinate_0.U Tiling',
              type: 'scalar',
              overrideValue: 2,
              source: 'nodeProperty'
            }
          ],
          staticSwitchParameters: [
            {
              name: 'TextureCoordinate_0.Un Mirror U',
              type: 'staticSwitch',
              overrideValue: false,
              source: 'nodeProperty'
            }
          ],
          textureParameters: [
            { name: 'BaseColor', type: 'texture', inheritedValue: '/Game/Textures/T_Master' }
          ]
        })
      }
    })

    expect(wrapper.findAll('.parameter-row')).toHaveLength(5)
    expect(wrapper.text()).toContain('数值参数')
    expect(wrapper.text()).toContain('贴图参数')
    expect(wrapper.text()).toContain('Roughness')
    expect(wrapper.text()).toContain('0.4')
    expect(wrapper.text()).toContain('BaseColor')
    expect(wrapper.text()).toContain('/Game/Textures/T_Master')
    expect(wrapper.text()).toContain('TextureCoordinate_0.Coordinate Index')
    expect(wrapper.text()).toContain('TextureCoordinate_0.U Tiling')
    expect(wrapper.text()).toContain('TextureCoordinate_0.Un Mirror U')
    expect(wrapper.text()).toContain('节点属性')
    expect(wrapper.text()).toContain('覆盖值')
    expect(wrapper.text()).toContain('继承值')
  })
})
