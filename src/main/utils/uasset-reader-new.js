/**
 * uasset-reader-js (v1.3.1)
 * https://github.com/blueprintue/uasset-reader-js
 *
 * MIT License
 *
 * Copyright (c) 2023 blueprintUE
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/* eslint-disable */
import fs from 'fs/promises'

/**
 * Uasset structure.
 *
 * @typedef Uasset
 * @property {HexView[]}            hexView               - list of bytes read with position and type in file
 * @property {object}               header                - header file
 * @property {Name[]}               names                 - to fill
 * @property {GatherableTextData[]} gatherableTextData    - to fill
 * @property {object}               imports               - to fill
 * @property {object}               exports               - to fill
 * @property {object}               depends               - to fill
 * @property {object}               softPackageReferences - to fill
 * @property {object}               searchableNames       - to fill
 * @property {Thumbnails}           thumbnails            - to fill
 * @property {object}               assetRegistryData     - to fill
 * @property {object}               preloadDependency     - to fill
 * @property {object}               bulkDataStart         - to fill
 */

/**
 * HexView structure.
 *
 * @typedef HexView
 * @property {string} key   - name of what we read
 * @property {string} type  - type name of what we read (int16, int32, etc...)
 * @property {string} value - value read
 * @property {number} start - start position in the file
 * @property {number} stop  - stop position in the file
 */

/**
 * Name structure.
 *
 * @typedef Name
 * @property {string} Name                  - value
 * @property {number} NonCasePreservingHash - hash of value with case non preserved (upper)
 * @property {number} CasePreservingHash    - hash of value with case preserved
 */

// region GatherableTextData
/**
 * GatherableTextData Structure.
 *
 * @typedef GatherableTextData
 * @property {string}               NamespaceName      - to fill
 * @property {SourceData}           SourceData         - to fill
 * @property {SourceSiteContexts[]} SourceSiteContexts - to fill
 */

/**
 * SourceData Structure.
 *
 * @typedef SourceData
 * @property {string}                     SourceString         - to fill
 * @property {GatherableTextDataMetadata} SourceStringMetaData - to fill
 */

/**
 * SourceSiteContexts Structure.
 *
 * @typedef SourceSiteContexts
 * @property {string}                     KeyName         - to fill
 * @property {string}                     SiteDescription - to fill
 * @property {number}                     IsEditorOnly    - to fill
 * @property {number}                     IsOptional      - to fill
 * @property {GatherableTextDataMetadata} InfoMetaData    - to fill
 * @property {GatherableTextDataMetadata} KeyMetaData     - to fill
 */

/**
 * GatherableTextDataMetadata Structure.
 *
 * @typedef GatherableTextDataMetadata
 * @property {number} ValueCount - to fill
 * @property {any[]}  Values     - to fill
 */
// endregion

// region Thumbnails
/**
 * Thumbnails Structure.
 *
 * @typedef Thumbnails
 * @property {ThumbnailsIndex[]}      Index      - index
 * @property {ThumbnailsThumbnails[]} Thumbnails - thumbnails
 */

/**
 * Thumbnails Index Structure
 *
 * @typedef ThumbnailsIndex
 * @property {string} AssetClassName               - class name
 * @property {string} ObjectPathWithoutPackageName - path
 * @property {number} FileOffset                   - position in file
 */

/**
 * Thumbnails Thumbnails Structure
 *
 * @typedef ThumbnailsThumbnails
 * @property {number}   ImageWidth    - width
 * @property {number}   ImageHeight   - height
 * @property {string}   ImageFormat   - format (PNG or JPEG)
 * @property {number}   ImageSizeData - how many bytes used in file
 * @property {number[]} ImageData     - raw data
 */
// endregion

var EPackageFileTag = {
  PACKAGE_FILE_TAG: 0x9e2a83c1,
  PACKAGE_FILE_TAG_SWAPPED: 0xc1832a9e
}

