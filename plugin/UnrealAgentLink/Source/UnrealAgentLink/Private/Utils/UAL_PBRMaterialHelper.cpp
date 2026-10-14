#include "Utils/UAL_PBRMaterialHelper.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/Material.h"
#include "Engine/Texture2D.h"
#include "Engine/StaticMesh.h"
#include "UObject/SavePackage.h"
#include "UObject/Package.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
// 导入源文件名：资产在导入时被改过名，OpenGL 法线标记只剩在源文件名里
#include "EditorFramework/AssetImportData.h"

DEFINE_LOG_CATEGORY_STATIC(LogPBRHelper, Log, All);

namespace
{
	/**
	 * 按命名分隔符（_ - 空格 .）切词并转小写。
	 *
	 * 新加的那几个短缩写（ORM / ARM / RMA / MRA / Mask / nor / gl）只按**整词**认，
	 * 不做子串匹配：子串的话 "Normal" 里有 rma、"Armor" / "Warm" 里有 arm、
	 * "Glass" 里有 gl，全会误判。也不拆驼峰 —— 宁可认不出，也不认错。
	 */
	TArray<FString> UAL_NameTokens(const FString& Name)
	{
		TArray<FString> Tokens;
		FString Current;
		for (const TCHAR Ch : Name.ToLower())
		{
			if (Ch == TEXT('_') || Ch == TEXT('-') || Ch == TEXT(' ') || Ch == TEXT('.'))
			{
				if (!Current.IsEmpty())
				{
					Tokens.Add(Current);
					Current.Reset();
				}
			}
			else
			{
				Current.AppendChar(Ch);
			}
		}
		if (!Current.IsEmpty())
		{
			Tokens.Add(Current);
		}
		return Tokens;
	}

	/** 法线约定词：gl / opengl / dx / directx（Substance、Poly Haven 都这么写） */
	bool UAL_IsNormalConventionToken(const FString& Token)
	{
		return Token == TEXT("gl") || Token == TEXT("opengl") || Token == TEXT("dx") || Token == TEXT("directx");
	}

	/**
	 * 「类型词」= 名字里最后一个有意义的词。
	 *
	 * 贴图类型按惯例写在名字末尾：T_Rock_ORM、rock_arm_4k、Rock_Normal_GL。
	 * 末尾的分辨率（4k / 2048 / 01）和法线约定词跳过。只看末尾是为了不把
	 * "T_Arm_BaseColor"（手臂的颜色图）、"T_Mask_Albedo"（面具）认成打包遮罩。
	 */
	FString UAL_TypeToken(const TArray<FString>& Tokens)
	{
		for (int32 Index = Tokens.Num() - 1; Index >= 0; --Index)
		{
			const FString& Token = Tokens[Index];
			const bool bResolution = Token.IsNumeric() ||
				(Token.Len() >= 2 && Token.EndsWith(TEXT("k")) && Token.LeftChop(1).IsNumeric());
			if (bResolution || UAL_IsNormalConventionToken(Token))
			{
				continue;
			}
			return Token;
		}
		return FString();
	}

	bool UAL_HasOpenGLToken(const FString& Name)
	{
		for (const FString& Token : UAL_NameTokens(Name))
		{
			if (Token == TEXT("gl") || Token == TEXT("opengl"))
			{
				return true;
			}
		}
		return false;
	}
}

// ==============================================================================
// 辅助函数实现
// ==============================================================================

bool FUAL_PBRMaterialHelper::ContainsAnyKeyword(const FString& Text, const TArray<FString>& Keywords)
{
	FString LowerText = Text.ToLower();
	for (const FString& Keyword : Keywords)
	{
		if (LowerText.Contains(Keyword.ToLower()))
		{
			return true;
		}
	}
	return false;
}

FString FUAL_PBRMaterialHelper::RemoveTypeSuffix(const FString& TextureName)
{
	// 待实现
	return TextureName;
}

float FUAL_PBRMaterialHelper::CalculateNameSimilarity(const FString& Name1, const FString& Name2)
{
	// 待实现：使用简单的Levenshtein距离
	return 0.0f;
}

