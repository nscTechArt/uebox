#include "UAL_MeshCommands.h"

#include "UAL_CommandUtils.h"
#include "UAL_MeshCompat.h"
#include "UAL_ScopedTransaction.h"

#include "Animation/MorphTarget.h"
#include "Animation/Skeleton.h"
#include "Editor.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/SkeletalMeshSocket.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshSocket.h"
#include "Engine/StaticMeshSourceData.h"
#include "FileHelpers.h"
#include "Materials/MaterialInterface.h"
#include "PhysicsEngine/BodySetup.h"
#include "PhysicsEngine/PhysicsAsset.h"
#include "ReferenceSkeleton.h"
#include "Rendering/SkeletalMeshLODRenderData.h"
#include "Rendering/SkeletalMeshRenderData.h"
#include "StaticMeshCompiler.h"
#include "StaticMeshEditorSubsystem.h"
#include "StaticMeshResources.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

DEFINE_LOG_CATEGORY_STATIC(LogUALMesh, Log, All);

namespace
{
	FString PathOf(const UObject* Obj)
	{
		return Obj ? Obj->GetPathName() : FString();
	}

	/**
	 * 「这个角色的脸朝网格的哪个方向」—— 从参考姿势的左右骨骼对推出来。
	 *
	 * ## 为什么需要这个
	 *
	 * 骨骼网格的「正面」不是引擎里存着的一个字段：导入时轴向怎么转全看
	 * DCC 那边，同一批素材里有朝 +X 的也有朝 +Y 的。以前工具一个字都不说，
	 * 调用方只能「摆好 → 试玩 → 截图目测」，而 T-pose 和运行时姿势不一样、
	 * 机位一远就糊，目测两次判错两次。
	 *
	 * ## 为什么用左右骨骼对，而不是别的
	 *
	 * 人形骨架里唯一稳定可测的方向量是**左右**：两只脚（或两条腿、两边
	 * 锁骨）在参考姿势下的连线就是角色的右轴，右轴叉上 Z 就是正前方
	 * （UE 左手系：Right × Up = Forward）。包围盒推不出朝向（人是左右
	 * 对称的），根骨骼旋转也推不出（多数骨架根骨骼是单位旋转）。
	 *
	 * ## 为什么骨骼名字认不出来时不猜
	 *
	 * 认不出就写 `known: false` 和原因，让调用方回到截图那条路。给一个
	 * 猜出来的角度比不给更坏 —— 调用方会拿它当事实去摆，错了还查不出
	 * 是哪一步错的。见「工具不回读校验就不许报 success」。
	 */
	TSharedPtr<FJsonObject> DescribeSkeletalFacing(const FReferenceSkeleton& RefSkeleton)
	{
		TSharedPtr<FJsonObject> Facing = MakeShared<FJsonObject>();

		const int32 BoneCount = RefSkeleton.GetNum();
		if (BoneCount <= 0)
		{
			Facing->SetBoolField(TEXT("known"), false);
			Facing->SetStringField(TEXT("reason"), TEXT("no bones"));
			return Facing;
		}

		// 参考姿势是每根骨骼相对父骨骼的，先顺着父链乘成组件空间
		const TArray<FTransform>& RefPose = RefSkeleton.GetRefBonePose();
		TArray<FTransform> ComponentSpace;
		ComponentSpace.SetNum(BoneCount);
		for (int32 Index = 0; Index < BoneCount; ++Index)
		{
			const FTransform& Local = RefPose.IsValidIndex(Index) ? RefPose[Index] : FTransform::Identity;
			const int32 Parent = RefSkeleton.GetParentIndex(Index);
			ComponentSpace[Index] = (Parent != INDEX_NONE && Parent < Index)
				? Local * ComponentSpace[Parent]
				: Local;
		}

		// 左右成对的候选，从下往上：脚最稳（站姿分得最开），手最不稳（T-pose
		// 里两只手是左右张开的，但 A-pose 里会往下垂，连线还是左右向，可用）
		struct FBonePair { const TCHAR* Left; const TCHAR* Right; };
		static const FBonePair Pairs[] = {
			{ TEXT("foot_l"), TEXT("foot_r") },
			{ TEXT("LeftFoot"), TEXT("RightFoot") },
			{ TEXT("calf_l"), TEXT("calf_r") },
			{ TEXT("LeftLeg"), TEXT("RightLeg") },
			{ TEXT("thigh_l"), TEXT("thigh_r") },
			{ TEXT("LeftUpLeg"), TEXT("RightUpLeg") },
			{ TEXT("clavicle_l"), TEXT("clavicle_r") },
			{ TEXT("LeftShoulder"), TEXT("RightShoulder") },
			{ TEXT("upperarm_l"), TEXT("upperarm_r") },
			{ TEXT("LeftArm"), TEXT("RightArm") },
			{ TEXT("hand_l"), TEXT("hand_r") },
			{ TEXT("LeftHand"), TEXT("RightHand") }
		};

		for (const FBonePair& Pair : Pairs)
		{
			const int32 LeftIndex = RefSkeleton.FindBoneIndex(FName(Pair.Left));
			const int32 RightIndex = RefSkeleton.FindBoneIndex(FName(Pair.Right));
			if (LeftIndex == INDEX_NONE || RightIndex == INDEX_NONE)
			{
				continue;
			}

			FVector Right = ComponentSpace[RightIndex].GetLocation() - ComponentSpace[LeftIndex].GetLocation();
			Right.Z = 0.0;	// 只要水平朝向；上下差是骨架的事，不是脸朝哪的事
			if (Right.IsNearlyZero())
			{
				continue;	// 这对骨骼在水平面上重合，问不出左右，换下一对
			}
			Right.Normalize();

			// UE 左手系：Right × Up = Forward
			const FVector Forward = FVector::CrossProduct(Right, FVector::UpVector).GetSafeNormal();
			if (Forward.IsNearlyZero())
			{
				continue;
			}

			const double YawOffset = FMath::RadiansToDegrees(FMath::Atan2(Forward.Y, Forward.X));

			Facing->SetBoolField(TEXT("known"), true);
			Facing->SetStringField(TEXT("from_bones"), FString::Printf(TEXT("%s / %s"), Pair.Left, Pair.Right));

			TSharedPtr<FJsonObject> ForwardJson = MakeShared<FJsonObject>();
			ForwardJson->SetNumberField(TEXT("x"), Forward.X);
			ForwardJson->SetNumberField(TEXT("y"), Forward.Y);
			ForwardJson->SetNumberField(TEXT("z"), Forward.Z);
			Facing->SetObjectField(TEXT("forward_local"), ForwardJson);

			Facing->SetNumberField(TEXT("yaw_offset"), YawOffset);
			// 这一句是给模型看的：它要的不是向量，是「Actor 的 yaw 该补多少」
			Facing->SetStringField(TEXT("hint"), FString::Printf(
				TEXT("mesh front points %.1f deg off the component +X axis; to make it face a world direction, set actor yaw = direction_yaw - (%.1f)"),
				YawOffset, YawOffset));
			return Facing;
		}

		Facing->SetBoolField(TEXT("known"), false);
		Facing->SetStringField(TEXT("reason"),
			TEXT("no left/right bone pair recognized in the reference skeleton; fall back to a front-on playtest screenshot"));
		return Facing;
	}