// https://github.com/EpicGames/UnrealEngine/blob/release/Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h#L83
var EUnrealEngineObjectUE4Version = {
  VER_UE4_OLDEST_LOADABLE_PACKAGE: {
    value: 214,
    comment: 'Oldest package managed by Unreal Engine'
  },
  VER_UE4_BLUEPRINT_VARS_NOT_READ_ONLY: {
    value: 215,
    comment: 'Removed restriction on blueprint-exposed variables from being read-only'
  },
  VER_UE4_STATIC_MESH_STORE_NAV_COLLISION: {
    value: 216,
    comment: 'Added manually serialized element to UStaticMesh (precalculated nav collision)'
  },
  VER_UE4_ATMOSPHERIC_FOG_DECAY_NAME_CHANGE: {
    value: 217,
    comment: 'Changed property name for atmospheric fog'
  },
  VER_UE4_SCENECOMP_TRANSLATION_TO_LOCATION: {
    value: 218,
    comment: 'Change many properties/functions from Translation to Location'
  },
  VER_UE4_MATERIAL_ATTRIBUTES_REORDERING: { value: 219, comment: 'Material attributes reordering' },
  VER_UE4_COLLISION_PROFILE_SETTING: {
    value: 220,
    comment:
      'Collision Profile setting has been added, and all components that exists has to be properly upgraded'
  },
  VER_UE4_BLUEPRINT_SKEL_TEMPORARY_TRANSIENT: {
    value: 221,
    comment: "Making the blueprint's skeleton class transient"
  },
  VER_UE4_BLUEPRINT_SKEL_SERIALIZED_AGAIN: {
    value: 222,
    comment: "Making the blueprint's skeleton class serialized again"
  },
  VER_UE4_BLUEPRINT_SETS_REPLICATION: {
    value: 223,
    comment: 'Blueprint now controls replication settings again'
  },
  VER_UE4_WORLD_LEVEL_INFO: { value: 224, comment: 'Added level info used by World browser' },
  VER_UE4_AFTER_CAPSULE_HALF_HEIGHT_CHANGE: {
    value: 225,
    comment: 'Changed capsule height to capsule half-height (afterwards)'
  },
  VER_UE4_ADDED_NAMESPACE_AND_KEY_DATA_TO_FTEXT: {
    value: 226,
    comment: 'Added Namepace, GUID (Key) and Flags to FText'
  },
  VER_UE4_ATTENUATION_SHAPES: { value: 227, comment: 'Attenuation shapes' },
  VER_UE4_LIGHTCOMPONENT_USE_IES_TEXTURE_MULTIPLIER_ON_NON_IES_BRIGHTNESS: {
    value: 228,
    comment: 'Use IES texture multiplier even when IES brightness is not being used'
  },
  VER_UE4_REMOVE_INPUT_COMPONENTS_FROM_BLUEPRINTS: {
    value: 229,
    comment: 'Removed InputComponent as a blueprint addable component'
  },
  VER_UE4_VARK2NODE_USE_MEMBERREFSTRUCT: {
    value: 230,
    comment: 'Use an FMemberReference struct in UK2Node_Variable'
  },
  VER_UE4_REFACTOR_MATERIAL_EXPRESSION_SCENECOLOR_AND_SCENEDEPTH_INPUTS: {
    value: 231,
    comment:
      'Refactored material expression inputs for UMaterialExpressionSceneColor and UMaterialExpressionSceneDepth'
  },
  VER_UE4_SPLINE_MESH_ORIENTATION: {
    value: 232,
    comment: 'Spline meshes changed from Z forwards to configurable'
  },
  VER_UE4_REVERB_EFFECT_ASSET_TYPE: { value: 233, comment: 'Added ReverbEffect asset type' },
  VER_UE4_MAX_TEXCOORD_INCREASED: { value: 234, comment: 'changed max texcoords from 4 to 8' },
  VER_UE4_SPEEDTREE_STATICMESH: {
    value: 235,
    comment: 'static meshes changed to support SpeedTrees'
  },
  VER_UE4_LANDSCAPE_COMPONENT_LAZY_REFERENCES: {
    value: 236,
    comment: 'Landscape component reference between landscape component and collision component'
  },
  VER_UE4_SWITCH_CALL_NODE_TO_USE_MEMBER_REFERENCE: {
    value: 237,
    comment: 'Refactored UK2Node_CallFunction to use FMemberReference'
  },
  VER_UE4_ADDED_SKELETON_ARCHIVER_REMOVAL: {
    value: 238,
    comment: 'Added fixup step to remove skeleton class references from blueprint objects'
  },
  VER_UE4_ADDED_SKELETON_ARCHIVER_REMOVAL_SECOND_TIME: {
    value: 239,
    comment: 'See above, take 2.'
  },
  VER_UE4_BLUEPRINT_SKEL_CLASS_TRANSIENT_AGAIN: {
    value: 240,
    comment: 'Making the skeleton class on blueprints transient'
  },
  VER_UE4_ADD_COOKED_TO_UCLASS: { value: 241, comment: "UClass knows if it's been cooked" },
  VER_UE4_DEPRECATED_STATIC_MESH_THUMBNAIL_PROPERTIES_REMOVED: {
    value: 242,
    comment: 'Deprecated static mesh thumbnail properties were removed'
  },
  VER_UE4_COLLECTIONS_IN_SHADERMAPID: {
    value: 243,
    comment: 'Added collections in material shader map ids'
  },
  VER_UE4_REFACTOR_MOVEMENT_COMPONENT_HIERARCHY: {
    value: 244,
    comment: 'Renamed some Movement Component properties, added PawnMovementComponent'
  },
  VER_UE4_FIX_TERRAIN_LAYER_SWITCH_ORDER: {
    value: 245,
    comment:
      'Swap UMaterialExpressionTerrainLayerSwitch::LayerUsed/LayerNotUsed the correct way round'
  },
  VER_UE4_ALL_PROPS_TO_CONSTRAINTINSTANCE: { value: 246, comment: 'Remove URB_ConstraintSetup' },
  VER_UE4_LOW_QUALITY_DIRECTIONAL_LIGHTMAPS: {
    value: 247,
    comment: 'Low quality directional lightmaps'
  },
  VER_UE4_ADDED_NOISE_EMITTER_COMPONENT: {
    value: 248,
    comment: 'Added NoiseEmitterComponent and removed related Pawn properties.'
  },
  VER_UE4_ADD_TEXT_COMPONENT_VERTICAL_ALIGNMENT: {
    value: 249,
    comment: 'Add text component vertical alignment'
  },
  VER_UE4_ADDED_FBX_ASSET_IMPORT_DATA: {
    value: 250,
    comment:
      'Added AssetImportData for FBX asset types, deprecating SourceFilePath and SourceFileTimestamp'
  },
  VER_UE4_REMOVE_LEVELBODYSETUP: { value: 251, comment: 'Remove LevelBodySetup from ULevel' },
  VER_UE4_REFACTOR_CHARACTER_CROUCH: { value: 252, comment: 'Refactor character crouching' },
  VER_UE4_SMALLER_DEBUG_MATERIALSHADER_UNIFORM_EXPRESSIONS: {
    value: 253,
    comment: 'Trimmed down material shader debug information.'
  },
  VER_UE4_APEX_CLOTH: { value: 254, comment: 'APEX Clothing' },
  VER_UE4_SAVE_COLLISIONRESPONSE_PER_CHANNEL: {
    value: 255,
    comment: 'we should rename to match ECollisionChannel'
  },
  VER_UE4_ADDED_LANDSCAPE_SPLINE_EDITOR_MESH: {
    value: 256,
    comment: 'Added Landscape Spline editor meshes'
  },
  VER_UE4_CHANGED_MATERIAL_REFACTION_TYPE: {
    value: 257,
    comment: 'Fixup input expressions for reading from refraction material attributes.'
  },
  VER_UE4_REFACTOR_PROJECTILE_MOVEMENT: {
    value: 258,
    comment: 'Refactor projectile movement, along with some other movement component work.'
  },
  VER_UE4_REMOVE_PHYSICALMATERIALPROPERTY: {
    value: 259,
    comment: 'Remove PhysicalMaterialProperty and replace with user defined enum'
  },
  VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS: {
    value: 260,
    comment: 'Removed all compile outputs from FMaterial'
  },
  VER_UE4_ADD_COOKED_TO_LANDSCAPE: {
    value: 261,
    comment: 'Ability to save cooked PhysX meshes to Landscape'
  },
  VER_UE4_CONSUME_INPUT_PER_BIND: {
    value: 262,
    comment: 'Change how input component consumption works'
  },
  VER_UE4_SOUND_CLASS_GRAPH_EDITOR: {
    value: 263,
    comment: 'Added new Graph based SoundClass Editor'
  },
  VER_UE4_FIXUP_TERRAIN_LAYER_NODES: {
    value: 264,
    comment: 'Fixed terrain layer node guids which was causing artifacts'
  },
  VER_UE4_RETROFIT_CLAMP_EXPRESSIONS_SWAP: {
    value: 265,
    comment: 'Added clamp min/max swap check to catch older materials'
  },
  VER_UE4_REMOVE_LIGHT_MOBILITY_CLASSES: {
    value: 266,
    comment: 'Remove static/movable/stationary light classes'
  },
  VER_UE4_REFACTOR_PHYSICS_BLENDING: {
    value: 267,
    comment: 'Refactor the way physics blending works to allow partial blending'
  },
  VER_UE4_WORLD_LEVEL_INFO_UPDATED: {
    value: 268,
    comment: 'WorldLevelInfo: Added reference to parent level and streaming distance'
  },
  VER_UE4_STATIC_SKELETAL_MESH_SERIALIZATION_FIX: {
    value: 269,
    comment: 'Fixed cooking of skeletal/static meshes due to bad serialization logic'
  },
  VER_UE4_REMOVE_STATICMESH_MOBILITY_CLASSES: {
    value: 270,
    comment: 'Removal of InterpActor and PhysicsActor'
  },
  VER_UE4_REFACTOR_PHYSICS_TRANSFORMS: { value: 271, comment: 'Refactor physics transforms' },
  VER_UE4_REMOVE_ZERO_TRIANGLE_SECTIONS: {
    value: 272,
    comment: 'Remove zero triangle sections from static meshes and compact material indices.'
  },
  VER_UE4_CHARACTER_MOVEMENT_DECELERATION: {
    value: 273,
    comment: 'Add param for deceleration in character movement instead of using acceleration.'
  },
  VER_UE4_CAMERA_ACTOR_USING_CAMERA_COMPONENT: {
    value: 274,
    comment: 'Made ACameraActor use a UCameraComponent for parameter storage, etc...'
  },
  VER_UE4_CHARACTER_MOVEMENT_DEPRECATE_PITCH_ROLL: {
    value: 275,
    comment: 'Deprecated some pitch/roll properties in CharacterMovementComponent'
  },
  VER_UE4_REBUILD_TEXTURE_STREAMING_DATA_ON_LOAD: {
    value: 276,
    comment: 'Rebuild texture streaming data on load for uncooked builds'
  },
  VER_UE4_SUPPORT_32BIT_STATIC_MESH_INDICES: {
    value: 277,
    comment: 'Add support for 32 bit index buffers for static meshes.'
  },
  VER_UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE: {
    value: 278,
    comment: 'Added streaming install ChunkID to AssetData and UPackage'
  },
  VER_UE4_CHARACTER_DEFAULT_MOVEMENT_BINDINGS: {
    value: 279,
    comment: 'Add flag to control whether Character blueprints receive default movement bindings.'
  },
  VER_UE4_APEX_CLOTH_LOD: { value: 280, comment: 'APEX Clothing LOD Info' },
  VER_UE4_ATMOSPHERIC_FOG_CACHE_DATA: {
    value: 281,
    comment: 'Added atmospheric fog texture data to be general'
  },
  VAR_UE4_ARRAY_PROPERTY_INNER_TAGS: { value: 282, comment: "Arrays serialize their inner's tags" },
  VER_UE4_KEEP_SKEL_MESH_INDEX_DATA: {
    value: 283,
    comment: 'Skeletal mesh index data is kept in memory in game to support mesh merging.'
  },
  VER_UE4_BODYSETUP_COLLISION_CONVERSION: {
    value: 284,
    comment: 'Added compatibility for the body instance collision change'
  },
  VER_UE4_REFLECTION_CAPTURE_COOKING: { value: 285, comment: 'Reflection capture cooking' },
  VER_UE4_REMOVE_DYNAMIC_VOLUME_CLASSES: {
    value: 286,
    comment: 'Removal of DynamicTriggerVolume, DynamicBlockingVolume, DynamicPhysicsVolume'
  },
  VER_UE4_STORE_HASCOOKEDDATA_FOR_BODYSETUP: {
    value: 287,
    comment:
      'Store an additional flag in the BodySetup to indicate whether there is any cooked data to load'
  },
  VER_UE4_REFRACTION_BIAS_TO_REFRACTION_DEPTH_BIAS: {
    value: 288,
    comment: 'Changed name of RefractionBias to RefractionDepthBias.'
  },
  VER_UE4_REMOVE_SKELETALPHYSICSACTOR: { value: 289, comment: 'Removal of SkeletalPhysicsActor' },
  VER_UE4_PC_ROTATION_INPUT_REFACTOR: {
    value: 290,
    comment: 'PlayerController rotation input refactor'
  },
  VER_UE4_LANDSCAPE_PLATFORMDATA_COOKING: {
    value: 291,
    comment: 'Landscape Platform Data cooking'
  },
  VER_UE4_CREATEEXPORTS_CLASS_LINKING_FOR_BLUEPRINTS: {
    value: 292,
    comment:
      'Added call for linking classes in CreateExport to ensure memory is initialized properly'
  },
  VER_UE4_REMOVE_NATIVE_COMPONENTS_FROM_BLUEPRINT_SCS: {
    value: 293,
    comment: 'Remove native component nodes from the blueprint SimpleConstructionScript'
  },
  VER_UE4_REMOVE_SINGLENODEINSTANCE: { value: 294, comment: 'Removal of Single Node Instance' },
  VER_UE4_CHARACTER_BRAKING_REFACTOR: { value: 295, comment: 'Character movement braking changes' },
  VER_UE4_VOLUME_SAMPLE_LOW_QUALITY_SUPPORT: {
    value: 296,
    comment: 'Supported low quality lightmaps in volume samples'
  },
  VER_UE4_SPLIT_TOUCH_AND_CLICK_ENABLES: {
    value: 297,
    comment: 'Split bEnableTouchEvents out from bEnableClickEvents'
  },
  VER_UE4_HEALTH_DEATH_REFACTOR: { value: 298, comment: 'Health/Death refactor' },
  VER_UE4_SOUND_NODE_ENVELOPER_CURVE_CHANGE: {
    value: 299,
    comment: 'Moving USoundNodeEnveloper from UDistributionFloatConstantCurve to FRichCurve'
  },
  VER_UE4_POINT_LIGHT_SOURCE_RADIUS: {
    value: 300,
    comment: 'Moved SourceRadius to UPointLightComponent'
  },
  VER_UE4_SCENE_CAPTURE_CAMERA_CHANGE: {
    value: 301,
    comment: 'Scene capture actors based on camera actors.'
  },
  VER_UE4_MOVE_SKELETALMESH_SHADOWCASTING: {
    value: 302,
    comment: 'Moving SkeletalMesh shadow casting flag from LoD details to material'
  },
  VER_UE4_CHANGE_SETARRAY_BYTECODE: {
    value: 303,
    comment: 'Changing bytecode operators for creating arrays'
  },
  VER_UE4_MATERIAL_INSTANCE_BASE_PROPERTY_OVERRIDES: {
    value: 304,
    comment: 'Material Instances overriding base material properties.'
  },
  VER_UE4_COMBINED_LIGHTMAP_TEXTURES: {
    value: 305,
    comment: 'Combined top/bottom lightmap textures'
  },
  VER_UE4_BUMPED_MATERIAL_EXPORT_GUIDS: {
    value: 306,
    comment: 'Forced material lightmass guids to be regenerated'
  },
  VER_UE4_BLUEPRINT_INPUT_BINDING_OVERRIDES: {
    value: 307,
    comment: 'Allow overriding of parent class input bindings'
  },
  VER_UE4_FIXUP_BODYSETUP_INVALID_CONVEX_TRANSFORM: {
    value: 308,
    comment: 'Fix up convex invalid transform'
  },
  VER_UE4_FIXUP_STIFFNESS_AND_DAMPING_SCALE: {
    value: 309,
    comment: 'Fix up scale of physics stiffness and damping value'
  },
  VER_UE4_REFERENCE_SKELETON_REFACTOR: {
    value: 310,
    comment: 'Convert USkeleton and FBoneContrainer to using FReferenceSkeleton.'
  },
  VER_UE4_K2NODE_REFERENCEGUIDS: {
    value: 311,
    comment:
      'Adding references to variable, function, and macro nodes to be able to update to renamed values'
  },
  VER_UE4_FIXUP_ROOTBONE_PARENT: {
    value: 312,
    comment: "Fix up the 0th bone's parent bone index."
  },
  VER_UE4_TEXT_RENDER_COMPONENTS_WORLD_SPACE_SIZING: {
    value: 313,
    comment: 'llow setting of TextRenderComponents size in world space.'
  },
  VER_UE4_MATERIAL_INSTANCE_BASE_PROPERTY_OVERRIDES_PHASE_2: {
    value: 314,
    comment: 'Material Instances overriding base material properties #2.'
  },
  VER_UE4_CLASS_NOTPLACEABLE_ADDED: {
    value: 315,
    comment: 'CLASS_Placeable becomes CLASS_NotPlaceable'
  },
  VER_UE4_WORLD_LEVEL_INFO_LOD_LIST: {
    value: 316,
    comment: 'Added LOD info list to a world tile description'
  },
  VER_UE4_CHARACTER_MOVEMENT_VARIABLE_RENAMING_1: {
    value: 317,
    comment: 'CharacterMovement variable naming refactor'
  },
  VER_UE4_FSLATESOUND_CONVERSION: {
    value: 318,
    comment: 'FName properties containing sound names converted to FSlateSound properties'
  },
  VER_UE4_WORLD_LEVEL_INFO_ZORDER: {
    value: 319,
    comment: 'Added ZOrder to a world tile description'
  },
  VER_UE4_PACKAGE_REQUIRES_LOCALIZATION_GATHER_FLAGGING: {
    value: 320,
    comment: 'Added flagging of localization gather requirement to packages'
  },
  VER_UE4_BP_ACTOR_VARIABLE_DEFAULT_PREVENTING: {
    value: 321,
    comment: 'Preventing Blueprint Actor variables from having default values'
  },
  VER_UE4_TEST_ANIMCOMP_CHANGE: {
    value: 322,
    comment: 'Preventing Blueprint Actor variables from having default values'
  },
  VER_UE4_EDITORONLY_BLUEPRINTS: {
    value: 323,
    comment: 'Class as primary asset, name convention changed'
  },
  VER_UE4_EDGRAPHPINTYPE_SERIALIZATION: {
    value: 324,
    comment: 'Custom serialization for FEdGraphPinType'
  },
  VER_UE4_NO_MIRROR_BRUSH_MODEL_COLLISION: {
    value: 325,
    comment: "Stop generating 'mirrored' cooked mesh for Brush and Model components"
  },
  VER_UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS: {
    value: 326,
    comment: 'Changed ChunkID to be an array of IDs.'
  },
  VER_UE4_WORLD_NAMED_AFTER_PACKAGE: {
    value: 327,
    comment:
      'Worlds have been renamed from "TheWorld" to be named after the package containing them'
  },
  VER_UE4_SKY_LIGHT_COMPONENT: { value: 328, comment: 'Added sky light component' },
  VER_UE4_WORLD_LAYER_ENABLE_DISTANCE_STREAMING: {
    value: 329,
    comment: 'Added Enable distance streaming flag to FWorldTileLayer'
  },
  VER_UE4_REMOVE_ZONES_FROM_MODEL: {
    value: 330,
    comment: 'Remove visibility/zone information from UModel'
  },
  VER_UE4_FIX_ANIMATIONBASEPOSE_SERIALIZATION: {
    value: 331,
    comment: 'Fix base pose serialization'
  },
  VER_UE4_SUPPORT_8_BONE_INFLUENCES_SKELETAL_MESHES: {
    value: 332,
    comment:
      'Support for up to 8 skinning influences per vertex on skeletal meshes (on non-gpu vertices)'
  },
  VER_UE4_ADD_OVERRIDE_GRAVITY_FLAG: {
    value: 333,
    comment: 'Add explicit bOverrideGravity to world settings'
  },
  VER_UE4_SUPPORT_GPUSKINNING_8_BONE_INFLUENCES: {
    value: 334,
    comment:
      'Support for up to 8 skinning influences per vertex on skeletal meshes (on gpu vertices)'
  },
  VER_UE4_ANIM_SUPPORT_NONUNIFORM_SCALE_ANIMATION: {
    value: 335,
    comment: 'Supporting nonuniform scale animation'
  },
  VER_UE4_ENGINE_VERSION_OBJECT: {
    value: 336,
    comment: 'Engine version is stored as a FEngineVersion object rather than changelist number'
  },
  VER_UE4_PUBLIC_WORLDS: { value: 337, comment: 'World assets now have RF_Public' },
  VER_UE4_SKELETON_GUID_SERIALIZATION: { value: 338, comment: 'Skeleton Guid' },
  VER_UE4_CHARACTER_MOVEMENT_WALKABLE_FLOOR_REFACTOR: {
    value: 339,
    comment: 'Character movement WalkableFloor refactor'
  },
  VER_UE4_INVERSE_SQUARED_LIGHTS_DEFAULT: {
    value: 340,
    comment: 'Lights default to inverse squared'
  },
  VER_UE4_DISABLED_SCRIPT_LIMIT_BYTECODE: {
    value: 341,
    comment: 'Disabled SCRIPT_LIMIT_BYTECODE_TO_64KB'
  },
  VER_UE4_PRIVATE_REMOTE_ROLE: {
    value: 342,
    comment: 'Made remote role private, exposed bReplicates'
  },
  VER_UE4_FOLIAGE_STATIC_MOBILITY: {
    value: 343,
    comment:
      'Fix up old foliage components to have static mobility (superseded by VER_UE4_FOLIAGE_MOVABLE_MOBILITY)'
  },
  VER_UE4_BUILD_SCALE_VECTOR: { value: 344, comment: 'Change BuildScale from a float to a vector' },
  VER_UE4_FOLIAGE_COLLISION: {
    value: 345,
    comment:
      'After implementing foliage collision, need to disable collision on old foliage instances'
  },
  VER_UE4_SKY_BENT_NORMAL: {
    value: 346,
    comment: 'Added sky bent normal to indirect lighting cache'
  },
  VER_UE4_LANDSCAPE_COLLISION_DATA_COOKING: {
    value: 347,
    comment: 'Added cooking for landscape collision data'
  },
  VER_UE4_MORPHTARGET_CPU_TANGENTZDELTA_FORMATCHANGE: {
    value: 348,
    comment: 'we still convert all to FVector in CPU time whenever any calculation'
  },
  VER_UE4_SOFT_CONSTRAINTS_USE_MASS: {
    value: 349,
    comment: 'Soft constraint limits will implicitly use the mass of the bodies'
  },
  VER_UE4_REFLECTION_DATA_IN_PACKAGES: {
    value: 350,
    comment: 'Reflection capture data saved in packages'
  },
  VER_UE4_FOLIAGE_MOVABLE_MOBILITY: {
    value: 351,
    comment:
      'Fix up old foliage components to have movable mobility (superseded by VER_UE4_FOLIAGE_STATIC_LIGHTING_SUPPORT)'
  },
  VER_UE4_UNDO_BREAK_MATERIALATTRIBUTES_CHANGE: {
    value: 352,
    comment: 'Undo BreakMaterialAttributes changes as it broke old content'
  },
  VER_UE4_ADD_CUSTOMPROFILENAME_CHANGE: {
    value: 353,
    comment:
      "Now Default custom profile name isn't NONE anymore due to copy/paste not working properly with it"
  },
  VER_UE4_FLIP_MATERIAL_COORDS: {
    value: 354,
    comment: 'Permanently flip and scale material expression coordinates'
  },
  VER_UE4_MEMBERREFERENCE_IN_PINTYPE: {
    value: 355,
    comment: 'PinSubCategoryMemberReference added to FEdGraphPinType'
  },
  VER_UE4_VEHICLES_UNIT_CHANGE: {
    value: 356,
    comment: 'Vehicles use Nm for Torque instead of cm and RPM instead of rad/s'
  },
  VER_UE4_ANIMATION_REMOVE_NANS: {
    value: 357,
    comment: 'now importing should detect NaNs, so we should not have NaNs in source data'
  },
  VER_UE4_SKELETON_ASSET_PROPERTY_TYPE_CHANGE: {
    value: 358,
    comment: 'Change skeleton preview attached assets property type'
  },
  VER_UE4_FIX_BLUEPRINT_VARIABLE_FLAGS: { value: 359, comment: "when they shouldn't" },
  VER_UE4_VEHICLES_UNIT_CHANGE2: {
    value: 360,
    comment:
      'Vehicles use Nm for Torque instead of cm and RPM instead of rad/s part two (missed conversion for some variables'
  },
  VER_UE4_UCLASS_SERIALIZE_INTERFACES_AFTER_LINKING: {
    value: 361,
    comment: 'Changed order of interface class serialization'
  },
  VER_UE4_STATIC_MESH_SCREEN_SIZE_LODS: {
    value: 362,
    comment: 'Change from LOD distances to display factors'
  },
  VER_UE4_FIX_MATERIAL_COORDS: {
    value: 363,
    comment: "Requires test of material coords to ensure they're saved correctly"
  },
  VER_UE4_SPEEDTREE_WIND_V7: { value: 364, comment: 'Changed SpeedTree wind presets to v7' },
  VER_UE4_LOAD_FOR_EDITOR_GAME: { value: 365, comment: 'NeedsLoadForEditorGame added' },
  VER_UE4_SERIALIZE_RICH_CURVE_KEY: {
    value: 366,
    comment: 'Manual serialization of FRichCurveKey to save space'
  },
  VER_UE4_MOVE_LANDSCAPE_MICS_AND_TEXTURES_WITHIN_LEVEL: {
    value: 367,
    comment:
      'Change the outer of ULandscapeMaterialInstanceConstants and Landscape-related textures to the level in which they reside'
  },
  VER_UE4_FTEXT_HISTORY: {
    value: 368,
    comment: 'FTexts have creation history data, removed Key, Namespaces, and SourceString'
  },
  VER_UE4_FIX_MATERIAL_COMMENTS: {
    value: 369,
    comment: 'Shift comments to the left to contain expressions properly'
  },
  VER_UE4_STORE_BONE_EXPORT_NAMES: {
    value: 370,
    comment:
      "Bone names stored as FName means that we can't guarantee the correct case on export, now we store a separate string for export purposes only"
  },
  VER_UE4_MESH_EMITTER_INITIAL_ORIENTATION_DISTRIBUTION: {
    value: 371,
    comment: 'changed mesh emitter initial orientation to distribution'
  },
  VER_UE4_DISALLOW_FOLIAGE_ON_BLUEPRINTS: {
    value: 372,
    comment: 'Foliage on blueprints causes crashes'
  },
  VER_UE4_FIXUP_MOTOR_UNITS: {
    value: 373,
    comment: 'change motors to use revolutions per second instead of rads/second'
  },
  VER_UE4_DEPRECATED_MOVEMENTCOMPONENT_MODIFIED_SPEEDS: {
    value: 374,
    comment: 'deprecated MovementComponent functions including "ModifiedMaxSpeed" et al'
  },
  VER_UE4_RENAME_CANBECHARACTERBASE: { value: 375, comment: 'rename CanBeCharacterBase' },
  VER_UE4_GAMEPLAY_TAG_CONTAINER_TAG_TYPE_CHANGE: {
    value: 376,
    comment:
      'Change GameplayTagContainers to have FGameplayTags instead of FNames; Required to fix-up native serialization'
  },
  VER_UE4_FOLIAGE_SETTINGS_TYPE: {
    value: 377,
    comment:
      'Change from UInstancedFoliageSettings to UFoliageType, and change the api from being keyed on UStaticMesh* to UFoliageType*'
  },
  VER_UE4_STATIC_SHADOW_DEPTH_MAPS: {
    value: 378,
    comment: 'Lights serialize static shadow depth maps'
  },
  VER_UE4_ADD_TRANSACTIONAL_TO_DATA_ASSETS: {
    value: 379,
    comment: 'Add RF_Transactional to data assets, fixing undo problems when editing them'
  },
  VER_UE4_ADD_LB_WEIGHTBLEND: {
    value: 380,
    comment: 'Change LB_AlphaBlend to LB_WeightBlend in ELandscapeLayerBlendType'
  },
  VER_UE4_ADD_ROOTCOMPONENT_TO_FOLIAGEACTOR: {
    value: 381,
    comment:
      'Add root component to an foliage actor, all foliage cluster components will be attached to a root'
  },
  VER_UE4_FIX_MATERIAL_PROPERTY_OVERRIDE_SERIALIZE: {
    value: 382,
    comment: "FMaterialInstanceBasePropertyOverrides didn't use proper UObject serialize"
  },
  VER_UE4_ADD_LINEAR_COLOR_SAMPLER: {
    value: 383,
    comment:
      'Addition of linear color sampler. color sample type is changed to linear sampler if source texture !sRGB'
  },
  VER_UE4_ADD_STRING_ASSET_REFERENCES_MAP: {
    value: 384,
    comment:
      'Added StringAssetReferencesMap to support renames of FStringAssetReference properties.'
  },
  VER_UE4_BLUEPRINT_USE_SCS_ROOTCOMPONENT_SCALE: {
    value: 385,
    comment:
      'Apply scale from SCS RootComponent details in the Blueprint Editor to new actor instances at construction time'
  },
  VER_UE4_LEVEL_STREAMING_DRAW_COLOR_TYPE_CHANGE: {
    value: 386,
    comment:
      "Changed level streaming to have a linear color since the visualization doesn't gamma correct."
  },
  VER_UE4_CLEAR_NOTIFY_TRIGGERS: {
    value: 387,
    comment: 'Cleared end triggers from non-state anim notifies'
  },
  VER_UE4_SKELETON_ADD_SMARTNAMES: {
    value: 388,
    comment: 'Convert old curve names stored in anim assets into skeleton smartnames'
  },
  VER_UE4_ADDED_CURRENCY_CODE_TO_FTEXT: {
    value: 389,
    comment: 'Added the currency code field to FTextHistory_AsCurrency'
  },
  VER_UE4_ENUM_CLASS_SUPPORT: { value: 390, comment: 'Added support for C++11 enum classes' },
  VER_UE4_FIXUP_WIDGET_ANIMATION_CLASS: { value: 391, comment: 'Fixup widget animation class' },
  VER_UE4_SOUND_COMPRESSION_TYPE_ADDED: {
    value: 392,
    comment: 'USoundWave objects now contain details about compression scheme used.'
  },
  VER_UE4_AUTO_WELDING: { value: 393, comment: 'Bodies will automatically weld when attached' },
  VER_UE4_RENAME_CROUCHMOVESCHARACTERDOWN: {
    value: 394,
    comment: 'Rename UCharacterMovementComponent::bCrouchMovesCharacterDown'
  },
  VER_UE4_LIGHTMAP_MESH_BUILD_SETTINGS: {
    value: 395,
    comment: 'Lightmap parameters in FMeshBuildSettings'
  },
  VER_UE4_RENAME_SM3_TO_ES3_1: {
    value: 396,
    comment: 'Rename SM3 to ES3_1 and updates featurelevel material node selector'
  },
  VER_UE4_DEPRECATE_UMG_STYLE_ASSETS: {
    value: 397,
    comment: 'Deprecated separate style assets for use in UMG'
  },
  VER_UE4_POST_DUPLICATE_NODE_GUID: {
    value: 398,
    comment: 'Duplicating Blueprints will regenerate NodeGuids after this version'
  },
  VER_UE4_RENAME_CAMERA_COMPONENT_VIEW_ROTATION: {
    value: 399,
    comment:
      'Rename UCameraComponent::bUseControllerViewRotation to bUsePawnViewRotation (and change the default value)'
  },
  VER_UE4_CASE_PRESERVING_FNAME: { value: 400, comment: 'Changed FName to be case preserving' },
  VER_UE4_RENAME_CAMERA_COMPONENT_CONTROL_ROTATION: {
    value: 401,
    comment: 'Rename UCameraComponent::bUsePawnViewRotation to bUsePawnControlRotation'
  },
  VER_UE4_FIX_REFRACTION_INPUT_MASKING: {
    value: 402,
    comment: 'Fix bad refraction material attribute masks'
  },
  VER_UE4_GLOBAL_EMITTER_SPAWN_RATE_SCALE: {
    value: 403,
    comment: 'A global spawn rate for emitters.'
  },
  VER_UE4_CLEAN_DESTRUCTIBLE_SETTINGS: {
    value: 404,
    comment: 'Cleanup destructible mesh settings'
  },
  VER_UE4_CHARACTER_MOVEMENT_UPPER_IMPACT_BEHAVIOR: {
    value: 405,
    comment:
      'CharacterMovementComponent refactor of AdjustUpperHemisphereImpact and deprecation of some associated vars.'
  },
  VER_UE4_BP_MATH_VECTOR_EQUALITY_USES_EPSILON: {
    value: 406,
    comment:
      'Changed Blueprint math equality functions for vectors and rotators to operate as a "nearly" equals rather than "exact"'
  },
  VER_UE4_FOLIAGE_STATIC_LIGHTING_SUPPORT: {
    value: 407,
    comment: 'Static lighting support was re-added to foliage, and mobility was returned to static'
  },
  VER_UE4_SLATE_COMPOSITE_FONTS: {
    value: 408,
    comment: 'Added composite fonts to Slate font info'
  },
  VER_UE4_REMOVE_SAVEGAMESUMMARY: {
    value: 409,
    comment: 'Remove UDEPRECATED_SaveGameSummary, required for UWorld::Serialize'
  },
  VER_UE4_REMOVE_SKELETALMESH_COMPONENT_BODYSETUP_SERIALIZATION: {
    value: 410,
    comment: 'emove bodyseutp serialization from skeletal mesh component'
  },
  VER_UE4_SLATE_BULK_FONT_DATA: {
    value: 411,
    comment: 'Made Slate font data use bulk data to store the embedded font data'
  },
  VER_UE4_ADD_PROJECTILE_FRICTION_BEHAVIOR: {
    value: 412,
    comment: 'Add new friction behavior in ProjectileMovementComponent.'
  },
  VER_UE4_MOVEMENTCOMPONENT_AXIS_SETTINGS: {
    value: 413,
    comment: 'Add axis settings enum to MovementComponent.'
  },
  VER_UE4_GRAPH_INTERACTIVE_COMMENTBUBBLES: {
    value: 414,
    comment:
      'Switch to new interactive comments, requires boundry conversion to preserve previous states'
  },
  VER_UE4_LANDSCAPE_SERIALIZE_PHYSICS_MATERIALS: {
    value: 415,
    comment: 'Landscape serializes physical materials for collision objects'
  },
  VER_UE4_RENAME_WIDGET_VISIBILITY: {
    value: 416,
    comment: 'Rename Visiblity on widgets to Visibility'
  },
  VER_UE4_ANIMATION_ADD_TRACKCURVES: { value: 417, comment: 'add track curves for animation' },
  VER_UE4_MONTAGE_BRANCHING_POINT_REMOVAL: {
    value: 418,
    comment: 'Removed BranchingPoints from AnimMontages and converted them to regular AnimNotifies.'
  },
  VER_UE4_BLUEPRINT_ENFORCE_CONST_IN_FUNCTION_OVERRIDES: {
    value: 419,
    comment:
      'Enforce const-correctness in Blueprint implementations of native C++ const class methods'
  },
  VER_UE4_ADD_PIVOT_TO_WIDGET_COMPONENT: {
    value: 420,
    comment:
      'Added pivot to widget components, need to load old versions as a 0,0 pivot, new default is 0.5,0.5'
  },
  VER_UE4_PAWN_AUTO_POSSESS_AI: {
    value: 421,
    comment:
      'Added finer control over when AI Pawns are automatically possessed. Also renamed Pawn.AutoPossess to Pawn.AutoPossessPlayer indicate this was a setting for players and not AI.'
  },
  VER_UE4_FTEXT_HISTORY_DATE_TIMEZONE: {
    value: 422,
    comment: 'Added serialization of timezone to FTextHistory for AsDate operations.'
  },
  VER_UE4_SORT_ACTIVE_BONE_INDICES: {
    value: 423,
    comment: 'Sort ActiveBoneIndices on lods so that we can avoid doing it at run time'
  },
  VER_UE4_PERFRAME_MATERIAL_UNIFORM_EXPRESSIONS: {
    value: 424,
    comment: 'Added per-frame material uniform expressions'
  },
  VER_UE4_MIKKTSPACE_IS_DEFAULT: {
    value: 425,
    comment: 'Make MikkTSpace the default tangent space calculation method for static meshes.'
  },
  VER_UE4_LANDSCAPE_GRASS_COOKING: {
    value: 426,
    comment: 'Only applies to cooked files, grass cooking support.'
  },
  VER_UE4_FIX_SKEL_VERT_ORIENT_MESH_PARTICLES: {
    value: 427,
    comment: 'Fixed code for using the bOrientMeshEmitters property.'
  },
  VER_UE4_LANDSCAPE_STATIC_SECTION_OFFSET: {
    value: 428,
    comment: 'Do not change landscape section offset on load under world composition'
  },
  VER_UE4_ADD_MODIFIERS_RUNTIME_GENERATION: {
    value: 429,
    comment: 'New options for navigation data runtime generation (static, modifiers only, dynamic)'
  },
  VER_UE4_MATERIAL_MASKED_BLENDMODE_TIDY: {
    value: 430,
    comment: "Tidied up material's handling of masked blend mode."
  },
  VER_UE4_MERGED_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7_DEPRECATED: {
    value: 431,
    comment:
      'Original version of VER_UE4_MERGED_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7; renumbered to prevent blocking promotion in main.'
  },
  VER_UE4_AFTER_MERGED_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7_DEPRECATED: {
    value: 432,
    comment:
      'Original version of VER_UE4_AFTER_MERGED_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7; renumbered to prevent blocking promotion in main.'
  },
  VER_UE4_MERGED_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7: {
    value: 433,
    comment: 'After merging VER_UE4_ADD_MODIFIERS_RUNTIME_GENERATION into 4.7 branch'
  },
  VER_UE4_AFTER_MERGING_ADD_MODIFIERS_RUNTIME_GENERATION_TO_4_7: {
    value: 434,
    comment: 'After merging VER_UE4_ADD_MODIFIERS_RUNTIME_GENERATION into 4.7 branch'
  },
  VER_UE4_SERIALIZE_LANDSCAPE_GRASS_DATA: {
    value: 435,
    comment: 'Landscape grass weightmap data is now generated in the editor and serialized.'
  },
  VER_UE4_OPTIONALLY_CLEAR_GPU_EMITTERS_ON_INIT: {
    value: 436,
    comment:
      'New property to optionally prevent gpu emitters clearing existing particles on Init().'
  },
  VER_UE4_SERIALIZE_LANDSCAPE_GRASS_DATA_MATERIAL_GUID: {
    value: 437,
    comment: 'Also store the Material guid with the landscape grass data'
  },
  VER_UE4_BLUEPRINT_GENERATED_CLASS_COMPONENT_TEMPLATES_PUBLIC: {
    value: 438,
    comment:
      'Make sure that all template components from blueprint generated classes are flagged as public'
  },
  VER_UE4_ACTOR_COMPONENT_CREATION_METHOD: {
    value: 439,
    comment:
      'Split out creation method on ActorComponents to distinguish between native, instance, and simple or user construction script'
  },
  VER_UE4_K2NODE_EVENT_MEMBER_REFERENCE: {
    value: 440,
    comment: 'K2Node_Event now uses FMemberReference for handling references'
  },
  VER_UE4_STRUCT_GUID_IN_PROPERTY_TAG: {
    value: 441,
    comment: 'FPropertyTag stores GUID of struct'
  },
  VER_UE4_REMOVE_UNUSED_UPOLYS_FROM_UMODEL: {
    value: 442,
    comment: 'Remove unused UPolys from UModel cooked content'
  },
  VER_UE4_REBUILD_HIERARCHICAL_INSTANCE_TREES: {
    value: 443,
    comment:
      'This doesn\'t do anything except trigger a rebuild on HISMC cluster trees, in this case to get a good "occlusion query" level'
  },
  VER_UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION: {
    value: 444,
    comment:
      "Package summary includes an CompatibleWithEngineVersion field, separately to the version it's saved with"
  },
  VER_UE4_TRACK_UCS_MODIFIED_PROPERTIES: {
    value: 445,
    comment: 'Track UCS modified properties on Actor Components'
  },
  VER_UE4_LANDSCAPE_SPLINE_CROSS_LEVEL_MESHES: {
    value: 446,
    comment:
      "Allowed landscape spline meshes to be stored into landscape streaming levels rather than the spline's level"
  },
  VER_UE4_DEPRECATE_USER_WIDGET_DESIGN_SIZE: {
    value: 447,
    comment: 'Deprecate the variables used for sizing in the designer on UUserWidget'
  },
  VER_UE4_ADD_EDITOR_VIEWS: {
    value: 448,
    comment: 'Make the editor views array dynamically sized'
  },
  VER_UE4_FOLIAGE_WITH_ASSET_OR_CLASS: {
    value: 449,
    comment: 'Updated foliage to work with either FoliageType assets or blueprint classes'
  },
  VER_UE4_BODYINSTANCE_BINARY_SERIALIZATION: {
    value: 450,
    comment: 'Allows PhysicsSerializer to serialize shapes and actors for faster load times'
  },
  VER_UE4_SERIALIZE_BLUEPRINT_EVENTGRAPH_FASTCALLS_IN_UFUNCTION: {
    value: 451,
    comment: 'Added fastcall data serialization directly in UFunction'
  },
  VER_UE4_INTERPCURVE_SUPPORTS_LOOPING: {
    value: 452,
    comment: 'Changes to USplineComponent and FInterpCurve'
  },
  VER_UE4_MATERIAL_INSTANCE_BASE_PROPERTY_OVERRIDES_DITHERED_LOD_TRANSITION: {
    value: 453,
    comment: 'Material Instances overriding base material LOD transitions'
  },
  VER_UE4_SERIALIZE_LANDSCAPE_ES2_TEXTURES: {
    value: 454,
    comment:
      'Serialize ES2 textures separately rather than overwriting the properties used on other platforms'
  },
  VER_UE4_CONSTRAINT_INSTANCE_MOTOR_FLAGS: {
    value: 455,
    comment: 'Constraint motor velocity is broken into per-component'
  },
  VER_UE4_SERIALIZE_PINTYPE_CONST: { value: 456, comment: 'Serialize bIsConst in FEdGraphPinType' },
  VER_UE4_LIBRARY_CATEGORIES_AS_FTEXT: {
    value: 457,
    comment:
      'Change UMaterialFunction::LibraryCategories to LibraryCategoriesText (old assets were saved before auto-conversion of FArrayProperty was possible)'
  },
  VER_UE4_SKIP_DUPLICATE_EXPORTS_ON_SAVE_PACKAGE: {
    value: 458,
    comment: 'Check for duplicate exports while saving packages.'
  },
  VER_UE4_SERIALIZE_TEXT_IN_PACKAGES: {
    value: 459,
    comment:
      'Pre-gathering of gatherable, localizable text in packages to optimize text gathering operation times'
  },
  VER_UE4_ADD_BLEND_MODE_TO_WIDGET_COMPONENT: {
    value: 460,
    comment:
      'Added pivot to widget components, need to load old versions as a 0,0 pivot, new default is 0.5,0.5'
  },
  VER_UE4_NEW_LIGHTMASS_PRIMITIVE_SETTING: {
    value: 461,
    comment: 'Added lightmass primitive setting'
  },
  VER_UE4_REPLACE_SPRING_NOZ_PROPERTY: {
    value: 462,
    comment: 'Deprecate NoZSpring property on spring nodes to be replaced with TranslateZ property'
  },
  VER_UE4_TIGHTLY_PACKED_ENUMS: {
    value: 463,
    comment:
      "Keep enums tight and serialize their values as pairs of FName and value. Don't insert dummy values."
  },
  VER_UE4_ASSET_IMPORT_DATA_AS_JSON: {
    value: 464,
    comment: 'Changed Asset import data to serialize file meta data as JSON'
  },
  VER_UE4_TEXTURE_LEGACY_GAMMA: { value: 465, comment: 'Legacy gamma support for textures.' },
  VER_UE4_ADDED_NATIVE_SERIALIZATION_FOR_IMMUTABLE_STRUCTURES: {
    value: 466,
    comment:
      'Added WithSerializer for basic native structures like FVector, FColor etc to improve serialization performance'
  },
  VER_UE4_DEPRECATE_UMG_STYLE_OVERRIDES: {
    value: 467,
    comment: 'Deprecated attributes that override the style on UMG widgets'
  },
  VER_UE4_STATIC_SHADOWMAP_PENUMBRA_SIZE: { value: 468, comment: 'Shadowmap penumbra size stored' },
  VER_UE4_NIAGARA_DATA_OBJECT_DEV_UI_FIX: {
    value: 469,
    comment: 'Fix BC on Niagara effects from the data object and dev UI changes.'
  },
  VER_UE4_FIXED_DEFAULT_ORIENTATION_OF_WIDGET_COMPONENT: {
    value: 470,
    comment: 'Fixed the default orientation of widget component so it faces down +x'
  },
  VER_UE4_REMOVED_MATERIAL_USED_WITH_UI_FLAG: {
    value: 471,
    comment:
      'Removed bUsedWithUI flag from UMaterial and replaced it with a new material domain for UI'
  },
  VER_UE4_CHARACTER_MOVEMENT_ADD_BRAKING_FRICTION: {
    value: 472,
    comment: 'Added braking friction separate from turning friction.'
  },
  VER_UE4_BSP_UNDO_FIX: { value: 473, comment: 'Removed TTransArrays from UModel' },
  VER_UE4_DYNAMIC_PARAMETER_DEFAULT_VALUE: {
    value: 474,
    comment: 'Added default value to dynamic parameter.'
  },
  VER_UE4_STATIC_MESH_EXTENDED_BOUNDS: {
    value: 475,
    comment: 'Added ExtendedBounds to StaticMesh'
  },
  VER_UE4_ADDED_NON_LINEAR_TRANSITION_BLENDS: {
    value: 476,
    comment: 'Added non-linear blending to anim transitions, deprecating old types'
  },
  VER_UE4_AO_MATERIAL_MASK: { value: 477, comment: 'AO Material Mask texture' },
  VER_UE4_NAVIGATION_AGENT_SELECTOR: {
    value: 478,
    comment: 'Replaced navigation agents selection with single structure'
  },
  VER_UE4_MESH_PARTICLE_COLLISIONS_CONSIDER_PARTICLE_SIZE: {
    value: 479,
    comment: 'Mesh particle collisions consider particle size.'
  },
  VER_UE4_BUILD_MESH_ADJ_BUFFER_FLAG_EXPOSED: {
    value: 480,
    comment:
      'Adjacency buffer building no longer automatically handled based on triangle count, user-controlled'
  },
  VER_UE4_MAX_ANGULAR_VELOCITY_DEFAULT: {
    value: 481,
    comment: 'Change the default max angular velocity'
  },
  VER_UE4_APEX_CLOTH_TESSELLATION: {
    value: 482,
    comment: 'Build Adjacency index buffer for clothing tessellation'
  },
  VER_UE4_DECAL_SIZE: {
    value: 483,
    comment: 'Added DecalSize member, solved backward compatibility'
  },
  VER_UE4_KEEP_ONLY_PACKAGE_NAMES_IN_STRING_ASSET_REFERENCES_MAP: {
    value: 484,
    comment: 'Keep only package names in StringAssetReferencesMap'
  },
  VER_UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT: {
    value: 485,
    comment: 'Support sound cue not saving out editor only data'
  },
  VER_UE4_DIALOGUE_WAVE_NAMESPACE_AND_CONTEXT_CHANGES: {
    value: 486,
    comment: 'Updated dialogue wave localization gathering logic.'
  },
  VER_UE4_MAKE_ROT_RENAME_AND_REORDER: {
    value: 487,
    comment: 'Renamed MakeRot MakeRotator and rearranged parameters.'
  },
  VER_UE4_K2NODE_VAR_REFERENCEGUIDS: {
    value: 488,
    comment: 'K2Node_Variable will properly have the VariableReference Guid set if available'
  },
  VER_UE4_SOUND_CONCURRENCY_PACKAGE: {
    value: 489,
    comment: 'Added support for sound concurrency settings structure and overrides'
  },
  VER_UE4_USERWIDGET_DEFAULT_FOCUSABLE_FALSE: {
    value: 490,
    comment: 'Changing the default value for focusable user widgets to false'
  },
  VER_UE4_BLUEPRINT_CUSTOM_EVENT_CONST_INPUT: {
    value: 491,
    comment:
      "Custom event nodes implicitly set 'const' on array and non-array pass-by-reference input params"
  },
  VER_UE4_USE_LOW_PASS_FILTER_FREQ: {
    value: 492,
    comment: 'Renamed HighFrequencyGain to LowPassFilterFrequency'
  },
  VER_UE4_NO_ANIM_BP_CLASS_IN_GAMEPLAY_CODE: {
    value: 493,
    comment:
      'UAnimBlueprintGeneratedClass can be replaced by a dynamic class. Use TSubclassOf<UAnimInstance> instead.'
  },
  VER_UE4_SCS_STORES_ALLNODES_ARRAY: {
    value: 494,
    comment:
      'The SCS keeps a list of all nodes in its hierarchy rather than recursively building it each time it is requested'
  },
  VER_UE4_FBX_IMPORT_DATA_RANGE_ENCAPSULATION: {
    value: 495,
    comment: 'Moved StartRange and EndRange in UFbxAnimSequenceImportData to use FInt32Interval'
  },
  VER_UE4_CAMERA_COMPONENT_ATTACH_TO_ROOT: {
    value: 496,
    comment: 'Adding a new root scene component to camera component'
  },
  VER_UE4_INSTANCED_STEREO_UNIFORM_UPDATE: {
    value: 497,
    comment: 'Updating custom material expression nodes for instanced stereo implementation'
  },
  VER_UE4_STREAMABLE_TEXTURE_MIN_MAX_DISTANCE: {
    value: 498,
    comment: 'Texture streaming min and max distance to handle HLOD'
  },
  VER_UE4_INJECT_BLUEPRINT_STRUCT_PIN_CONVERSION_NODES: {
    value: 499,
    comment:
      'Fixing up invalid struct-to-struct pin connections by injecting available conversion nodes'
  },
  VER_UE4_INNER_ARRAY_TAG_INFO: {
    value: 500,
    comment: "Saving tag data for Array Property's inner property"
  },
  VER_UE4_FIX_SLOT_NAME_DUPLICATION: {
    value: 501,
    comment: 'Fixed duplicating slot node names in skeleton due to skeleton preload on compile'
  },
  VER_UE4_STREAMABLE_TEXTURE_AABB: {
    value: 502,
    comment: 'Texture streaming using AABBs instead of Spheres'
  },
  VER_UE4_PROPERTY_GUID_IN_PROPERTY_TAG: {
    value: 503,
    comment: 'FPropertyTag stores GUID of property'
  },
  VER_UE4_NAME_HASHES_SERIALIZED: {
    value: 504,
    comment: 'Name table hashes are calculated and saved out rather than at load time'
  },
  VER_UE4_INSTANCED_STEREO_UNIFORM_REFACTOR: {
    value: 505,
    comment:
      'Updating custom material expression nodes for instanced stereo implementation refactor'
  },
  VER_UE4_COMPRESSED_SHADER_RESOURCES: {
    value: 506,
    comment: 'Added compression to the shader resource for memory savings'
  },
  VER_UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS: {
    value: 507,
    comment:
      'Cooked files contain the dependency graph for the event driven loader (the serialization is largely independent of the use of the new loader)'
  },
  VER_UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS: {
    value: 508,
    comment:
      'Cooked files contain the TemplateIndex used by the event driven loader (the serialization is largely independent of the use of the new loader, i.e. this will be null if cooking for the old loader)'
  },
  VER_UE4_PROPERTY_TAG_SET_MAP_SUPPORT: {
    value: 509,
    comment: 'FPropertyTag includes contained type(s) for Set and Map properties:'
  },
  VER_UE4_ADDED_SEARCHABLE_NAMES: {
    value: 510,
    comment: 'Added SearchableNames to the package summary and asset registry'
  },
  VER_UE4_64BIT_EXPORTMAP_SERIALSIZES: {
    value: 511,
    comment:
      'Increased size of SerialSize and SerialOffset in export map entries to 64 bit, allow support for bigger files'
  },
  VER_UE4_SKYLIGHT_MOBILE_IRRADIANCE_MAP: {
    value: 512,
    comment: 'Sky light stores IrradianceMap for mobile renderer.'
  },
  VER_UE4_ADDED_SWEEP_WHILE_WALKING_FLAG: {
    value: 513,
    comment: 'Added flag to control sweep behavior while walking in UCharacterMovementComponent.'
  },
  VER_UE4_ADDED_SOFT_OBJECT_PATH: {
    value: 514,
    comment:
      'StringAssetReference changed to SoftObjectPath and swapped to serialize as a name+string instead of a string'
  },
  VER_UE4_POINTLIGHT_SOURCE_ORIENTATION: {
    value: 515,
    comment: 'Changed the source orientation of point lights to match spot lights (z axis)'
  },
  VER_UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID: {
    value: 516,
    comment: 'LocalizationId has been added to the package summary (editor-only)'
  },
  VER_UE4_FIX_WIDE_STRING_CRC: {
    value: 517,
    comment:
      'Fixed case insensitive hashes of wide strings containing character values from 128-255'
  },
  VER_UE4_ADDED_PACKAGE_OWNER: {
    value: 518,
    comment: 'Added package owner to allow private references'
  },
  VER_UE4_SKINWEIGHT_PROFILE_DATA_LAYOUT_CHANGES: {
    value: 519,
    comment: 'Changed the data layout for skin weight profile data'
  },
  VER_UE4_NON_OUTER_PACKAGE_IMPORT: {
    value: 520,
    comment: 'Added import that can have package different than their outer'
  },
  VER_UE4_ASSETREGISTRY_DEPENDENCYFLAGS: {
    value: 521,
    comment: 'Added DependencyFlags to AssetRegistry'
  },
  VER_UE4_CORRECT_LICENSEE_FLAG: {
    value: 522,
    comment: 'Fixed corrupt licensee flag in 4.26 assets'
  },
  VER_UE4_AUTOMATIC_VERSION_PLUS_ONE: { value: 523, comment: 'Last version +1' },
  VER_UE4_AUTOMATIC_VERSION: { value: 522, comment: 'Fixed corrupt licensee flag in 4.26 assets' }
}