// ==============================================================================
// 核心功能实现（占位符，后续逐步填充）
// ==============================================================================

EUAL_PBRTextureType FUAL_PBRMaterialHelper::ClassifyTexture(const FString& TextureName)
{
	FString LowerName = TextureName.ToLower();

	// 打包遮罩和短缩写先认，而且只按末尾整词认（理由见 UAL_TypeToken）。
	//
	// 必须排在下面那些子串检测前面：T_Metal_ORM 会先撞上 "metal" 被当成金属度图，
	// 然后留着 sRGB 当单通道用 —— 三个通道的数据就全错了。
	{
		const FString TypeToken = UAL_TypeToken(UAL_NameTokens(TextureName));
		// ORM（glTF 的叫法）和 ARM（Poly Haven 的叫法）是同一种排布：R=AO G=Roughness B=Metallic
		if (TypeToken == TEXT("orm") || TypeToken == TEXT("arm"))
		{
			return EUAL_PBRTextureType::PackedORM;
		}
		if (TypeToken == TEXT("rma"))
		{
			return EUAL_PBRTextureType::PackedRMA;
		}
		if (TypeToken == TEXT("mra"))
		{
			return EUAL_PBRTextureType::PackedMRA;
		}
		// 只写 Mask 的不知道通道顺序：照数据图处理（关 sRGB），但不往材质里接
		if (TypeToken == TEXT("mask") || TypeToken == TEXT("masks"))
		{
			return EUAL_PBRTextureType::PackedMask;
		}
		// Poly Haven 的法线叫 nor_gl / nor_dx；"nor" 太短，只按整词认
		if (TypeToken == TEXT("nor"))
		{
			return EUAL_PBRTextureType::Normal;
		}
	}

	// Albedo/BaseColor/Diffuse 检测
	{
		TArray<FString> AlbedoKeywords = {
			TEXT("albedo"), TEXT("basecolor"), TEXT("base_color"), TEXT("diffuse"),
			TEXT("color"), TEXT("_d."), TEXT("_d_"), TEXT("_a."), TEXT("_a_"),
			TEXT("_bc."), TEXT("_bc_"), TEXT("_diff.")
		};
		if (ContainsAnyKeyword(LowerName, AlbedoKeywords))
		{
			return EUAL_PBRTextureType::Albedo;
		}
	}
	
	// Normal 检测
	//
	// 不含 "bump"：凹凸图是灰度高度，不是切线空间法线。当法线用的话 sRGB 关了、
	// 压缩成 BC5 只留 RG，着色直接是错的 —— 它归到下面的 Height。
	{
		TArray<FString> NormalKeywords = {
			TEXT("normal"), TEXT("nrm"), TEXT("nrml"), TEXT("_n."), TEXT("_n_"),
			TEXT("norm")
		};
		if (ContainsAnyKeyword(LowerName, NormalKeywords))
		{
			return EUAL_PBRTextureType::Normal;
		}
	}
	
	// Roughness 检测
	{
		TArray<FString> RoughnessKeywords = {
			TEXT("rough"), TEXT("_r."), TEXT("_r_"), TEXT("rgh")
		};
		if (ContainsAnyKeyword(LowerName, RoughnessKeywords))
		{
			return EUAL_PBRTextureType::Roughness;
		}
	}
	
	// Metallic/Metalness 检测
	{
		TArray<FString> MetallicKeywords = {
			TEXT("metal"), TEXT("_m."), TEXT("_m_"), TEXT("mtl")
		};
		if (ContainsAnyKeyword(LowerName, MetallicKeywords))
		{
			return EUAL_PBRTextureType::Metallic;
		}
	}
	
	// AO (Ambient Occlusion) 检测
	{
		TArray<FString> AOKeywords = {
			TEXT("_ao."), TEXT("_ao_"), TEXT("ambient"), TEXT("occlusion"),
			TEXT("ambientocclusion")
		};
		if (ContainsAnyKeyword(LowerName, AOKeywords))
		{
			return EUAL_PBRTextureType::AO;
		}
	}
	
	// Height/Displacement 检测
	{
		TArray<FString> HeightKeywords = {
			TEXT("height"), TEXT("displace"), TEXT("disp"), TEXT("_h."), TEXT("_h_"),
			TEXT("bump")
		};
		if (ContainsAnyKeyword(LowerName, HeightKeywords))
		{
			return EUAL_PBRTextureType::Height;
		}
	}
	
	// Emissive 检测
	{
		TArray<FString> EmissiveKeywords = {
			TEXT("emissive"), TEXT("emission"), TEXT("emit"), TEXT("glow")
		};
		if (ContainsAnyKeyword(LowerName, EmissiveKeywords))
		{
			return EUAL_PBRTextureType::Emissive;
		}
	}
	
	// Opacity/Alpha 检测
	{
		TArray<FString> OpacityKeywords = {
			TEXT("opacity"), TEXT("alpha"), TEXT("transparent"), TEXT("trans")
		};
		if (ContainsAnyKeyword(LowerName, OpacityKeywords))
		{
			return EUAL_PBRTextureType::Opacity;
		}
	}
	
	// Specular 检测
	{
		TArray<FString> SpecularKeywords = {
			TEXT("specular"), TEXT("spec"), TEXT("_s."), TEXT("_s_")
		};
		if (ContainsAnyKeyword(LowerName, SpecularKeywords))
		{
			return EUAL_PBRTextureType::Specular;
		}
	}
	
	// Subsurface 检测
	{
		TArray<FString> SubsurfaceKeywords = {
			TEXT("subsurface"), TEXT("sss"), TEXT("scattering")
		};
		if (ContainsAnyKeyword(LowerName, SubsurfaceKeywords))
		{
			return EUAL_PBRTextureType::Subsurface;
		}
	}
	
	return EUAL_PBRTextureType::Unknown;
}

