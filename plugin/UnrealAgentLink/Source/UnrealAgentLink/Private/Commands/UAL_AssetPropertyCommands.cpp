#include "UAL_AssetPropertyCommands.h"
#include "UAL_CommandUtils.h"
#include "UAL_PropertyPath.h"
#include "UAL_ScopedTransaction.h"

#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "StaticMeshCompiler.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "TextureCompiler.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogUALAssetProps, Log, All);

namespace UALAssetProps
{
	/** 认 `/Game/X/T_A`、`/Game/X/T_A.T_A`、带 `.uasset` 的写法 */
	UObject* LoadAsset(const FString& RawPath, FString& OutPath)
	{
		OutPath = UAL_CommandUtils::NormalizeAssetPath(RawPath);
		UObject* Loaded = LoadObject<UObject>(nullptr, *OutPath);
		if (!Loaded && !OutPath.Contains(TEXT(".")))
		{
			FString AssetName;
			OutPath.Split(TEXT("/"), nullptr, &AssetName, ESearchCase::CaseSensitive, ESearchDir::FromEnd);
			Loaded = LoadObject<UObject>(nullptr, *FString::Printf(TEXT("%s.%s"), *OutPath, *AssetName));
		}
		return Loaded;
	}

	/**
	 * 等这个资产的异步编译做完。
	 *
	 * 静态网格的 PostEditChange 会起一次异步 Build（含 Nanite），贴图的会起一次异步压缩。
	 * 不等的话：下一条属性的写入和后台构建抢同一块数据（静态网格的属性在构建期间
	 * 是「借出去」的，引擎自己的访问器都会先等），回读读到的是半途的状态，存盘也存不全。
	 * FinishCompilation 对没在编译的资产是空操作。5.0–5.8 两个管理器的这个签名都在
	 * （5.6 起静态网格那个多了一个带默认值的参数）。
	 */
	void FinishCompilation(UObject* Asset)
	{
		if (UStaticMesh* Mesh = Cast<UStaticMesh>(Asset))
		{
			FStaticMeshCompilingManager::Get().FinishCompilation({ Mesh });
		}
		else if (UTexture* Texture = Cast<UTexture>(Asset))
		{
			FTextureCompilingManager::Get().FinishCompilation({ Texture });
		}
	}

	/** `TextureCompressionSettings::TC_Masks` → `TC_Masks`；`ETextureMipLoadOptions::AllMips` → `AllMips` */
	FString StripEnumScope(const FString& Text)
	{
		FString Right;
		if (Text.Split(TEXT("::"), nullptr, &Right, ESearchCase::CaseSensitive, ESearchDir::FromEnd))
		{
			return Right;
		}
		return Text;
	}

	bool TryParseNumber(const FString& Text, double& Out)
	{
		const FString Trimmed = Text.TrimStartAndEnd();
		if (Trimmed.IsEmpty() || !Trimmed.IsNumeric())
		{
			return false;
		}
		Out = FCString::Atod(*Trimmed);
		return true;
	}

	bool TryParseBool(const FString& Text, bool& Out)
	{
		if (Text.Equals(TEXT("true"), ESearchCase::IgnoreCase) || Text == TEXT("1"))
		{
			Out = true;
			return true;
		}
		if (Text.Equals(TEXT("false"), ESearchCase::IgnoreCase) || Text == TEXT("0"))
		{
			Out = false;
			return true;
		}
		return false;
	}

	bool NumbersMatch(double A, double B)
	{
		// float 属性回读是 0.10000000149 这种，按相对误差比
		return FMath::Abs(A - B) <= 1e-4 * FMath::Max(1.0, FMath::Max(FMath::Abs(A), FMath::Abs(B)));
	}

	enum class EMatch : uint8
	{
		Match,
		Mismatch,
		/** 形状比不了（数组、结构体、用数字写的枚举）—— 不替引擎下结论 */
		Unknown
	};