// https://github.com/EpicGames/UnrealEngine/blob/release/Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h#L39
var EUnrealEngineObjectUE5Version = {
  VER_UE5_INITIAL_VERSION: {
    value: 1000,
    comment:
      'The original UE5 version, at the time this was added the UE4 version was 522, so UE5 will start from 1000 to show a clear difference'
  },
  VER_UE5_NAMES_REFERENCED_FROM_EXPORT_DATA: {
    value: 1001,
    comment: 'Support stripping names that are not referenced from export data'
  },
  VER_UE5_PAYLOAD_TOC: {
    value: 1002,
    comment: 'Added a payload table of contents to the package summary'
  },
  VER_UE5_OPTIONAL_RESOURCES: {
    value: 1003,
    comment: 'Added data to identify references from and to optional package'
  },
  VER_UE5_LARGE_WORLD_COORDINATES: {
    value: 1004,
    comment:
      'Large world coordinates converts a number of core types to double components by default.'
  },
  VER_UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID: {
    value: 1005,
    comment: 'Remove package GUID from FObjectExport'
  },
  VER_UE5_TRACK_OBJECT_EXPORT_IS_INHERITED: {
    value: 1006,
    comment: 'Add IsInherited to the FObjectExport entry'
  },
  VER_UE5_FSOFTOBJECTPATH_REMOVE_ASSET_PATH_FNAMES: {
    value: 1007,
    comment:
      'Replace FName asset path in FSoftObjectPath with (package name, asset name) pair FTopLevelAssetPath'
  },
  VER_UE5_ADD_SOFTOBJECTPATH_LIST: {
    value: 1008,
    comment: 'Add a soft object path list to the package summary for fast remap'
  },
  VER_UE5_DATA_RESOURCES: { value: 1009, comment: 'Added bulk/data resource table' },
  VER_UE5_SCRIPT_SERIALIZATION_OFFSET: {
    value: 1010,
    comment:
      'Added script property serialization offset to export table entries for saved, versioned packages'
  },
  VER_UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION: {
    value: 1011,
    comment:
      'Adding property tag extension, Support for overridable serialization on UObject, Support for overridable logic in containers'
  },
  VER_UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME: {
    value: 1012,
    comment: 'Added property tag complete type name and serialization type'
  },
  VER_UE5_ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES: {
    value: 1013,
    comment: 'Changed UE::AssetRegistry::WritePackageData to include PackageBuildDependencies'
  },
  VER_UE5_METADATA_SERIALIZATION_OFFSET: {
    value: 1014,
    comment: 'Added meta data serialization offset to for saved, versioned packages'
  },
  VER_UE5_VERSE_CELLS: { value: 1015, comment: 'Added VCells to the object graph' },
  VER_UE5_PACKAGE_SAVED_HASH: {
    value: 1016,
    comment: 'Changed PackageFileSummary to write FIoHash PackageSavedHash instead of FGuid Guid'
  },
  VER_UE5_OS_SUB_OBJECT_SHADOW_SERIALIZATION: {
    value: 1017,
    comment: 'OS shadow serialization of subobjects'
  },
  VER_UE5_IMPORT_TYPE_HIERARCHIES: {
    value: 1018,
    comment: 'Adds a table of hierarchical type information for imports in a package'
  },
  VER_UE5_AUTOMATIC_VERSION_PLUS_ONE: { value: 1019, comment: 'Last version +1' },
  VER_UE5_AUTOMATIC_VERSION: { value: 1018, comment: 'AUTOMATIC_VERSION_PLUS_ONE - 1' }
}