FString FUAL_PBRMaterialHelper::ExtractBaseName(const FString& TextureName)
{
	FString BaseName = TextureName;

	// 法线约定词先摘掉：Rock_Normal_GL 要和 Rock_Albedo 分到同一组（基名都是 Rock），
	// 不摘的话下面只摘得掉一层，基名成了 Rock_Normal，法线自己单成一组
	{
		const TArray<FString> ConventionSuffixes = {
			TEXT("_OpenGL"), TEXT("_DirectX"), TEXT("_GL"), TEXT("_DX")
		};
		for (const FString& Suffix : ConventionSuffixes)
		{
			if (BaseName.EndsWith(Suffix, ESearchCase::IgnoreCase))
			{
				BaseName = BaseName.Left(BaseName.Len() - Suffix.Len());
				break;
			}
		}
	}

	// 移除常见的纹理类型后缀
	TArray<FString> Suffixes = {
		// 打包遮罩、凹凸、Poly Haven 的 nor —— 和 ClassifyTexture 认的词对齐
		TEXT("_ORM"), TEXT("_ARM"), TEXT("_RMA"), TEXT("_MRA"), TEXT("_Masks"), TEXT("_Mask"),
		TEXT("_Bump"), TEXT("_Nor"),
		TEXT("_Albedo"), TEXT("_BaseColor"), TEXT("_Diffuse"), TEXT("_Color"),
		TEXT("_Normal"), TEXT("_NRM"), TEXT("_N"),
		TEXT("_Roughness"), TEXT("_Rough"), TEXT("_R"),
		TEXT("_Metallic"), TEXT("_Metal"), TEXT("_M"),
		TEXT("_AO"), TEXT("_Occlusion"),
		TEXT("_Height"), TEXT("_Displacement"), TEXT("_H"),
		TEXT("_Emissive"), TEXT("_Emit"),
		TEXT("_Opacity"), TEXT("_Alpha"),
		TEXT("_Specular"), TEXT("_Spec"), TEXT("_S"),
		TEXT("_D"), TEXT("_A"), TEXT("_BC")
	};
	
	// 不区分大小写的后缀移除
	for (const FString& Suffix : Suffixes)
	{
		if (BaseName.EndsWith(Suffix, ESearchCase::IgnoreCase))
		{
			BaseName = BaseName.Left(BaseName.Len() - Suffix.Len());
			break;
		}
	}
	
	// 移除数字后缀（例如 _01, _02）
	if (BaseName.Len() > 3)
	{
		int32 UnderscorePos = BaseName.Len() - 3;
		if (BaseName[UnderscorePos] == '_' &&
			FChar::IsDigit(BaseName[UnderscorePos + 1]) &&
			FChar::IsDigit(BaseName[UnderscorePos + 2]))
		{
			BaseName = BaseName.Left(UnderscorePos);
		}
	}
	
	return BaseName.TrimStartAndEnd();
}