	bool StringsMatch(const FString& Requested, const FString& Actual)
	{
		if (Requested.Equals(Actual, ESearchCase::IgnoreCase))
		{
			return true;
		}
		if (StripEnumScope(Requested).Equals(StripEnumScope(Actual), ESearchCase::IgnoreCase))
		{
			return true;
		}
		// 资产引用：请求写 /Game/X/SM_A，回读是 /Game/X/SM_A.SM_A
		if (Requested.StartsWith(TEXT("/")) && !Requested.Contains(TEXT("."))
			&& Actual.StartsWith(Requested + TEXT("."), ESearchCase::IgnoreCase))
		{
			return true;
		}
		// 清空引用：请求 "" 或 "None"，回读 "None"
		const bool bRequestedEmpty = Requested.IsEmpty() || Requested.Equals(TEXT("None"), ESearchCase::IgnoreCase);
		const bool bActualEmpty = Actual.IsEmpty() || Actual.Equals(TEXT("None"), ESearchCase::IgnoreCase);
		return bRequestedEmpty && bActualEmpty;
	}

	EMatch Compare(const TSharedPtr<FJsonValue>& Requested, const TSharedPtr<FJsonValue>& Actual)
	{
		if (!Requested.IsValid() || !Actual.IsValid())
		{
			return EMatch::Unknown;
		}

		switch (Requested->Type)
		{
		case EJson::Boolean:
		{
			const bool Want = Requested->AsBool();
			if (Actual->Type == EJson::Boolean)
			{
				return Actual->AsBool() == Want ? EMatch::Match : EMatch::Mismatch;
			}
			if (Actual->Type == EJson::Number)
			{
				return (Actual->AsNumber() != 0.0) == Want ? EMatch::Match : EMatch::Mismatch;
			}
			bool Got = false;
			if (Actual->Type == EJson::String && TryParseBool(Actual->AsString(), Got))
			{
				return Got == Want ? EMatch::Match : EMatch::Mismatch;
			}
			return EMatch::Unknown;
		}

		case EJson::Number:
		{
			const double Want = Requested->AsNumber();
			if (Actual->Type == EJson::Number)
			{
				return NumbersMatch(Want, Actual->AsNumber()) ? EMatch::Match : EMatch::Mismatch;
			}
			if (Actual->Type == EJson::Boolean)
			{
				return (Want != 0.0) == Actual->AsBool() ? EMatch::Match : EMatch::Mismatch;
			}
			double Got = 0.0;
			if (Actual->Type == EJson::String && TryParseNumber(Actual->AsString(), Got))
			{
				return NumbersMatch(Want, Got) ? EMatch::Match : EMatch::Mismatch;
			}
			// 枚举用数字写、回读是名字：比不了
			return EMatch::Unknown;
		}

		case EJson::String:
		{
			const FString Want = Requested->AsString();
			if (Actual->Type == EJson::String)
			{
				return StringsMatch(Want, Actual->AsString()) ? EMatch::Match : EMatch::Mismatch;
			}
			if (Actual->Type == EJson::Number)
			{
				double WantNumber = 0.0;
				if (TryParseNumber(Want, WantNumber))
				{
					return NumbersMatch(WantNumber, Actual->AsNumber()) ? EMatch::Match : EMatch::Mismatch;
				}
				return EMatch::Unknown;
			}
			if (Actual->Type == EJson::Boolean)
			{
				bool WantBool = false;
				if (TryParseBool(Want, WantBool))
				{
					return WantBool == Actual->AsBool() ? EMatch::Match : EMatch::Mismatch;
				}
				return EMatch::Unknown;
			}
			return EMatch::Unknown;
		}

		default:
			return EMatch::Unknown;
		}
	}