// https://github.com/EpicGames/UnrealEngine/blob/release/Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectMacros.h#L116
var PackageFlags = {
  PKG_None: { value: 0x00000000, comment: 'No flags' },
  PKG_NewlyCreated: {
    value: 0x00000001,
    comment: 'Newly created package, not saved yet. In editor only.'
  },
  PKG_ClientOptional: { value: 0x00000002, comment: 'Purely optional for clients.' },
  PKG_ServerSideOnly: { value: 0x00000004, comment: 'Only needed on the server side.' },
  PKG_CompiledIn: { value: 0x00000010, comment: 'This package is from "compiled in" classes.' },
  PKG_ForDiffing: {
    value: 0x00000020,
    comment: 'This package was loaded just for the purposes of diffing'
  },
  PKG_EditorOnly: {
    value: 0x00000040,
    comment: 'This is editor-only package (for example: editor module script package)'
  },
  PKG_Developer: { value: 0x00000080, comment: 'Developer module' },
  PKG_UncookedOnly: {
    value: 0x00000100,
    comment: 'Loaded only in uncooked builds (i.e. runtime in editor)'
  },
  PKG_Cooked: { value: 0x00000200, comment: 'Package is cooked' },
  PKG_ContainsNoAsset: {
    value: 0x00000400,
    comment: "Package doesn't contain any asset object (although asset tags can be present)"
  },
  PKG_NotExternallyReferenceable: {
    value: 0x00000800,
    comment:
      'Objects in this package cannot be referenced in a different plugin or mount point (i.e /Game -> /Engine)'
  },
  PKG_Unused_1000: { value: 0x00001000, comment: 'Unused' },
  PKG_UnversionedProperties: {
    value: 0x00002000,
    comment:
      'Uses unversioned property serialization instead of versioned tagged property serialization'
  },
  PKG_ContainsMapData: {
    value: 0x00004000,
    comment:
      'Contains map data (UObjects only referenced by a single ULevel) but is stored in a different package'
  },
  PKG_IsSaving: {
    value: 0x00008000,
    comment: 'Temporarily set on a package while it is being saved.'
  },
  PKG_Compiling: { value: 0x00010000, comment: 'package is currently being compiled' },
  PKG_ContainsMap: {
    value: 0x00020000,
    comment: 'Set if the package contains a ULevel/ UWorld object'
  },
  PKG_RequiresLocalizationGather: {
    value: 0x00040000,
    comment: 'Set if the package contains any data to be gathered by localization'
  },
  PKG_Unused_80000: { value: 0x00080000, comment: 'Unused' },
  PKG_PlayInEditor: {
    value: 0x00100000,
    comment: 'Set if the package was created for the purpose of PIE'
  },
  PKG_ContainsScript: {
    value: 0x00200000,
    comment: 'Package is allowed to contain UClass objects'
  },
  PKG_DisallowExport: {
    value: 0x00400000,
    comment: 'Editor should not export asset in this package'
  },
  PKG_Unused_800000: { value: 0x00800000, comment: 'Unused' },
  PKG_Unused_1000000: { value: 0x01000000, comment: 'Unused' },
  PKG_Unused_2000000: { value: 0x02000000, comment: 'Unused' },
  PKG_Unused_4000000: { value: 0x04000000, comment: 'Unused' },
  PKG_CookGenerated: {
    value: 0x08000000,
    comment: 'This package was generated by the cooker and does not exist in the WorkspaceDomain'
  },
  PKG_DynamicImports: {
    value: 0x10000000,
    comment: 'This package should resolve dynamic imports from its export at runtime.'
  },
  PKG_RuntimeGenerated: {
    value: 0x20000000,
    comment:
      'This package contains elements that are runtime generated, and may not follow standard loading order rules'
  },
  PKG_ReloadingForCooker: {
    value: 0x40000000,
    comment:
      "This package is reloading in the cooker, try to avoid getting data we will never need. We won't save this package."
  },
  PKG_FilterEditorOnly: { value: 0x80000000, comment: 'Package has editor-only data filtered out' },
  PKG_TransientFlags: {
    value: 0x00000001 | 0x00008000 | 0x40000000,
    comment: 'Transient Flags are cleared when serializing to or from PackageFileSummary'
  }
}
/* eslint-enable */