TArray<FUAL_TextureGroup> FUAL_PBRMaterialHelper::GroupTexturesByAsset(const TArray<UTexture2D*>& Textures)
{
	TMap<FString, FUAL_TextureGroup> GroupMap;
	
	for (UTexture2D* Texture : Textures)
	{
		if (!Texture) continue;
		
		FString TextureName = Texture->GetName();
		EUAL_PBRTextureType Type = ClassifyTexture(TextureName);
		
		// 只处理识别的纹理类型
		if (Type == EUAL_PBRTextureType::Unknown)
		{
			UE_LOG(LogPBRHelper, Warning, TEXT("Unknown texture type: %s"), *TextureName);
			continue;
		}
		
		// 提取基础名称
		FString BaseName = ExtractBaseName(TextureName);
		
		// 如果该基础名称的组不存在，创建新组
		if (!GroupMap.Contains(BaseName))
		{
			FUAL_TextureGroup NewGroup;
			NewGroup.BaseName = BaseName;
			GroupMap.Add(BaseName, NewGroup);
		}
		
		// 添加到对应组
		FUAL_TextureGroup& Group = GroupMap[BaseName];
		
		// 检查是否已有相同类型的纹理
		if (Group.Textures.Contains(Type))
		{
			UE_LOG(LogPBRHelper, Warning, 
				TEXT("Duplicate texture type %d for asset '%s', keeping first one"),
				(int32)Type, *BaseName);
		}
		else
		{
			Group.Textures.Add(Type, Texture);
			UE_LOG(LogPBRHelper, Log, 
				TEXT("Grouped texture: %s -> %s (Type: %d)"),
				*TextureName, *BaseName, (int32)Type);
		}
	}
	
	// 转换Map为Array
	TArray<FUAL_TextureGroup> Result;
	for (auto& Pair : GroupMap)
	{
		Result.Add(Pair.Value);
	}
	
	UE_LOG(LogPBRHelper, Log, TEXT("Grouped %d textures into %d assets"), 
		Textures.Num(), Result.Num());
	
	return Result;
}