	void AddBounds(const TSharedPtr<FJsonObject>& Data, const FBox& Box)
	{
		// size + min/max 都要给。
		//
		// 这里一度只给 size，理由是「没有消费者会用到网格在局部空间里的角点坐标」。
		// 那条理由是错的：局部空间的 min/max **就是原点相对几何体的位置** ——
		// 居中的网格 min.z ≈ -size.z/2，坐在地面上的 min.z ≈ 0，角点原点的 min ≈ 0。
		// 拼模块化套件（地板+墙+天花板）必须知道这个约定才算得出摆放坐标，
		// 而 size 一个数字答不了。实测里因此反复绕：先按「居中」假设拼一版，
		// 截图发现天花板悬在墙外，再逐个 viewport.focus 去反推 —— 而 focus 会飞镜头。
		TSharedPtr<FJsonObject> Bounds = MakeShared<FJsonObject>();
		Bounds->SetObjectField(TEXT("size"), UAL_CommandUtils::MakeVectorJson(Box.GetSize()));
		Bounds->SetObjectField(TEXT("min"), UAL_CommandUtils::MakeVectorJson(Box.Min));
		Bounds->SetObjectField(TEXT("max"), UAL_CommandUtils::MakeVectorJson(Box.Max));
		Data->SetObjectField(TEXT("bounds"), Bounds);
	}

	const TCHAR* CollisionComplexityToString(ECollisionTraceFlag Flag)
	{
		switch (Flag)
		{
		case CTF_UseSimpleAndComplex: return TEXT("simple_and_complex");
		case CTF_UseSimpleAsComplex:  return TEXT("simple_as_complex");
		case CTF_UseComplexAsSimple:  return TEXT("complex_as_simple");
		default:                      return TEXT("default");
		}
	}

	// ------------------------------------------------------------------
	// 静态网格
	// ------------------------------------------------------------------

	void DescribeStaticMesh(UStaticMesh* Mesh, const TSharedPtr<FJsonObject>& Data)
	{
		Data->SetStringField(TEXT("type"), TEXT("static"));

		const int32 NumLODs = Mesh->GetNumLODs();
		const FStaticMeshRenderData* RenderData = Mesh->GetRenderData();

		TArray<TSharedPtr<FJsonValue>> Lods;
		for (int32 Index = 0; Index < NumLODs; ++Index)
		{
			TSharedPtr<FJsonObject> Lod = MakeShared<FJsonObject>();
			Lod->SetNumberField(TEXT("index"), Index);
			Lod->SetNumberField(TEXT("triangles"), Mesh->GetNumTriangles(Index));
			Lod->SetNumberField(TEXT("vertices"), Mesh->GetNumVertices(Index));
			Lod->SetNumberField(TEXT("sections"), Mesh->GetNumSections(Index));
			Lod->SetNumberField(TEXT("uv_channels"), Mesh->GetNumUVChannels(Index));

			// 屏占比：LOD 之间必须单调递减，不然会跳变。审计要用这个值。
			if (RenderData && RenderData->LODResources.IsValidIndex(Index))
			{
				Lod->SetNumberField(TEXT("screen_size"), RenderData->ScreenSize[Index].Default);
			}

#if WITH_EDITORONLY_DATA
			// LOD 是导入的还是引擎生成的 —— 这条决定了「能不能覆盖」。
			// 美术手工导入的 LOD 被 generate_lods 盖掉是不可逆的（见设计文档 §5.3 红线 1）。
			if (Mesh->GetNumSourceModels() > Index)
			{
				const bool bRawEmpty = Mesh->GetSourceModel(Index).IsRawMeshEmpty();
				Lod->SetStringField(TEXT("source"), bRawEmpty ? TEXT("generated") : TEXT("imported"));
			}
#endif

			Lods.Add(MakeShared<FJsonValueObject>(Lod));
		}
		Data->SetArrayField(TEXT("lods"), Lods);

		// --- 材质槽 ---
		TArray<TSharedPtr<FJsonValue>> Slots;
		const TArray<FStaticMaterial>& Materials = Mesh->GetStaticMaterials();
		for (int32 Index = 0; Index < Materials.Num(); ++Index)
		{
			TSharedPtr<FJsonObject> Slot = MakeShared<FJsonObject>();
			Slot->SetNumberField(TEXT("index"), Index);
			Slot->SetStringField(TEXT("slot_name"), Materials[Index].MaterialSlotName.ToString());
			Slot->SetStringField(TEXT("material"), PathOf(Materials[Index].MaterialInterface));
			Slots.Add(MakeShared<FJsonValueObject>(Slot));
		}
		Data->SetArrayField(TEXT("material_slots"), Slots);

		// --- 碰撞 ---
		TSharedPtr<FJsonObject> Collision = MakeShared<FJsonObject>();
		const UBodySetup* BodySetup = Mesh->GetBodySetup();
		const int32 PrimCount = BodySetup ? BodySetup->AggGeom.GetElementCount() : 0;
		Collision->SetNumberField(TEXT("primitives"), PrimCount);
		Collision->SetNumberField(TEXT("convex_hulls"), BodySetup ? BodySetup->AggGeom.ConvexElems.Num() : 0);
		// 这里原本还报 `UStaticMesh::GetNumSectionsWithCollision()`，去掉了：
		// 那个方法在引擎头文件里**没有 ENGINE_API**，插件链接不到它
		//（UE 5.5 上是 `error LNK2019: 无法解析的外部符号`）。
		// 它只是个锦上添花的字段 —— 「到底有没有碰撞」由下面的 has_any 回答，
		// 为了它去翻编辑器专用的 SectionInfoMap 不划算。
		Collision->SetStringField(TEXT("complexity"),
			BodySetup ? CollisionComplexityToString(BodySetup->CollisionTraceFlag) : TEXT("unknown"));
		// 「有没有碰撞」是审计第一条检查项，别让调用方自己去推
		Collision->SetBoolField(TEXT("has_any"), PrimCount > 0 ||
			(BodySetup && BodySetup->CollisionTraceFlag == CTF_UseComplexAsSimple));
		Data->SetObjectField(TEXT("collision"), Collision);

		// --- Nanite ---
		// 走 UALMeshCompat：IsNaniteEnabled() 在 5.0–5.2 上还不存在
		TSharedPtr<FJsonObject> Nanite = MakeShared<FJsonObject>();
		Nanite->SetBoolField(TEXT("enabled"), UALMeshCompat::IsNaniteEnabled(Mesh));
		Data->SetObjectField(TEXT("nanite"), Nanite);

		// --- 光照贴图 UV ---
		// 通道索引指向不存在的通道是烘焙报错的常见根因，这里直接判定给出，
		// 别让模型自己拿 lightmap_coordinate_index 和 uv_channels 去比。
		TSharedPtr<FJsonObject> Lightmap = MakeShared<FJsonObject>();
		const int32 LightmapIndex = Mesh->GetLightMapCoordinateIndex();
		const int32 Lod0Channels = NumLODs > 0 ? Mesh->GetNumUVChannels(0) : 0;
		Lightmap->SetNumberField(TEXT("coordinate_index"), LightmapIndex);
		Lightmap->SetNumberField(TEXT("lod0_uv_channels"), Lod0Channels);
		Lightmap->SetBoolField(TEXT("index_valid"), LightmapIndex >= 0 && LightmapIndex < Lod0Channels);
		Data->SetObjectField(TEXT("lightmap"), Lightmap);

		AddBounds(Data, Mesh->GetBoundingBox());

		// --- Socket ---
		TArray<TSharedPtr<FJsonValue>> Sockets;
		for (const UStaticMeshSocket* Socket : Mesh->Sockets)
		{
			if (!Socket)
			{
				continue;
			}
			TSharedPtr<FJsonObject> SocketJson = MakeShared<FJsonObject>();
			SocketJson->SetStringField(TEXT("name"), Socket->SocketName.ToString());
			Sockets.Add(MakeShared<FJsonValueObject>(SocketJson));
		}
		Data->SetArrayField(TEXT("sockets"), Sockets);
	}