/* global EPackageFileTag, EUnrealEngineObjectUE4Version, EUnrealEngineObjectUE5Version, GatherableTextData, SourceSiteContexts, Uasset */
/**
 * Main public entry point.
 *
 * @class ReaderUasset
 */
function ReaderUasset() {
  this.currentIdx = 0
  this.bytes = []

  /*
   * Scratch buffer for scalar reads. Every int/uint used to allocate a plain array,
   * a Uint8Array and a DataView per call; on a large asset pack that allocation churn
   * (and the GC behind it) dominated the parse. One 8 byte buffer per reader is enough
   * because a scalar is fully consumed before the next read starts.
   */
  /** @type {Uint8Array} */
  this.scalarBytes = new Uint8Array(8)
  /** @type {DataView} */
  this.scalarView = new DataView(this.scalarBytes.buffer)

  /** @type {Uasset} */
  this.uasset = {
    hexView: [],
    header: {},
    names: [],
    gatherableTextData: [],
    imports: {},
    exports: [],
    depends: {},
    softPackageReferences: {},
    searchableNames: {},
    thumbnails: { Index: [], Thumbnails: [] },
    assetRegistryData: {},
    preloadDependency: {},
    bulkDataStart: {}
  }
}

// region helpers
/**
 * Read 2 bytes, save in hex view and return value as uint16 en littleEndian.
 *
 * @function ReaderUasset#uint16
 * @param {string} key - name of what we read
 * @returns {number}
 * @private
 */
ReaderUasset.prototype.uint16 = function uint16(key) {
  /** @type {number} */
  var val

  val = this.readScalarView(2).getUint16(0, this.useLittleEndian)

  this.addHexView(key, 'uint16', val, this.currentIdx - 2, this.currentIdx - 1)

  return val
}

/**
 * Read 4 bytes, save in hex view and return value as int32 en littleEndian.
 *
 * @function ReaderUasset#int32
 * @param {string} key - name of what we read
 * @returns {number}
 * @private
 */
ReaderUasset.prototype.int32 = function int32(key) {
  /** @type {number} */
  var val

  val = this.readScalarView(4).getInt32(0, this.useLittleEndian)

  this.addHexView(key, 'int32', val, this.currentIdx - 4, this.currentIdx - 1)

  return val
}

/**
 * Read 1 byte, save in hex view and return value as boolean (0=false, non-zero=true).
 *
 * @function ReaderUasset#fbool
 * @param {string} key - name of what we read
 * @returns {number} 0 or 1
 * @private
 */
ReaderUasset.prototype.fbool = function fbool(key) {
  /** @type {number} */
  var val
  /** @type {number[]} */
  var bytes = this.readCountBytes(1)

  val = bytes[0] !== 0 ? 1 : 0

  this.addHexView(key, 'bool', val, this.currentIdx - 1, this.currentIdx - 1)

  return val
}

/**
 * Read 4 bytes, save in hex view and return value as uint32 en littleEndian.
 *
 * @function ReaderUasset#uint32
 * @param {string} key - name of what we read
 * @returns {number}
 * @private
 */
ReaderUasset.prototype.uint32 = function uint32(key) {
  /** @type {number} */
  var val

  val = this.readScalarView(4).getUint32(0, this.useLittleEndian)

  this.addHexView(key, 'uint32', val, this.currentIdx - 4, this.currentIdx - 1)

  return val
}

/**
 * Read 8 bytes, save in hex view and return value as int64 en littleEndian.
 *
 * @function ReaderUasset#int64
 * @param {string} key - name of what we read
 * @returns {number}
 * @private
 */
ReaderUasset.prototype.int64 = function int64(key) {
  /** @type {bigint} */
  var val

  val = this.readScalarView(8).getBigInt64(0, this.useLittleEndian)

  this.addHexView(key, 'int64', val, this.currentIdx - 8, this.currentIdx - 1)

  return val
}

/**
 * Read 8 bytes, save in hex view and return value as uint64 en littleEndian.
 *
 * @function ReaderUasset#uint64
 * @param {string} key - name of what we read
 * @returns {number}
 * @private
 */
ReaderUasset.prototype.uint64 = function uint64(key) {
  /** @type {bigint} */
  var val

  val = this.readScalarView(8).getBigUint64(0, this.useLittleEndian)

  this.addHexView(key, 'uint64', val, this.currentIdx - 8, this.currentIdx - 1)

  return val
}

/**
 * Read 16 bytes, save in hex view and return value as string.
 *
 * @function ReaderUasset#fguidSlot
 * @param {string} key - name of what we read
 * @returns {string}
 * @private
 */
ReaderUasset.prototype.fguidSlot = function fguidSlot(key) {
  /** @type {string} */
  var val
  /** @type {string} */
  var str1 = ''
  /** @type {string} */
  var str2 = ''
  /** @type {string} */
  var str3 = ''
  /** @type {string} */
  var str4 = ''
  /** @type {number} */
  var idx = 3
  /** @type {number[]} */
  var bytes = this.readCountBytes(16)

  for (; idx >= 0; --idx) {
    str1 = str1 + bytes[idx].toString(16).padStart(2, '0')
    str2 = str2 + bytes[idx + 4].toString(16).padStart(2, '0')
    str3 = str3 + bytes[idx + 8].toString(16).padStart(2, '0')
    str4 = str4 + bytes[idx + 12].toString(16).padStart(2, '0')
  }

  val = (str1 + str2 + str3 + str4).toUpperCase()

  this.addHexView(key, 'fguidSlot', val, this.currentIdx - 16, this.currentIdx - 1)

  return val
}

/**
 * Read 16 bytes, save in hex view and return value as string.
 *
 * @function ReaderUasset#fguidString
 * @param {string} key - name of what we read
 * @returns {string}
 * @private
 */
ReaderUasset.prototype.fguidString = function fguidString(key) {
  /** @type {string} */
  var val
  /** @type {string} */
  var str = ''
  /** @type {number} */
  var idx = 0
  /** @type {number[]} */
  var bytes = this.readCountBytes(16)

  for (; idx < 16; ++idx) {
    str = str + bytes[idx].toString(16).padStart(2, '0')
  }

  val = str.toUpperCase()

  this.addHexView(key, 'fguidString', val, this.currentIdx - 16, this.currentIdx - 1)

  return val
}

/**
 * Read 16 bytes, save in hex view and return value as string.
 *
 * @function ReaderUasset#fstring
 * @param {string} key - name of what we read
 * @returns {string}
 * @private
 */
ReaderUasset.prototype.fstring = function fstring(key) {
  /** @type {string} */
  var val
  /** @type {number[]} */
  var bytes
  /** @type {string} */
  var str = ''
  /** @type {number} */
  var counter = 0
  /** @type {number[]} */
  var output = []
  /** @type {string} */
  var value
  /** @type {string} */
  var extra
  /** @type {number} */
  var idx
  /** @type {number} */
  var startPosition

  var length = this.int32(key + ' (fstring length)')
  if (length === 0) {
    return ''
  }

  /*
   * UE5.6+ Protection: Protect against corrupt/huge lengths that would cause OOM.
   * A reasonable FString length should not exceed 1MB (1048576 bytes).
   * If we detect an unreasonable length, return empty string to prevent crash.
   */

  var MAX_FSTRING_LENGTH = 1048576
  var absLength = length > 0 ? length : length * -1 * 2
  if (absLength > MAX_FSTRING_LENGTH || absLength < 0) {
    return ''
  }

  startPosition = this.currentIdx

  if (length > 0) {
    bytes = this.readCountBytes(length)
    for (idx = 0; idx < bytes.length - 1; ++idx) {
      str = str + String.fromCharCode(bytes[idx])
    }

    val = str

    this.addHexView(key, 'fstring', val, startPosition, this.currentIdx - 1)

    return str
  }

  /*
   * UTF-16LE decoding: length is negative, indicating UTF-16 encoded string.
   * Each character is 2 bytes in little-endian order.
   */
  length = length * -1 * 2
  bytes = this.readCountBytes(length)
  while (counter < bytes.length - 1) {
    // Read 2 bytes as UTF-16LE (little-endian): low byte first, then high byte
    var charCode = bytes[counter] | (bytes[counter + 1] << 8)
    counter += 2

    // Handle surrogate pairs for characters outside BMP (> U+FFFF)
    if (charCode >= 0xd800 && charCode <= 0xdbff && counter < bytes.length - 1) {
      // High surrogate - read low surrogate
      var lowSurrogate = bytes[counter] | (bytes[counter + 1] << 8)
      if (lowSurrogate >= 0xdc00 && lowSurrogate <= 0xdfff) {
        // Valid surrogate pair - combine to get code point and convert to string
        var codePoint = ((charCode & 0x3ff) << 10) + (lowSurrogate & 0x3ff) + 0x10000
        str = str + String.fromCodePoint(codePoint)
        counter += 2
      } else {
        // Invalid low surrogate - just push high surrogate as character
        str = str + String.fromCharCode(charCode)
      }
    } else if (charCode !== 0) {
      // Regular character (skip null terminator) - convert to string
      str = str + String.fromCharCode(charCode)
    }
  }

  val = str

  this.addHexView(key, 'fstring', val, startPosition, this.currentIdx - 1)

  return val
}

/**
 * Read n bytes.
 *
 * @function ReaderUasset#readCountBytes
 * @param {number} count - number of bytes to read.
 * @returns {number[]}
 * @private
 */
/**
 * Read N bytes into the reusable scalar buffer and return a DataView over it.
 *
 * @function ReaderUasset#readScalarView
 * @param {number} count - number of bytes to read (1 to 8).
 * @returns {DataView}
 * @private
 */
ReaderUasset.prototype.readScalarView = function readScalarView(count) {
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var start = this.currentIdx

  for (; idx < count; ++idx) {
    /*
     * `| 0` keeps the old behaviour when the read runs past the end of the buffer:
     * `undefined` used to land in a Uint8Array and become 0, and it still does.
     */
    this.scalarBytes[idx] = this.bytes[start + idx] | 0
  }

  this.currentIdx = start + count

  return this.scalarView
}

/**
 * Read N bytes as a plain array, moving the cursor.
 *
 * @function ReaderUasset#readCountBytes
 * @param {number} count - number of bytes to read.
 * @returns {number[]}
 * @private
 */
ReaderUasset.prototype.readCountBytes = function readCountBytes(count) {
  /** @type {number[]} */
  var bytes
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var start = this.currentIdx

  this.currentIdx = start + count

  /*
   * Preallocate instead of growing. Thumbnail payloads are the only large reads here
   * and pushing them a byte at a time made the array reallocate over and over, which
   * cost more than the rest of the parse put together.
   */
  bytes = new Array(count)
  for (; idx < count; ++idx) {
    bytes[idx] = this.bytes[start + idx]
  }

  return bytes
}

/**
 * Add informations in HexView struct.
 *
 * @function ReaderUasset#addHexView
 * @param {string} key           - name of what we read
 * @param {string} type          - type name of what we read (int16, int32, etc...)
 * @param {string} value         - value read
 * @param {number} startPosition - start position in the file
 * @param {number} stopPosition  - stop position in the file
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.addHexView = function addHexView(
  key,
  type,
  value,
  startPosition,
  stopPosition
) {
  if (this.saveHexView === false) {
    return
  }

  this.uasset.hexView.push({
    key: key,
    type: type,
    value: value,
    start: startPosition,
    stop: stopPosition
  })
}

/**
 * Resolve FName.
 *
 * @function ReaderUasset#resolveFName
 * @param {number} idx - name of what we read
 * @returns {string}
 * @private
 */
ReaderUasset.prototype.resolveFName = function resolveFName(idx) {
  if (this.uasset.names[idx]) {
    return this.uasset.names[idx].Name
  }

  return ''
}

/**
 * Resolve FName with number suffix.
 * In UE, FName consists of a NameIndex and a Number.
 * When Number > 0, the suffix "_N" is appended where N = Number - 1.
 * For example: Name="Texture", Number=3 → "Texture_2"
 *
 * @function ReaderUasset#resolveFNameWithNumber
 * @param {number} nameIndex - index into the names table
 * @param {number} number    - FName number field (0 means no suffix)
 * @returns {string}
 * @private
 */
ReaderUasset.prototype.resolveFNameWithNumber = function resolveFNameWithNumber(nameIndex, number) {
  var baseName = this.resolveFName(nameIndex)

  if (number > 0) {
    return baseName + '_' + (number - 1)
  }

  return baseName
}
// endregion

/**
 * Read Header.
 *
 * @function ReaderUasset#readHeader
 * @returns {(Error|undefined)}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp#L48
 */