UMaterialInstanceConstant* FUAL_PBRMaterialHelper::CreatePBRMaterialInstance(
	const FString& MaterialName,
	const FString& DestinationPath,
	const FUAL_TextureGroup& TextureGroup,
	const FUAL_PBRMaterialOptions& Options,
	TArray<FUAL_PBRTextureReport>* OutTextureReports)
{
	if (!TextureGroup.IsValid())
	{
		UE_LOG(LogPBRHelper, Warning, TEXT("Invalid texture group for material creation"));
		return nullptr;
	}
	
	// 1. 加载Master Material
	FString MasterMatPath = Options.MasterMaterialPath.IsEmpty() ? 
		TEXT("/Engine/EngineMaterials/DefaultMaterial") : Options.MasterMaterialPath;
	
	UMaterial* MasterMaterial = LoadObject<UMaterial>(nullptr, *MasterMatPath);
	if (!MasterMaterial)
	{
		UE_LOG(LogPBRHelper, Error, TEXT("Failed to load Master Material: %s"), *MasterMatPath);
		return nullptr;
	}
	
	// 2. 确定材质实例名称
	FString FinalMatName = Options.bUseStandardNaming ? 
		StandardizeAssetName(MaterialName, TEXT("MaterialInstance")) : MaterialName;
	
	// 3. 创建Package
	FString PackagePath = DestinationPath / FinalMatName;
	UPackage* Package = CreatePackage(*PackagePath);
	if (!Package)
	{
		UE_LOG(LogPBRHelper, Error, TEXT("Failed to create package: %s"), *PackagePath);
		return nullptr;
	}
	
	// 4. 创建Material Instance Constant
	UMaterialInstanceConstant* MatInst = NewObject<UMaterialInstanceConstant>(
		Package,
		FName(*FinalMatName),
		RF_Public | RF_Standalone | RF_Transactional);
	
	if (!MatInst)
	{
		UE_LOG(LogPBRHelper, Error, TEXT("Failed to create Material Instance"));
		return nullptr;
	}
	
	// 5. 设置Parent Material
	MatInst->SetParentEditorOnly(MasterMaterial);
	
	// 6. 配置纹理并设置参数
	TMap<UTexture2D*, bool> FlippedByNaming;
	if (Options.bAutoConfigureTextures)
	{
		for (const auto& Pair : TextureGroup.Textures)
		{
			const bool bWasFlipped = Pair.Value && Pair.Value->bFlipGreenChannel;
			ConfigureTextureSettings(Pair.Value, Pair.Key);
			FlippedByNaming.Add(Pair.Value, Pair.Value && !bWasFlipped && Pair.Value->bFlipGreenChannel);
		}
	}
	
	// 7. 设置纹理参数到材质实例
	// 参数名称匹配 M_UAMaster 母材质中的定义
	//
	// 打包遮罩（ORM/RMA/MRA/Mask）一律不接：母材质的 Roughness / Ambient Occlusion 参数
	// 各自读一张单通道图，读的是哪个通道在这里看不见，接上去等于随手挑一个通道当粗糙度。
	// 通道含义写进回执（见 GetPackedChannels），由调用方在自己的材质里按通道拆开接。
	TMap<EUAL_PBRTextureType, FString> WiredParams;
	auto SetParam = [&](EUAL_PBRTextureType Type, const TCHAR* ParamName)
	{
		MatInst->SetTextureParameterValueEditorOnly(
			FMaterialParameterInfo(ParamName),
			TextureGroup.Textures[Type]);
		WiredParams.Add(Type, ParamName);
		UE_LOG(LogPBRHelper, Log, TEXT("Set %s texture"), ParamName);
	};
	
	// Albedo/BaseColor
	if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::Albedo))
	{
		SetParam(EUAL_PBRTextureType::Albedo, TEXT("Albedo"));
	}
	
	// Normal
	if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::Normal))
	{
		SetParam(EUAL_PBRTextureType::Normal, TEXT("Normal"));
	}
	
	// Roughness
	if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::Roughness))
	{
		SetParam(EUAL_PBRTextureType::Roughness, TEXT("Roughness"));
	}
	
	// AO (Ambient Occlusion) - 注意参数名有空格
	if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::AO))
	{
		SetParam(EUAL_PBRTextureType::AO, TEXT("Ambient Occlusion"));
	}
	
	// Overlay (用于叠加层贴图)
	// 如果有 Height 或 Opacity 类型的贴图，尝试设置为 Overlay
	if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::Height))
	{
		SetParam(EUAL_PBRTextureType::Height, TEXT("Overlay"));
	}
	else if (TextureGroup.Textures.Contains(EUAL_PBRTextureType::Opacity))
	{
		SetParam(EUAL_PBRTextureType::Opacity, TEXT("Overlay"));
	}
	
	if (OutTextureReports)
	{
		for (const auto& Pair : TextureGroup.Textures)
		{
			FUAL_PBRTextureReport Report;
			Report.Texture = Pair.Value;
			Report.Type = Pair.Key;
			if (const FString* Param = WiredParams.Find(Pair.Key))
			{
				Report.MaterialParameter = *Param;
			}
			if (const bool* bFlipped = FlippedByNaming.Find(Pair.Value))
			{
				Report.bFlippedGreenByNaming = *bFlipped;
			}
			OutTextureReports->Add(Report);
		}
	}
	
	// 8. 标记为已修改并保存
	Package->MarkPackageDirty();
	MatInst->PostEditChange();
	
	// 9. 注册到AssetRegistry
	FAssetRegistryModule::AssetCreated(MatInst);
	
	UE_LOG(LogPBRHelper, Log, TEXT("Created PBR Material Instance: %s with %d textures"),
		*FinalMatName, TextureGroup.Textures.Num());
	
	return MatInst;
}