	/**
	 * 路径上每一层对象各自那一截属性。
	 *
	 * `BodySetup.CollisionTraceFlag` 是两层：StaticMesh 上的 [BodySetup]，
	 * BodySetup 上的 [CollisionTraceFlag]。细节面板发通知也是这么分层发的 ——
	 * 先通知最里面的子对象（属性 = CollisionTraceFlag），再通知外面的资产
	 * （属性 = BodySetup），见引擎 PropertyNode.cpp 的 FPropertyNode::NotifyPostChange。
	 */
	struct FLevel
	{
		UObject* Object = nullptr;
		TArray<FProperty*> Props;
	};

	void BuildLevels(const TArray<UALPropertyPath::FResolvedStep>& Steps, TArray<FLevel>& OutLevels)
	{
		OutLevels.Reset();
		for (const UALPropertyPath::FResolvedStep& Step : Steps)
		{
			if (OutLevels.Num() == 0 || OutLevels.Last().Object != Step.Owner)
			{
				FLevel& Level = OutLevels.AddDefaulted_GetRef();
				Level.Object = Step.Owner;
			}
			OutLevels.Last().Props.Add(Step.Property);
		}
	}

	/**
	 * 这条路径在细节面板里能不能改。不能改的在写之前就拦下，并说清楚是哪一段、为什么。
	 *
	 * - 每一段都得是 CPF_Edit（细节面板里看得见）。SourceModels 这类内部数组不是 ——
	 *   改它等于绕开 LOD 生成流程，不归这个工具管。
	 * - 任何一段带 EditConst：灰着的，只读。
	 * - 穿进对象时，那个对象必须是这个资产自己的子对象（Outer 链在资产内）。
	 *   否则就是顺着引用改到了别的资产上 —— 那该对那个资产自己调一次。
	 * - 最后一段本身是 Instanced 子对象：换掉整个子对象不是细节面板会做的事，改它的字段。
	 */
	bool CheckEditable(
		UObject* Root,
		const FString& Path,
		const TArray<UALPropertyPath::FResolvedStep>& Steps,
		FString& OutReason,
		FString& OutError)
	{
		for (int32 Index = 0; Index < Steps.Num(); ++Index)
		{
			const UALPropertyPath::FResolvedStep& Step = Steps[Index];
			const FProperty* Prop = Step.Property;
			const FString Name = Prop->GetName();

			if (!Prop->HasAnyPropertyFlags(CPF_Edit))
			{
				OutReason = TEXT("not_editable");
				OutError = FString::Printf(
					TEXT("'%s' is not exposed in the Details panel, so this tool does not write it"), *Name);
				return false;
			}
			if (Prop->HasAnyPropertyFlags(CPF_EditConst))
			{
				OutReason = TEXT("read_only");
				OutError = FString::Printf(TEXT("'%s' is read-only in the Details panel"), *Name);
				return false;
			}
			if (Step.Descended && !Step.Descended->IsIn(Root))
			{
				OutReason = TEXT("not_editable");
				OutError = FString::Printf(
					TEXT("'%s' points to another asset (%s); change that asset directly"),
					*Name, *Step.Descended->GetPathName());
				return false;
			}
			const bool bLast = Index == Steps.Num() - 1;
			if (bLast && Prop->IsA<FObjectPropertyBase>() && Prop->HasAnyPropertyFlags(CPF_InstancedReference))
			{
				OutReason = TEXT("read_only");
				OutError = FString::Printf(
					TEXT("'%s' is an instanced sub-object; set its fields instead (e.g. '%s.<Field>')"),
					*Name, *Path);
				return false;
			}
		}
		return true;
	}

	TSharedPtr<FJsonObject> MakeResult(const FString& Path, const TSharedPtr<FJsonValue>& Requested)
	{
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("property"), Path);
		if (Requested.IsValid())
		{
			Result->SetField(TEXT("requested"), Requested);
		}
		else
		{
			Result->SetField(TEXT("requested"), MakeShared<FJsonValueNull>());
		}
		return Result;
	}

	void MarkFailed(const TSharedPtr<FJsonObject>& Result, const FString& Reason, const FString& Error)
	{
		Result->SetBoolField(TEXT("ok"), false);
		Result->SetStringField(TEXT("reason"), Reason);
		Result->SetStringField(TEXT("error"), Error);
	}
}