ReaderUasset.prototype.readHeader = function readHeader() {
  /** @type {number} */
  var idx
  /** @type {number} */
  var count
  /** @type {number} */
  var MAX_CHUNKIDS_SAFE_COUNT = 100000

  // Check file is uasset
  this.uasset.header.EPackageFileTag = this.uint32('EPackageFileTag')
  if (this.uasset.header.EPackageFileTag === EPackageFileTag.PACKAGE_FILE_TAG_SWAPPED) {
    // The package has been stored in a separate endianness
    this.useLittleEndian = false
  }

  if (
    this.uasset.header.EPackageFileTag !== EPackageFileTag.PACKAGE_FILE_TAG &&
    this.uasset.header.EPackageFileTag !== EPackageFileTag.PACKAGE_FILE_TAG_SWAPPED
  ) {
    return new Error('invalid uasset')
  }

  /**
   * Check file is not UE3
   *
   * The package file version number when this package was saved.
   *
   * Lower 16 bits stores the UE3 engine version
   * Upper 16 bits stores the UE licensee version
   * For newer packages this is -7:<br>
   * -2 indicates presence of enum-based custom versions<br>
   * -3 indicates guid-based custom versions<br>
   * -4 indicates removal of the UE3 version. Packages saved with this ID cannot be loaded in older engine versions<br>
   * -5 indicates the replacement of writing out the "UE3 version" so older versions of engine can gracefully fail to open newer packages<br>
   * -6 indicates optimizations to how custom versions are being serialized<br>
   * -7 indicates the texture allocation info has been removed from the summary<br>
   * -8 indicates that the UE5 version has been added to the summary
   * -9 indicates a contractual change in when early exits are required based on FileVersionTooNew. At or
   * after this LegacyFileVersion, we support changing the PackageFileSummary serialization format for
   * all bytes serialized after FileVersionLicensee, and that format change can be conditional on any
   * of the versions parsed before that point. All packageloaders that understand the -9
   * legacyfileformat are required to early exit without further serialization at that point if
   * FileVersionTooNew is true.
   */
  this.uasset.header.LegacyFileVersion = this.int32('LegacyFileVersion')

  /*
   * -2: enum-based custom versions
   * -3: guid-based custom versions
   * -4: removal of UE3 version
   * -5: replacement of UE3 version writing
   * -6: optimized custom versions
   * -7: texture allocation info removed
   * -8: UE5 version added
   * -9: contractual change for FileVersionTooNew
   */

  if (this.uasset.header.LegacyFileVersion > -2 || this.uasset.header.LegacyFileVersion < -9) {
    return new Error('unsupported version')
  }

  /*
   * Next bytes is for UE3
   * Only read LegacyUE3Version if LegacyFileVersion is not -4
   * (Per UE source: -4 indicates removal of the UE3 version)
   */

  if (this.uasset.header.LegacyFileVersion !== -4) {
    this.uasset.header.LegacyUE3Version = this.int32('LegacyUE3Version')
  }

  // Check file is valid UE4
  this.uasset.header.FileVersionUE4 = this.int32('FileVersionUE4')

  // Check valid UE5
  this.uasset.header.FileVersionUE5 = 0

  if (this.uasset.header.LegacyFileVersion <= -8) {
    this.uasset.header.FileVersionUE5 = this.int32('FileVersionUE5')
  }

  this.uasset.header.FileVersionLicenseeUE4 = this.int32('FileVersionLicenseeUE4')
  if (
    this.uasset.header.FileVersionUE4 === 0 &&
    this.uasset.header.FileVersionLicenseeUE4 === 0 &&
    this.uasset.header.FileVersionUE5 === 0
  ) {
    return new Error('asset unversioned')
  }

  if (
    this.uasset.header.FileVersionUE5 >=
    EUnrealEngineObjectUE5Version.VER_UE5_PACKAGE_SAVED_HASH.value
  ) {
    this.uasset.header.SavedPackageHash = this.readCountBytes(20)
      .map(function iter(byte) {
        return byte.toString(16).padStart(2, '0')
      })
      .join('')
    this.uasset.header.TotalHeaderSize = this.int32('TotalHeaderSize')
  }

  /*
   * CustomVersions format depends on LegacyFileVersion:
   * -2: Enums format (Tag: uint32, Version: int32)
   * -3 to -5: Guids format (Key: GUID, Version: int32, FriendlyName: FString)
   * < -5: Optimized format (Key: GUID, Version: int32)
   */
  count = this.int32('CustomVersions Count')
  this.uasset.header.CustomVersions = []
  for (idx = 0; idx < count; ++idx) {
    if (this.uasset.header.LegacyFileVersion === -2) {
      // Enum-based format (deprecated)
      this.uasset.header.CustomVersions.push({
        tag: this.uint32('CustomVersions #' + idx + ': tag'),
        version: this.int32('CustomVersions #' + idx + ': version')
      })
    } else if (this.uasset.header.LegacyFileVersion >= -5) {
      // Guid-based format (deprecated) - includes FriendlyName string
      this.uasset.header.CustomVersions.push({
        key: this.fguidSlot('CustomVersions #' + idx + ': key'),
        version: this.int32('CustomVersions #' + idx + ': version'),
        friendlyName: this.fstring('CustomVersions #' + idx + ': friendlyName')
      })
    } else {
      // Optimized format (current)
      this.uasset.header.CustomVersions.push({
        key: this.fguidSlot('CustomVersions #' + idx + ': key'),
        version: this.int32('CustomVersions #' + idx + ': version')
      })
    }
  }

  if (
    this.uasset.header.FileVersionUE5 <
    EUnrealEngineObjectUE5Version.VER_UE5_PACKAGE_SAVED_HASH.value
  ) {
    this.uasset.header.TotalHeaderSize = this.int32('TotalHeaderSize')
  }

  this.uasset.header.FolderName = this.fstring('FolderName')

  this.uasset.header.PackageFlags = this.uint32('PackageFlags')

  this.uasset.header.NameCount = this.int32('NameCount')
  this.uasset.header.NameOffset = this.int32('NameOffset')

  if (
    this.uasset.header.FileVersionUE5 >=
    EUnrealEngineObjectUE5Version.VER_UE5_ADD_SOFTOBJECTPATH_LIST.value
  ) {
    this.uasset.header.SoftObjectPathsCount = this.uint32('SoftObjectPathsCount')
    this.uasset.header.SoftObjectPathsOffset = this.uint32('SoftObjectPathsOffset')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID.value
  ) {
    this.uasset.header.LocalizationId = this.fstring('LocalizationId')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_SERIALIZE_TEXT_IN_PACKAGES.value
  ) {
    this.uasset.header.GatherableTextDataCount = this.int32('GatherableTextDataCount')
    this.uasset.header.GatherableTextDataOffset = this.int32('GatherableTextDataOffset')
  }

  this.uasset.header.ExportCount = this.int32('ExportCount')
  this.uasset.header.ExportOffset = this.int32('ExportOffset')

  this.uasset.header.ImportCount = this.int32('ImportCount')
  this.uasset.header.ImportOffset = this.int32('ImportOffset')

  // UE5: VERSE_CELLS (1015) - Cell exports and imports for Verse
  if (
    this.uasset.header.FileVersionUE5 >= EUnrealEngineObjectUE5Version.VER_UE5_VERSE_CELLS.value
  ) {
    this.uasset.header.CellExportCount = this.int32('CellExportCount')
    this.uasset.header.CellExportOffset = this.int32('CellExportOffset')
    this.uasset.header.CellImportCount = this.int32('CellImportCount')
    this.uasset.header.CellImportOffset = this.int32('CellImportOffset')
  }

  if (
    this.uasset.header.FileVersionUE5 >=
    EUnrealEngineObjectUE5Version.VER_UE5_METADATA_SERIALIZATION_OFFSET.value
  ) {
    this.uasset.header.MetadataOffset = this.int32('MetadataOffset')
  }

  this.uasset.header.DependsOffset = this.int32('DependsOffset')

  if (
    this.uasset.header.FileVersionUE4 <
    EUnrealEngineObjectUE4Version.VER_UE4_OLDEST_LOADABLE_PACKAGE.value
  ) {
    return new Error('asset too old')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ADD_STRING_ASSET_REFERENCES_MAP.value
  ) {
    this.uasset.header.SoftPackageReferencesCount = this.int32('SoftPackageReferencesCount')
    this.uasset.header.SoftPackageReferencesOffset = this.int32('SoftPackageReferencesOffset')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ADDED_SEARCHABLE_NAMES.value
  ) {
    this.uasset.header.SearchableNamesOffset = this.int32('SearchableNamesOffset')
  }

  this.uasset.header.ThumbnailTableOffset = this.int32('ThumbnailTableOffset')

  // UE5: IMPORT_TYPE_HIERARCHIES (1018) - Adds a table of hierarchical type information for imports
  if (
    this.uasset.header.FileVersionUE5 >=
    EUnrealEngineObjectUE5Version.VER_UE5_IMPORT_TYPE_HIERARCHIES.value
  ) {
    this.uasset.header.ImportTypeHierarchiesCount = this.int32('ImportTypeHierarchiesCount')
    this.uasset.header.ImportTypeHierarchiesOffset = this.int32('ImportTypeHierarchiesOffset')
  }

  /*
   * UE5: < PACKAGE_SAVED_HASH (1016) - LegacyGuid 仅在旧版本中读取
   * 对于 >= 1016，Guid 已在 header 开头被 SavedPackageHash 替代
   */
  if (
    this.uasset.header.FileVersionUE5 <
    EUnrealEngineObjectUE5Version.VER_UE5_PACKAGE_SAVED_HASH.value
  ) {
    this.uasset.header.Guid = this.fguidString('Guid')
  }

  /*
   * PersistentGuid - 仅在非 FilterEditorOnly 且 >= VER_UE4_ADDED_PACKAGE_OWNER 时读取
   * FilterEditorOnly 通过 PackageFlags & PKG_FilterEditorOnly (0x80000000) 判断
   */

  if ((this.uasset.header.PackageFlags & 0x80000000) === 0) {
    if (
      this.uasset.header.FileVersionUE4 >=
      EUnrealEngineObjectUE4Version.VER_UE4_ADDED_PACKAGE_OWNER.value
    ) {
      this.uasset.header.PersistentGuid = this.fguidString('PersistentGuid')
    }

    // eslint-disable-next-line stylistic/max-len
    if (
      this.uasset.header.FileVersionUE4 >=
        EUnrealEngineObjectUE4Version.VER_UE4_ADDED_PACKAGE_OWNER.value &&
      this.uasset.header.FileVersionUE4 <
        EUnrealEngineObjectUE4Version.VER_UE4_NON_OUTER_PACKAGE_IMPORT.value
    ) {
      this.uasset.header.OwnerPersistentGuid = this.fguidString('OwnerPersistentGuid')
    }
  }

  count = this.int32('Generations Count')
  this.uasset.header.Generations = []
  for (idx = 0; idx < count; ++idx) {
    this.uasset.header.Generations.push({
      exportCount: this.int32('Generations #' + idx + ': export count'),
      nameCount: this.int32('Generations #' + idx + ': name count)')
    })
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ENGINE_VERSION_OBJECT.value
  ) {
    this.uasset.header.SavedByEngineVersion = String(this.uint16('SavedByEngineVersion Major'))
    this.uasset.header.SavedByEngineVersion =
      this.uasset.header.SavedByEngineVersion + '.' + this.uint16('SavedByEngineVersion Minor')
    this.uasset.header.SavedByEngineVersion =
      this.uasset.header.SavedByEngineVersion + '.' + this.uint16('SavedByEngineVersion Patch')
    this.uasset.header.SavedByEngineVersion =
      this.uasset.header.SavedByEngineVersion + '-' + this.uint32('SavedByEngineVersion Changelist')
    this.uasset.header.SavedByEngineVersion =
      this.uasset.header.SavedByEngineVersion + '+' + this.fstring('SavedByEngineVersion Branch')
  } else {
    this.uasset.header.EngineChangelist = this.int32('EngineChangelist')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION.value
  ) {
    this.uasset.header.CompatibleWithEngineVersion = String(
      this.uint16('CompatibleWithEngineVersion Major')
    )
    this.uasset.header.CompatibleWithEngineVersion =
      this.uasset.header.CompatibleWithEngineVersion +
      '.' +
      this.uint16('CompatibleWithEngineVersion Minor')
    this.uasset.header.CompatibleWithEngineVersion =
      this.uasset.header.CompatibleWithEngineVersion +
      '.' +
      this.uint16('CompatibleWithEngineVersion Patch')
    this.uasset.header.CompatibleWithEngineVersion =
      this.uasset.header.CompatibleWithEngineVersion +
      '-' +
      this.uint32('CompatibleWithEngineVersion Changelist')
    this.uasset.header.CompatibleWithEngineVersion =
      this.uasset.header.CompatibleWithEngineVersion +
      '+' +
      this.fstring('CompatibleWithEngineVersion Branch')
  } else {
    this.uasset.header.CompatibleWithEngineVersion = this.uasset.header.SavedByEngineVersion
  }

  this.uasset.header.CompressionFlags = this.uint32('CompressionFlags')

  count = this.int32('CompressedChunks Count')
  if (count > 0) {
    return new Error('asset compressed')
  }

  this.uasset.header.PackageSource = this.uint32('PackageSource')

  count = this.uint32('AdditionalPackagesToCook Count')
  this.uasset.header.AdditionalPackagesToCook = []
  if (count > 0) {
    return new Error('AdditionalPackagesToCook has items')
  }

  if (this.uasset.header.LegacyFileVersion > -7) {
    this.uasset.header.NumTextureAllocations = this.int32('NumTextureAllocations')
  }

  this.uasset.header.AssetRegistryDataOffset = this.int32('AssetRegistryDataOffset')
  this.uasset.header.BulkDataStartOffset = this.int64('BulkDataStartOffset')

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_WORLD_LEVEL_INFO.value
  ) {
    this.uasset.header.WorldTileInfoDataOffset = this.int32('WorldTileInfoDataOffset')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS.value
  ) {
    count = this.int32('ChunkIDs Count')
    this.uasset.header.ChunkIDs = []
    if (count < 0 || count > MAX_CHUNKIDS_SAFE_COUNT) {
      return new Error('invalid ChunkIDs count: ' + String(count))
    }
    while (count > 0) {
      this.uasset.header.ChunkIDs.push(this.int32('ChunkIDs Item'))
      count = count - 1
    }
  } else if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE.value
  ) {
    this.uasset.header.ChunkID = this.int32('ChunkID')
  }

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS.value
  ) {
    this.uasset.header.PreloadDependencyCount = this.int32('PreloadDependencyCount')
    this.uasset.header.PreloadDependencyOffset = this.int32('PreloadDependencyOffset')
  } else {
    this.uasset.header.PreloadDependencyCount = -1
    this.uasset.header.PreloadDependencyOffset = 0
  }

  if (
    this.uasset.header.FileVersionUE5 >=
    EUnrealEngineObjectUE5Version.VER_UE5_NAMES_REFERENCED_FROM_EXPORT_DATA.value
  ) {
    this.uasset.header.NamesReferencedFromExportDataCount = this.int32(
      'NamesReferencedFromExportDataCount'
    )
  }

  if (
    this.uasset.header.FileVersionUE5 >= EUnrealEngineObjectUE5Version.VER_UE5_PAYLOAD_TOC.value
  ) {
    this.uasset.header.PayloadTocOffset = this.int64('PayloadTocOffset')
  } else {
    this.uasset.header.PayloadTocOffset = -1
  }

  if (
    this.uasset.header.FileVersionUE5 >= EUnrealEngineObjectUE5Version.VER_UE5_DATA_RESOURCES.value
  ) {
    this.uasset.header.DataResourceOffset = this.int32('DataResourceOffset')
  }

  return undefined
}

/**
 * Read Names.
 *
 * @function ReaderUasset#readNames
 * @returns {undefined}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/Core/Private/UObject/UnrealNames.cpp#L2736
 */
ReaderUasset.prototype.readNames = function readNames() {
  var idx = 0
  var count = this.uasset.header.NameCount
  this.currentIdx = this.uasset.header.NameOffset

  /*
   * Hashes: These are not used anymore but recalculated on save to maintain serialization format
   * GetRawNonCasePreservingHash -> return FCrc::Strihash_DEPRECATED(Source) & 0xFFFF;
   * GetRawCasePreservingHash -> return FCrc::StrCrc32(Source) & 0xFFFF;
   * Note: Hashes only exist in files >= VER_UE4_NAME_HASHES_SERIALIZED (504)
   */
  var hasHashes =
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_NAME_HASHES_SERIALIZED.value

  /*
   * UE5.6+ Name Serialization Issue:
   * Some UE5.6+ .uasset files have 3 extra bytes inserted at unpredictable positions
   * in the name table. These bytes appear to be additional hash/algorithm data.
   * When we detect a corrupt string length, we try skipping 3 bytes to recover.
   *
   * NOTE: Negative lengths are VALID - they indicate UTF-16 encoded strings.
   * Only consider length corrupt if absolute value exceeds reasonable bounds.
   */
  var MAX_REASONABLE_NAME_LENGTH = 1024

  // Create DataView once for performance (avoid creating in loop)
  var dataView = new DataView(new Uint8Array(this.bytes).buffer)

  for (; idx < count; ++idx) {
    // Peek at the length before reading
    var peekLength = dataView.getInt32(this.currentIdx, this.useLittleEndian)

    // Calculate absolute length (negative = UTF-16, use |length| * 2)
    var absLength = peekLength >= 0 ? peekLength : peekLength * -1 * 2

    // If absolute length is unreasonable, try skipping 3 bytes
    if (absLength > MAX_REASONABLE_NAME_LENGTH) {
      var skipLength = dataView.getInt32(this.currentIdx + 3, this.useLittleEndian)
      var absSkipLength = skipLength >= 0 ? skipLength : skipLength * -1 * 2
      if (absSkipLength > 0 && absSkipLength < MAX_REASONABLE_NAME_LENGTH) {
        // Skip the 3 extra bytes
        this.currentIdx = this.currentIdx + 3
      }
    }

    this.uasset.names.push({
      Name: this.fstring('Name #' + (idx + 1) + ': string'),
      NonCasePreservingHash: hasHashes
        ? this.uint16('Name #' + (idx + 1) + ': NonCasePreservingHash')
        : 0,
      CasePreservingHash: hasHashes ? this.uint16('Name #' + (idx + 1) + ': CasePreservingHash') : 0
    })
  }
}

/**
 * Read FLocMetadataValue - recursive helper for metadata parsing.
 * ELocMetadataType: None=0, String=1, Boolean=2, Array=3, Object=4
 *
 * @function ReaderUasset#readLocMetadataValue
 * @param {string} label - Debug label
 * @param          depth
 * @returns {object} The parsed metadata value
 * @private
 */
ReaderUasset.prototype.readLocMetadataValue = function readLocMetadataValue(label, depth) {
  var type = this.int32(label + ': Type')
  var value
  var arrayCount
  var arrayValues
  var idx

  var maxDepth = 10

  var maxArraySize = 1000

  // Prevent infinite recursion
  depth = depth || 0
  if (depth > maxDepth) {
    return { type: 'Error', value: 'Max recursion depth exceeded' }
  }

  /*
   * ELocMetadataType mapping:
   * 0 = None
   * 1 = Boolean
   * 2 = String
   * 3 = Array
   * 4 = Object
   */
  switch (type) {
    case 0:
      // None
      value = { type: 'None', value: null }
      break
    case 1:
      // Boolean
      value = { type: 'Boolean', value: this.int32(label + ': BoolValue') !== 0 }
      break
    case 2:
      // String
      value = { type: 'String', value: this.fstring(label + ': StringValue') }
      break
    case 3:
      // Array
      arrayCount = this.int32(label + ': ArrayCount')

      // Boundary check: prevent excessive array sizes
      if (arrayCount < 0 || arrayCount > maxArraySize) {
        value = { type: 'Error', value: 'Invalid array count: ' + arrayCount }
        break
      }
      arrayValues = []
      for (idx = 0; idx < arrayCount; ++idx) {
        arrayValues.push(this.readLocMetadataValue(label + '[' + idx + ']', depth + 1))
      }
      value = { type: 'Array', value: arrayValues }
      break
    case 4:
      // Object
      value = { type: 'Object', value: this.readLocMetadataObject(label + '.Object', depth + 1) }
      break
    default:
      // Unknown type - skip gracefully
      value = { type: 'Unknown', value: null, typeId: type }
  }

  return value
}