void FUAL_PBRMaterialHelper::ApplyMaterialToMesh(
	UStaticMesh* StaticMesh,
	UMaterialInterface* Material,
	int32 MaterialIndex)
{
	if (!StaticMesh || !Material)
	{
		UE_LOG(LogPBRHelper, Warning, TEXT("Invalid mesh or material for ApplyMaterialToMesh"));
		return;
	}
	
	// 确保材质槽索引有效
	if (MaterialIndex < 0 || MaterialIndex >= StaticMesh->GetStaticMaterials().Num())
	{
		UE_LOG(LogPBRHelper, Warning, 
			TEXT("Invalid material index %d for mesh %s (has %d slots)"),
			MaterialIndex, *StaticMesh->GetName(), StaticMesh->GetStaticMaterials().Num());
		return;
	}
	
	// 应用材质
	StaticMesh->SetMaterial(MaterialIndex, Material);
	StaticMesh->PostEditChange();
	
	UE_LOG(LogPBRHelper, Log, 
		TEXT("Applied material '%s' to mesh '%s' at slot %d"),
		*Material->GetName(), *StaticMesh->GetName(), MaterialIndex);
}

FString FUAL_PBRMaterialHelper::StandardizeAssetName(const FString& BaseName, const FString& AssetType)
{
	FString Prefix;
	
	// 根据UE命名约定添加前缀
	if (AssetType == TEXT("Texture"))
	{
		Prefix = TEXT("T_");
	}
	else if (AssetType == TEXT("Material"))
	{
		Prefix = TEXT("M_");
	}
	else if (AssetType == TEXT("MaterialInstance"))
	{
		Prefix = TEXT("MI_");
	}
	else if (AssetType == TEXT("StaticMesh"))
	{
		Prefix = TEXT("SM_");
	}
	else if (AssetType == TEXT("SkeletalMesh"))
	{
		Prefix = TEXT("SK_");
	}
	
	// 如果已有前缀，不重复添加
	if (BaseName.StartsWith(Prefix))
	{
		return BaseName;
	}
	
	return Prefix + BaseName;
}

void FUAL_PBRMaterialHelper::ConfigureTextureSettings(UTexture2D* Texture, EUAL_PBRTextureType Type)
{
	if (!Texture) return;
	
	bool bModified = false;
	
	switch (Type)
	{
		case EUAL_PBRTextureType::Albedo:
		case EUAL_PBRTextureType::Emissive:
			// Albedo和Emissive使用sRGB
			if (!Texture->SRGB)
			{
				Texture->SRGB = true;
				bModified = true;
			}
			Texture->CompressionSettings = TC_Default;
			break;
			
		case EUAL_PBRTextureType::Normal:
			// 法线贴图特殊设置
			Texture->SRGB = false;
			Texture->CompressionSettings = TC_Normalmap;
			bModified = true;
			/*
			 * 绿通道翻转只认明确信号：名字里有独立的 gl / opengl 词（Substance 导出的
			 * Normal_OpenGL、Poly Haven 的 nor_gl）。UE 是 DirectX 约定（绿朝下），
			 * OpenGL 约定的法线不翻就是凹凸反了。
			 *
			 * 不从图像内容猜 —— 看像素判断朝向没有可靠办法，猜错比不翻更糟。
			 * 也只会打开不会关掉：用户自己已经勾上的不动。
			 */
			if (!Texture->bFlipGreenChannel && HasOpenGLNormalMarker(Texture))
			{
				Texture->bFlipGreenChannel = true;
				UE_LOG(LogPBRHelper, Log, TEXT("Flipped green channel (OpenGL marker in name): %s"), *Texture->GetName());
			}
			UE_LOG(LogPBRHelper, Log, TEXT("Configured Normal map: %s"), *Texture->GetName());
			break;
			
		case EUAL_PBRTextureType::Roughness:
		case EUAL_PBRTextureType::Metallic:
		case EUAL_PBRTextureType::AO:
		case EUAL_PBRTextureType::Height:
		case EUAL_PBRTextureType::Opacity:
		case EUAL_PBRTextureType::Specular:
		case EUAL_PBRTextureType::PackedORM:
		case EUAL_PBRTextureType::PackedRMA:
		case EUAL_PBRTextureType::PackedMRA:
		case EUAL_PBRTextureType::PackedMask:
		{
			// 数据贴图不使用sRGB
			if (Texture->SRGB)
			{
				Texture->SRGB = false;
				bModified = true;
			}
			/*
			 * 压缩用 Masks 而不是 Default：两者压缩格式一样，但 Masks 是引擎里「线性数据」
			 * 的那一档 —— 不能再被勾回 sRGB（UTexture::PostEditChangeProperty 会强制关掉），
			 * 拿它新建采样节点时引擎给的采样器类型是 Masks 而不是 Color。
			 * 原来改了这里却不置 bModified，SRGB 本来就关着时连 UpdateResource 都不调。
			 *
			 * 导入器给浮点源（EXR/HDR）挑的 HDR 系压缩不动：改成 Masks 会把 16/32 位
			 * 压成 8 位，高度图最怕这个。这是导入器自己的判断，不是我们猜的。
			 */
			const bool bFloatCompression =
				Texture->CompressionSettings == TC_HDR ||
				Texture->CompressionSettings == TC_HDR_Compressed ||
				Texture->CompressionSettings == TC_HalfFloat;
			if (!bFloatCompression && Texture->CompressionSettings != TC_Masks)
			{
				Texture->CompressionSettings = TC_Masks;
				bModified = true;
			}
			break;
		}
			
		default:
			break;
	}
	
	if (bModified)
	{
		Texture->UpdateResource();
		Texture->MarkPackageDirty();
	}
}