	// ------------------------------------------------------------------
	// 骨骼网格
	// ------------------------------------------------------------------

	void DescribeSkeletalMesh(USkeletalMesh* Mesh, const TSharedPtr<FJsonObject>& Data)
	{
		Data->SetStringField(TEXT("type"), TEXT("skeletal"));

		const FSkeletalMeshRenderData* RenderData = Mesh->GetResourceForRendering();
		const int32 NumLODs = Mesh->GetLODNum();

		TArray<TSharedPtr<FJsonValue>> Lods;
		for (int32 Index = 0; Index < NumLODs; ++Index)
		{
			TSharedPtr<FJsonObject> Lod = MakeShared<FJsonObject>();
			Lod->SetNumberField(TEXT("index"), Index);

			if (RenderData && RenderData->LODRenderData.IsValidIndex(Index))
			{
				const FSkeletalMeshLODRenderData& LodData = RenderData->LODRenderData[Index];
				Lod->SetNumberField(TEXT("vertices"), LodData.GetNumVertices());
				Lod->SetNumberField(TEXT("sections"), LodData.RenderSections.Num());

				int32 Triangles = 0;
				for (const FSkelMeshRenderSection& Section : LodData.RenderSections)
				{
					Triangles += Section.NumTriangles;
				}
				Lod->SetNumberField(TEXT("triangles"), Triangles);
			}

			if (const FSkeletalMeshLODInfo* Info = Mesh->GetLODInfo(Index))
			{
				Lod->SetNumberField(TEXT("screen_size"), Info->ScreenSize.Default);
			}

			Lods.Add(MakeShared<FJsonValueObject>(Lod));
		}
		Data->SetArrayField(TEXT("lods"), Lods);

		// --- 材质槽 ---
		TArray<TSharedPtr<FJsonValue>> Slots;
		const TArray<FSkeletalMaterial>& Materials = Mesh->GetMaterials();
		for (int32 Index = 0; Index < Materials.Num(); ++Index)
		{
			TSharedPtr<FJsonObject> Slot = MakeShared<FJsonObject>();
			Slot->SetNumberField(TEXT("index"), Index);
			Slot->SetStringField(TEXT("slot_name"), Materials[Index].MaterialSlotName.ToString());
			Slot->SetStringField(TEXT("material"), PathOf(Materials[Index].MaterialInterface));
			Slots.Add(MakeShared<FJsonValueObject>(Slot));
		}
		Data->SetArrayField(TEXT("material_slots"), Slots);

		// --- 骨架 ---
		Data->SetStringField(TEXT("skeleton"), PathOf(Mesh->GetSkeleton()));

		// 骨骼**只给摘要，不给全表**。几百根骨骼倒进上下文没有信息量，
		// 真要找某根骨头，让模型按名字问第二次。
		const FReferenceSkeleton& RefSkeleton = Mesh->GetRefSkeleton();
		const int32 BoneCount = RefSkeleton.GetNum();
		TSharedPtr<FJsonObject> Bones = MakeShared<FJsonObject>();
		Bones->SetNumberField(TEXT("count"), BoneCount);
		if (BoneCount > 0)
		{
			Bones->SetStringField(TEXT("root"), RefSkeleton.GetBoneName(0).ToString());

			int32 MaxDepth = 0;
			for (int32 Index = 0; Index < BoneCount; ++Index)
			{
				int32 Depth = 0;
				int32 Parent = RefSkeleton.GetParentIndex(Index);
				while (Parent != INDEX_NONE)
				{
					++Depth;
					Parent = RefSkeleton.GetParentIndex(Parent);
				}
				MaxDepth = FMath::Max(MaxDepth, Depth);
			}
			Bones->SetNumberField(TEXT("max_depth"), MaxDepth);
		}
		Data->SetObjectField(TEXT("bones"), Bones);

		// --- 朝向 ---
		Data->SetObjectField(TEXT("facing"), DescribeSkeletalFacing(RefSkeleton));

		// --- 物理资产 ---
		// 没有物理资产 = 布娃娃、逐骨骼命中、准确包围盒全部不工作，而且引擎不报错。
		// 审计要用，所以这里给一个明确的布尔，不要只给路径让调用方判空。
		UPhysicsAsset* PhysicsAsset = Mesh->GetPhysicsAsset();
		Data->SetStringField(TEXT("physics_asset"), PathOf(PhysicsAsset));
		Data->SetBoolField(TEXT("has_physics_asset"), PhysicsAsset != nullptr);

		// --- Socket ---
		TArray<TSharedPtr<FJsonValue>> Sockets;
		for (const USkeletalMeshSocket* Socket : Mesh->GetMeshOnlySocketList())
		{
			if (!Socket)
			{
				continue;
			}
			TSharedPtr<FJsonObject> SocketJson = MakeShared<FJsonObject>();
			SocketJson->SetStringField(TEXT("name"), Socket->SocketName.ToString());
			SocketJson->SetStringField(TEXT("bone"), Socket->BoneName.ToString());
			Sockets.Add(MakeShared<FJsonValueObject>(SocketJson));
		}
		Data->SetArrayField(TEXT("sockets"), Sockets);

		// --- Morph Target ---
		TArray<TSharedPtr<FJsonValue>> Morphs;
		for (const UMorphTarget* Morph : Mesh->GetMorphTargets())
		{
			if (Morph)
			{
				Morphs.Add(MakeShared<FJsonValueString>(Morph->GetName()));
			}
		}
		Data->SetArrayField(TEXT("morph_targets"), Morphs);

		AddBounds(Data, Mesh->GetImportedBounds().GetBox());
	}
}