/**
 * Read FLocMetadataObject - for InfoMetaData/KeyMetaData parsing.
 *
 * @function ReaderUasset#readLocMetadataObject
 * @param {string} label - Debug label
 * @param {number} depth - Current recursion depth
 * @returns {object} The parsed metadata object
 * @private
 */
ReaderUasset.prototype.readLocMetadataObject = function readLocMetadataObject(label, depth) {
  var valueCount = this.int32(label + ': ValueCount')
  var values = {}
  var idx
  var key
  var metaValue

  var maxValueCount = 100

  var maxDepth = 10

  // Prevent infinite recursion
  depth = depth || 0
  if (depth > maxDepth) {
    return { error: 'Max recursion depth exceeded' }
  }

  // Boundary check: prevent excessive value counts
  if (valueCount < 0 || valueCount > maxValueCount) {
    return { error: 'Invalid value count: ' + valueCount }
  }

  for (idx = 0; idx < valueCount; ++idx) {
    key = this.fstring(label + '[' + idx + ']: Key')
    metaValue = this.readLocMetadataValue(label + '[' + idx + ']: Value', depth)
    values[key] = metaValue
  }

  return values
}

/**
 * Read Gatherable Text Data.
 *
 * @function ReaderUasset#readGatherableTextData
 * @returns {Error|undefined}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/Core/Private/Internationalization/GatherableTextData.cpp
 */
ReaderUasset.prototype.readGatherableTextData = function readGatherableTextData() {
  /** @type {GatherableTextData} */
  var gatherableTextData
  /** @type {SourceSiteContexts} */
  var sourceSiteContexts
  /** @type {number} */
  var countSourceSiteContexts
  /** @type {number} */
  var idxSourceSiteContexts
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var count = this.uasset.header.GatherableTextDataCount

  this.currentIdx = this.uasset.header.GatherableTextDataOffset

  this.uasset.gatherableTextData = []
  for (; idx < count; ++idx) {
    gatherableTextData = {}

    gatherableTextData.NamespaceName = this.fstring(
      'GatherableTextData #' + (idx + 1) + ': NamespaceName'
    )

    gatherableTextData.SourceData = {
      SourceString: this.fstring('GatherableTextData #' + (idx + 1) + ': SourceData.SourceString'),

      // Read SourceStringMetaData as FLocMetadataObject
      SourceStringMetaData: this.readLocMetadataObject(
        'GatherableTextData #' + (idx + 1) + ': SourceStringMetaData'
      )
    }

    gatherableTextData.SourceSiteContexts = []
    countSourceSiteContexts = this.int32(
      'GatherableTextData #' + (idx + 1) + ': CountSourceSiteContexts'
    )
    for (
      idxSourceSiteContexts = 0;
      idxSourceSiteContexts < countSourceSiteContexts;
      ++idxSourceSiteContexts
    ) {
      sourceSiteContexts = {}
      sourceSiteContexts.KeyName = this.fstring(
        'GatherableTextData #' +
          (idx + 1) +
          ' - SourceSiteContexts #' +
          (idxSourceSiteContexts + 1) +
          ': KeyName'
      )
      sourceSiteContexts.SiteDescription = this.fstring(
        'GatherableTextData #' +
          (idx + 1) +
          ' - SourceSiteContexts #' +
          (idxSourceSiteContexts + 1) +
          ': SiteDescription'
      )
      sourceSiteContexts.IsEditorOnly = this.uint32(
        'GatherableTextData #' +
          (idx + 1) +
          ' - SourceSiteContexts #' +
          (idxSourceSiteContexts + 1) +
          ': IsEditorOnly'
      )
      sourceSiteContexts.IsOptional = this.uint32(
        'GatherableTextData #' +
          (idx + 1) +
          ' - SourceSiteContexts #' +
          (idxSourceSiteContexts + 1) +
          ': IsOptional'
      )

      // Read InfoMetaData as FLocMetadataObject
      sourceSiteContexts.InfoMetaData = this.readLocMetadataObject(
        'GatherableTextData #' + (idx + 1) + ' - InfoMetaData'
      )

      // Read KeyMetaData as FLocMetadataObject
      sourceSiteContexts.KeyMetaData = this.readLocMetadataObject(
        'GatherableTextData #' + (idx + 1) + ' - KeyMetaData'
      )

      gatherableTextData.SourceSiteContexts.push(sourceSiteContexts)
    }

    this.uasset.gatherableTextData.push(gatherableTextData)
  }

  return undefined
}

/**
 * Read Imports.
 *
 * @function ReaderUasset#readImports
 * @returns {undefined}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/CoreUObject/Private/UObject/ObjectResource.cpp#L302
 */
ReaderUasset.prototype.readImports = function readImports() {
  var idx = 0
  /** @type {number} */
  var classPackageIndex
  /** @type {number} */
  var classPackageNumber
  /** @type {number} */
  var classNameIndex
  /** @type {number} */
  var classNameNumber
  /** @type {number} */
  var outerIndex
  /** @type {number} */
  var objectNameIndex
  /** @type {number} */
  var objectNameNumber
  /** @type {number} */
  var packageNameIndex
  /** @type {number} */
  var packageNameNumber
  /** @type {string} */
  var packageName
  /** @type {number} */
  var bImportOptional = 0
  /** @type {number} */
  var count = this.uasset.header.ImportCount
  /**
   * FObjectImport::PackageName only exists since UE 4.26 (VER_UE4_NON_OUTER_PACKAGE_IMPORT).
   * Older packages do not carry the field at all, so it must stay NAME_None instead of
   * falling back to name index 0.
   *
   * @type {boolean}
   * @see https://github.com/EpicGames/UnrealEngine/blob/4.27/Engine/Source/Runtime/CoreUObject/Private/UObject/ObjectResource.cpp#L294
   */
  var hasPackageName =
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_NON_OUTER_PACKAGE_IMPORT.value

  this.currentIdx = this.uasset.header.ImportOffset

  this.uasset.imports.Imports = []
  for (; idx < count; ++idx) {
    // FName is serialized as two int32: NameIndex and Number
    // See UE5 LinkerLoad.h:1033-1057
    classPackageIndex = this.int32('Import #' + (idx + 1) + ': classPackageIndex')
    classPackageNumber = this.int32('Import #' + (idx + 1) + ': classPackageNumber')
    classNameIndex = this.int32('Import #' + (idx + 1) + ': classNameIndex')
    classNameNumber = this.int32('Import #' + (idx + 1) + ': classNameNumber')
    outerIndex = this.int32('Import #' + (idx + 1) + ': outerIndex')
    objectNameIndex = this.int32('Import #' + (idx + 1) + ': objectNameIndex')
    objectNameNumber = this.int32('Import #' + (idx + 1) + ': objectNameNumber')

    packageName = ''
    if (hasPackageName) {
      packageNameIndex = this.int32('Import #' + (idx + 1) + ': packageNameIndex')
      packageNameNumber = this.int32('Import #' + (idx + 1) + ': packageNameNumber')
      packageName = this.resolveFNameWithNumber(packageNameIndex, packageNameNumber)
    }

    if (
      this.uasset.header.FileVersionUE5 >=
      EUnrealEngineObjectUE5Version.VER_UE5_OPTIONAL_RESOURCES.value
    ) {
      bImportOptional = this.int32('Import #' + (idx + 1) + ': importOptional')
    }

    this.uasset.imports.Imports.push({
      classPackage: this.resolveFNameWithNumber(classPackageIndex, classPackageNumber),
      className: this.resolveFNameWithNumber(classNameIndex, classNameNumber),
      outerIndex: outerIndex,
      objectName: this.resolveFNameWithNumber(objectNameIndex, objectNameNumber),
      packageName: packageName,
      bImportOptional: bImportOptional
    })
  }
}

/**
 * Read Exports.
 *
 * @function ReaderUasset#readExports
 * @returns {undefined}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/CoreUObject/Private/UObject/ObjectResource.cpp#L113
 * @todo Data are HERE, need to find how to read that
 */

ReaderUasset.prototype.readExports = function readExports() {
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var count
  /** @type {number} */
  var nodeNameRef
  /** @type {number} */
  var nodeNameNumber
  /** @type {number} */
  var classIndex
  /** @type {number} */
  var superIndex
  /** @type {number} */
  var templateIndex = 0
  /** @type {number} */
  var outerIndex
  /** @type {number} */
  var objectName
  /** @type {number} */
  var objectNameNumber
  /** @type {number} */
  var objectFlags
  /** @type {number} */
  var serialSize
  /** @type {number} */
  var serialOffset
  /** @type {number} */
  var bForcedExport
  /** @type {number} */
  var bNotForClient
  /** @type {number} */
  var bNotForServer
  /** @type {string} */
  var packageGuid
  /** @type {number} */
  var packageFlags
  /** @type {number} */
  var bNotAlwaysLoadedForEditorGame = 0
  /** @type {number} */
  var bIsAsset = 0
  /** @type {number} */
  var bGeneratePublicHash = 0
  /** @type {number} */
  var bIsInheritedInstance = 0
  /** @type {number} */
  var firstExportDependency = 0
  /** @type {number} */
  var serializationBeforeSerializationDependencies = 0
  /** @type {number} */
  var createBeforeSerializationDependencies = 0
  /** @type {number} */
  var serializationBeforeCreateDependencies = 0
  /** @type {number} */
  var createBeforeCreateDependencies = 0
  /** @type {number} */
  var scriptSerializationStartOffset = 0
  /** @type {number} */
  var scriptSerializationEndOffset = 0

  this.currentIdx = this.uasset.header.ExportOffset

  count = this.uasset.header.ExportCount
  this.uasset.exports = []
  for (; idx < count; ++idx) {
    classIndex = this.int32('Export #' + (idx + 1) + ': classIndex')
    superIndex = this.int32('Export #' + (idx + 1) + ': superIndex')

    if (
      this.uasset.header.FileVersionUE4 >=
      EUnrealEngineObjectUE4Version.VER_UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS.value
    ) {
      templateIndex = this.int32('Export #' + (idx + 1) + ': templateIndex')
    }

    outerIndex = this.int32('Export #' + (idx + 1) + ': outerIndex')

    /*
     * FName is serialized as two int32: NameIndex and Number. Reading the pair as a
     * single uint64 makes every numbered name (`Foo_10` is stored as `Foo` plus number 11)
     * overflow the names table lookup and resolve to an empty string.
     * Same byte count, different interpretation.
     */
    objectName = this.int32('Export #' + (idx + 1) + ': objectNameIndex')
    objectNameNumber = this.int32('Export #' + (idx + 1) + ': objectNameNumber')
    objectFlags = this.uint32('Export #' + (idx + 1) + ': objectFlags')
    serialSize = this.int64('Export #' + (idx + 1) + ': serialSize')
    serialOffset = this.int64('Export #' + (idx + 1) + ': serialOffset')
    bForcedExport = this.int32('Export #' + (idx + 1) + ': bForcedExport')
    bNotForClient = this.int32('Export #' + (idx + 1) + ': bNotForClient')
    bNotForServer = this.int32('Export #' + (idx + 1) + ': bNotForServer')

    // UE5: PackageGuid removed in REMOVE_OBJECT_EXPORT_PACKAGE_GUID (1005)
    if (
      this.uasset.header.FileVersionUE5 <
      EUnrealEngineObjectUE5Version.VER_UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID.value
    ) {
      packageGuid = this.fguidString('Export #' + (idx + 1) + ': packageGuid')
    } else {
      packageGuid = ''
    }

    // UE5: bIsInheritedInstance added in TRACK_OBJECT_EXPORT_IS_INHERITED (1006)
    if (
      this.uasset.header.FileVersionUE5 >=
      EUnrealEngineObjectUE5Version.VER_UE5_TRACK_OBJECT_EXPORT_IS_INHERITED.value
    ) {
      bIsInheritedInstance = this.int32('Export #' + (idx + 1) + ': bIsInheritedInstance')
    }

    packageFlags = this.uint32('Export #' + (idx + 1) + ': packageFlags')

    if (
      this.uasset.header.FileVersionUE4 >=
      EUnrealEngineObjectUE4Version.VER_UE4_LOAD_FOR_EDITOR_GAME.value
    ) {
      bNotAlwaysLoadedForEditorGame = this.int32(
        'Export #' + (idx + 1) + ': bNotAlwaysLoadedForEditorGame'
      )
    }

    if (
      this.uasset.header.FileVersionUE4 >=
      EUnrealEngineObjectUE4Version.VER_UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT.value
    ) {
      bIsAsset = this.int32('Export #' + (idx + 1) + ': bIsAsset')
    }

    if (
      this.uasset.header.FileVersionUE5 >=
      EUnrealEngineObjectUE5Version.VER_UE5_OPTIONAL_RESOURCES.value
    ) {
      bGeneratePublicHash = this.int32('Export #' + (idx + 1) + ': bGeneratePublicHash')
    }

    if (
      this.uasset.header.FileVersionUE4 >=
      EUnrealEngineObjectUE4Version.VER_UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS.value
    ) {
      firstExportDependency = this.int32('Export #' + (idx + 1) + ': firstExportDependency')
      serializationBeforeSerializationDependencies = this.int32(
        'Export #' + (idx + 1) + ': serializationBeforeSerializationDependencies'
      )
      createBeforeSerializationDependencies = this.int32(
        'Export #' + (idx + 1) + ': createBeforeSerializationDependencies'
      )
      serializationBeforeCreateDependencies = this.int32(
        'Export #' + (idx + 1) + ': serializationBeforeCreateDependencies'
      )
      createBeforeCreateDependencies = this.int32(
        'Export #' + (idx + 1) + ': createBeforeCreateDependencies'
      )
    }

    // UE5: ScriptSerializationOffsets added in SCRIPT_SERIALIZATION_OFFSET (1010)
    if (
      this.uasset.header.FileVersionUE5 >=
      EUnrealEngineObjectUE5Version.VER_UE5_SCRIPT_SERIALIZATION_OFFSET.value
    ) {
      scriptSerializationStartOffset = this.int32(
        'Export #' + (idx + 1) + ': scriptSerializationStartOffset'
      )
      scriptSerializationEndOffset = this.int32(
        'Export #' + (idx + 1) + ': scriptSerializationEndOffset'
      )
    }

    // UE5: DataResources padding added in DATA_RESOURCES (1009) - 8 additional bytes
    if (
      this.uasset.header.FileVersionUE5 >=
      EUnrealEngineObjectUE5Version.VER_UE5_DATA_RESOURCES.value
    ) {
      // Skip 8 bytes of padding/reserved fields
      this.readCountBytes(8)
    }

    this.uasset.exports.push({
      classIndex: classIndex,
      superIndex: superIndex,
      templateIndex: templateIndex,
      outerIndex: outerIndex,
      objectName: this.resolveFNameWithNumber(objectName, objectNameNumber),
      objectFlags: objectFlags,
      serialSize: serialSize,
      serialOffset: serialOffset,
      bForcedExport: bForcedExport,
      bNotForClient: bNotForClient,
      bNotForServer: bNotForServer,
      packageGuid: packageGuid,
      packageFlags: packageFlags,
      bNotAlwaysLoadedForEditorGame: bNotAlwaysLoadedForEditorGame,
      bIsAsset: bIsAsset,
      bGeneratePublicHash: bGeneratePublicHash,
      bIsInheritedInstance: bIsInheritedInstance,
      firstExportDependency: firstExportDependency,
      serializationBeforeSerializationDependencies: serializationBeforeSerializationDependencies,
      createBeforeSerializationDependencies: createBeforeSerializationDependencies,
      serializationBeforeCreateDependencies: serializationBeforeCreateDependencies,
      createBeforeCreateDependencies: createBeforeCreateDependencies,
      scriptSerializationStartOffset: scriptSerializationStartOffset,
      scriptSerializationEndOffset: scriptSerializationEndOffset,
      data: []
    })
  }

  for (idx = 0; idx < count; ++idx) {
    if (this.uasset.exports[idx].serialSize <= 0) {
      continue
    }

    this.currentIdx = Number(this.uasset.exports[idx].serialOffset)

    // Data are HERE, need to find how to read that

    nodeNameRef = this.int32('Exports #' + (idx + 1) + ': data nameIndex')
    nodeNameNumber = this.int32('Exports #' + (idx + 1) + ': data nameNumber')
    this.uasset.exports[idx].data.push(this.resolveFNameWithNumber(nodeNameRef, nodeNameNumber))
    this.uasset.exports[idx].data.push(this.uint32('flags'))
  }
}