const TCHAR* FUAL_PBRMaterialHelper::GetTextureTypeName(EUAL_PBRTextureType Type)
{
	switch (Type)
	{
		case EUAL_PBRTextureType::Albedo:     return TEXT("albedo");
		case EUAL_PBRTextureType::Normal:     return TEXT("normal");
		case EUAL_PBRTextureType::Roughness:  return TEXT("roughness");
		case EUAL_PBRTextureType::Metallic:   return TEXT("metallic");
		case EUAL_PBRTextureType::AO:         return TEXT("ao");
		case EUAL_PBRTextureType::Height:     return TEXT("height");
		case EUAL_PBRTextureType::Emissive:   return TEXT("emissive");
		case EUAL_PBRTextureType::Opacity:    return TEXT("opacity");
		case EUAL_PBRTextureType::Specular:   return TEXT("specular");
		case EUAL_PBRTextureType::Subsurface: return TEXT("subsurface");
		case EUAL_PBRTextureType::PackedORM:  return TEXT("packed_orm");
		case EUAL_PBRTextureType::PackedRMA:  return TEXT("packed_rma");
		case EUAL_PBRTextureType::PackedMRA:  return TEXT("packed_mra");
		case EUAL_PBRTextureType::PackedMask: return TEXT("packed_mask");
		default:                              return TEXT("unknown");
	}
}

bool FUAL_PBRMaterialHelper::GetPackedChannels(EUAL_PBRTextureType Type,
	const TCHAR*& OutR, const TCHAR*& OutG, const TCHAR*& OutB)
{
	switch (Type)
	{
		case EUAL_PBRTextureType::PackedORM:
			OutR = TEXT("ao"); OutG = TEXT("roughness"); OutB = TEXT("metallic");
			return true;
		case EUAL_PBRTextureType::PackedRMA:
			OutR = TEXT("roughness"); OutG = TEXT("metallic"); OutB = TEXT("ao");
			return true;
		case EUAL_PBRTextureType::PackedMRA:
			OutR = TEXT("metallic"); OutG = TEXT("roughness"); OutB = TEXT("ao");
			return true;
		default:
			// PackedMask：名字只说了「是遮罩」，没说哪个通道是什么 —— 不编一个出来
			return false;
	}
}