// ======================================================================
// 注册
// ======================================================================

void FUAL_MeshCommands::RegisterCommands(TMap<FString, TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>>& CommandMap)
{
	CommandMap.Add(TEXT("mesh.describe"), [](const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
	{
		Handle_Describe(Payload, RequestId);
	});
	CommandMap.Add(TEXT("mesh.optimize"), [](const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
	{
		Handle_Optimize(Payload, RequestId);
	});
}

// ======================================================================
// mesh.describe
// ======================================================================

void FUAL_MeshCommands::Handle_Describe(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	Path = UAL_CommandUtils::NormalizeAssetPath(Path);

	UObject* Asset = LoadObject<UObject>(nullptr, *Path);
	if (!Asset)
	{
		UAL_CommandUtils::SendError(RequestId, 404,
			FString::Printf(TEXT("Mesh asset not found: %s"), *Path));
		return;
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetStringField(TEXT("path"), Asset->GetPathName());
	Data->SetStringField(TEXT("name"), Asset->GetName());

	if (UStaticMesh* StaticMesh = Cast<UStaticMesh>(Asset))
	{
		DescribeStaticMesh(StaticMesh, Data);
	}
	else if (USkeletalMesh* SkeletalMesh = Cast<USkeletalMesh>(Asset))
	{
		DescribeSkeletalMesh(SkeletalMesh, Data);
	}
	else
	{
		// 说清楚它实际是什么 —— 「不是网格」这句话没法让调用方决定下一步
		UAL_CommandUtils::SendError(RequestId, 400,
			FString::Printf(TEXT("Asset is not a static or skeletal mesh: %s (class %s)"),
				*Path, *Asset->GetClass()->GetName()));
		return;
	}

	UAL_CommandUtils::SendResponse(RequestId, 200, Data);
}

// ======================================================================
// mesh.optimize
// ======================================================================

// 具名而不是匿名：插件走 unity 构建，几个 .cpp 拼成一个编译单元，
// 匿名命名空间里的 MarkFailed 之类会和别的文件撞名
namespace UALMeshOptimize
{
	/**
	 * 凸包分解的参数范围和默认值，照抄静态网格编辑器「Collision → Auto Convex Collision」
	 * 面板（`StaticMeshEditorTools.cpp` 顶部那几个常量，5.0 与 5.8 一致）。
	 * 用户在编辑器里点出来的结果和我们生成的应该是同一个东西。
	 */
	constexpr int32 MinHullCount = 1;
	constexpr int32 MaxHullCount = 64;
	constexpr int32 DefaultHullCount = 4;
	constexpr int32 MinVertsPerHull = 6;
	constexpr int32 MaxVertsPerHull = 32;
	constexpr int32 DefaultVertsPerHull = 16;
	constexpr int32 MinHullPrecision = 10000;
	constexpr int32 MaxHullPrecision = 1000000;
	constexpr int32 DefaultHullPrecision = 100000;

	/** 这一级 LOD 有没有自己的源几何 —— 有就是导入的（美术的活），没有就是引擎按比例生成的 */
	bool IsImportedLod(UStaticMesh* Mesh, int32 Index)
	{
		return Index < Mesh->GetNumSourceModels() && !Mesh->GetSourceModel(Index).IsRawMeshEmpty();
	}

	/** LOD1 起最后一个导入的 LOD 下标；没有就是 0 */
	int32 LastImportedLod(UStaticMesh* Mesh)
	{
		int32 Last = 0;
		for (int32 Index = 1; Index < Mesh->GetNumSourceModels(); ++Index)
		{
			if (IsImportedLod(Mesh, Index))
			{
				Last = Index;
			}
		}
		return Last;
	}

	/** 每级 LOD 的事实：面数读渲染数据（构建完的真东西），来源和减面比例读 SourceModel */
	TArray<TSharedPtr<FJsonValue>> ReadLodFacts(UStaticMesh* Mesh)
	{
		TArray<TSharedPtr<FJsonValue>> Lods;
		const FStaticMeshRenderData* RenderData = Mesh->GetRenderData();
		const int32 NumLODs = Mesh->GetNumLODs();
		for (int32 Index = 0; Index < NumLODs; ++Index)
		{
			TSharedPtr<FJsonObject> Lod = MakeShared<FJsonObject>();
			Lod->SetNumberField(TEXT("index"), Index);
			Lod->SetNumberField(TEXT("triangles"), Mesh->GetNumTriangles(Index));
			if (RenderData && RenderData->LODResources.IsValidIndex(Index))
			{
				Lod->SetNumberField(TEXT("screen_size"), RenderData->ScreenSize[Index].Default);
			}
			if (Index < Mesh->GetNumSourceModels())
			{
				const bool bImported = IsImportedLod(Mesh, Index);
				Lod->SetStringField(TEXT("source"), bImported ? TEXT("imported") : TEXT("generated"));
				if (!bImported)
				{
					Lod->SetNumberField(TEXT("reduction_percent"),
						Mesh->GetSourceModel(Index).ReductionSettings.PercentTriangles * 100.0);
				}
			}
			Lods.Add(MakeShared<FJsonValueObject>(Lod));
		}
		return Lods;
	}

	/** 简单碰撞按类型数一遍。复杂度一起给：complex_as_simple 时简单碰撞根本不参与查询 */
	TSharedPtr<FJsonObject> ReadCollisionFacts(UStaticMesh* Mesh)
	{
		TSharedPtr<FJsonObject> Facts = MakeShared<FJsonObject>();
		const UBodySetup* Body = Mesh->GetBodySetup();
		Facts->SetNumberField(TEXT("box"), Body ? Body->AggGeom.BoxElems.Num() : 0);
		Facts->SetNumberField(TEXT("sphere"), Body ? Body->AggGeom.SphereElems.Num() : 0);
		Facts->SetNumberField(TEXT("capsule"), Body ? Body->AggGeom.SphylElems.Num() : 0);
		Facts->SetNumberField(TEXT("convex"), Body ? Body->AggGeom.ConvexElems.Num() : 0);
		Facts->SetNumberField(TEXT("total"), Body ? Body->AggGeom.GetElementCount() : 0);
		Facts->SetStringField(TEXT("complexity"),
			Body ? CollisionComplexityToString(Body->CollisionTraceFlag) : TEXT("unknown"));
		return Facts;
	}

	/** 某一类简单碰撞的个数；Type 为空时给总数 */
	int32 CollisionCount(UStaticMesh* Mesh, const FString& Type)
	{
		const UBodySetup* Body = Mesh->GetBodySetup();
		if (!Body)
		{
			return 0;
		}
		if (Type == TEXT("box")) return Body->AggGeom.BoxElems.Num();
		if (Type == TEXT("sphere")) return Body->AggGeom.SphereElems.Num();
		if (Type == TEXT("capsule")) return Body->AggGeom.SphylElems.Num();
		if (Type == TEXT("convex")) return Body->AggGeom.ConvexElems.Num();
		return Body->AggGeom.GetElementCount();
	}

	void FinishMeshCompilation(UStaticMesh* Mesh)
	{
		// 对没在编译的网格是空操作；签名 5.0–5.8 一致（5.8 多一个带默认值的 Options 参数）
		FStaticMeshCompilingManager::Get().FinishCompilation({ Mesh });
	}

	void MarkFailed(const TSharedPtr<FJsonObject>& Result, const FString& Reason)
	{
		Result->SetBoolField(TEXT("ok"), false);
		Result->SetStringField(TEXT("reason"), Reason);
	}

	/** 解析出来的请求。参数本身有错就在动手前整条拒掉（400），不进「部分成功」 */
	struct FLodRequest
	{
		int32 Count = 0;
		/** 下标 k 对应 LOD k+1，单位是「占 LOD0 面数的百分比」 */
		TArray<float> Percent;
		bool bKeepImported = false;
		/** 用生成的 LOD 换掉导入的（LOD1 起全部重建）。只在用户明确同意时传，和 bKeepImported 互斥 */
		bool bReplaceImported = false;
	};

	struct FCollisionRequest
	{
		FString Type;
		int32 HullCount = DefaultHullCount;
		int32 MaxHullVerts = DefaultVertsPerHull;
		int32 HullPrecision = DefaultHullPrecision;
		bool bReplace = true;
	};

	bool ReadIntInRange(const TSharedPtr<FJsonObject>& Obj, const TCHAR* Field, int32 Min, int32 Max, int32& InOut, FString& OutError)
	{
		double Value = 0.0;
		if (!Obj->TryGetNumberField(Field, Value))
		{
			return true;	// 没给就用默认值
		}
		if (Value != FMath::FloorToDouble(Value) || Value < Min || Value > Max)
		{
			OutError = FString::Printf(TEXT("%s must be an integer in [%d, %d], got %g"), Field, Min, Max, Value);
			return false;
		}
		InOut = static_cast<int32>(Value);
		return true;
	}

	bool ParseLodRequest(const TSharedPtr<FJsonObject>& Obj, FLodRequest& Out, FString& OutError)
	{
		double CountValue = 0.0;
		if (!Obj->TryGetNumberField(TEXT("count"), CountValue))
		{
			OutError = TEXT("lods.count is required: total number of LODs including LOD0 (2-8)");
			return false;
		}
		if (CountValue != FMath::FloorToDouble(CountValue) || CountValue < 2 || CountValue > MAX_STATIC_MESH_LODS)
		{
			OutError = FString::Printf(TEXT("lods.count must be an integer in [2, %d], got %g"), MAX_STATIC_MESH_LODS, CountValue);
			return false;
		}
		Out.Count = static_cast<int32>(CountValue);

		const TArray<TSharedPtr<FJsonValue>>* Reduction = nullptr;
		if (Obj->TryGetArrayField(TEXT("reduction"), Reduction) && Reduction)
		{
			if (Reduction->Num() != Out.Count - 1)
			{
				OutError = FString::Printf(TEXT("lods.reduction needs exactly count-1 = %d entries (LOD1..LOD%d), got %d"),
					Out.Count - 1, Out.Count - 1, Reduction->Num());
				return false;
			}
			for (const TSharedPtr<FJsonValue>& Entry : *Reduction)
			{
				double Percent = 0.0;
				if (!Entry.IsValid() || !Entry->TryGetNumber(Percent) || Percent <= 0.0 || Percent > 100.0)
				{
					OutError = TEXT("lods.reduction entries are percent of LOD0 triangles, each in (0, 100]");
					return false;
				}
				Out.Percent.Add(static_cast<float>(Percent));
			}
		}
		else
		{
			// 默认逐级减半：LOD1 50%、LOD2 25%、LOD3 12.5%……
			// 这就是引擎自带 LOD 组的做法（BaseEngine.ini [StaticMeshLODSettings] 的
			// LODPercentTriangles=50，StaticMesh.cpp 里按级连乘），不是我们另编的一套。
			for (int32 Index = 1; Index < Out.Count; ++Index)
			{
				Out.Percent.Add(100.0f * FMath::Pow(0.5f, static_cast<float>(Index)));
			}
		}

		Obj->TryGetBoolField(TEXT("keep_imported"), Out.bKeepImported);
		Obj->TryGetBoolField(TEXT("replace_imported"), Out.bReplaceImported);
		if (Out.bKeepImported && Out.bReplaceImported)
		{
			OutError = TEXT("lods.keep_imported and lods.replace_imported are mutually exclusive: keep the imported LODs, or replace them - not both");
			return false;
		}
		return true;
	}

	bool ParseCollisionRequest(const TSharedPtr<FJsonObject>& Obj, FCollisionRequest& Out, FString& OutError)
	{
		if (!Obj->TryGetStringField(TEXT("type"), Out.Type))
		{
			OutError = TEXT("collision.type is required: box | sphere | capsule | convex");
			return false;
		}
		Out.Type = Out.Type.ToLower();
		if (Out.Type != TEXT("box") && Out.Type != TEXT("sphere") && Out.Type != TEXT("capsule") && Out.Type != TEXT("convex"))
		{
			OutError = FString::Printf(TEXT("collision.type must be box | sphere | capsule | convex, got \"%s\""), *Out.Type);
			return false;
		}
		if (!ReadIntInRange(Obj, TEXT("hull_count"), MinHullCount, MaxHullCount, Out.HullCount, OutError)
			|| !ReadIntInRange(Obj, TEXT("max_hull_verts"), MinVertsPerHull, MaxVertsPerHull, Out.MaxHullVerts, OutError)
			|| !ReadIntInRange(Obj, TEXT("hull_precision"), MinHullPrecision, MaxHullPrecision, Out.HullPrecision, OutError))
		{
			OutError = TEXT("collision.") + OutError;
			return false;
		}
		Obj->TryGetBoolField(TEXT("replace"), Out.bReplace);
		return true;
	}
}

/**
 * 两件互相独立的事，各自成败：生成 LOD、生成简单碰撞。
 *
 * ## 红线（设计文档 §5.3）
 *
 * 1. **导入的 LOD 是美术的活**。LOD1 起有任何一级带源几何，keep_imported / replace_imported
 *    都没给，这一项直接拒绝并把哪几级是导入的说出来 —— 覆盖掉引擎生成不回来。
 *    replace_imported 是用户明确同意之后的出口（典型是布尔挖洞后导入的 LOD 还是旧几何），
 *    回执里 `replaced_imported` 点名换掉了哪几级。两个开关互斥，都给就 400。
 * 2. 回执里的 before / after 都是**从引擎读回来的**：面数读构建完的渲染数据，
 *    碰撞按 AggGeom 逐类数，不念请求（AGENTS.md §5 第 14 条）。
 * 3. 默认存盘。
 *
 * ## 顺序
 *
 * LOD 先、碰撞后。两个都会 PostEditChange 触发重建；凸包分解读的是 LOD0 渲染数据，
 * 所以中间等一次编译结束。全部做完、编译全部结束之后才读 after。
 */
void FUAL_MeshCommands::Handle_Optimize(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
	using namespace UALMeshOptimize;

	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	Path = UAL_CommandUtils::NormalizeAssetPath(Path);

	TSharedPtr<FJsonObject> LodsObj;
	TSharedPtr<FJsonObject> CollisionObj;
	const bool bWantLods = UAL_CommandUtils::TryGetObjectFieldFlexible(Payload, TEXT("lods"), LodsObj) && LodsObj.IsValid();
	const bool bWantCollision = UAL_CommandUtils::TryGetObjectFieldFlexible(Payload, TEXT("collision"), CollisionObj) && CollisionObj.IsValid();
	if (!bWantLods && !bWantCollision)
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Nothing to do: give lods and/or collision"));
		return;
	}

	FLodRequest LodReq;
	FCollisionRequest CollisionReq;
	FString ParseError;
	if ((bWantLods && !ParseLodRequest(LodsObj, LodReq, ParseError))
		|| (bWantCollision && !ParseCollisionRequest(CollisionObj, CollisionReq, ParseError)))
	{
		UAL_CommandUtils::SendError(RequestId, 400, ParseError);
		return;
	}

	bool bSave = true;
	Payload->TryGetBoolField(TEXT("save"), bSave);

	// 编辑器子系统在 PIE 期间一律拒绝（EditorScriptingHelpers::CheckIfInEditorAndPIE），
	// 与其让它返回一个看不出原因的失败，不如在门口说清楚
	if (UAL_CommandUtils::RefuseDuringPlay(RequestId, TEXT("生成网格 LOD / 碰撞"), TEXT("generating mesh LODs / collision")))
	{
		return;
	}

	UObject* Asset = LoadObject<UObject>(nullptr, *Path);
	if (!Asset)
	{
		UAL_CommandUtils::SendError(RequestId, 404, FString::Printf(TEXT("Mesh asset not found: %s"), *Path));
		return;
	}
	UStaticMesh* Mesh = Cast<UStaticMesh>(Asset);
	if (!Mesh)
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("mesh.optimize only works on static meshes: %s is %s"), *Path, *Asset->GetClass()->GetName()));
		return;
	}
	if (Mesh->GetNumSourceModels() == 0)
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("%s has no source geometry (cooked or broken asset); LODs and collision cannot be generated from it"), *Path));
		return;
	}

	// 刚导入、刚改过的网格可能还在后台编译，before 要读构建完的
	FinishMeshCompilation(Mesh);

	const bool bNanite = UALMeshCompat::IsNaniteEnabled(Mesh);

	/**
	 * 网格编辑器开着就先关、做完再开 —— 引擎自己的 SetLods / AddSimpleCollisions 改之前
	 * 都这么做，注释写的是「防止崩溃」（编辑器里的 LOD 面板和预览组件攥着旧渲染数据）。
	 * 只在真要写之前关一次；子系统函数里那次关闭到时候找不到编辑器，是空操作。
	 */
	UAssetEditorSubsystem* AssetEditors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
	bool bEditorClosed = false;
	auto CloseMeshEditorOnce = [&]()
	{
		if (!bEditorClosed && AssetEditors && AssetEditors->FindEditorForAsset(Mesh, /*bFocusIfOpen=*/false))
		{
			AssetEditors->CloseAllEditorsForAsset(Mesh);
			bEditorClosed = true;
		}
	};

	TSharedPtr<FJsonObject> LodResult;
	TSharedPtr<FJsonObject> CollisionResult;
	bool bLodAttempted = false;
	int32 KeepCount = 1;
	bool bCollisionAttempted = false;
	int32 CollisionTypeBefore = 0;
	bool bChanged = false;

	{
		FUAL_ScopedTransaction Transaction(NSLOCTEXT("UALMesh", "OptimizeMesh", "Optimize Static Mesh"));

		// ---------------- LOD ----------------
		if (bWantLods)
		{
			LodResult = MakeShared<FJsonObject>();
			LodResult->SetBoolField(TEXT("ok"), true);
			LodResult->SetNumberField(TEXT("requested_count"), LodReq.Count);
			LodResult->SetArrayField(TEXT("before"), ReadLodFacts(Mesh));

			const int32 LastImported = LastImportedLod(Mesh);
			// LOD1 起哪几级是导入的 —— 拒绝时要点名，replace_imported 时回执要点名
			TArray<FString> Imported;
			TArray<TSharedPtr<FJsonValue>> ImportedIndices;
			for (int32 Index = 1; Index <= LastImported; ++Index)
			{
				if (IsImportedLod(Mesh, Index))
				{
					Imported.Add(FString::Printf(TEXT("LOD%d"), Index));
					ImportedIndices.Add(MakeShared<FJsonValueNumber>(Index));
				}
			}
			if (LastImported > 0 && !LodReq.bKeepImported && !LodReq.bReplaceImported)
			{
				const bool bPlural = Imported.Num() > 1;
				MarkFailed(LodResult, FString::Printf(
					TEXT("refused: %s %s imported (artist-made, has its own source geometry). Generating LODs would delete %s and the engine cannot recreate %s. Ask the user first: to keep %s and only generate LODs after %s pass keep_imported=true; only if the user explicitly agrees to throw %s away (e.g. stale geometry after a boolean cut) pass replace_imported=true."),
					*FString::Join(Imported, TEXT(", ")), bPlural ? TEXT("are") : TEXT("is"),
					bPlural ? TEXT("them") : TEXT("it"), bPlural ? TEXT("them") : TEXT("it"),
					bPlural ? TEXT("them") : TEXT("it"), bPlural ? TEXT("them") : TEXT("it"), bPlural ? TEXT("them") : TEXT("it")));
			}
			else
			{
				KeepCount = LodReq.bKeepImported ? LastImported + 1 : 1;
				if (LodReq.Count <= KeepCount)
				{
					MarkFailed(LodResult, FString::Printf(
						TEXT("refused: LOD0..LOD%d are kept as imported, so count=%d leaves nothing to generate; count must be greater than %d"),
						KeepCount - 1, LodReq.Count, KeepCount));
				}
				else
				{
					CloseMeshEditorOnce();
					Mesh->Modify();

					// 自动屏占比开着就交给引擎算；关着（美术手调过）就不去动这个开关，
					// 新生成的每级取上一级的一半，保证逐级递减
					const bool bAutoScreenSize = UALMeshCompat::GetAutoComputeLODScreenSize(Mesh);

					// 和 SetLodsWithNotification 同一条路：截到要保留的级数，再逐级 AddSourceModel、
					// 抄上一级的构建/减面设置、改减面比例，最后 PostEditChange 触发重建
					Mesh->SetNumSourceModels(KeepCount);
					for (int32 Index = KeepCount; Index < LodReq.Count; ++Index)
					{
						Mesh->AddSourceModel();
						const FStaticMeshSourceModel& Prev = Mesh->GetSourceModel(Index - 1);
						FStaticMeshSourceModel& Src = Mesh->GetSourceModel(Index);
						Src.BuildSettings = Prev.BuildSettings;
						Src.ReductionSettings = Prev.ReductionSettings;
						// 百分比一律相对 LOD0、按面数停 —— 和 SetLods / LOD 组的语义一致
						Src.ReductionSettings.BaseLODModel = 0;
						Src.ReductionSettings.TerminationCriterion = EStaticMeshReductionTerimationCriterion::Triangles;
						Src.ReductionSettings.PercentTriangles = LodReq.Percent[Index - 1] / 100.0f;
						if (!bAutoScreenSize)
						{
							Src.ScreenSize.Default = Prev.ScreenSize.Default * 0.5f;
						}
					}

					Mesh->PostEditChange();
					FinishMeshCompilation(Mesh);

					bLodAttempted = true;
					bChanged = true;
					LodResult->SetBoolField(TEXT("auto_screen_size"), bAutoScreenSize);
					if (KeepCount > 1)
					{
						// 原样保留的级数（含 LOD0）。reduction 里对应这几级的条目被跳过了
						LodResult->SetNumberField(TEXT("kept_imported"), KeepCount);
					}
					if (LodReq.bReplaceImported && ImportedIndices.Num() > 0)
					{
						// 被换掉的导入级（换之前读的下标）。这是不可逆的那一步，回执必须点名
						LodResult->SetArrayField(TEXT("replaced_imported"), ImportedIndices);
					}
				}
			}
		}

		// ---------------- 碰撞 ----------------
		if (bWantCollision)
		{
			CollisionResult = MakeShared<FJsonObject>();
			CollisionResult->SetBoolField(TEXT("ok"), true);
			CollisionResult->SetStringField(TEXT("type"), CollisionReq.Type);
			CollisionResult->SetObjectField(TEXT("before"), ReadCollisionFacts(Mesh));

			const int32 TotalBefore = CollisionCount(Mesh, FString());
			CollisionTypeBefore = CollisionCount(Mesh, CollisionReq.Type);
			UStaticMeshEditorSubsystem* MeshEditing = GEditor ? GEditor->GetEditorSubsystem<UStaticMeshEditorSubsystem>() : nullptr;

			if (!MeshEditing)
			{
				MarkFailed(CollisionResult, TEXT("StaticMeshEditorSubsystem is not available in this editor"));
			}
			else if (CollisionReq.Type == TEXT("convex"))
			{
				if (!CollisionReq.bReplace && TotalBefore > 0)
				{
					// 引擎的凸包分解开头就 RemoveSimpleCollision，追加不了
					MarkFailed(CollisionResult, FString::Printf(
						TEXT("refused: convex decomposition always replaces all existing simple collision (%d shapes here) - that is how the engine does it. Pass replace=true to accept that."),
						TotalBefore));
				}
				else if (!Mesh->IsMeshDescriptionValid(0))
				{
					MarkFailed(CollisionResult, TEXT("LOD0 has no source geometry to decompose"));
				}
				else
				{
					CloseMeshEditorOnce();
					Mesh->Modify();
					if (UBodySetup* Body = Mesh->GetBodySetup())
					{
						Body->Modify();
					}
					// 网格编辑器「Auto Convex Collision」面板背后的同一个分解（DecomposeMeshToHulls）
					const bool bOk = MeshEditing->SetConvexDecompositionCollisionsWithNotification(
						Mesh, CollisionReq.HullCount, CollisionReq.MaxHullVerts, CollisionReq.HullPrecision, /*bApplyChanges=*/true);
					FinishMeshCompilation(Mesh);
					bCollisionAttempted = true;
					bChanged = true;
					// 凸包分解把所有类型都清了，「之前有几个凸包」不再是比较基准
					CollisionTypeBefore = 0;
					CollisionResult->SetBoolField(TEXT("replaced"), TotalBefore > 0);
					if (!bOk)
					{
						MarkFailed(CollisionResult, TEXT("the engine's convex decomposition reported failure (see Output Log, LogStaticMeshEditorSubsystem)"));
					}
				}
			}
			else
			{
				const EScriptCollisionShapeType Shape =
					CollisionReq.Type == TEXT("box") ? EScriptCollisionShapeType::Box
					: CollisionReq.Type == TEXT("sphere") ? EScriptCollisionShapeType::Sphere
					: EScriptCollisionShapeType::Capsule;

				CloseMeshEditorOnce();
				Mesh->Modify();
				if (UBodySetup* Body = Mesh->GetBodySetup())
				{
					Body->Modify();
				}

				const bool bRemove = CollisionReq.bReplace && TotalBefore > 0;
				if (bRemove)
				{
					// bApplyChanges=false：Modify 上面已经做过，重建留给下面那一次，免得构建两遍
					MeshEditing->RemoveCollisionsWithNotification(Mesh, /*bApplyChanges=*/false);
					CollisionTypeBefore = 0;
				}

				// 和网格编辑器 Collision 菜单里「Add Box/Sphere/Capsule Simplified Collision」同一个生成函数
				const int32 PrimIndex = MeshEditing->AddSimpleCollisionsWithNotification(Mesh, Shape, /*bApplyChanges=*/true);
				if (PrimIndex == INDEX_NONE)
				{
					// 子系统的早退路径（PIE 检查之类）不 PostEditChange，而上面可能已经删过旧碰撞 ——
					// 补一次重建（正常失败路径上它已经建过一次，多建一次无害），after 里如实读出现状
					Mesh->PostEditChange();
					MarkFailed(CollisionResult, FString::Printf(
						TEXT("the engine could not fit a %s to this mesh (empty or degenerate geometry)"), *CollisionReq.Type));
				}
				FinishMeshCompilation(Mesh);
				bCollisionAttempted = true;
				bChanged = true;
				CollisionResult->SetBoolField(TEXT("replaced"), bRemove);
			}
		}

		// 一项都没动：别在撤销栈上留一个空步骤
		if (!bChanged)
		{
			Transaction.Cancel();
		}
	}

	// ---------------- 全部做完、编译全部结束之后再读 after ----------------
	FinishMeshCompilation(Mesh);

	int32 Succeeded = 0;
	int32 Failed = 0;
	TArray<FString> FailureLines;

	if (LodResult.IsValid())
	{
		LodResult->SetArrayField(TEXT("after"), ReadLodFacts(Mesh));
		if (bLodAttempted && LodResult->GetBoolField(TEXT("ok")))
		{
			// 读回校验：级数对得上、要生成的那几级确实是生成的
			const int32 Built = Mesh->GetNumLODs();
			bool bGeneratedOk = Built == LodReq.Count;
			for (int32 Index = KeepCount; bGeneratedOk && Index < LodReq.Count; ++Index)
			{
				bGeneratedOk = !IsImportedLod(Mesh, Index);
			}
			if (!bGeneratedOk)
			{
				MarkFailed(LodResult, FString::Printf(
					TEXT("asked for %d LODs but the engine built %d (see Output Log for mesh build / reduction errors)"),
					LodReq.Count, Built));
			}
		}
		if (bNanite)
		{
			// TS 侧据此写说明：开着 Nanite 时这些 LOD 只在不走 Nanite 的路径上用
			LodResult->SetBoolField(TEXT("nanite"), true);
		}
		if (LodResult->GetBoolField(TEXT("ok")))
		{
			++Succeeded;
		}
		else
		{
			++Failed;
			FailureLines.Add(TEXT("lods: ") + LodResult->GetStringField(TEXT("reason")));
		}
	}

	if (CollisionResult.IsValid())
	{
		CollisionResult->SetObjectField(TEXT("after"), ReadCollisionFacts(Mesh));
		if (bCollisionAttempted && CollisionResult->GetBoolField(TEXT("ok")))
		{
			// 读回校验：这一类形状确实多出来了。子系统说成功但读不到，就不报成功
			const int32 TypeAfter = CollisionCount(Mesh, CollisionReq.Type);
			if (TypeAfter <= CollisionTypeBefore)
			{
				MarkFailed(CollisionResult, FString::Printf(
					TEXT("the engine reported success but read-back finds %d %s shapes (expected more than %d)"),
					TypeAfter, *CollisionReq.Type, CollisionTypeBefore));
			}
		}
		if (CollisionResult->GetBoolField(TEXT("ok")))
		{
			++Succeeded;
		}
		else
		{
			++Failed;
			FailureLines.Add(TEXT("collision: ") + CollisionResult->GetStringField(TEXT("reason")));
		}
	}

	// ---------------- 落盘 ----------------
	UPackage* Package = Mesh->GetOutermost();
	bool bSaved = false;
	FString SaveError;
	if (bChanged && bSave)
	{
		if (UEditorLoadingAndSavingUtils::SavePackages({ Package }, /*bOnlyDirty=*/false) && !Package->IsDirty())
		{
			bSaved = true;
		}
		else
		{
			SaveError = TEXT("save failed (file read-only, not checked out, or locked by another program); changes are in memory, save later with ue_save");
		}
	}

	if (bEditorClosed && AssetEditors)
	{
		AssetEditors->OpenEditorForAsset(Mesh);
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetBoolField(TEXT("ok"), Succeeded > 0);
	Data->SetStringField(TEXT("path"), Mesh->GetPathName());
	Data->SetStringField(TEXT("name"), Mesh->GetName());
	Data->SetBoolField(TEXT("nanite"), bNanite);
	Data->SetNumberField(TEXT("succeeded_count"), Succeeded);
	Data->SetNumberField(TEXT("failed_count"), Failed);
	Data->SetBoolField(TEXT("changed"), bChanged);
	Data->SetBoolField(TEXT("saved"), bSaved);
	if (!SaveError.IsEmpty())
	{
		Data->SetStringField(TEXT("save_error"), SaveError);
	}
	Data->SetBoolField(TEXT("dirty"), Package->IsDirty());
	Data->SetBoolField(TEXT("reopened_editor"), bEditorClosed);
	if (LodResult.IsValid())
	{
		Data->SetObjectField(TEXT("lods"), LodResult);
	}
	if (CollisionResult.IsValid())
	{
		Data->SetObjectField(TEXT("collision"), CollisionResult);
	}
	if (Succeeded == 0)
	{
		Data->SetStringField(TEXT("error"), FString::Printf(TEXT("nothing on %s was optimized%s: %s"),
			*Mesh->GetPathName(),
			bChanged ? TEXT(" (but the mesh WAS modified - check lods/collision.after)") : TEXT(""),
			*FString::Join(FailureLines, TEXT("; "))));
	}

	UE_LOG(LogUALMesh, Log, TEXT("mesh.optimize %s: %d ok, %d failed, changed=%d, saved=%d"),
		*Mesh->GetPathName(), Succeeded, Failed, bChanged ? 1 : 0, bSaved ? 1 : 0);

	UAL_CommandUtils::SendResponse(RequestId, 200, Data);
}