/**
 * Read Depends.
 *
 * @function ReaderUasset#readDepends
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readDepends = function readDepends() {
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var count

  this.currentIdx = this.uasset.header.DependsOffset

  count = this.int32('Depends Count')
  this.uasset.depends.Depends = []
  for (; idx < count; ++idx) {
    this.uasset.depends.Depends.push({
      FPackageIndex: this.int32('Depend #' + (idx + 1) + ': FPackageIndex')
    })
  }
}

/**
 * Read Soft Package References.
 *
 * @function ReaderUasset#readSoftPackageReferences
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readSoftPackageReferences = function readSoftPackageReferences() {
  /** @type {number} */
  var nameIndex
  /** @type {number} */
  var nameNumber
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var count

  this.currentIdx = this.uasset.header.SoftPackageReferencesOffset

  count = this.uasset.header.SoftPackageReferencesCount
  this.uasset.softPackageReferences = []
  for (; idx < count; ++idx) {
    /*
     * SoftPackageReferenceList is a TArray<FName>, so each entry is NameIndex plus Number.
     * Reading the pair as one uint64 drops every numbered name (`Foo_1` is stored as `Foo`
     * plus number 2), which then resolves to an empty string.
     */
    nameIndex = this.int32('SoftPackageReferences #' + (idx + 1) + ': nameIndex')
    nameNumber = this.int32('SoftPackageReferences #' + (idx + 1) + ': nameNumber')
    this.uasset.softPackageReferences.push({
      assetPathName: this.resolveFNameWithNumber(nameIndex, nameNumber)
    })
  }
}

/**
 * Read Searchable Names.
 *
 * @function ReaderUasset#readSearchableNames
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readSearchableNames = function readSearchableNames() {
  this.currentIdx = this.uasset.header.SearchableNamesOffset

  this.int32('CountSearchableNames')
  this.uasset.searchableNames = []
}

/**
 * Read Thumbnails.
 *
 * @function ReaderUasset#readThumbnails
 * @returns {undefined}
 * @private
 * @see https://github.com/EpicGames/UnrealEngine/blob/5.0/Engine/Source/Runtime/Core/Private/Misc/ObjectThumbnail.cpp#L42
 */
ReaderUasset.prototype.readThumbnails = function readThumbnails() {
  /** @type {number} */
  var pos
  /** @type {number} */
  var idx = 0
  /** @type {number} */
  var count
  /** @type {number} */
  var imageWidth
  /** @type {number} */
  var imageHeight
  /** @type {string} */
  var imageFormat
  /** @type {number} */
  var imageSizeData
  /** @type {number[]} */
  var imageData
  /** @type {string} */
  var imageHexView
  /** @type {number} */
  var fileOffset
  /** @type {number} */
  var fileLength = this.bytes.length

  // 检查 ThumbnailTableOffset 是否有效
  if (
    this.uasset.header.ThumbnailTableOffset <= 0 ||
    this.uasset.header.ThumbnailTableOffset >= fileLength
  ) {
    return
  }

  this.currentIdx = this.uasset.header.ThumbnailTableOffset

  count = this.int32('Thumbnails Count')

  // 检查缩略图数量是否合理（避免读取错误数据导致的大量循环）

  if (count <= 0 || count > 1000) {
    return
  }

  this.uasset.thumbnails.Index = []
  this.uasset.thumbnails.Thumbnails = []
  for (; idx < count; ++idx) {
    this.uasset.thumbnails.Index.push({
      AssetClassName: this.fstring('Thumbnails #' + (idx + 1) + ': assetClassName'),
      ObjectPathWithoutPackageName: this.fstring(
        'Thumbnails #' + (idx + 1) + ': objectPathWithoutPackageName'
      ),
      FileOffset: (fileOffset = this.int32('Thumbnails #' + (idx + 1) + ': fileOffset'))
    })

    // 如果 FileOffset 无效，清空索引并返回（表示无有效缩略图）
    if (fileOffset <= 0 || fileOffset >= fileLength) {
      this.uasset.thumbnails.Index = []
      return
    }
  }

  for (idx = 0; idx < count; ++idx) {
    this.currentIdx = this.uasset.thumbnails.Index[idx].FileOffset

    // 再次验证位置是否在文件范围内
    if (this.currentIdx <= 0 || this.currentIdx >= fileLength) {
      continue
    }

    imageWidth = this.int32('Thumbnails #' + (idx + 1) + ': imageWidth')
    imageHeight = this.int32('Thumbnails #' + (idx + 1) + ': imageHeight')
    imageFormat = 'PNG'

    if (imageHeight < 0) {
      imageFormat = 'JPEG'
      imageHeight = imageHeight * -1
    }

    imageData = []
    imageSizeData = this.int32('Thumbnails #' + (idx + 1) + ': imageSizeData')

    // 验证图片数据大小是否合理
    if (
      imageSizeData > 0 &&
      imageSizeData < fileLength &&
      this.currentIdx + imageSizeData <= fileLength
    ) {
      pos = this.currentIdx
      imageData = this.readCountBytes(imageSizeData)

      /*
       * Only stringify the image bytes when the hex view actually wants them.
       * Arguments are evaluated before the call, so an unconditional join() builds
       * a string out of every thumbnail byte just for addHexView to drop it --
       * that alone was two thirds of the parse time on a large asset pack.
       */
      imageHexView = ''
      if (this.saveHexView) {
        imageHexView = imageData.join('')
      }

      this.addHexView(
        'Thumbnails #' + (idx + 1) + ': imageData',
        'data',
        imageHexView,
        pos,
        this.currentIdx - 1
      )
    }

    this.uasset.thumbnails.Thumbnails.push({
      ImageWidth: imageWidth,
      ImageHeight: imageHeight,
      ImageFormat: imageFormat,
      ImageSizeData: imageSizeData,
      ImageData: imageData
    })
  }
}

/**
 * Read Asset Registry Data.
 *
 * @function ReaderUasset#readAssetRegistryData
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readAssetRegistryData = function readAssetRegistryData() {
  /** @type {number} */
  var idx
  /** @type {number} */
  var count
  /** @type {number} */
  var idxTag
  /** @type {number} */
  var countTag
  /** @type {number} */
  var nextOffset = this.uasset.header.TotalHeaderSize

  // Skip if no AssetRegistryData section exists (offset <= 0 means no data)
  if (this.uasset.header.AssetRegistryDataOffset <= 0) {
    this.uasset.assetRegistryData.data = []
    return
  }

  this.currentIdx = this.uasset.header.AssetRegistryDataOffset

  if (this.uasset.header.WorldTileInfoDataOffset > 0) {
    nextOffset = this.uasset.header.WorldTileInfoDataOffset
  }

  this.uasset.assetRegistryData.size = nextOffset - this.uasset.header.AssetRegistryDataOffset

  if (
    this.uasset.header.FileVersionUE4 >=
    EUnrealEngineObjectUE4Version.VER_UE4_ASSETREGISTRY_DEPENDENCYFLAGS.value
  ) {
    this.uasset.assetRegistryData.DependencyDataOffset = this.int64('DependencyDataOffset')
  }

  this.uasset.assetRegistryData.data = []
  count = this.int32('AssetRegistryData Count')

  /*
   * UE5.6+ Protection: Guard against corrupt count values causing infinite loops.
   * A reasonable AssetRegistryData count should not exceed 100000 entries.
   */

  var MAX_ASSET_REGISTRY_COUNT = 100000
  if (count < 0 || count > MAX_ASSET_REGISTRY_COUNT) {
    return
  }

  for (idx = 0; idx < count; ++idx) {
    this.uasset.assetRegistryData.data.push({
      ObjectPath: this.fstring('ObjectPath'),
      ObjectClassName: this.fstring('ObjectClassName'),
      Tags: []
    })

    countTag = this.int32('AssetRegistryData Tag Count')

    var MAX_TAG_COUNT = 10000
    if (countTag < 0 || countTag > MAX_TAG_COUNT) {
      continue
    }

    for (idxTag = 0; idxTag < countTag; ++idxTag) {
      this.uasset.assetRegistryData.data[idx].Tags.push({
        Key: this.fstring('key'),
        Value: this.fstring('value')
      })
    }
  }
}

/**
 * Read Preload Dependency.
 *
 * @function ReaderUasset#readPreloadDependency
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readPreloadDependency = function readPreloadDependency() {
  this.currentIdx = this.uasset.header.PreloadDependencyOffset
}

/**
 * Read Bulk Data Start.
 *
 * @function ReaderUasset#readBulkDataStart
 * @returns {undefined}
 * @private
 */
ReaderUasset.prototype.readBulkDataStart = function readBulkDataStart() {
  this.currentIdx = Number(this.uasset.header.BulkDataStartOffset)
}

/**
 * Analyze Uasset.
 *
 * @function ReaderUasset#analyze
 * @param {Uint8Array} bytes       - bytes read from file
 * @param {boolean}    saveHexView - if true save all informations to debug
 * @returns {(Error|Uasset)}
 * @public
 */
ReaderUasset.prototype.analyze = function analyze(bytes, saveHexView) {
  /** @type {(Error|undefined)} */
  var err

  this.currentIdx = 0
  this.bytes = bytes
  this.saveHexView = saveHexView || false
  this.useLittleEndian = true

  err = this.readHeader()
  if (err !== undefined) {
    return err
  }

  this.readNames()

  err = this.readGatherableTextData()
  if (err !== undefined) {
    return err
  }

  this.readImports()
  this.readExports()
  this.readDepends()
  this.readSoftPackageReferences()
  this.readSearchableNames()
  this.readThumbnails()
  this.readAssetRegistryData()
  this.readPreloadDependency()
  this.readBulkDataStart()

  this.uasset.hexView.sort(function sortHexView(left, right) {
    return left.start - right.start
  })

  return this.uasset
}

/**
 * 只解析 header，返回关键偏移量信息.
 * 用于流式读取时确定需要读取的元数据范围.
 *
 * @function ReaderUasset#parseHeaderOnly
 * @param {Uint8Array} bytes - 至少包含 header 数据的字节数组（建议 8KB+）
 * @returns {object|Error} 包含 BulkDataStartOffset 等关键偏移量，或错误
 */
ReaderUasset.prototype.parseHeaderOnly = function parseHeaderOnly(bytes) {
  this.currentIdx = 0
  this.bytes = bytes
  this.saveHexView = false
  this.useLittleEndian = true

  var err = this.readHeader()
  if (err !== undefined) {
    return err
  }

  return {
    BulkDataStartOffset: this.uasset.header.BulkDataStartOffset,
    NameOffset: this.uasset.header.NameOffset,
    ImportOffset: this.uasset.header.ImportOffset,
    ExportOffset: this.uasset.header.ExportOffset,
    TotalHeaderSize: this.uasset.header.TotalHeaderSize || this.currentIdx
  }
}

// Freeze prototype for security issue about prototype pollution.
Object.freeze(ReaderUasset.prototype)
Object.freeze(ReaderUasset)

/**
 * Node.js 专用流式读取入口.
 * 支持大文件（8GB+）的元数据提取，跳过 BulkData.
 *
 * @module streaming
 */

/* 默认配置常量 */
/* .uasset 文件通常有 BulkData，元数据较小，使用 256MB 限制 */
var DEFAULT_MAX_METADATA_SIZE_UASSET = 1024 * 1024 * 1024
/* .umap 地图文件没有 BulkData，元数据可能很大，使用 1GB 限制 */
var DEFAULT_MAX_METADATA_SIZE_UMAP = 1024 * 1024 * 1024
var MIN_HEADER_SIZE = 64

/**
 * 根据文件扩展名获取默认的元数据大小限制
 * .umap 地图文件没有 BulkData，元数据可能很大，使用 1GB 限制
 * .uasset 文件通常有 BulkData，元数据较小，使用 256MB 限制
 *
 * @param {string} filePath - 文件路径
 * @returns {number} 默认的最大元数据大小
 * @private
 */
function getDefaultMaxMetadataSize(filePath) {
  var ext = filePath.toLowerCase().split('.').pop()
  if (ext === 'umap') {
    return DEFAULT_MAX_METADATA_SIZE_UMAP
  }
  return DEFAULT_MAX_METADATA_SIZE_UASSET
}

/**
 * 从文件路径分析 uasset 元数据（跳过 BulkData）
 *
 * @param {string}  filePath                  - uasset 文件路径
 * @param {object}  options                   - 配置选项
 * @param {number}  [options.maxMetadataSize] - 最大元数据大小限制（字节）
 * @param {boolean} [options.saveHexView]     - 是否保存 HexView 调试信息
 * @returns {Promise<Uasset|Error>} 解析结果或错误
 */
async function analyzeFromFile(filePath, options = {}) {
  const maxMetadataSize = options.maxMetadataSize || getDefaultMaxMetadataSize(filePath)
  const saveHexView = options.saveHexView || false

  /** @type {import('fs/promises').FileHandle|null} */
  let fd = null

  try {
    // Step 1: 打开文件并获取基本信息
    fd = await fs.open(filePath, 'r')
    const stat = await fd.stat()

    // Step 2: 验证文件大小
    if (stat.size < MIN_HEADER_SIZE) {
      return new Error('Invalid uasset: file too small (' + stat.size + ' bytes)')
    }

    // Step 3: 计算需要读取的元数据范围
    const readSize = await calculateMetadataSize(fd, stat.size, maxMetadataSize)
    if (readSize instanceof Error) {
      return readSize
    }

    // Step 4: 读取元数据区域
    const metadataBuffer = Buffer.alloc(readSize)
    const { bytesRead } = await fd.read(metadataBuffer, 0, readSize, 0)

    if (bytesRead !== readSize) {
      return new Error('Read incomplete: expected ' + readSize + ', got ' + bytesRead)
    }

    // Step 5: 使用现有 ReaderUasset 解析
    const reader = new ReaderUasset()
    return reader.analyze(new Uint8Array(metadataBuffer), saveHexView)
  } catch (err) {
    // 处理文件系统错误
    if (err.code === 'ENOENT') {
      return new Error('File not found: ' + filePath)
    }
    if (err.code === 'EACCES') {
      return new Error('Permission denied: ' + filePath)
    }
    return err
  } finally {
    // 确保文件句柄被关闭
    if (fd !== null) {
      await fd.close()
    }
  }
}

/**
 * 计算需要读取的元数据大小
 * 优先使用 BulkDataStartOffset，否则使用保守估计
 *
 * @param {import('fs/promises').FileHandle} fd       - 文件句柄
 * @param {number}                           fileSize - 文件总大小
 * @param {number}                           maxSize  - 最大允许读取大小
 * @returns {Promise<number|Error>} 需要读取的字节数或错误
 * @private
 */
async function calculateMetadataSize(fd, fileSize, maxSize) {
  /*
   * 生产级两阶段策略：
   * 1. 读取 8KB header buffer
   * 2. 使用 parseHeaderOnly 精确解析 BulkDataStartOffset
   * 3. 根据 BulkDataStartOffset 确定实际需要读取的大小
   */
  var HEADER_PROBE_SIZE = 8192

  // 对于小文件直接读取全部
  if (fileSize <= HEADER_PROBE_SIZE) {
    return fileSize
  }

  try {
    // 读取 8KB header
    var headerBuf = Buffer.alloc(HEADER_PROBE_SIZE)
    await fd.read(headerBuf, 0, HEADER_PROBE_SIZE, 0)

    // 使用 parseHeaderOnly 解析
    var reader = new ReaderUasset()
    var headerInfo = reader.parseHeaderOnly(new Uint8Array(headerBuf))

    // 如果解析失败，回退到读取整个文件
    if (headerInfo instanceof Error) {
      return Math.min(fileSize, maxSize)
    }

    // 获取 BulkDataStartOffset（标记元数据结束位置）
    var bulkDataOffset = headerInfo.BulkDataStartOffset

    if (bulkDataOffset && bulkDataOffset > 0n && bulkDataOffset < BigInt(fileSize)) {
      var readSize = Number(bulkDataOffset)
      if (readSize > maxSize) {
        return new Error('Metadata too large: ' + readSize + ' bytes (max: ' + maxSize + ')')
      }
      return readSize
    }

    // 如果 BulkDataStartOffset 无效，回退策略
    return Math.min(fileSize, maxSize)
  } catch (err) {
    // 解析失败时使用保守策略
    return Math.min(fileSize, maxSize)
  }
}

// 导出供外部使用
export { ReaderUasset, analyzeFromFile }
export default { ReaderUasset, analyzeFromFile }
