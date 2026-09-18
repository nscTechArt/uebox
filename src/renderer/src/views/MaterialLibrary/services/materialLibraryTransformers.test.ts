import { describe, expect, it } from 'vitest'
import {
  extractLegacyMaterialDependencies,
  extractLegacyMaterialParameters,
  summarizeLegacyGraph
} from './materialLibraryTransformers'

describe('materialLibraryTransformers', () => {
  it('summarizes legacy T3D material source', () => {
    const summary = summarizeLegacyGraph(`
      Begin Object Class=/Script/Engine.MaterialExpressionTextureSample Name="MaterialExpressionTextureSample_0"
      End Object
      Begin Object Class=/Script/Engine.MaterialExpressionMultiply Name="MaterialExpressionMultiply_0"
      End Object
      LinkedTo=(MaterialExpressionTextureSample_0)
    `)

    expect(summary.nodeCount).toBe(2)
    expect(summary.textureNodeCount).toBe(1)
    expect(summary.connectionCount).toBe(1)
  })

  it('extracts parameter collection dependencies from legacy T3D source', () => {
    const dependencies = extractLegacyMaterialDependencies(`
      Begin Object Class=/Script/Engine.MaterialExpressionCollectionParameter Name="MaterialExpressionCollectionParameter_0"
      End Object
      Collection=MaterialParameterCollection'"/Game/MaterialCollections/MPC_Global.MPC_Global"'
    `)

    expect(dependencies.parameterCollectionPaths).toEqual(['/Game/MaterialCollections/MPC_Global'])
  })

  it('extracts editable node values from legacy material graph text', () => {
    const parameters = extractLegacyMaterialParameters(`
      Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0"
          CustomProperties Pin (PinId=A,PinName="Value",Direction="EGPD_Input",DefaultValue="1.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
      End Object
      Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate Name="MaterialExpressionTextureCoordinate_0"
          CustomProperties Pin (PinId=B,PinName="CoordinateIndex",PinFriendlyName="Coordinate Index",Direction="EGPD_Input",DefaultValue="0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
          CustomProperties Pin (PinId=C,PinName="UTiling",PinFriendlyName="U Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
          CustomProperties Pin (PinId=D,PinName="VTiling",PinFriendlyName="V Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
          CustomProperties Pin (PinId=E,PinName="UnMirrorU",PinFriendlyName="Un Mirror U",Direction="EGPD_Input",DefaultValue="False",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
          CustomProperties Pin (PinId=F,PinName="UnMirrorV",PinFriendlyName="Un Mirror V",Direction="EGPD_Input",DefaultValue="True",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
      End Object
    `)

    expect(parameters.scalarParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Constant_0.Value',
          type: 'scalar',
          overrideValue: 1,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.Coordinate Index',
          type: 'scalar',
          overrideValue: 0,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.U Tiling',
          type: 'scalar',
          overrideValue: 2,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.V Tiling',
          type: 'scalar',
          overrideValue: 2,
          source: 'nodeProperty'
        })
      ])
    )
    expect(parameters.staticSwitchParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'TextureCoordinate_0.Un Mirror U',
          type: 'staticSwitch',
          overrideValue: false,
          source: 'nodeProperty'
        }),
        expect.objectContaining({
          name: 'TextureCoordinate_0.Un Mirror V',
          type: 'staticSwitch',
          overrideValue: true,
          source: 'nodeProperty'
        })
      ])
    )
  })

  it('extracts visible material pins from MaterialGraphNode wrappers', () => {
    const parameters = extractLegacyMaterialParameters(`
      Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0"
         Begin Object Class=/Script/Engine.MaterialExpressionTextureCoordinate Name="MaterialExpressionTextureCoordinate_0"
            CoordinateIndex=0
         End Object
         MaterialExpression=/Script/Engine.MaterialExpressionTextureCoordinate'"MaterialExpressionTextureCoordinate_0"'
         CustomProperties Pin (PinId=A,PinName="CoordinateIndex",PinFriendlyName="Coordinate Index",Direction="EGPD_Input",DefaultValue="0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
         CustomProperties Pin (PinId=B,PinName="UTiling",PinFriendlyName="U Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
         CustomProperties Pin (PinId=C,PinName="VTiling",PinFriendlyName="V Tiling",Direction="EGPD_Input",DefaultValue="2.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
      End Object
      Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1"
         Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0"
         End Object
         MaterialExpression=/Script/Engine.MaterialExpressionConstant'"MaterialExpressionConstant_0"'
         CustomProperties Pin (PinId=D,PinName="Value",Direction="EGPD_Input",DefaultValue="1.0",PersistentGuid=00000000000000000000000000000000,bHidden=False,bDefaultValueIsReadOnly=False,bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)
      End Object
    `)

    expect(parameters.scalarParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'TextureCoordinate_0.Coordinate Index', overrideValue: 0 }),
        expect.objectContaining({ name: 'TextureCoordinate_0.U Tiling', overrideValue: 2 }),
        expect.objectContaining({ name: 'TextureCoordinate_0.V Tiling', overrideValue: 2 }),
        expect.objectContaining({ name: 'Constant_0.Value', overrideValue: 1 })
      ])
    )
  })
})