void FUAL_AssetPropertyCommands::RegisterCommands(TMap<FString, FHandlerFunc>& CommandMap)
{
	CommandMap.Add(TEXT("content.set_asset_properties"), &Handle_SetAssetProperties);
}

void FUAL_AssetPropertyCommands::Handle_SetAssetProperties(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
	FString RawPath;
	if (!Payload->TryGetStringField(TEXT("asset_path"), RawPath) || RawPath.TrimStartAndEnd().IsEmpty())
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("asset_path is required"));
		return;
	}

	TSharedPtr<FJsonObject> Properties;
	if (!UAL_CommandUtils::TryGetObjectFieldFlexible(Payload, TEXT("properties"), Properties)
		|| !Properties.IsValid() || Properties->Values.Num() == 0)
	{
		UAL_CommandUtils::SendError(RequestId, 400,
			TEXT("properties is required: an object of { \"PropertyPath\": value }, e.g. { \"NaniteSettings.bEnabled\": true }"));
		return;
	}

	bool bSave = true;
	Payload->TryGetBoolField(TEXT("save"), bSave);

	FString AssetPath;
	UObject* Asset = UALAssetProps::LoadAsset(RawPath, AssetPath);
	if (!Asset)
	{
		UAL_CommandUtils::SendError(RequestId, 404, FString::Printf(TEXT("Asset not found: %s"), *AssetPath));
		return;
	}
	if (Asset->IsA<UWorld>())
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("%s is a level (World). Level and actor settings go through the level/actor tools, not this one."),
			*AssetPath));
		return;
	}

	UPackage* Package = Asset->GetOutermost();
	TArray<TSharedPtr<FJsonValue>> Notes;

	// 写之前等一次：刚导入、刚改过的网格/贴图可能还在后台编译
	UALAssetProps::FinishCompilation(Asset);

	/**
	 * 静态网格编辑器开着时先关掉，改完再开回来。
	 *
	 * 照抄引擎自己的脚本接口 UStaticMeshEditorSubsystem::SetNaniteSettings / SetLods：
	 * 它们改之前都先 CloseAllEditorsForAsset，注释写的是「防止崩溃」。
	 * 网格编辑器里的 LOD 面板、预览组件都攥着旧的渲染数据，重建期间它们还在画。
	 * 只在真要写的时候才关（第一条要落地的属性之前）。
	 */
	UAssetEditorSubsystem* AssetEditors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
	bool bEditorClosed = false;
	auto CloseMeshEditorOnce = [&]()
	{
		if (bEditorClosed || !AssetEditors || !Asset->IsA<UStaticMesh>())
		{
			return;
		}
		if (AssetEditors->FindEditorForAsset(Asset, /*bFocusIfOpen=*/false))
		{
			AssetEditors->CloseAllEditorsForAsset(Asset);
			bEditorClosed = true;
		}
	};

	TArray<TSharedPtr<FJsonObject>> Results;
	int32 ChangedCount = 0;

	{
		FUAL_ScopedTransaction Transaction(NSLOCTEXT("UALAssetProps", "SetAssetProperties", "Set Asset Properties"));

		for (const auto& Pair : Properties->Values)
		{
			const FString Path = UAL_JsonKey(Pair.Key).TrimStartAndEnd();
			const TSharedPtr<FJsonValue>& Requested = Pair.Value;
			TSharedPtr<FJsonObject> Result = UALAssetProps::MakeResult(Path, Requested);
			Results.Add(Result);

			// null 转成属性文本是空串，ImportText 对数值和布尔会静默写成 0 / false
			if (!Requested.IsValid() || Requested->Type == EJson::Null)
			{
				UALAssetProps::MarkFailed(Result, TEXT("type_mismatch"), TEXT("value is null; give the value to set"));
				continue;
			}

			// 1. 解析路径
			TArray<UALPropertyPath::FResolvedStep> Steps;
			UALPropertyPath::EResolveFailure Failure = UALPropertyPath::EResolveFailure::None;
			FString Error;
			if (!UALPropertyPath::ResolvePath(Asset, Path, Steps, Failure, Error))
			{
				UALAssetProps::MarkFailed(Result,
					Failure == UALPropertyPath::EResolveFailure::NotFound ? TEXT("not_found") : TEXT("invalid_path"),
					Error);
				continue;
			}

			// 2. 细节面板里能不能改
			FString Reason;
			if (!UALAssetProps::CheckEditable(Asset, Path, Steps, Reason, Error))
			{
				UALAssetProps::MarkFailed(Result, Reason, Error);
				continue;
			}

			// 3. 已经是这个值就不动 —— 一次无谓的 Nanite 重建可能是几十秒
			FString ReadError;
			const TSharedPtr<FJsonValue> Before = UALPropertyPath::GetByPath(Asset, Path, ReadError);
			if (Before.IsValid())
			{
				Result->SetField(TEXT("before"), Before);
				if (UALAssetProps::Compare(Requested, Before) == UALAssetProps::EMatch::Match)
				{
					Result->SetBoolField(TEXT("unchanged"), true);
					continue;
				}
			}

			CloseMeshEditorOnce();

			// 4. 细节面板同款通知：最里层先，逐层往外
			TArray<UALAssetProps::FLevel> Levels;
			UALAssetProps::BuildLevels(Steps, Levels);

			TArray<TSharedPtr<FEditPropertyChain>> Chains;
			for (const UALAssetProps::FLevel& Level : Levels)
			{
				TSharedPtr<FEditPropertyChain> Chain = MakeShared<FEditPropertyChain>();
				for (FProperty* Prop : Level.Props)
				{
					Chain->AddTail(Prop);
				}
				Chain->SetActiveMemberPropertyNode(Level.Props[0]);
				Chain->SetActivePropertyNode(Level.Props.Last());
				Chains.Add(Chain);
			}

			for (const UALAssetProps::FLevel& Level : Levels)
			{
				Level.Object->Modify();
			}
			for (int32 Index = Levels.Num() - 1; Index >= 0; --Index)
			{
				Levels[Index].Object->PreEditChange(*Chains[Index]);
			}

			const bool bWritten = UALPropertyPath::SetByPath(Asset, Path, Requested, Error);

			// Pre 发过就必须配一次 Post，写失败也一样：静态网格的 PreEditChange 已经释放了渲染资源，
			// 不 Post 就不会重建，场景里用到它的组件全黑
			for (int32 Index = Levels.Num() - 1; Index >= 0; --Index)
			{
				FPropertyChangedEvent Event(Levels[Index].Props.Last(), EPropertyChangeType::ValueSet);
				Event.SetActiveMemberProperty(Levels[Index].Props[0]);
				FPropertyChangedChainEvent ChainEvent(*Chains[Index], Event);
				Levels[Index].Object->PostEditChangeChainProperty(ChainEvent);
			}

			UALAssetProps::FinishCompilation(Asset);

			if (!bWritten)
			{
				UALAssetProps::MarkFailed(Result, TEXT("type_mismatch"), Error);
				continue;
			}
			++ChangedCount;
		}

		// 一条都没写：别在撤销栈上留一个空步骤
		if (ChangedCount == 0)
		{
			Transaction.Cancel();
		}
	}

	// 5. 全部写完、构建都结束之后再回读 —— PostEditChange 可能夹紧、改写或连带改别的值
	int32 Succeeded = 0;
	int32 Failed = 0;
	TArray<FString> FailureLines;
	for (const TSharedPtr<FJsonObject>& Result : Results)
	{
		const FString Path = Result->GetStringField(TEXT("property"));
		if (Result->HasField(TEXT("reason")))
		{
			++Failed;
			FailureLines.Add(FString::Printf(TEXT("%s: %s"), *Path, *Result->GetStringField(TEXT("error"))));
			continue;
		}

		FString ReadError;
		const TSharedPtr<FJsonValue> Actual = UALPropertyPath::GetByPath(Asset, Path, ReadError);
		const TSharedPtr<FJsonValue> Requested = Result->TryGetField(TEXT("requested"));
		if (!Actual.IsValid())
		{
			// 写进去了但读不回来：不替引擎作答
			Result->SetBoolField(TEXT("ok"), true);
			Result->SetStringField(TEXT("actual_unavailable"), ReadError.IsEmpty() ? TEXT("value could not be serialized") : ReadError);
			++Succeeded;
			continue;
		}

		Result->SetField(TEXT("actual"), Actual);
		if (UALAssetProps::Compare(Requested, Actual) == UALAssetProps::EMatch::Mismatch)
		{
			UALAssetProps::MarkFailed(Result, TEXT("value_mismatch"), FString::Printf(
				TEXT("the engine kept %s instead of the requested value (clamped, rejected, or overridden by another setting)"),
				*UAL_CommandUtils::JsonValueToString(Actual)));
			++Failed;
			FailureLines.Add(FString::Printf(TEXT("%s: %s"), *Path, *Result->GetStringField(TEXT("error"))));
			continue;
		}
		Result->SetBoolField(TEXT("ok"), true);
		++Succeeded;
	}

	// 6. 落盘
	bool bSaved = false;
	FString SaveError;
	if (ChangedCount > 0 && bSave)
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
	else if (ChangedCount > 0)
	{
		Notes.Add(MakeShared<FJsonValueString>(TEXT("save=false: changes are in memory only")));
	}

	if (bEditorClosed && AssetEditors)
	{
		AssetEditors->OpenEditorForAsset(Asset);
	}

	TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
	Data->SetBoolField(TEXT("ok"), Succeeded > 0);
	Data->SetStringField(TEXT("asset_path"), Asset->GetPathName());
	Data->SetStringField(TEXT("asset_class"), Asset->GetClass()->GetName());
	Data->SetNumberField(TEXT("succeeded_count"), Succeeded);
	Data->SetNumberField(TEXT("failed_count"), Failed);
	Data->SetNumberField(TEXT("changed_count"), ChangedCount);
	Data->SetBoolField(TEXT("saved"), bSaved);
	if (!SaveError.IsEmpty())
	{
		Data->SetStringField(TEXT("save_error"), SaveError);
	}
	Data->SetBoolField(TEXT("dirty"), Package->IsDirty());
	Data->SetBoolField(TEXT("reopened_editor"), bEditorClosed);

	TArray<TSharedPtr<FJsonValue>> ResultValues;
	for (const TSharedPtr<FJsonObject>& Result : Results)
	{
		ResultValues.Add(MakeShared<FJsonValueObject>(Result));
	}
	Data->SetArrayField(TEXT("results"), ResultValues);
	Data->SetArrayField(TEXT("notes"), Notes);

	if (Succeeded == 0)
	{
		Data->SetStringField(TEXT("error"), FString::Printf(TEXT("none of the %d properties on %s was set: %s"),
			Failed, *Asset->GetPathName(), *FString::Join(FailureLines, TEXT("; "))));
	}

	UE_LOG(LogUALAssetProps, Log, TEXT("content.set_asset_properties %s: %d ok, %d failed, %d changed, saved=%d"),
		*Asset->GetPathName(), Succeeded, Failed, ChangedCount, bSaved ? 1 : 0);

	UAL_CommandUtils::SendResponse(RequestId, 200, Data);
}