bool FUAL_PBRMaterialHelper::HasOpenGLNormalMarker(const UTexture2D* Texture)
{
	if (!Texture)
	{
		return false;
	}
	if (UAL_HasOpenGLToken(Texture->GetName()))
	{
		return true;
	}
#if WITH_EDITORONLY_DATA
	// 导入时 asset_names 改过名（rock_nor_gl.png → T_Rock_N），标记就只剩在源文件名里
	if (Texture->AssetImportData)
	{
		const FString SourceFile = Texture->AssetImportData->GetFirstFilename();
		if (!SourceFile.IsEmpty() && UAL_HasOpenGLToken(FPaths::GetBaseFilename(SourceFile)))
		{
			return true;
		}
	}
#endif
	return false;
}

int32 FUAL_PBRMaterialHelper::BatchProcessPBRAssets(
	const TArray<UTexture2D*>& ImportedTextures,
	const TArray<UStaticMesh*>& ImportedMeshes,
	const FString& DestinationPath,
	const FUAL_PBRMaterialOptions& Options,
	TArray<UMaterialInstanceConstant*>& OutCreatedMaterials,
	TArray<FUAL_PBRTextureReport>* OutTextureReports)
{
	UE_LOG(LogPBRHelper, Log, TEXT("Starting batch PBR processing: %d textures, %d meshes"),
		ImportedTextures.Num(), ImportedMeshes.Num());
	
	OutCreatedMaterials.Empty();
	
	// 如果没有纹理，无法创建PBR材质
	if (ImportedTextures.Num() == 0)
	{
		UE_LOG(LogPBRHelper, Warning, TEXT("No textures to process"));
		return 0;
	}
	
	// 1. 将纹理按资产分组
	TArray<FUAL_TextureGroup> TextureGroups = GroupTexturesByAsset(ImportedTextures);
	
	if (TextureGroups.Num() == 0)
	{
		UE_LOG(LogPBRHelper, Warning, TEXT("No valid texture groups found"));
		return 0;
	}
	
	int32 SuccessCount = 0;
	
	// 2. 为每个纹理组创建PBR材质
	for (const FUAL_TextureGroup& Group : TextureGroups)
	{
		// 材质名称基于纹理组的基础名称
		FString MaterialName = Group.BaseName + TEXT("_Mat");
		
		UMaterialInstanceConstant* Material = CreatePBRMaterialInstance(
			MaterialName,
			DestinationPath,
			Group,
			Options,
			OutTextureReports);
		
		if (Material)
		{
			OutCreatedMaterials.Add(Material);
			SuccessCount++;
			
			UE_LOG(LogPBRHelper, Log, TEXT("Created material for group: %s"), *Group.BaseName);
			
			// 3. 如果启用自动应用，尝试将材质应用到网格体
			if (Options.bApplyToMesh && ImportedMeshes.Num() > 0)
			{
				// 尝试找到名称匹配的网格体
				UStaticMesh* MatchedMesh = nullptr;
				
				for (UStaticMesh* Mesh : ImportedMeshes)
				{
					if (Mesh && Mesh->GetName().Contains(Group.BaseName))
					{
						MatchedMesh = Mesh;
						break;
					}
				}
				
				// 如果没有找到名称匹配的，并且只有一个网格体和一个材质组，自动匹配
				if (!MatchedMesh && ImportedMeshes.Num() == 1 && TextureGroups.Num() == 1)
				{
					MatchedMesh = ImportedMeshes[0];
					UE_LOG(LogPBRHelper, Log, TEXT("Auto-matching single mesh to single material group"));
				}
				
				// 应用材质
				if (MatchedMesh)
				{
					ApplyMaterialToMesh(MatchedMesh, Material, 0);
					UE_LOG(LogPBRHelper, Log, TEXT("Applied material to mesh: %s"),  *MatchedMesh->GetName());
				}
				else
				{
					UE_LOG(LogPBRHelper, Warning, 
						TEXT("No matching mesh found for material group: %s"), *Group.BaseName);
				}
			}
		}
		else
		{
			UE_LOG(LogPBRHelper, Error, TEXT("Failed to create material for group: %s"), 
				*Group.BaseName);
		}
	}
	
	UE_LOG(LogPBRHelper, Log, 
		TEXT("Batch processing complete: Created %d/%d PBR materials"),
		SuccessCount, TextureGroups.Num());
	
	return SuccessCount;
}
