// Copyright Epic Games, Inc. All Rights Reserved.
// UnrealAgentLink - Widget Commands

#include "UAL_WidgetCommands.h"
#include "UAL_CommandUtils.h"

// UMG & Widget Blueprint
#include "Blueprint/UserWidget.h"
#include "Blueprint/WidgetTree.h"
#include "Components/Widget.h"
#include "Components/PanelWidget.h"
#include "Components/PanelSlot.h"
#include "Components/CanvasPanel.h"
#include "Components/CanvasPanelSlot.h"
#include "Components/VerticalBox.h"
#include "Components/VerticalBoxSlot.h"
#include "Components/HorizontalBox.h"
#include "Components/HorizontalBoxSlot.h"
#include "Components/Overlay.h"
#include "Components/OverlaySlot.h"
#include "UAL_ScopedTransaction.h"
#include "Components/Button.h"
#include "Components/TextBlock.h"
#include "Components/Image.h"
#include "Components/Border.h"
#include "Components/ScrollBox.h"
#include "Components/SizeBox.h"
#include "Components/Spacer.h"
#include "Components/ProgressBar.h"
#include "Components/Slider.h"
#include "Components/CheckBox.h"
#include "Components/ComboBoxString.h"
#include "Components/EditableText.h"
#include "Components/EditableTextBox.h"
#include "Components/SpinBox.h"
#include "Components/RichTextBlock.h"
// 字号和对齐（FontSize / Justification）。UTextLayoutWidget 是 TextBlock、
// RichTextBlock、EditableText(Box) 的共同基类，Justification 声明在它身上
#include "Components/TextWidgetTypes.h"
#include "Components/GridPanel.h"
#include "Components/GridSlot.h"
#include "Components/WrapBox.h"
#include "Components/UniformGridPanel.h"

// Editor utilities
#include "Editor.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"

// Rendering (for Preview)
#include "Slate/WidgetRenderer.h"
#include "RenderingThread.h"
#include "UObject/Package.h"
#include "Engine/TextureRenderTarget2D.h"
#include "Engine/UserInterfaceSettings.h"
#include "IImageWrapperModule.h"
#include "IImageWrapper.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "HAL/PlatformFileManager.h"
// widget.set_property 表外的属性按反射写，值走 JSON ↔ 属性转换
#include "JsonObjectConverter.h"

// 仅编辑器模式 (UMGEditor 模块)
#if WITH_EDITOR
#include "WidgetBlueprint.h"
#include "WidgetBlueprintFactory.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "FileHelpers.h"
// widget.make_variable 改名要连带图表引用一起改
#include "Kismet2/Kismet2NameValidators.h"
#include "K2Node_Variable.h"
#include "K2Node_ComponentBoundEvent.h"
#include "Animation/WidgetAnimation.h"
#include "Blueprint/WidgetNavigation.h"
#include "MovieScene.h"
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8)
#include "WidgetBlueprintOperationUtils.h"
#elif ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6
// 改名时同步 UI Component 扩展里记的控件名（5.6/5.7 引擎 RenameWidget 里的 FUIComponentUtils::OnWidgetRenamed）
#include "WidgetBlueprintExtension.h"
#include "UIComponentWidgetBlueprintExtension.h"
#endif
#endif

DEFINE_LOG_CATEGORY_STATIC(LogUALWidget, Log, All);

// ============================================================================
// 辅助：生成唯一 Widget 名称（防止重名崩溃）
// ============================================================================

static FName MakeUniqueWidgetName(UWidgetTree* WidgetTree, const FString& DesiredName)
{
	if (DesiredName.IsEmpty())
	{
		return NAME_None; // 让 ConstructWidget 自动生成
	}

	FName TestName(*DesiredName);
	if (!WidgetTree->FindWidget(TestName))
	{
		return TestName;
	}

	// 名称冲突，追加后缀
	for (int32 i = 1; i < 1000; ++i)
	{
		FString SuffixedName = FString::Printf(TEXT("%s_%d"), *DesiredName, i);
		TestName = FName(*SuffixedName);
		if (!WidgetTree->FindWidget(TestName))
		{
			UE_LOG(LogUALWidget, Warning, TEXT("Widget name '%s' already exists, renamed to '%s'"),
				*DesiredName, *SuffixedName);
			return TestName;
		}
	}

	// 极端情况，回退到自动命名
	UE_LOG(LogUALWidget, Error, TEXT("Failed to generate unique name for '%s' after 999 attempts"), *DesiredName);
	return NAME_None;
}

#if WITH_EDITOR
/** 把控件蓝图自己（或它的子类）放进自己的树里，编译时无限递归 */
static bool UAL_WouldNestSelf(const UWidgetBlueprint* WidgetBP, const UClass* Class)
{
	return WidgetBP && Class
		&& ((WidgetBP->GeneratedClass && Class->IsChildOf(WidgetBP->GeneratedClass))
			|| (WidgetBP->SkeletonGeneratedClass && Class->IsChildOf(WidgetBP->SkeletonGeneratedClass)));
}
#endif

// ============================================================================
// 命令注册
// ============================================================================

void FUAL_WidgetCommands::RegisterCommands(TMap<FString, TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>>& CommandMap)
{
	// Phase 1: 只读能力
	CommandMap.Add(TEXT("widget.get_hierarchy"), &Handle_GetHierarchy);
	
	// Phase 2: 创建 + CanvasPanel 布局
	CommandMap.Add(TEXT("widget.create"), &Handle_Create);
	CommandMap.Add(TEXT("widget.set_canvas_slot"), &Handle_SetCanvasSlot);
	
	// Phase 3: 通用子控件添加。
	// add_control / add_to_vertical / add_to_horizontal 已删（2026-09-16）——
	// add_child 认所有容器（Canvas/VBox/HBox/Overlay…）且收同一套 slot 参数，
	// 那三条是它出现之前的分容器版本，盒子这边一条都没调过
	CommandMap.Add(TEXT("widget.add_child"), &Handle_AddChild);
	CommandMap.Add(TEXT("widget.set_vertical_slot"), &Handle_SetVerticalSlot);
	
	// Phase 4: 预览渲染
	CommandMap.Add(TEXT("widget.preview"), &Handle_Preview);
	
	// Phase 5: 事件绑定
	CommandMap.Add(TEXT("widget.make_variable"), &Handle_MakeVariable);
	CommandMap.Add(TEXT("widget.set_property"), &Handle_SetProperty);

	// Phase 6: 改现成的界面
	CommandMap.Add(TEXT("widget.replace"), &Handle_Replace);
	CommandMap.Add(TEXT("widget.remove"), &Handle_Remove);

	UE_LOG(LogUALWidget, Log, TEXT("FUAL_WidgetCommands: Registered %d widget commands"), 10);
}

// ============================================================================
// Phase 1: 只读能力 - widget.get_hierarchy
// ============================================================================

void FUAL_WidgetCommands::Handle_GetHierarchy(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}

	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}

	UWidgetTree* WidgetTree = WidgetBP->WidgetTree;
	if (!WidgetTree)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("WidgetBlueprint has no WidgetTree"));
		return;
	}

	UWidget* RootWidget = WidgetTree->RootWidget;
	if (!RootWidget)
	{
		// 空 Widget，返回空结构
		TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("path"), Path);
		Result->SetField(TEXT("root"), MakeShared<FJsonValueNull>());
		Result->SetNumberField(TEXT("widget_count"), 0);
		UAL_CommandUtils::SendResponse(RequestId, 200, Result);
		return;
	}

	// 递归构建 Widget 层级
	TSharedPtr<FJsonObject> RootJson = BuildWidgetJson(RootWidget);
	
	// 统计控件数量
	int32 WidgetCount = 0;
	WidgetTree->ForEachWidget([&WidgetCount](UWidget* Widget)
	{
		WidgetCount++;
	});

	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Path);
	Result->SetStringField(TEXT("name"), WidgetBP->GetName());
	Result->SetObjectField(TEXT("root"), RootJson);
	Result->SetNumberField(TEXT("widget_count"), WidgetCount);
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.get_hierarchy: path=%s, widget_count=%d"), *Path, WidgetCount);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.get_hierarchy is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 2: 创建 + CanvasPanel 布局
// ============================================================================

void FUAL_WidgetCommands::Handle_Create(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	// 解析参数
	FString Name;
	if (!Payload->TryGetStringField(TEXT("name"), Name))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: name"));
		return;
	}
	
	FString Folder = TEXT("/Game/UI");
	Payload->TryGetStringField(TEXT("folder"), Folder);
	
	FString RootType = TEXT("CanvasPanel");
	Payload->TryGetStringField(TEXT("root_type"), RootType);
	
	// 确保文件夹路径格式正确
	if (!Folder.StartsWith(TEXT("/")))
	{
		Folder = TEXT("/") + Folder;
	}
	
	// 检查资产是否已存在（防止重名崩溃）
	FString AssetPath = Folder / Name;
	if (StaticLoadObject(UObject::StaticClass(), nullptr, *AssetPath))
	{
		UAL_CommandUtils::SendError(RequestId, 409,
			FString::Printf(TEXT("Widget Blueprint already exists: %s"), *AssetPath));
		return;
	}
	
	/**
	 * 根控件类型在建资产**之前**就认好，认不出来直接 400。
	 *
	 * 原来认不出来就悄悄换成 CanvasPanel，回执里却照抄请求的 root_type ——
	 * 调用方以为根是 VerticalBox，接着按竖排去加子控件，全叠在左上角。
	 * FindWidgetClass 除了常用表还会按 U 前缀动态找任意 UWidget 子类，
	 * 这样都找不到就是真写错了，退回默认只会把错藏起来。
	 * 放在 CreateAsset 前面，是为了拒绝时不留下一个半成品资产。
	 */
	UClass* RootClass = FindWidgetClass(RootType);
	if (!RootClass)
	{
		UAL_CommandUtils::SendError(RequestId, 400,
			FString::Printf(TEXT("Unknown root_type '%s'. Use a UWidget class name without the U prefix, e.g. CanvasPanel / VerticalBox / HorizontalBox / Overlay / ScrollBox / GridPanel / UniformGridPanel / WrapBox / SizeBox / Border."),
				*RootType));
		return;
	}

	// 事务包裹
	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "CreateWidget", "Agent Create Widget"));
	
	// 创建 Widget Blueprint
	UWidgetBlueprintFactory* Factory = NewObject<UWidgetBlueprintFactory>();
	Factory->ParentClass = UUserWidget::StaticClass();
	
	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
	UObject* NewAsset = AssetToolsModule.Get().CreateAsset(Name, Folder, UWidgetBlueprint::StaticClass(), Factory);
	
	if (!NewAsset)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to create Widget Blueprint asset"));
		return;
	}
	
	UWidgetBlueprint* WidgetBP = Cast<UWidgetBlueprint>(NewAsset);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Created asset is not a Widget Blueprint"));
		return;
	}
	
	// 标记蓝图被修改
	WidgetBP->Modify();
	
	// 设置根控件
	UWidgetTree* WidgetTree = WidgetBP->WidgetTree;
	if (WidgetTree)
	{
		// 创建根控件（RootClass 在建资产前已经校验过）
		UWidget* RootWidget = WidgetTree->ConstructWidget<UWidget>(RootClass);
		if (RootWidget)
		{
			RootWidget->SetDesignerFlags(EWidgetDesignFlags::Designing);
			WidgetTree->RootWidget = RootWidget;
		}
	}
	
	// 标记结构修改并保存
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	
	// 保存资产
	TArray<UPackage*> PackagesToSave;
	PackagesToSave.Add(WidgetBP->GetOutermost());
	// 返回值原来被丢掉，回执里也就没有 saved —— 只读目录、源码管理没签出时
	// 资产只在内存里，关编辑器就没了，调用方却以为已经落盘
	const bool bSaved = FEditorFileUtils::PromptForCheckoutAndSave(PackagesToSave, false, false)
		== FEditorFileUtils::PR_Success;

	// 构建响应
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("name"), WidgetBP->GetName());
	Result->SetStringField(TEXT("path"), WidgetBP->GetPathName());
	// root_type 从树上读回来，不回显请求：报的是引擎里此刻真正的根
	UWidget* ActualRoot = WidgetTree ? WidgetTree->RootWidget : nullptr;
	const FString ActualRootType = ActualRoot ? ActualRoot->GetClass()->GetName() : FString();
	Result->SetStringField(TEXT("root_type"), ActualRootType);
	Result->SetStringField(TEXT("requested_root_type"), RootType);
	if (!ActualRoot)
	{
		Result->SetStringField(TEXT("warning"),
			TEXT("The Widget Blueprint was created but has no root widget - the root could not be constructed."));
	}
	else if (ActualRoot->GetClass() != RootClass)
	{
		// 按类比、不按名字比：别名（Text → TextBlock）类名不同但就是请求的那个，不该报警
		Result->SetStringField(TEXT("warning"),
			FString::Printf(TEXT("Requested root_type '%s' (%s) but the root widget is '%s'."),
				*RootType, *RootClass->GetName(), *ActualRootType));
	}
	Result->SetBoolField(TEXT("saved"), bSaved);
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.create: name=%s, path=%s"), *Name, *WidgetBP->GetPathName());
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.create is only available in editor mode"));
#endif
}

void FUAL_WidgetCommands::Handle_SetCanvasSlot(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	// 解析参数
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	FString WidgetName;
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	
	// 加载 WidgetBlueprint
	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	// 查找控件
	UWidget* Widget = FindWidgetByName(WidgetBP->WidgetTree, WidgetName);
	if (!Widget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, 
			FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}
	
	// 获取 CanvasPanelSlot
	UCanvasPanelSlot* Slot = Cast<UCanvasPanelSlot>(Widget->Slot);
	if (!Slot)
	{
		UAL_CommandUtils::SendError(RequestId, 400, 
			FString::Printf(TEXT("Widget '%s' is not in a CanvasPanel"), *WidgetName));
		return;
	}
	
	// 事务包裹
	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "SetCanvasSlot", "Agent Set Canvas Slot"));
	WidgetBP->Modify();
	
	// 更新 Slot 属性
	FString AnchorsStr;
	if (Payload->TryGetStringField(TEXT("anchors"), AnchorsStr))
	{
		Slot->SetAnchors(ParseAnchors(AnchorsStr));
	}
	
	const TSharedPtr<FJsonObject>* PosObj;
	if (Payload->TryGetObjectField(TEXT("position"), PosObj))
	{
		Slot->SetPosition(ParseVector2D(*PosObj));
	}
	
	const TSharedPtr<FJsonObject>* SizeObj;
	if (Payload->TryGetObjectField(TEXT("size"), SizeObj))
	{
		Slot->SetSize(ParseVector2D(*SizeObj));
	}
	
	const TSharedPtr<FJsonObject>* AlignObj;
	if (Payload->TryGetObjectField(TEXT("alignment"), AlignObj))
	{
		Slot->SetAlignment(ParseVector2D(*AlignObj));
	}
	
	int32 ZOrder;
	if (Payload->TryGetNumberField(TEXT("z_order"), ZOrder))
	{
		Slot->SetZOrder(ZOrder);
	}
	
	// 标记修改
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	
	// 构建响应
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), WidgetName);
	Result->SetObjectField(TEXT("slot_data"), BuildCanvasSlotJson(Slot));
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.set_canvas_slot: widget=%s"), *WidgetName);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.set_canvas_slot is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 3: 其他布局容器
// ============================================================================

void FUAL_WidgetCommands::Handle_SetVerticalSlot(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	FString WidgetName;
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	
	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	UWidget* Widget = FindWidgetByName(WidgetBP->WidgetTree, WidgetName);
	if (!Widget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, 
			FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}
	
	UVerticalBoxSlot* Slot = Cast<UVerticalBoxSlot>(Widget->Slot);
	if (!Slot)
	{
		UAL_CommandUtils::SendError(RequestId, 400, 
			FString::Printf(TEXT("Widget '%s' is not in a VerticalBox"), *WidgetName));
		return;
	}
	
	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "SetVerticalSlot", "Agent Set Vertical Slot"));
	WidgetBP->Modify();
	
	FString SizeRule;
	if (Payload->TryGetStringField(TEXT("size_rule"), SizeRule))
	{
		if (SizeRule.Equals(TEXT("Fill"), ESearchCase::IgnoreCase))
		{
			Slot->SetSize(FSlateChildSize(ESlateSizeRule::Fill));
		}
		else
		{
			Slot->SetSize(FSlateChildSize(ESlateSizeRule::Automatic));
		}
	}
	
	const TSharedPtr<FJsonObject>* PaddingObj;
	if (Payload->TryGetObjectField(TEXT("padding"), PaddingObj))
	{
		double Left = 0, Top = 0, Right = 0, Bottom = 0;
		(*PaddingObj)->TryGetNumberField(TEXT("left"), Left);
		(*PaddingObj)->TryGetNumberField(TEXT("top"), Top);
		(*PaddingObj)->TryGetNumberField(TEXT("right"), Right);
		(*PaddingObj)->TryGetNumberField(TEXT("bottom"), Bottom);
		Slot->SetPadding(FMargin(Left, Top, Right, Bottom));
	}
	
	FString HAlign;
	if (Payload->TryGetStringField(TEXT("h_align"), HAlign))
	{
		if (HAlign.Contains(TEXT("Left"))) Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Left);
		else if (HAlign.Contains(TEXT("Center"))) Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Center);
		else if (HAlign.Contains(TEXT("Right"))) Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Right);
		else if (HAlign.Contains(TEXT("Fill"))) Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
	}
	
	FString VAlign;
	if (Payload->TryGetStringField(TEXT("v_align"), VAlign))
	{
		if (VAlign.Contains(TEXT("Top"))) Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Top);
		else if (VAlign.Contains(TEXT("Center"))) Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Center);
		else if (VAlign.Contains(TEXT("Bottom"))) Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Bottom);
		else if (VAlign.Contains(TEXT("Fill"))) Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Fill);
	}
	
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), WidgetName);
	Result->SetObjectField(TEXT("slot_data"), BuildVerticalSlotJson(Slot));
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.set_vertical_slot: widget=%s"), *WidgetName);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.set_vertical_slot is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 3: 通用子控件添加 - widget.add_child
// ============================================================================

void FUAL_WidgetCommands::Handle_AddChild(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	FString ParentName;
	if (!Payload->TryGetStringField(TEXT("parent_name"), ParentName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: parent_name"));
		return;
	}
	
	FString ControlType;
	if (!Payload->TryGetStringField(TEXT("control_type"), ControlType))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: control_type"));
		return;
	}
	
	FString WidgetName;
	Payload->TryGetStringField(TEXT("name"), WidgetName);
	
	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	UWidgetTree* WidgetTree = WidgetBP->WidgetTree;
	if (!WidgetTree)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("WidgetBlueprint has no WidgetTree"));
		return;
	}
	
	// 查找父容器
	UWidget* Parent = nullptr;
	FString ParentType;
	
	if (ParentName.Equals(TEXT("root"), ESearchCase::IgnoreCase))
	{
		Parent = WidgetTree->RootWidget;
		if (!Parent)
		{
			UAL_CommandUtils::SendError(RequestId, 404, TEXT("Widget has no root"));
			return;
		}
		ParentType = Parent->GetClass()->GetName();
	}
	else
	{
		Parent = FindWidgetByName(WidgetTree, ParentName);
		if (!Parent)
		{
			UAL_CommandUtils::SendError(RequestId, 404, 
				FString::Printf(TEXT("Parent not found: %s"), *ParentName));
			return;
		}
		ParentType = Parent->GetClass()->GetName();
	}
	
	// 创建新控件
	FString ClassError;
	UClass* WidgetClass = ResolveWidgetClass(ControlType, ClassError);
	if (!WidgetClass)
	{
		UAL_CommandUtils::SendError(RequestId, 400, ClassError);
		return;
	}
	if (UAL_WouldNestSelf(WidgetBP, WidgetClass))
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("%s cannot contain itself"), *WidgetBP->GetName()));
		return;
	}
	
	// 生成唯一名称（防止重名崩溃）
	FName UniqueName = NAME_None;
	if (!WidgetName.IsEmpty())
	{
		UniqueName = MakeUniqueWidgetName(WidgetTree, WidgetName);
	}
	
	UWidget* NewWidget = WidgetTree->ConstructWidget<UWidget>(WidgetClass, UniqueName);
	if (!NewWidget)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to construct widget"));
		return;
	}
	
	NewWidget->SetDesignerFlags(EWidgetDesignFlags::Designing);
	
	// 根据父容器类型选择添加方式
	FString SlotType;
	TSharedPtr<FJsonObject> SlotData = MakeShared<FJsonObject>();
	// 这个父容器的槽位真正认了哪些参数。没进这张表、调用方又传了的，
	// 最后进 ignored_fields —— 原来一律 ok:true，给 VBox 传 anchors 就静默丢掉
	TSet<FString> AppliedFields;
	auto MarkApplied = [&AppliedFields](std::initializer_list<const TCHAR*> Fields)
	{
		for (const TCHAR* Field : Fields)
		{
			AppliedFields.Add(Field);
		}
	};
	// 单内容容器（Button/Border/SizeBox）原有的子控件被顶掉时记下来
	TSharedPtr<FJsonObject> ReplacedChild;
	
	// CanvasPanel
	if (UCanvasPanel* Canvas = Cast<UCanvasPanel>(Parent))
	{
		UCanvasPanelSlot* Slot = Cast<UCanvasPanelSlot>(Canvas->AddChild(NewWidget));
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to add widget to CanvasPanel"));
			return;
		}
		
		// 设置 Canvas Slot 属性
		FString Anchors;
		if (Payload->TryGetStringField(TEXT("anchors"), Anchors))
		{
			Slot->SetAnchors(ParseAnchors(Anchors));
		}
		
		const TSharedPtr<FJsonObject>* PosObj;
		if (Payload->TryGetObjectField(TEXT("position"), PosObj))
		{
			double X = 0, Y = 0;
			(*PosObj)->TryGetNumberField(TEXT("x"), X);
			(*PosObj)->TryGetNumberField(TEXT("y"), Y);
			Slot->SetPosition(FVector2D(X, Y));
		}
		
		const TSharedPtr<FJsonObject>* SizeObj;
		if (Payload->TryGetObjectField(TEXT("size"), SizeObj))
		{
			double W = 100, H = 40;
			(*SizeObj)->TryGetNumberField(TEXT("width"), W);
			(*SizeObj)->TryGetNumberField(TEXT("height"), H);
			Slot->SetSize(FVector2D(W, H));
		}
		
		MarkApplied({ TEXT("anchors"), TEXT("position"), TEXT("size") });
		SlotType = TEXT("CanvasPanelSlot");
		SlotData = BuildCanvasSlotJson(Slot);
	}
	// VerticalBox
	else if (UVerticalBox* VBox = Cast<UVerticalBox>(Parent))
	{
		UVerticalBoxSlot* Slot = Cast<UVerticalBoxSlot>(VBox->AddChild(NewWidget));
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to add widget to VerticalBox"));
			return;
		}
		
		// 设置 Slot 属性
		FString SizeRule;
		if (Payload->TryGetStringField(TEXT("size_rule"), SizeRule))
		{
			if (SizeRule.Equals(TEXT("Fill"), ESearchCase::IgnoreCase))
			{
				Slot->SetSize(FSlateChildSize(ESlateSizeRule::Fill));
			}
			else
			{
				Slot->SetSize(FSlateChildSize(ESlateSizeRule::Automatic));
			}
		}
		
		// 设置对齐
		FString HAlign;
		if (Payload->TryGetStringField(TEXT("h_align"), HAlign))
		{
			if (HAlign.Equals(TEXT("Left"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Left);
			else if (HAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Center);
			else if (HAlign.Equals(TEXT("Right"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Right);
			else
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
		}
		
		FString VAlign;
		if (Payload->TryGetStringField(TEXT("v_align"), VAlign))
		{
			if (VAlign.Equals(TEXT("Top"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Top);
			else if (VAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Center);
			else if (VAlign.Equals(TEXT("Bottom"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Bottom);
			else
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Fill);
		}
		
		// 设置内边距
		const TSharedPtr<FJsonObject>* PaddingObj;
		if (Payload->TryGetObjectField(TEXT("padding"), PaddingObj))
		{
			double Left = 0, Top = 0, Right = 0, Bottom = 0;
			(*PaddingObj)->TryGetNumberField(TEXT("left"), Left);
			(*PaddingObj)->TryGetNumberField(TEXT("top"), Top);
			(*PaddingObj)->TryGetNumberField(TEXT("right"), Right);
			(*PaddingObj)->TryGetNumberField(TEXT("bottom"), Bottom);
			Slot->SetPadding(FMargin(Left, Top, Right, Bottom));
		}
		
		MarkApplied({ TEXT("size_rule"), TEXT("h_align"), TEXT("v_align"), TEXT("padding") });
		SlotType = TEXT("VerticalBoxSlot");
		SlotData = BuildVerticalSlotJson(Slot);
	}
	// HorizontalBox
	else if (UHorizontalBox* HBox = Cast<UHorizontalBox>(Parent))
	{
		UHorizontalBoxSlot* Slot = Cast<UHorizontalBoxSlot>(HBox->AddChild(NewWidget));
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to add widget to HorizontalBox"));
			return;
		}
		
		FString SizeRule;
		if (Payload->TryGetStringField(TEXT("size_rule"), SizeRule))
		{
			if (SizeRule.Equals(TEXT("Fill"), ESearchCase::IgnoreCase))
			{
				Slot->SetSize(FSlateChildSize(ESlateSizeRule::Fill));
			}
			else
			{
				Slot->SetSize(FSlateChildSize(ESlateSizeRule::Automatic));
			}
		}
		
		const TSharedPtr<FJsonObject>* PaddingObj;
		if (Payload->TryGetObjectField(TEXT("padding"), PaddingObj))
		{
			double Left = 0, Top = 0, Right = 0, Bottom = 0;
			(*PaddingObj)->TryGetNumberField(TEXT("left"), Left);
			(*PaddingObj)->TryGetNumberField(TEXT("top"), Top);
			(*PaddingObj)->TryGetNumberField(TEXT("right"), Right);
			(*PaddingObj)->TryGetNumberField(TEXT("bottom"), Bottom);
			Slot->SetPadding(FMargin(Left, Top, Right, Bottom));
		}
		
		// 对齐原来只在 VBox / Overlay 分支里设，HBox 收了 h_align/v_align 却不管 ——
		// 工具描述写着「VerticalBox/HorizontalBox 用 alignment」，传了就该生效
		FString HAlign;
		if (Payload->TryGetStringField(TEXT("h_align"), HAlign))
		{
			if (HAlign.Equals(TEXT("Left"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Left);
			else if (HAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Center);
			else if (HAlign.Equals(TEXT("Right"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Right);
			else
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
		}

		FString VAlign;
		if (Payload->TryGetStringField(TEXT("v_align"), VAlign))
		{
			if (VAlign.Equals(TEXT("Top"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Top);
			else if (VAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Center);
			else if (VAlign.Equals(TEXT("Bottom"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Bottom);
			else
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Fill);
		}

		MarkApplied({ TEXT("size_rule"), TEXT("h_align"), TEXT("v_align"), TEXT("padding") });
		SlotType = TEXT("HorizontalBoxSlot");
		SlotData = BuildHorizontalSlotJson(Slot);
	}
	// Overlay
	else if (UOverlay* Overlay = Cast<UOverlay>(Parent))
	{
		UOverlaySlot* Slot = Cast<UOverlaySlot>(Overlay->AddChild(NewWidget));
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to add widget to Overlay"));
			return;
		}
		
		// 设置对齐
		FString HAlign;
		if (Payload->TryGetStringField(TEXT("h_align"), HAlign))
		{
			if (HAlign.Equals(TEXT("Left"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Left);
			else if (HAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Center);
			else if (HAlign.Equals(TEXT("Right"), ESearchCase::IgnoreCase))
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Right);
			else
				Slot->SetHorizontalAlignment(EHorizontalAlignment::HAlign_Fill);
		}
		
		FString VAlign;
		if (Payload->TryGetStringField(TEXT("v_align"), VAlign))
		{
			if (VAlign.Equals(TEXT("Top"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Top);
			else if (VAlign.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Center);
			else if (VAlign.Equals(TEXT("Bottom"), ESearchCase::IgnoreCase))
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Bottom);
			else
				Slot->SetVerticalAlignment(EVerticalAlignment::VAlign_Fill);
		}
		
		const TSharedPtr<FJsonObject>* PaddingObj;
		if (Payload->TryGetObjectField(TEXT("padding"), PaddingObj))
		{
			double Left = 0, Top = 0, Right = 0, Bottom = 0;
			(*PaddingObj)->TryGetNumberField(TEXT("left"), Left);
			(*PaddingObj)->TryGetNumberField(TEXT("top"), Top);
			(*PaddingObj)->TryGetNumberField(TEXT("right"), Right);
			(*PaddingObj)->TryGetNumberField(TEXT("bottom"), Bottom);
			Slot->SetPadding(FMargin(Left, Top, Right, Bottom));
		}
		
		MarkApplied({ TEXT("h_align"), TEXT("v_align"), TEXT("padding") });
		SlotType = TEXT("OverlaySlot");
	}
	// Button/Border/SizeBox 等单内容容器 (ContentWidget)
	else if (UContentWidget* ContentWidget = Cast<UContentWidget>(Parent))
	{
		// 单内容容器只能放一个子控件，已有内容就顶掉。顶掉照做（按钮换文字是常见操作），
		// 但必须进回执：原来静默清掉，调用方以为按钮里的图标还在
		if (ContentWidget->GetChildrenCount() > 0)
		{
			if (UWidget* OldContent = ContentWidget->GetContent())
			{
				ReplacedChild = MakeShared<FJsonObject>();
				ReplacedChild->SetStringField(TEXT("name"), OldContent->GetName());
				ReplacedChild->SetStringField(TEXT("class"), OldContent->GetClass()->GetName());
			}
			ContentWidget->ClearChildren();
		}
		
		UPanelSlot* Slot = ContentWidget->AddChild(NewWidget);
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to set content widget"));
			return;
		}
		
		SlotType = TEXT("ContentSlot");
	}
	else
	{
		// 尝试作为通用 PanelWidget 添加
		UPanelWidget* Panel = Cast<UPanelWidget>(Parent);
		if (!Panel)
		{
			UAL_CommandUtils::SendError(RequestId, 400, 
				FString::Printf(TEXT("Parent '%s' (%s) is not a container"), *ParentName, *ParentType));
			return;
		}
		
		UPanelSlot* Slot = Panel->AddChild(NewWidget);
		if (!Slot)
		{
			UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to add widget to panel"));
			return;
		}
		
		SlotType = TEXT("PanelSlot");
	}
	
	// 如果是 TextBlock，设置文本
	FString Text;
	UTextBlock* NewTextBlock = Cast<UTextBlock>(NewWidget);
	if (Payload->TryGetStringField(TEXT("text"), Text))
	{
		if (NewTextBlock)
		{
			NewTextBlock->SetText(FText::FromString(Text));
			AppliedFields.Add(TEXT("text"));
		}
	}

	// 调用方传了、这个父容器 / 控件类型却不认的参数
	TArray<TSharedPtr<FJsonValue>> IgnoredFields;
	TArray<FString> IgnoredSlotFields;
	static const TCHAR* OptionalSlotFields[] = {
		TEXT("anchors"), TEXT("position"), TEXT("size"), TEXT("size_rule"),
		TEXT("h_align"), TEXT("v_align"), TEXT("padding")
	};
	for (const TCHAR* Field : OptionalSlotFields)
	{
		if (Payload->HasField(Field) && !AppliedFields.Contains(Field))
		{
			IgnoredFields.Add(MakeShared<FJsonValueString>(Field));
			IgnoredSlotFields.Add(Field);
		}
	}
	const bool bTextIgnored = Payload->HasField(TEXT("text")) && !AppliedFields.Contains(TEXT("text"));
	if (bTextIgnored)
	{
		IgnoredFields.Add(MakeShared<FJsonValueString>(TEXT("text")));
	}
	
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("name"), NewWidget->GetName());
	Result->SetStringField(TEXT("class"), NewWidget->GetClass()->GetName());
	Result->SetStringField(TEXT("parent"), Parent->GetName());
	Result->SetStringField(TEXT("parent_type"), ParentType);
	Result->SetStringField(TEXT("slot_type"), SlotType);
	if (SlotData.IsValid() && SlotData->Values.Num() > 0)
	{
		Result->SetObjectField(TEXT("slot_data"), SlotData);
	}
	// 文本从控件上读回来，不回显请求
	if (NewTextBlock)
	{
		Result->SetStringField(TEXT("text"), NewTextBlock->GetText().ToString());
	}
	if (IgnoredFields.Num() > 0)
	{
		Result->SetArrayField(TEXT("ignored_fields"), IgnoredFields);
		// AGENTS.md §5 第 14 条：有没办成的，顶层带 failed_count
		Result->SetNumberField(TEXT("failed_count"), IgnoredFields.Num());
		TArray<FString> Notes;
		if (IgnoredSlotFields.Num() > 0)
		{
			Notes.Add(FString::Printf(TEXT("parent '%s' (%s) gives a %s, which does not take %s"),
				*Parent->GetName(), *ParentType, *SlotType, *FString::Join(IgnoredSlotFields, TEXT(", "))));
		}
		if (bTextIgnored)
		{
			Notes.Add(FString::Printf(TEXT("'text' only applies to TextBlock, this is a %s - add a TextBlock child to it"),
				*NewWidget->GetClass()->GetName()));
		}
		Result->SetStringField(TEXT("ignored_note"),
			FString::Printf(TEXT("Not applied: %s."), *FString::Join(Notes, TEXT("; "))));
	}
	if (ReplacedChild.IsValid())
	{
		Result->SetObjectField(TEXT("replaced_child"), ReplacedChild);
	}
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.add_child: type=%s, name=%s, parent=%s (%s)"), 
		*ControlType, *NewWidget->GetName(), *Parent->GetName(), *ParentType);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.add_child is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 4: 预览渲染
// ============================================================================

void FUAL_WidgetCommands::Handle_Preview(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	int32 Width = 1920;
	int32 Height = 1080;
	Payload->TryGetNumberField(TEXT("width"), Width);
	Payload->TryGetNumberField(TEXT("height"), Height);
	// InitAutoFormat 里是 check(尺寸 > 0)：传 0 直接把编辑器带崩，负数会变成超大的无符号尺寸
	if (Width <= 0 || Height <= 0 || Width > 8192 || Height > 8192)
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("width/height must be between 1 and 8192 (got %d x %d)"), Width, Height));
		return;
	}

	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	// 编译蓝图确保最新
	FKismetEditorUtilities::CompileBlueprint(WidgetBP);
	
	// 获取生成类
	UClass* WidgetClass = WidgetBP->GeneratedClass;
	if (!WidgetClass || !WidgetClass->IsChildOf(UUserWidget::StaticClass()))
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Widget Blueprint has no valid generated class"));
		return;
	}
	
	// 创建临时 Widget 实例。
	// Outer 必须是 TransientPackage，不能挂在编辑器关卡下：挂在关卡下的实例在 GC 前一直活着，
	// 之后蓝图改了 ubergraph 重编译时会被重实例化，UE 5.7 上会 ensure 帧 key 不匹配后崩溃。
	// 用设计器模式（同引擎自带的 Widget 缩略图渲染），不跑 Construct 里的游戏逻辑。
	UUserWidget* TempWidget = NewObject<UUserWidget>(GetTransientPackage(), WidgetClass, NAME_None, RF_Transient);
	if (!TempWidget)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to create widget instance for preview"));
		return;
	}
	TempWidget->SetDesignerFlags(EWidgetDesignFlags::Designing | EWidgetDesignFlags::ExecutePreConstruct);
	TempWidget->Initialize();

	// 强制布局计算
	TempWidget->ForceLayoutPrepass();

	UTextureRenderTarget2D* RenderTarget = NewObject<UTextureRenderTarget2D>(GetTransientPackage(), NAME_None, RF_Transient);
	RenderTarget->InitAutoFormat(Width, Height);
	RenderTarget->UpdateResourceImmediate();

	// 游戏里 UMG 会按项目「用户界面」设置的 DPI 曲线缩放（默认按短边），1920x1080 的布局放到 1280x720
	// 会整体缩小。按 1 倍画出来的预览和实际游戏对不上，所以这里用同一条曲线算出缩放再画。
	// 带 Scale 的 DrawWidget 在 5.0~5.8 都是：根几何逻辑尺寸 = 像素尺寸 / Scale，再按 Scale 放大到像素。
	const float DPIScale = GetDefault<UUserInterfaceSettings>()->GetDPIScaleBasedOnSize(FIntPoint(Width, Height));

	// 使用 FWidgetRenderer 渲染到 RenderTarget；渲染器和 Slate 控件限定在块内，画完即释放
	{
		FWidgetRenderer WidgetRenderer(true);
		TSharedRef<SWidget> SlateWidget = TempWidget->TakeWidget();
		WidgetRenderer.DrawWidget(RenderTarget, SlateWidget, DPIScale, FVector2D(Width, Height), 0.0f);
		FlushRenderingCommands();
	}

	// 保存到文件
	FString OutputDir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("Screenshots/UAL"));
	IFileManager::Get().MakeDirectory(*OutputDir, true);
	
	FString Filename = FString::Printf(TEXT("widget_preview_%s_%lld.png"), 
		*FPaths::GetBaseFilename(Path), FDateTime::Now().GetTicks());
	FString OutputPath = FPaths::Combine(OutputDir, Filename);
	
	// 读取像素数据
	TArray<FColor> Bitmap;
	FTextureRenderTargetResource* RTResource = RenderTarget->GameThread_GetRenderTargetResource();
	if (RTResource && RTResource->ReadPixels(Bitmap))
	{
		// 保存为 PNG
		IImageWrapperModule& ImageWrapperModule = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		TSharedPtr<IImageWrapper> ImageWrapper = ImageWrapperModule.CreateImageWrapper(EImageFormat::PNG);
		
		if (ImageWrapper->SetRaw(Bitmap.GetData(), Bitmap.Num() * sizeof(FColor), Width, Height, ERGBFormat::BGRA, 8))
		{
			const TArray64<uint8>& PNGData = ImageWrapper->GetCompressed();
			if (PNGData.Num() > 0)
			{
				FFileHelper::SaveArrayToFile(PNGData, *OutputPath);
			}
		}
	}
	
	// 清理临时实例：释放 Slate 资源后交给 GC。
	// 不要手动 ConditionalBeginDestroy——那会把仍可达的对象改名为 None、拆掉 ubergraph 帧，
	// 留到下次编译重实例化时就是野指针。
	TempWidget->RemoveFromParent();
	TempWidget->ReleaseSlateResources(true);
	TempWidget->MarkAsGarbage();
	RenderTarget->ReleaseResource();
	RenderTarget->MarkAsGarbage();
	
	// 返回结果
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("path"), OutputPath);
	Result->SetNumberField(TEXT("width"), Width);
	Result->SetNumberField(TEXT("height"), Height);
	Result->SetNumberField(TEXT("dpi_scale"), DPIScale);
	
	UE_LOG(LogUALWidget, Log, TEXT("widget.preview: path=%s, output=%s, dpi_scale=%.3f"), *Path, *OutputPath, DPIScale);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.preview is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 5: 事件绑定
// ============================================================================

#if WITH_EDITOR
/** 这个节点是不是在用本蓝图上叫 Name 的控件变量：变量读写节点，或绑在控件上的事件（OnClicked 之类） */
static bool UAL_NodeRefsWidgetVariable(const UEdGraphNode* Node, const UWidgetBlueprint* WidgetBP, const FName Name)
{
	if (const UK2Node_ComponentBoundEvent* BoundEvent = Cast<UK2Node_ComponentBoundEvent>(Node))
	{
		return BoundEvent->ComponentPropertyName == Name;
	}
	const UK2Node_Variable* VarNode = Cast<UK2Node_Variable>(Node);
	if (!VarNode || VarNode->GetVarName() != Name || VarNode->VariableReference.IsLocalScope())
	{
		return false;
	}
	UClass* SelfClass = WidgetBP->GeneratedClass;
	UClass* Owner = VarNode->VariableReference.GetMemberParentClass(SelfClass);
	return Owner && ((SelfClass && Owner->IsChildOf(SelfClass))
		|| (WidgetBP->SkeletonGeneratedClass && Owner->IsChildOf(WidgetBP->SkeletonGeneratedClass)));
}

/**
 * 编辑器改控件名那一套，不依赖打开的蓝图编辑器。
 * 5.8 起引擎有公开的 FWidgetBlueprintOperationUtils::RenameWidget，直接用；更早的版本里
 * 对应的 FWidgetBlueprintEditorUtils::RenameWidget 在 Private 头里，还要传一个打开着的
 * 编辑器，只能照 5.0 引擎那份实现抄关键步骤：改对象名、改图表里的变量/事件引用、
 * 属性绑定、动画绑定、导航绑定、子蓝图撞名检查，最后标记结构变更让骨架类重编。
 * 后续版本引擎多出来的步骤按版本补上：5.3 起的默认焦点控件名，5.6 起的变量 GUID 表和 UI Component。
 * 名字已经由调用方验过（不撞控件树、不撞蓝图成员）。
 */
static bool UAL_RenameWidgetLikeEditor(UWidgetBlueprint* WidgetBP, UWidget* Widget, const FName NewName)
{
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 8)
	return FWidgetBlueprintOperationUtils::RenameWidget(WidgetBP, Widget, NewName.ToString());
#else
	const FName OldName = Widget->GetFName();
	const FString OldNameStr = OldName.ToString();
	const FString NewNameStr = NewName.ToString();

	WidgetBP->Modify();
	Widget->Modify();
	Widget->SetDisplayLabel(NewNameStr);
	if (!Widget->Rename(*NewNameStr))
	{
		return false;
	}
#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6
	// 5.6 起控件变量名 → GUID 的表（WidgetVariableNameToGuidMap）要跟着改，
	// 不然编译时 ValidateAndFixUpVariableGuids 连报两个 ensure，还给它换个新 GUID，外部引用就断了
	WidgetBP->OnVariableRenamed(OldName, NewName);
#endif

	FBlueprintEditorUtils::ReplaceVariableReferences(WidgetBP, OldName, NewName);

#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 3
	// 5.3 起引擎会顺手改 CDO 上记的默认焦点控件名（ReplaceDesiredFocus，私有头里），照它的效果改
	if (WidgetBP->GeneratedClass)
	{
		if (UUserWidget* WidgetCDO = WidgetBP->GeneratedClass->GetDefaultObject<UUserWidget>())
		{
			if (WidgetCDO->GetDesiredFocusWidgetName() == OldName)
			{
				WidgetCDO->SetFlags(RF_Transactional);
				WidgetCDO->Modify();
				WidgetCDO->SetDesiredFocusWidget(NewName);
			}
		}
	}
#endif

	for (FDelegateEditorBinding& Binding : WidgetBP->Bindings)
	{
		if (Binding.ObjectName == OldNameStr)
		{
			Binding.ObjectName = NewNameStr;
		}
	}

	for (UWidgetAnimation* WidgetAnimation : WidgetBP->Animations)
	{
		if (!WidgetAnimation)
		{
			continue;
		}
		for (FWidgetAnimationBinding& AnimBinding : WidgetAnimation->AnimationBindings)
		{
			if (AnimBinding.WidgetName != OldName)
			{
				continue;
			}
			AnimBinding.WidgetName = NewName;
			if (WidgetAnimation->MovieScene)
			{
				WidgetAnimation->MovieScene->Modify();
				if (AnimBinding.SlotWidgetName == NAME_None)
				{
					if (FMovieScenePossessable* Possessable = WidgetAnimation->MovieScene->FindPossessable(AnimBinding.AnimationGuid))
					{
						Possessable->SetName(NewNameStr);
					}
				}
			}
		}
	}

	WidgetBP->WidgetTree->ForEachWidget([OldName, NewName](UWidget* Each)
	{
		if (Each && Each->Navigation)
		{
			Each->Navigation->SetFlags(RF_Transactional);
			Each->Navigation->Modify();
			Each->Navigation->TryToRenameBinding(OldName, NewName);
		}
	});

#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6
	// UI Component 扩展里按控件名记着挂了哪些组件，要跟着改（FUIComponentUtils::OnWidgetRenamed 的蓝图那一半，
	// 它要一个打开的编辑器，预览那一半这里没有）。5.7 这个类没导出 StaticClass，只能按类路径找
	if (UClass* ComponentExtClass = FindObject<UClass>(nullptr, TEXT("/Script/UMGEditor.UIComponentWidgetBlueprintExtension")))
	{
		UWidgetBlueprintExtension* Extension = UWidgetBlueprintExtension::GetExtension(WidgetBP, ComponentExtClass);
		if (Extension && Extension->IsA(ComponentExtClass))
		{
			static_cast<UUIComponentWidgetBlueprintExtension*>(Extension)->RenameWidget(OldName, NewName);
		}
	}
#endif

	FBlueprintEditorUtils::ValidateBlueprintChildVariables(WidgetBP, NewName);
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	return true;
#endif
}
#endif

void FUAL_WidgetCommands::Handle_MakeVariable(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	FString WidgetName;
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	
	FString VariableName;
	if (!Payload->TryGetStringField(TEXT("variable_name"), VariableName))
	{
		VariableName = WidgetName; // 默认使用控件名
	}
	
	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	UWidget* Widget = FindWidgetByName(WidgetBP->WidgetTree, WidgetName);
	if (!Widget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, 
			FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}
	
	// 改名前先把名字验完：和编辑器的改名框一样，撞了就拒绝，不偷偷加后缀——
	// 调用方接下来要按自己给的名字去连图表，换个名字等于让它连错
	const FName OldName = Widget->GetFName();
	FName NewName = OldName;
	if (VariableName != WidgetName)
	{
		const FString Slug = SlugStringForValidName(VariableName);
		if (Slug.IsEmpty())
		{
			UAL_CommandUtils::SendError(RequestId, 400,
				FString::Printf(TEXT("variable_name '%s' has no characters usable in a variable name"), *VariableName));
			return;
		}
		NewName = FName(*Slug);
	}
	const bool bWantsRename = NewName != OldName;
	if (bWantsRename)
	{
		const UWidget* Holder = WidgetBP->WidgetTree->FindWidget(NewName);
		if ((Holder && Holder != Widget) || StaticFindObject(nullptr, Widget->GetOuter(), *NewName.ToString()))
		{
			UAL_CommandUtils::SendError(RequestId, 409, Holder
				? FString::Printf(TEXT("Name '%s' is already used by widget %s (%s); pick another variable_name"),
					*NewName.ToString(), *Holder->GetName(), *Holder->GetClass()->GetName())
				: FString::Printf(TEXT("Name '%s' is already used by another object in this Widget Blueprint; pick another variable_name"),
					*NewName.ToString()));
			return;
		}

		// 父类里同名的 BindWidget 属性是给这个控件留的位子，可以占
		bool bBindWidgetSlot = false;
		if (WidgetBP->ParentClass)
		{
			const FObjectPropertyBase* Existing = CastField<FObjectPropertyBase>(WidgetBP->ParentClass->FindPropertyByName(NewName));
			bBindWidgetSlot = Existing && (Existing->HasMetaData(TEXT("BindWidget")) || Existing->HasMetaData(TEXT("BindWidgetOptional")))
				&& Widget->IsA(Existing->PropertyClass);
		}
		FKismetNameValidator Validator(WidgetBP, OldName);
		const EValidatorResult Validity = Validator.IsValid(NewName);
		if (Validity != EValidatorResult::Ok && !bBindWidgetSlot)
		{
			UAL_CommandUtils::SendError(RequestId, 409,
				FString::Printf(TEXT("Cannot rename widget %s to '%s': %s"), *OldName.ToString(), *NewName.ToString(),
					*INameValidatorInterface::GetErrorString(NewName.ToString(), Validity)));
			return;
		}
	}

	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "MakeVariable", "Agent Make Variable"));
	WidgetBP->Modify();
	Widget->Modify();

	// 设置控件为变量
	Widget->bIsVariable = true;

	// 改名前记下图表里哪些节点在用旧名，改完逐个读回去看是不是跟着变了
	TArray<TWeakObjectPtr<UEdGraphNode>> ReferencingNodes;
	if (bWantsRename)
	{
		TArray<UEdGraph*> Graphs;
		WidgetBP->GetAllGraphs(Graphs);
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (Node && UAL_NodeRefsWidgetVariable(Node, WidgetBP, OldName))
				{
					ReferencingNodes.Add(Node);
				}
			}
		}
	}

	const bool bRenamed = bWantsRename && UAL_RenameWidgetLikeEditor(WidgetBP, Widget, NewName);
	if (bWantsRename && !bRenamed)
	{
		UAL_CommandUtils::SendError(RequestId, 500,
			FString::Printf(TEXT("Engine refused to rename widget %s to '%s'"), *OldName.ToString(), *NewName.ToString()));
		return;
	}
	if (!bRenamed)
	{
		// 改名那条路自己会标记结构变更；没改名时由这里让骨架类长出这个变量
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	}

	int32 UpdatedRefs = 0;
	TArray<TSharedPtr<FJsonValue>> StaleRefs;
	for (const TWeakObjectPtr<UEdGraphNode>& Weak : ReferencingNodes)
	{
		const UEdGraphNode* Node = Weak.Get();
		if (!Node)
		{
			continue; // 节点在重建里被换掉了，下面 found/updated 对不上就会显出来
		}
		if (UAL_NodeRefsWidgetVariable(Node, WidgetBP, Widget->GetFName()))
		{
			++UpdatedRefs;
		}
		else
		{
			const UEdGraph* Graph = Node->GetGraph();
			StaleRefs.Add(MakeShared<FJsonValueString>(FString::Printf(TEXT("%s: %s"),
				Graph ? *Graph->GetName() : TEXT("?"), *Node->GetNodeTitle(ENodeTitleType::ListView).ToString())));
		}
	}
	const int32 FoundRefs = ReferencingNodes.Num();
	const int32 NotUpdated = FoundRefs - UpdatedRefs;

	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	if (NotUpdated > 0)
	{
		Result->SetNumberField(TEXT("failed_count"), NotUpdated);
	}
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), Widget->GetName());
	Result->SetStringField(TEXT("old_name"), OldName.ToString());
	Result->SetBoolField(TEXT("renamed"), Widget->GetFName() != OldName);
	Result->SetBoolField(TEXT("is_variable"), Widget->bIsVariable);
	// 图表里用旧名的节点（变量读写、绑定事件）是不是都跟着改了；没改名时没有可改的
	Result->SetNumberField(TEXT("graph_references_found"), FoundRefs);
	Result->SetNumberField(TEXT("graph_references_renamed"), UpdatedRefs);
	Result->SetBoolField(TEXT("graph_references_updated"), NotUpdated == 0);
	if (StaleRefs.Num() > 0)
	{
		Result->SetArrayField(TEXT("stale_graph_references"), StaleRefs);
	}

	UE_LOG(LogUALWidget, Log, TEXT("widget.make_variable: widget=%s old=%s refs=%d/%d"),
		*Widget->GetName(), *OldName.ToString(), UpdatedRefs, FoundRefs);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.make_variable is only available in editor mode"));
#endif
}

/** JSON 里这个值到底是什么类型 —— 报错要说事实，不能替调用方假设它传错了 */
static FString UAL_JsonTypeName(const TSharedPtr<FJsonValue>& Value)
{
	if (!Value.IsValid()) return TEXT("缺失");
	switch (Value->Type)
	{
	case EJson::None:    return TEXT("None");
	case EJson::Null:    return TEXT("null");
	case EJson::String:  return TEXT("字符串");
	case EJson::Number:  return TEXT("数字");
	case EJson::Boolean: return TEXT("布尔");
	case EJson::Array:   return TEXT("数组");
	case EJson::Object:  return TEXT("对象");
	default:             return TEXT("未知");
	}
}

/**
 * 读颜色值。**对象和「被序列化成字符串的对象」都收。**
 *
 * 2026-09-17 真机复测：调用方传的是 `{"r":0.5,"g":0.5,"b":0.5,"a":0.5}`，
 * 而这里的 `TryGetObjectField` 拿不到。盒子那侧发出去的确实还是嵌套对象
 * （单测验过），所以形状是在中间某一层变的 —— 最可能是被序列化成了字符串
 * （MCP 入口和某些模型的工具参数编码都会这么干，而盒子的 schema 允许 value
 * 是字符串，于是原样转发）。**这一条尚未证实**，下面那句报错会把实际类型
 * 说出来，下次真机跑一次就有定论。
 *
 * 不管是哪一层干的，收两种形状都是对的：调用方写对了、后端也支持，中间那层的
 * 编码差异不该变成用户面前的失败。插件是所有客户端（盒子 / CLI / MCP）唯一的
 * 汇合点，在这里兼容一次覆盖全部入口，比在每个客户端各补一次可靠。
 *
 * 拿不到就说**实际收到的是什么类型**，不再断言「你没传对象」：
 * 原来那句话在调用方明明传了对象的时候是假的，它会照着错方向改两轮。
 */
static bool UAL_TryReadColorValue(const TSharedPtr<FJsonObject>& Payload, FLinearColor& OutColor, FString& OutError)
{
	const TSharedPtr<FJsonValue> RawValue = Payload->TryGetField(TEXT("value"));

	TSharedPtr<FJsonObject> ColorObj;
	const TSharedPtr<FJsonObject>* ObjectField = nullptr;
	if (RawValue.IsValid() && RawValue->TryGetObject(ObjectField) && ObjectField && ObjectField->IsValid())
	{
		ColorObj = *ObjectField;
	}
	else
	{
		// 字符串形态：可能是 "{\"r\":0.5,...}" 这样被序列化过的对象
		FString AsString;
		if (RawValue.IsValid() && RawValue->TryGetString(AsString))
		{
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(AsString);
			TSharedPtr<FJsonObject> Parsed;
			if (FJsonSerializer::Deserialize(Reader, Parsed) && Parsed.IsValid())
			{
				ColorObj = Parsed;
			}
		}
	}

	if (!ColorObj.IsValid())
	{
		OutError = FString::Printf(
			TEXT("颜色要一个对象 {\"r\":0.8,\"g\":0.1,\"b\":0.1,\"a\":1}（分量 0..1），")
			TEXT("这次收到的 value 是%s。"),
			*UAL_JsonTypeName(RawValue));
		return false;
	}

	// r/g/b 一个都没有：多半传的是别的结构（比如 {"color":{...}} 或 [r,g,b]）
	if (!ColorObj->HasField(TEXT("r")) && !ColorObj->HasField(TEXT("g")) && !ColorObj->HasField(TEXT("b")))
	{
		OutError = TEXT("颜色对象里没有 r / g / b 字段。形如 {\"r\":0.8,\"g\":0.1,\"b\":0.1,\"a\":1}，分量 0..1。");
		return false;
	}

	OutColor = FLinearColor(
		ColorObj->HasField(TEXT("r")) ? (float)ColorObj->GetNumberField(TEXT("r")) : 0.0f,
		ColorObj->HasField(TEXT("g")) ? (float)ColorObj->GetNumberField(TEXT("g")) : 0.0f,
		ColorObj->HasField(TEXT("b")) ? (float)ColorObj->GetNumberField(TEXT("b")) : 0.0f,
		ColorObj->HasField(TEXT("a")) ? (float)ColorObj->GetNumberField(TEXT("a")) : 1.0f);
	return true;
}

/**
 * 这个控件**实际**能设哪几个属性。
 *
 * 失败时列一张全属性表是自相矛盾的：给 Border 设 Text 报「属性名 'Text' 不认识」，
 * 紧接着的清单里第一个就是 Text —— 调用方会认定清单不可信，然后照着乱试。
 * 真相是「Border 这个类没有 Text」，那就按类说。
 *
 * 分支和下面 `Handle_SetProperty` 的 Cast 一一对应，改那边记得改这里。
 */
static FString UAL_SupportedPropertiesFor(UWidget* Widget)
{
	TArray<FString> Names = { TEXT("Visibility"), TEXT("IsEnabled"), TEXT("ToolTipText") };

	if (Widget)
	{
		if (Widget->IsA<UTextBlock>())
		{
			Names.Append({ TEXT("Text"), TEXT("FontSize"), TEXT("Justification"), TEXT("ColorAndOpacity") });
		}
		else if (Widget->IsA<URichTextBlock>())
		{
			Names.Append({ TEXT("FontSize"), TEXT("Justification") });
		}
		else if (Widget->IsA<UTextLayoutWidget>())
		{
			Names.Add(TEXT("Justification"));
		}
		else if (Widget->IsA<UProgressBar>())
		{
			Names.Append({ TEXT("Percent"), TEXT("FillColorAndOpacity") });
		}
		else if (Widget->IsA<UImage>())
		{
			Names.Add(TEXT("ColorAndOpacity"));
		}
		else if (Widget->IsA<UBorder>())
		{
			Names.Add(TEXT("BrushColor"));
		}
	}

	return FString::Join(Names, TEXT(" / "));
}

#if WITH_EDITOR
/**
 * 细节面板里这个控件实例上能改的属性：勾了「可编辑」、没关「实例可编辑」、不是只读，
 * 也不是 Slot / Navigation 那种内嵌子对象（整个换掉会把布局和导航丢掉）。
 */
static bool UAL_IsInstanceEditable(const FProperty* Property)
{
	return Property
		&& Property->HasAnyPropertyFlags(CPF_Edit)
		&& !Property->HasAnyPropertyFlags(CPF_DisableEditOnInstance | CPF_EditConst | CPF_InstancedReference | CPF_ContainsInstancedReference);
}

/** 按名字找属性：先精确，再忽略大小写比对内部名、蓝图里写的名字和显示名 */
static FProperty* UAL_FindWidgetProperty(UClass* Class, const FString& Name)
{
	if (FProperty* Exact = FindFProperty<FProperty>(Class, *Name))
	{
		return Exact;
	}
	for (TFieldIterator<FProperty> It(Class, EFieldIteratorFlags::IncludeSuper); It; ++It)
	{
		if (It->GetName().Equals(Name, ESearchCase::IgnoreCase)
			|| It->GetAuthoredName().Equals(Name, ESearchCase::IgnoreCase)
			|| It->GetMetaData(TEXT("DisplayName")).Equals(Name, ESearchCase::IgnoreCase))
		{
			return *It;
		}
	}
	return nullptr;
}

/**
 * 这个控件类自己（UWidget 基类以下）声明的、实例上能改的属性。
 * 用户控件蓝图里勾了「实例可编辑」的变量（WB_Text_Button 的 InText）就在这里。
 */
static FString UAL_InstanceEditableNamesFor(UWidget* Widget)
{
	TArray<FString> Names;
	for (TFieldIterator<FProperty> It(Widget->GetClass(), EFieldIteratorFlags::IncludeSuper); It; ++It)
	{
		const UClass* Owner = It->GetOwnerClass();
		if (!Owner || Owner == UWidget::StaticClass() || !Owner->IsChildOf(UWidget::StaticClass()) || !UAL_IsInstanceEditable(*It))
		{
			continue;
		}
		Names.Add(It->GetAuthoredName());
		if (Names.Num() >= 40)
		{
			Names.Add(TEXT("…"));
			break;
		}
	}
	return Names.Num() ? FString::Join(Names, TEXT(" / ")) : FString(TEXT("(none)"));
}

/**
 * 表外的属性按反射写，和在细节面板里改一样：PreEditChange → 写值 → PostEditChangeProperty。
 *
 * 原来 set_property 只有一张写死的属性表。用户控件上的「实例可编辑」变量（CommonUI 按钮的
 * 文字 InText、图标、样式）一个都设不了，调用方只能放一个没有文字的按钮了事。
 *
 * 值先按 JSON 转（字符串给文本 / 名字 / 枚举，数字、布尔，对象给结构体），转不了而传的是
 * 字符串时再按 UE 文本格式导入，`(R=1,G=0,B=0,A=1)`、对象路径这类都走这条。
 */
static bool UAL_SetWidgetPropertyByReflection(UWidget* Widget, FProperty* Property, const TSharedPtr<FJsonValue>& Value,
	TSharedPtr<FJsonValue>& OutReadBack, FString& OutError)
{
	if (!Value.IsValid() || Value->IsNull())
	{
		OutError = FString::Printf(TEXT("缺少 value（%s 是 %s）"), *Property->GetAuthoredName(), *Property->GetCPPType());
		return false;
	}

	void* ValuePtr = Property->ContainerPtrToValuePtr<void>(Widget);
	Widget->SetFlags(RF_Transactional);
	Widget->Modify();
	Widget->PreEditChange(Property);

	bool bOk = FJsonObjectConverter::JsonValueToUProperty(Value, Property, ValuePtr, 0, 0);
	FString AsString;
	if (!bOk && Value->TryGetString(AsString))
	{
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
		bOk = Property->ImportText_Direct(*AsString, ValuePtr, Widget, PPF_None) != nullptr;
#else
		bOk = Property->ImportText(*AsString, ValuePtr, PPF_None, Widget) != nullptr;
#endif
	}

	FPropertyChangedEvent ChangedEvent(Property, EPropertyChangeType::ValueSet);
	Widget->PostEditChangeProperty(ChangedEvent);

	if (!bOk)
	{
		OutError = FString::Printf(TEXT("%s 是 %s，收到的%s写不进去"),
			*Property->GetAuthoredName(), *Property->GetCPPType(), *UAL_JsonTypeName(Value));
		return false;
	}
	OutReadBack = FJsonObjectConverter::UPropertyToJsonValue(Property, ValuePtr, 0, 0);
	return true;
}
#endif

void FUAL_WidgetCommands::Handle_SetProperty(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	
	FString WidgetName;
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	
	FString PropertyName;
	if (!Payload->TryGetStringField(TEXT("property_name"), PropertyName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: property_name"));
		return;
	}
	
	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	
	UWidget* Widget = FindWidgetByName(WidgetBP->WidgetTree, WidgetName);
	if (!Widget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, 
			FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}
	
	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "SetProperty", "Agent Set Property"));
	WidgetBP->Modify();
	
	bool bSuccess = false;
	FString ResultMessage;
	// 写完读回来的值。有的分支才填，填了就进回执的 value 字段
	TSharedPtr<FJsonValue> ReadBackValue;

	// 处理常见属性（类型安全）
	if (PropertyName.Equals(TEXT("Text"), ESearchCase::IgnoreCase))
	{
		// TextBlock.Text
		FString TextValue;
		if (Payload->TryGetStringField(TEXT("value"), TextValue))
		{
			if (UTextBlock* TextBlock = Cast<UTextBlock>(Widget))
			{
				TextBlock->SetText(FText::FromString(TextValue));
				bSuccess = true;
				ResultMessage = FString::Printf(TEXT("Set Text to: %s"), *TextValue);
			}
		}
	}
	else if (PropertyName.Equals(TEXT("Visibility"), ESearchCase::IgnoreCase))
	{
		/**
		 * 精确匹配枚举名，认不出来就拒。
		 *
		 * 原来是 Contains 链：认不出来的值一律落成 Visible，而
		 * "SelfHitTestInvisible" 先撞上 Contains("HitTestInvisible")，
		 * 设成了 HitTestInvisible —— 子控件跟着点不动了。回执还照抄输入，
		 * 调用方看到的是自己要的那个值，永远发现不了。
		 */
		struct FUAL_VisibilityName
		{
			const TCHAR* Name;
			ESlateVisibility Value;
		};
		static const FUAL_VisibilityName VisibilityNames[] = {
			{ TEXT("Visible"), ESlateVisibility::Visible },
			{ TEXT("Collapsed"), ESlateVisibility::Collapsed },
			{ TEXT("Hidden"), ESlateVisibility::Hidden },
			{ TEXT("HitTestInvisible"), ESlateVisibility::HitTestInvisible },
			{ TEXT("SelfHitTestInvisible"), ESlateVisibility::SelfHitTestInvisible },
		};

		FString VisValue;
		if (Payload->TryGetStringField(TEXT("value"), VisValue))
		{
			VisValue.TrimStartAndEndInline();
			// 兼容带枚举前缀的写法（ESlateVisibility::Hidden）
			VisValue.RemoveFromStart(TEXT("ESlateVisibility::"));

			const FUAL_VisibilityName* Matched = nullptr;
			for (const FUAL_VisibilityName& Entry : VisibilityNames)
			{
				if (VisValue.Equals(Entry.Name, ESearchCase::IgnoreCase))
				{
					Matched = &Entry;
					break;
				}
			}

			if (Matched)
			{
				Widget->SetVisibility(Matched->Value);
				bSuccess = true;
				// 写完从控件上读回来，回执报引擎里的值
				const FString ActualVis = StaticEnum<ESlateVisibility>()
					? StaticEnum<ESlateVisibility>()->GetNameStringByValue((int64)Widget->GetVisibility())
					: FString(Matched->Name);
				ReadBackValue = MakeShared<FJsonValueString>(ActualVis);
				ResultMessage = FString::Printf(TEXT("Visibility is now: %s"), *ActualVis);
			}
			else
			{
				ResultMessage = FString::Printf(
					TEXT("Visibility 只认 Visible / Collapsed / Hidden / HitTestInvisible / SelfHitTestInvisible，收到的是 \"%s\"。"),
					*VisValue);
			}
		}
		else
		{
			ResultMessage = TEXT("Visibility 要传字符串：Visible / Collapsed / Hidden / HitTestInvisible / SelfHitTestInvisible。");
		}
	}
	else if (PropertyName.Equals(TEXT("IsEnabled"), ESearchCase::IgnoreCase))
	{
		bool bEnabled = true;
		if (Payload->TryGetBoolField(TEXT("value"), bEnabled))
		{
			Widget->SetIsEnabled(bEnabled);
			bSuccess = true;
			ResultMessage = FString::Printf(TEXT("Set IsEnabled to: %s"), bEnabled ? TEXT("true") : TEXT("false"));
		}
	}
	else if (PropertyName.Equals(TEXT("ToolTipText"), ESearchCase::IgnoreCase))
	{
		FString TooltipValue;
		if (Payload->TryGetStringField(TEXT("value"), TooltipValue))
		{
			Widget->SetToolTipText(FText::FromString(TooltipValue));
			bSuccess = true;
			ResultMessage = FString::Printf(TEXT("Set ToolTipText to: %s"), *TooltipValue);
		}
	}
	// 颜色。做 UI 绕不开的一项 —— 「做一个红色血条」原来直接办不到，
	// 因为这里只有 Text/Visibility/IsEnabled/ToolTipText/Percent 五个分支。
	// value 形如 { "r":0.8, "g":0.1, "b":0.1, "a":1 }（0..1）。
	else if (PropertyName.Equals(TEXT("FillColorAndOpacity"), ESearchCase::IgnoreCase)
		|| PropertyName.Equals(TEXT("ColorAndOpacity"), ESearchCase::IgnoreCase)
		|| PropertyName.Equals(TEXT("BrushColor"), ESearchCase::IgnoreCase))
	{
		FLinearColor NewColor = FLinearColor::White;
		FString ColorError;
		if (UAL_TryReadColorValue(Payload, NewColor, ColorError))
		{
			if (UProgressBar* Bar = Cast<UProgressBar>(Widget))
			{
				Bar->SetFillColorAndOpacity(NewColor);
				bSuccess = true;
			}
			else if (UTextBlock* TextWidget = Cast<UTextBlock>(Widget))
			{
				TextWidget->SetColorAndOpacity(FSlateColor(NewColor));
				bSuccess = true;
			}
			else if (UImage* ImageWidget = Cast<UImage>(Widget))
			{
				ImageWidget->SetColorAndOpacity(NewColor);
				bSuccess = true;
			}
			else if (UBorder* BorderWidget = Cast<UBorder>(Widget))
			{
				BorderWidget->SetBrushColor(NewColor);
				bSuccess = true;
			}
			else
			{
				// 说清楚是「这个控件不支持」而不是「参数写错了」
				ResultMessage = FString::Printf(
					TEXT("控件 %s（%s）不支持颜色设置，目前支持 ProgressBar / TextBlock / Image / Border。"),
					*WidgetName, *Widget->GetClass()->GetName());
			}

			if (bSuccess)
			{
				ResultMessage = FString::Printf(TEXT("Set %s to (%.2f, %.2f, %.2f, %.2f)"),
					*PropertyName, NewColor.R, NewColor.G, NewColor.B, NewColor.A);
			}
		}
		else
		{
			ResultMessage = ColorError;
		}
	}
	/**
	 * 字号。
	 *
	 * 以前这里没有入口，文档只写「设不了」，于是 2026-09-16 的反馈里，
	 * 调用方绕去 Python 试了三轮（`widget_tree` 是 protected、CDO 上找不到控件），
	 * 第四轮才摸到按对象路径 load 控件那条路。一个字号绕了四次往返，
	 * 而这里加一个分支就完了 —— 能用 C++ 做的能力不做成 Python 脚本。
	 *
	 * 只能改字号，不整个换字体：字体资产要用户自己选，而「大一点」是
	 * 调用方真正会提的需求。改的是字号这**一个字段**，字族、字重、轮廓都留着。
	 */
	else if (PropertyName.Equals(TEXT("FontSize"), ESearchCase::IgnoreCase))
	{
		double SizeValue = 0.0;
		if (Payload->TryGetNumberField(TEXT("value"), SizeValue) && SizeValue > 0.0)
		{
			if (UTextBlock* TextWidget = Cast<UTextBlock>(Widget))
			{
				// UTextBlock::GetFont() 是 5.1 才加的；5.0 上 Font 还是个公开成员。
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
				FSlateFontInfo Font = TextWidget->GetFont();
#else
				FSlateFontInfo Font = TextWidget->Font;
#endif
				Font.Size = static_cast<float>(SizeValue);
				TextWidget->SetFont(Font);
				bSuccess = true;
			}
			else if (URichTextBlock* RichWidget = Cast<URichTextBlock>(Widget))
			{
				// RichTextBlock 的字体长在 DefaultTextStyle 里，没有 GetFont
				FSlateFontInfo Font = RichWidget->GetDefaultTextStyle().Font;
				Font.Size = static_cast<float>(SizeValue);
				RichWidget->SetDefaultFont(Font);
				bSuccess = true;
			}
			else
			{
				ResultMessage = FString::Printf(
					TEXT("控件 %s（%s）没有字号可设，FontSize 只支持 TextBlock / RichTextBlock。"),
					*WidgetName, *Widget->GetClass()->GetName());
			}

			if (bSuccess)
			{
				ResultMessage = FString::Printf(TEXT("Set FontSize to: %.0f"), SizeValue);
			}
		}
		else
		{
			ResultMessage = TEXT("FontSize 要传一个大于 0 的数字，例如 34。");
		}
	}
	/**
	 * 水平对齐。声明在 `UTextLayoutWidget` 上，所以 TextBlock、RichTextBlock、
	 * EditableText、EditableTextBox、MultiLineEditableText 一次全覆盖 ——
	 * 逐个 Cast 的话每加一种控件都要回来补一次。
	 */
	else if (PropertyName.Equals(TEXT("Justification"), ESearchCase::IgnoreCase))
	{
		FString JustifyValue;
		if (Payload->TryGetStringField(TEXT("value"), JustifyValue))
		{
			if (UTextLayoutWidget* TextLayout = Cast<UTextLayoutWidget>(Widget))
			{
				ETextJustify::Type NewJustify = ETextJustify::Left;
				bool bKnown = true;
				if (JustifyValue.Equals(TEXT("Left"), ESearchCase::IgnoreCase)) NewJustify = ETextJustify::Left;
				else if (JustifyValue.Equals(TEXT("Center"), ESearchCase::IgnoreCase)) NewJustify = ETextJustify::Center;
				else if (JustifyValue.Equals(TEXT("Right"), ESearchCase::IgnoreCase)) NewJustify = ETextJustify::Right;
				else bKnown = false;

				if (bKnown)
				{
					TextLayout->SetJustification(NewJustify);
					bSuccess = true;
					ResultMessage = FString::Printf(TEXT("Set Justification to: %s"), *JustifyValue);
				}
				else
				{
					ResultMessage = FString::Printf(
						TEXT("Justification 只认 Left / Center / Right，收到的是 \"%s\"。"), *JustifyValue);
				}
			}
			else
			{
				ResultMessage = FString::Printf(
					TEXT("控件 %s（%s）不是文本类控件，Justification 支持 TextBlock / RichTextBlock / EditableText / EditableTextBox。"),
					*WidgetName, *Widget->GetClass()->GetName());
			}
		}
		else
		{
			ResultMessage = TEXT("Justification 要传字符串：Left / Center / Right。");
		}
	}
	else if (PropertyName.Equals(TEXT("Percent"), ESearchCase::IgnoreCase))
	{
		// ProgressBar.Percent
		double PercentValue = 0.0;
		if (Payload->TryGetNumberField(TEXT("value"), PercentValue))
		{
			if (UProgressBar* ProgressBar = Cast<UProgressBar>(Widget))
			{
				ProgressBar->SetPercent(PercentValue);
				bSuccess = true;
				ResultMessage = FString::Printf(TEXT("Set Percent to: %.2f"), PercentValue);
			}
		}
	}
	
	// 表里没办成的，按反射找这个控件类上的同名属性再试一次（用户控件的实例可编辑变量、
	// 引擎控件表外的属性都走这里）。属性不能在实例上改时说清楚是哪一步挡住的
	FString ReflectionNote;
	if (!bSuccess)
	{
		if (FProperty* Property = UAL_FindWidgetProperty(Widget->GetClass(), PropertyName))
		{
			if (!UAL_IsInstanceEditable(Property))
			{
				ReflectionNote = FString::Printf(
					TEXT("%s 上有 '%s'，但它不能在实例上改（没勾「可编辑」/「实例可编辑」，或是只读）。")
					TEXT("如果它是 %s 里的蓝图变量，在那个蓝图里给它勾上「实例可编辑」再设。"),
					*Widget->GetClass()->GetName(), *Property->GetAuthoredName(), *Widget->GetClass()->GetName());
			}
			else
			{
				FString ReflectionError;
				if (UAL_SetWidgetPropertyByReflection(Widget, Property, Payload->TryGetField(TEXT("value")), ReadBackValue, ReflectionError))
				{
					bSuccess = true;
					ResultMessage = FString::Printf(TEXT("Set %s (%s) by reflection"), *Property->GetAuthoredName(), *Property->GetCPPType());
				}
				else
				{
					ReflectionNote = ReflectionError;
				}
			}
		}
	}

	if (!bSuccess)
	{
		/**
		 * 上面每个分支失败时都拼了一句**具体**的话（这个控件是什么类、
		 * 支持哪几种、值该怎么传）。原来这里把它整个丢掉，只回一句
		 * 「Property may not be supported or value type is incorrect」——
		 * 三种完全不同的失败长成一个样，调用方只能换个参数再猜一轮。
		 * 2026-09-16 的反馈里，一次 BrushColor 失败回给模型的全部信息就是
		 * 「设置属性失败」六个字。拼好的诊断必须发出去。
		 */
		FString Detail = ReflectionNote.IsEmpty() ? ResultMessage
			: ResultMessage.IsEmpty() ? ReflectionNote
			: ResultMessage + TEXT(" ") + ReflectionNote;
		if (Detail.IsEmpty())
		{
			/**
			 * 走到这里有两种情况：属性名根本不认识，或者认识但**这个控件类没有**
			 * （给 Border 设 Text 就是后者 —— Text 分支只 Cast UTextBlock）。
			 *
			 * 两种都按「这个类能设什么」来答。原来一律列全属性表，于是出现
			 * 「属性名 'Text' 不认识」后面跟着一张第一项就是 Text 的清单 ——
			 * 自相矛盾，调用方会判定整张清单不可信（2026-09-17 复测时点出来的）。
			 */
			Detail = FString::Printf(
				TEXT("%s 这个控件没有 '%s'。它能设的是：%s；以及这个类自己的可编辑属性：%s。"),
				*Widget->GetClass()->GetName(), *PropertyName, *UAL_SupportedPropertiesFor(Widget),
				*UAL_InstanceEditableNamesFor(Widget));
		}

		UAL_CommandUtils::SendError(RequestId, 400,
			FString::Printf(TEXT("Failed to set property '%s' on widget '%s'（%s）: %s"),
				*PropertyName, *WidgetName, *Widget->GetClass()->GetName(), *Detail));
		return;
	}
	
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);
	
	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), WidgetName);
	Result->SetStringField(TEXT("property_name"), PropertyName);
	Result->SetStringField(TEXT("message"), ResultMessage);
	if (ReadBackValue.IsValid())
	{
		Result->SetField(TEXT("value"), ReadBackValue);
	}

	UE_LOG(LogUALWidget, Log, TEXT("widget.set_property: widget=%s, property=%s"), *WidgetName, *PropertyName);
	
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.set_property is only available in editor mode"));
#endif
}

// ============================================================================
// Phase 6: 改现成的界面 —— 替换、删除
//
// 前五期都是照「从零搭一个新界面」做的：建、加、摆、设、预览。用户拿来的
// 却多半是现成的界面（商城模板、CommonUI 项目），要的是「把这个按钮换成导航
// 那种」「把这块删了」—— 没有这两步，调用方只能在旁边再加一个，然后让用户
// 自己去编辑器里删旧的、连事件。
// ============================================================================

#if WITH_EDITOR
/** 报告里一个节点的样子：「图名: 节点标题」 */
static FString UAL_NodeLabel(const UEdGraphNode* Node)
{
	const UEdGraph* Graph = Node ? Node->GetGraph() : nullptr;
	return FString::Printf(TEXT("%s: %s"),
		Graph ? *Graph->GetName() : TEXT("?"),
		Node ? *Node->GetNodeTitle(ENodeTitleType::ListView).ToString() : TEXT("?"));
}

/** 图表里用到这个控件的节点，分成绑在它上面的事件和其余（变量读写） */
static void UAL_CollectWidgetGraphRefs(UWidgetBlueprint* WidgetBP, const FName Name,
	TArray<UK2Node_ComponentBoundEvent*>& OutEvents, TArray<UEdGraphNode*>& OutOthers)
{
	TArray<UEdGraph*> Graphs;
	WidgetBP->GetAllGraphs(Graphs);
	for (UEdGraph* Graph : Graphs)
	{
		if (!Graph)
		{
			continue;
		}
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (!Node || !UAL_NodeRefsWidgetVariable(Node, WidgetBP, Name))
			{
				continue;
			}
			if (UK2Node_ComponentBoundEvent* BoundEvent = Cast<UK2Node_ComponentBoundEvent>(Node))
			{
				OutEvents.Add(BoundEvent);
			}
			else
			{
				OutOthers.Add(Node);
			}
		}
	}
}

/** 控件类上蓝图能绑的事件（OnClicked 这类 BlueprintAssignable 委托） */
static TMap<FName, FMulticastDelegateProperty*> UAL_BindableWidgetEvents(UClass* Class)
{
	TMap<FName, FMulticastDelegateProperty*> Events;
	for (TFieldIterator<FMulticastDelegateProperty> It(Class, EFieldIteratorFlags::IncludeSuper); It; ++It)
	{
		if (It->HasAnyPropertyFlags(CPF_BlueprintAssignable))
		{
			Events.Add(It->GetFName(), *It);
		}
	}
	return Events;
}

static FString UAL_JoinEventNames(const TMap<FName, FMulticastDelegateProperty*>& Events)
{
	TArray<FString> Names;
	for (const TPair<FName, FMulticastDelegateProperty*>& Pair : Events)
	{
		Names.Add(Pair.Key.ToString());
	}
	Names.Sort();
	return Names.Num() ? FString::Join(Names, TEXT(", ")) : FString(TEXT("(none)"));
}

/** 被删掉的控件在报告里的样子。TextBlock 带上字 —— 换按钮时调用方要把「登录」两个字搬到新按钮上 */
static TSharedPtr<FJsonObject> UAL_DescribeWidgetBrief(UWidget* Widget)
{
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("name"), Widget->GetName());
	Obj->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
	if (const UTextBlock* Text = Cast<UTextBlock>(Widget))
	{
		Obj->SetStringField(TEXT("text"), Text->GetText().ToString());
	}
	return Obj;
}

static FString UAL_DescribeWidgetsInline(const TArray<UWidget*>& Widgets)
{
	TArray<FString> Parts;
	for (const UWidget* Widget : Widgets)
	{
		const UTextBlock* Text = Cast<UTextBlock>(Widget);
		Parts.Add(Text
			? FString::Printf(TEXT("%s (%s \"%s\")"), *Widget->GetName(), *Widget->GetClass()->GetName(), *Text->GetText().ToString())
			: FString::Printf(TEXT("%s (%s)"), *Widget->GetName(), *Widget->GetClass()->GetName()));
	}
	return FString::Join(Parts, TEXT(", "));
}

/**
 * 控件离开这棵树时，蓝图里挂在它名字上的东西一并拆掉，和编辑器删控件一样：
 * 图表里的变量节点和绑定事件、属性绑定、默认焦点，5.6 起还有变量 GUID 表。
 * 返回拆掉的图表节点。事件后面接的逻辑节点留在图里，只是断开了。
 */
static TArray<FString> UAL_DetachWidgetName(UWidgetBlueprint* WidgetBP, const FName Name)
{
	TArray<FString> RemovedNodes;
	TArray<UK2Node_ComponentBoundEvent*> Events;
	TArray<UEdGraphNode*> Others;
	UAL_CollectWidgetGraphRefs(WidgetBP, Name, Events, Others);
	TArray<UEdGraphNode*> ToRemove(Others);
	ToRemove.Append(Events);
	for (UEdGraphNode* Node : ToRemove)
	{
		RemovedNodes.Add(UAL_NodeLabel(Node));
		FBlueprintEditorUtils::RemoveNode(WidgetBP, Node, /*bDontRecompile=*/true);
	}

	const FString NameStr = Name.ToString();
	for (int32 Index = WidgetBP->Bindings.Num() - 1; Index >= 0; --Index)
	{
		if (WidgetBP->Bindings[Index].ObjectName == NameStr)
		{
			WidgetBP->Bindings.RemoveAt(Index);
		}
	}

#if (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 3) || ENGINE_MAJOR_VERSION > 5
	if (WidgetBP->GeneratedClass)
	{
		if (UUserWidget* WidgetCDO = WidgetBP->GeneratedClass->GetDefaultObject<UUserWidget>())
		{
			if (WidgetCDO->GetDesiredFocusWidgetName() == Name)
			{
				WidgetCDO->SetFlags(RF_Transactional);
				WidgetCDO->Modify();
				WidgetCDO->SetDesiredFocusWidget(NAME_None);
			}
		}
	}
#endif
#if (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 6) || ENGINE_MAJOR_VERSION > 5
	// 不清的话这个名字的 GUID 一直留在表里，下次编译 ValidateAndFixUpVariableGuids 报 ensure
	WidgetBP->OnVariableRemoved(Name);
#endif
	return RemovedNodes;
}

/** 控件换类时原样带过去的 UWidget 基类属性：显隐、可用、提示、透明度、渲染变换 */
static TArray<FString> UAL_CarryBaseWidgetProperties(const UWidget* From, UWidget* To)
{
	static const TCHAR* Carried[] = {
		TEXT("Visibility"), TEXT("bIsEnabled"), TEXT("ToolTipText"),
		TEXT("RenderOpacity"), TEXT("RenderTransform"), TEXT("RenderTransformPivot")
	};
	TArray<FString> Done;
	for (const TCHAR* Name : Carried)
	{
		if (const FProperty* Property = UWidget::StaticClass()->FindPropertyByName(Name))
		{
			if (!Property->Identical_InContainer(From, To))
			{
				Property->CopyCompleteValue_InContainer(To, From);
				Done.Add(Name);
			}
		}
	}
	return Done;
}
#endif

void FUAL_WidgetCommands::Handle_Replace(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	FString WidgetName;
	FString NewType;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	if (!Payload->TryGetStringField(TEXT("new_type"), NewType))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: new_type"));
		return;
	}
	bool bDropChildren = false;
	Payload->TryGetBoolField(TEXT("drop_children"), bDropChildren);

	// event_map：旧控件上的事件名 → 新类上的事件名。对象和「被序列化成字符串的对象」都收
	// （理由同 UAL_TryReadColorValue）
	TMap<FName, FName> EventMap;
	{
		TSharedPtr<FJsonObject> MapObj;
		const TSharedPtr<FJsonObject>* ObjField = nullptr;
		FString MapString;
		if (Payload->TryGetObjectField(TEXT("event_map"), ObjField) && ObjField)
		{
			MapObj = *ObjField;
		}
		else if (Payload->TryGetStringField(TEXT("event_map"), MapString) && !MapString.IsEmpty())
		{
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(MapString);
			FJsonSerializer::Deserialize(Reader, MapObj);
		}
		if (Payload->HasField(TEXT("event_map")) && !MapObj.IsValid())
		{
			UAL_CommandUtils::SendError(RequestId, 400,
				TEXT("event_map must be an object like {\"OnClicked\": \"OnButtonBaseClicked\"}"));
			return;
		}
		if (MapObj.IsValid())
		{
			for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : MapObj->Values)
			{
				FString To;
				if (!Pair.Value.IsValid() || !Pair.Value->TryGetString(To) || To.IsEmpty())
				{
					UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
						TEXT("event_map[\"%s\"] must be the name of an event on the new class"), *Pair.Key));
					return;
				}
				EventMap.Add(FName(*Pair.Key), FName(*To));
			}
		}
	}

	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	UWidgetTree* WidgetTree = WidgetBP->WidgetTree;
	if (!WidgetTree)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("WidgetBlueprint has no WidgetTree"));
		return;
	}
	UWidget* OldWidget = FindWidgetByName(WidgetTree, WidgetName);
	if (!OldWidget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}

	FString ClassError;
	UClass* NewClass = ResolveWidgetClass(NewType, ClassError);
	if (!NewClass)
	{
		UAL_CommandUtils::SendError(RequestId, 400, ClassError);
		return;
	}
	if (UAL_WouldNestSelf(WidgetBP, NewClass))
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(TEXT("%s cannot contain itself"), *WidgetBP->GetName()));
		return;
	}
	if (OldWidget->GetClass() == NewClass)
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("%s is already a %s"), *OldWidget->GetName(), *NewClass->GetName()));
		return;
	}

	UPanelWidget* Parent = OldWidget->GetParent();
	const bool bIsRoot = WidgetTree->RootWidget == OldWidget;
	if (!Parent && !bIsRoot)
	{
		UAL_CommandUtils::SendError(RequestId, 400, FString::Printf(
			TEXT("%s sits in a named slot, not in a panel; replacing it there is not supported"), *OldWidget->GetName()));
		return;
	}
	const FName OldName = OldWidget->GetFName();
	UClass* OldClass = OldWidget->GetClass();

	// ── 1. 事件：绑在旧控件上的每个事件，新类上都得有去处。有一个没着落就一个都不动 ──
	TArray<UK2Node_ComponentBoundEvent*> OldEvents;
	TArray<UEdGraphNode*> VariableNodes;
	UAL_CollectWidgetGraphRefs(WidgetBP, OldName, OldEvents, VariableNodes);
	const TMap<FName, FMulticastDelegateProperty*> NewEvents = UAL_BindableWidgetEvents(NewClass);

	struct FUAL_EventMove
	{
		TWeakObjectPtr<UK2Node_ComponentBoundEvent> Node;
		FName From;
		FName To;
	};
	TArray<FUAL_EventMove> Moves;
	TArray<FString> Unplaced;
	TSet<FName> Taken;
	for (UK2Node_ComponentBoundEvent* Node : OldEvents)
	{
		const FName From = Node->DelegatePropertyName;
		const FName* Mapped = EventMap.Find(From);
		const FName To = Mapped ? *Mapped : From;
		if (!NewEvents.Contains(To))
		{
			Unplaced.Add(Mapped
				? FString::Printf(TEXT("%s → %s (%s has no %s)"), *From.ToString(), *To.ToString(), *NewClass->GetName(), *To.ToString())
				: From.ToString());
			continue;
		}
		if (Taken.Contains(To))
		{
			Unplaced.Add(FString::Printf(TEXT("%s → %s (another event is already going there)"), *From.ToString(), *To.ToString()));
			continue;
		}
		Taken.Add(To);
		Moves.Add({ Node, From, To });
	}
	if (Unplaced.Num() > 0)
	{
		UAL_CommandUtils::SendError(RequestId, 409, FString::Printf(
			TEXT("Nothing replaced: %s has events bound in the graph that %s does not have: %s. ")
			TEXT("Pass event_map {\"<old event>\": \"<new event>\"} to move each one; the logic wired after it stays connected. ")
			TEXT("Events %s can bind: %s"),
			*OldName.ToString(), *NewClass->GetName(), *FString::Join(Unplaced, TEXT("; ")),
			*NewClass->GetName(), *UAL_JoinEventNames(NewEvents)));
		return;
	}

	// ── 2. 子控件：新控件装得下的搬过去；装不下的连同子孙要调用方点头才删 ──
	TArray<UWidget*> OldChildren;
	if (UPanelWidget* OldPanel = Cast<UPanelWidget>(OldWidget))
	{
		for (int32 Index = 0; Index < OldPanel->GetChildrenCount(); ++Index)
		{
			if (UWidget* Child = OldPanel->GetChildAt(Index))
			{
				OldChildren.Add(Child);
			}
		}
	}
	int32 Capacity = 0;
	if (NewClass->IsChildOf(UPanelWidget::StaticClass()))
	{
		const UPanelWidget* PanelCDO = NewClass->GetDefaultObject<UPanelWidget>();
		Capacity = PanelCDO && PanelCDO->CanHaveMultipleChildren() ? MAX_int32 : 1;
	}
	TArray<UWidget*> KeptChildren;
	for (UWidget* Child : OldChildren)
	{
		if (KeptChildren.Num() < Capacity)
		{
			KeptChildren.Add(Child);
		}
	}
	// 留不下的：旧控件的全部子孙（含具名插槽里的内容）去掉搬走的那几支
	TArray<UWidget*> AllDescendants;
	UWidgetTree::GetChildWidgets(OldWidget, AllDescendants);
	TSet<UWidget*> KeptSet;
	for (UWidget* Child : KeptChildren)
	{
		KeptSet.Add(Child);
		TArray<UWidget*> Sub;
		UWidgetTree::GetChildWidgets(Child, Sub);
		KeptSet.Append(Sub);
	}
	TArray<UWidget*> Dropped;
	for (UWidget* Each : AllDescendants)
	{
		if (!KeptSet.Contains(Each))
		{
			Dropped.Add(Each);
		}
	}
	if (Dropped.Num() > 0 && !bDropChildren)
	{
		UAL_CommandUtils::SendError(RequestId, 409, FString::Printf(
			TEXT("Nothing replaced: %s cannot hold what is inside %s, so these would be deleted: %s. ")
			TEXT("Pass drop_children: true to delete them with the old widget (carry their text over with widget_set_property afterwards), ")
			TEXT("or pick a type that can hold them."),
			*NewClass->GetName(), *OldName.ToString(), *UAL_DescribeWidgetsInline(Dropped)));
		return;
	}

	// ── 3. 动手 ──
	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "ReplaceWidget", "Agent Replace Widget"));
	WidgetBP->Modify();
	WidgetTree->SetFlags(RF_Transactional);
	WidgetTree->Modify();
	OldWidget->SetFlags(RF_Transactional);
	OldWidget->Modify();
	if (Parent)
	{
		Parent->SetFlags(RF_Transactional);
		Parent->Modify();
	}

	// 先用临时名建，旧控件让出名字后再改回原名：变量名、图表引用、动画和导航绑定都按名字认
	UWidget* NewWidget = WidgetTree->ConstructWidget<UWidget>(NewClass, NAME_None);
	if (!NewWidget)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("Failed to construct the new widget"));
		return;
	}
	NewWidget->SetFlags(RF_Transactional);
	NewWidget->SetDesignerFlags(EWidgetDesignFlags::Designing);

	// 原地换：槽位对象不动，位置、锚点、尺寸、对齐、边距全留着
	if (Parent)
	{
		if (!Parent->ReplaceChild(OldWidget, NewWidget))
		{
			UAL_CommandUtils::SendError(RequestId, 500, FString::Printf(
				TEXT("Engine refused to swap %s out of %s"), *OldName.ToString(), *Parent->GetName()));
			return;
		}
	}
	else
	{
		WidgetTree->RootWidget = NewWidget;
	}

	TArray<TSharedPtr<FJsonValue>> MovedJson;
	if (UPanelWidget* NewPanel = Cast<UPanelWidget>(NewWidget))
	{
		for (UWidget* Child : KeptChildren)
		{
			Child->SetFlags(RF_Transactional);
			Child->Modify();
			// AddChild 会先把它从旧控件上摘下来
			if (NewPanel->AddChild(Child))
			{
				MovedJson.Add(MakeShared<FJsonValueString>(Child->GetName()));
			}
		}
	}

	const TArray<FString> Carried = UAL_CarryBaseWidgetProperties(OldWidget, NewWidget);
	NewWidget->bIsVariable = OldWidget->bIsVariable || Moves.Num() > 0 || VariableNodes.Num() > 0;

	// 属性绑定（Text 绑到函数那种）：新类上没有这个可绑属性的就去掉，不然编译报错
	TArray<TSharedPtr<FJsonValue>> DroppedBindings;
	for (int32 Index = WidgetBP->Bindings.Num() - 1; Index >= 0; --Index)
	{
		const FDelegateEditorBinding& Binding = WidgetBP->Bindings[Index];
		if (Binding.ObjectName == OldName.ToString()
			&& !FindFProperty<FDelegateProperty>(NewClass, FName(*(Binding.PropertyName.ToString() + TEXT("Delegate")))))
		{
			DroppedBindings.Add(MakeShared<FJsonValueString>(Binding.PropertyName.ToString()));
			WidgetBP->Bindings.RemoveAt(Index);
		}
	}

	// 删掉的子孙：先拆图表引用，再挪去临时包把名字让出来
	TArray<TSharedPtr<FJsonValue>> DroppedJson;
	TArray<TSharedPtr<FJsonValue>> RemovedNodesJson;
	for (UWidget* Each : Dropped)
	{
		DroppedJson.Add(MakeShared<FJsonValueObject>(UAL_DescribeWidgetBrief(Each)));
		for (const FString& Label : UAL_DetachWidgetName(WidgetBP, Each->GetFName()))
		{
			RemovedNodesJson.Add(MakeShared<FJsonValueString>(Label));
		}
		Each->SetFlags(RF_Transactional);
		Each->Modify();
		Each->Rename(nullptr, GetTransientPackage());
	}

	const FString DisplayLabel = OldWidget->GetDisplayLabel();
	OldWidget->Rename(nullptr, GetTransientPackage());
	NewWidget->Rename(*OldName.ToString(), WidgetTree);
	if (!DisplayLabel.IsEmpty())
	{
		NewWidget->SetDisplayLabel(DisplayLabel);
	}

	// 骨架类重建后，同名变量的类型才是新类，事件节点才能挂上去
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);

	FObjectProperty* WidgetProperty = nullptr;
	for (UClass* Candidate : { WidgetBP->SkeletonGeneratedClass.Get(), WidgetBP->GeneratedClass.Get() })
	{
		if (Candidate && !WidgetProperty)
		{
			WidgetProperty = FindFProperty<FObjectProperty>(Candidate, OldName);
		}
	}

	int32 FailedEvents = 0;
	TArray<TSharedPtr<FJsonValue>> EventsJson;
	for (const FUAL_EventMove& Move : Moves)
	{
		TSharedPtr<FJsonObject> EventObj = MakeShared<FJsonObject>();
		EventObj->SetStringField(TEXT("from"), Move.From.ToString());
		EventObj->SetStringField(TEXT("to"), Move.To.ToString());
		UK2Node_ComponentBoundEvent* Node = Move.Node.Get();
		if (!Node || !WidgetProperty)
		{
			++FailedEvents;
			EventObj->SetBoolField(TEXT("ok"), false);
			EventObj->SetStringField(TEXT("error"), Node
				? TEXT("the widget has no variable on the skeleton class; compile the blueprint and bind the event again")
				: TEXT("the event node disappeared during the rebuild"));
			EventsJson.Add(MakeShared<FJsonValueObject>(EventObj));
			continue;
		}
		Node->Modify();
		Node->InitializeComponentBoundEventParams(WidgetProperty, NewEvents.FindChecked(Move.To));
		Node->ReconstructNode();

		// 新事件没有的参数引脚，原来连着线的会变成孤儿引脚，编译报错 —— 点名出来
		TArray<TSharedPtr<FJsonValue>> Orphans;
		for (const UEdGraphPin* Pin : Node->Pins)
		{
			if (Pin && Pin->bOrphanedPin)
			{
				Orphans.Add(MakeShared<FJsonValueString>(Pin->PinName.ToString()));
			}
		}
		const bool bMoved = Node->DelegatePropertyName == Move.To && Node->ComponentPropertyName == OldName;
		if (!bMoved || Orphans.Num() > 0)
		{
			++FailedEvents;
		}
		EventObj->SetBoolField(TEXT("ok"), bMoved && Orphans.Num() == 0);
		EventObj->SetStringField(TEXT("node"), UAL_NodeLabel(Node));
		if (Orphans.Num() > 0)
		{
			EventObj->SetArrayField(TEXT("orphaned_pins"), Orphans);
		}
		EventsJson.Add(MakeShared<FJsonValueObject>(EventObj));
	}

	// 读写这个控件的节点按新类型重建引脚；新类上没有的函数会在编译时报出来
	TArray<TSharedPtr<FJsonValue>> VariableRefsJson;
	for (UEdGraphNode* Node : VariableNodes)
	{
		if (Node)
		{
			Node->ReconstructNode();
			VariableRefsJson.Add(MakeShared<FJsonValueString>(UAL_NodeLabel(Node)));
		}
	}
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);

	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	if (FailedEvents > 0)
	{
		Result->SetNumberField(TEXT("failed_count"), FailedEvents);
	}
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), NewWidget->GetName());
	Result->SetStringField(TEXT("old_class"), OldClass->GetName());
	Result->SetStringField(TEXT("new_class"), NewWidget->GetClass()->GetName());
	Result->SetStringField(TEXT("new_class_path"), NewWidget->GetClass()->GetPathName());
	Result->SetStringField(TEXT("parent"), Parent ? Parent->GetName() : TEXT("(root)"));
	if (NewWidget->Slot)
	{
		Result->SetStringField(TEXT("slot_type"), NewWidget->Slot->GetClass()->GetName());
	}
	Result->SetBoolField(TEXT("is_variable"), NewWidget->bIsVariable);
	Result->SetArrayField(TEXT("moved_children"), MovedJson);
	Result->SetArrayField(TEXT("dropped_widgets"), DroppedJson);
	if (RemovedNodesJson.Num() > 0)
	{
		Result->SetArrayField(TEXT("removed_graph_nodes"), RemovedNodesJson);
	}
	Result->SetArrayField(TEXT("events_moved"), EventsJson);
	if (VariableRefsJson.Num() > 0)
	{
		Result->SetArrayField(TEXT("variable_references"), VariableRefsJson);
	}
	if (DroppedBindings.Num() > 0)
	{
		Result->SetArrayField(TEXT("dropped_bindings"), DroppedBindings);
	}
	TArray<TSharedPtr<FJsonValue>> CarriedJson;
	for (const FString& Name : Carried)
	{
		CarriedJson.Add(MakeShared<FJsonValueString>(Name));
	}
	Result->SetArrayField(TEXT("carried_properties"), CarriedJson);
	TArray<FString> EventNames;
	for (const TPair<FName, FMulticastDelegateProperty*>& Pair : NewEvents)
	{
		EventNames.Add(Pair.Key.ToString());
	}
	EventNames.Sort();
	TArray<TSharedPtr<FJsonValue>> EventNamesJson;
	for (const FString& Name : EventNames)
	{
		EventNamesJson.Add(MakeShared<FJsonValueString>(Name));
	}
	Result->SetArrayField(TEXT("bindable_events"), EventNamesJson);
	// 实例上能设的属性：换成用户控件后，按钮文字这类东西就在这里
	Result->SetStringField(TEXT("editable_properties"), UAL_InstanceEditableNamesFor(NewWidget));

	UE_LOG(LogUALWidget, Log, TEXT("widget.replace: %s %s -> %s, moved=%d dropped=%d events=%d failed=%d"),
		*OldName.ToString(), *OldClass->GetName(), *NewClass->GetName(), MovedJson.Num(), Dropped.Num(), Moves.Num(), FailedEvents);
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.replace is only available in editor mode"));
#endif
}

void FUAL_WidgetCommands::Handle_Remove(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
#if WITH_EDITOR
	FString Path;
	FString WidgetName;
	if (!Payload->TryGetStringField(TEXT("path"), Path))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: path"));
		return;
	}
	if (!Payload->TryGetStringField(TEXT("widget_name"), WidgetName))
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("Missing required field: widget_name"));
		return;
	}
	bool bForce = false;
	Payload->TryGetBoolField(TEXT("force"), bForce);

	FString Error;
	UWidgetBlueprint* WidgetBP = LoadWidgetBlueprint(Path, Error);
	if (!WidgetBP)
	{
		UAL_CommandUtils::SendError(RequestId, 404, Error);
		return;
	}
	UWidgetTree* WidgetTree = WidgetBP->WidgetTree;
	if (!WidgetTree)
	{
		UAL_CommandUtils::SendError(RequestId, 500, TEXT("WidgetBlueprint has no WidgetTree"));
		return;
	}
	UWidget* Widget = FindWidgetByName(WidgetTree, WidgetName);
	if (!Widget)
	{
		UAL_CommandUtils::SendError(RequestId, 404, FString::Printf(TEXT("Widget not found: %s"), *WidgetName));
		return;
	}

	TArray<UWidget*> Doomed = { Widget };
	UWidgetTree::GetChildWidgets(Widget, Doomed);

	// 图表里还在用的，默认不删，列出来；force 才连节点一起删（和删 Actor 查引用是同一个规矩）
	TArray<FString> InUse;
	for (UWidget* Each : Doomed)
	{
		TArray<UK2Node_ComponentBoundEvent*> Events;
		TArray<UEdGraphNode*> Others;
		UAL_CollectWidgetGraphRefs(WidgetBP, Each->GetFName(), Events, Others);
		for (const UEdGraphNode* Node : Others)
		{
			InUse.Add(UAL_NodeLabel(Node));
		}
		for (const UK2Node_ComponentBoundEvent* Node : Events)
		{
			InUse.Add(UAL_NodeLabel(Node));
		}
	}
	if (InUse.Num() > 0 && !bForce)
	{
		UAL_CommandUtils::SendError(RequestId, 409, FString::Printf(
			TEXT("Nothing removed: the graph still uses %s or its children: %s. ")
			TEXT("Pass force: true to remove them together with these nodes (logic wired after a removed event stays, disconnected), ")
			TEXT("or move the logic first."),
			*Widget->GetName(), *FString::Join(InUse, TEXT("; "))));
		return;
	}

	const FUAL_ScopedTransaction Transaction(NSLOCTEXT("UAL", "RemoveWidget", "Agent Remove Widget"));
	WidgetBP->Modify();
	WidgetTree->SetFlags(RF_Transactional);
	WidgetTree->Modify();
	UPanelWidget* Parent = Widget->GetParent();
	const FString ParentName = Parent ? Parent->GetName() : (WidgetTree->RootWidget == Widget ? TEXT("(root)") : TEXT("(named slot)"));
	if (Parent)
	{
		Parent->SetFlags(RF_Transactional);
		Parent->Modify();
	}
	Widget->SetFlags(RF_Transactional);
	Widget->Modify();

	if (!WidgetTree->RemoveWidget(Widget))
	{
		UAL_CommandUtils::SendError(RequestId, 500, FString::Printf(TEXT("Engine refused to remove %s"), *Widget->GetName()));
		return;
	}

	TArray<TSharedPtr<FJsonValue>> RemovedJson;
	TArray<TSharedPtr<FJsonValue>> RemovedNodesJson;
	for (UWidget* Each : Doomed)
	{
		RemovedJson.Add(MakeShared<FJsonValueObject>(UAL_DescribeWidgetBrief(Each)));
		for (const FString& Label : UAL_DetachWidgetName(WidgetBP, Each->GetFName()))
		{
			RemovedNodesJson.Add(MakeShared<FJsonValueString>(Label));
		}
		Each->SetFlags(RF_Transactional);
		Each->Modify();
		// 挪去临时包，名字让给以后的新控件
		Each->Rename(nullptr, GetTransientPackage());
	}
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(WidgetBP);

	TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("ok"), true);
	Result->SetStringField(TEXT("widget_name"), WidgetName);
	Result->SetStringField(TEXT("parent"), ParentName);
	Result->SetArrayField(TEXT("removed"), RemovedJson);
	Result->SetArrayField(TEXT("removed_graph_nodes"), RemovedNodesJson);

	UE_LOG(LogUALWidget, Log, TEXT("widget.remove: %s (+%d children), graph nodes removed=%d"),
		*WidgetName, Doomed.Num() - 1, RemovedNodesJson.Num());
	UAL_CommandUtils::SendResponse(RequestId, 200, Result);
#else
	UAL_CommandUtils::SendError(RequestId, 501, TEXT("widget.remove is only available in editor mode"));
#endif
}

// ============================================================================
// 辅助函数
// ============================================================================

UWidgetBlueprint* FUAL_WidgetCommands::LoadWidgetBlueprint(const FString& Path, FString& OutError)
{
#if WITH_EDITOR
	// 尝试多种路径格式
	FString NormalizedPath = Path;
	if (!NormalizedPath.StartsWith(TEXT("/")))
	{
		NormalizedPath = TEXT("/") + NormalizedPath;
	}
	
	// 尝试直接加载
	UObject* LoadedObject = StaticLoadObject(UWidgetBlueprint::StaticClass(), nullptr, *NormalizedPath);
	if (LoadedObject)
	{
		return Cast<UWidgetBlueprint>(LoadedObject);
	}
	
	// 尝试添加 _C 后缀（BlueprintGeneratedClass）
	if (!NormalizedPath.EndsWith(TEXT("_C")))
	{
		FString ClassPath = NormalizedPath + TEXT("_C");
		LoadedObject = StaticLoadObject(UWidgetBlueprint::StaticClass(), nullptr, *ClassPath);
		if (LoadedObject)
		{
			return Cast<UWidgetBlueprint>(LoadedObject);
		}
	}
	
	// 尝试通过 Asset Registry 查找
	FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();
	
	FString PackagePath, AssetName;
	NormalizedPath.Split(TEXT("."), &PackagePath, &AssetName, ESearchCase::CaseSensitive, ESearchDir::FromEnd);
	if (AssetName.IsEmpty())
	{
		// 从路径获取资产名
		int32 LastSlash;
		if (NormalizedPath.FindLastChar(TEXT('/'), LastSlash))
		{
			AssetName = NormalizedPath.Mid(LastSlash + 1);
			PackagePath = NormalizedPath.Left(LastSlash);
		}
	}
	
	TArray<FAssetData> AssetDataList;
	FARFilter Filter;
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	Filter.ClassPaths.Add(UWidgetBlueprint::StaticClass()->GetClassPathName());
#else
	Filter.ClassNames.Add(UWidgetBlueprint::StaticClass()->GetFName());
#endif
	Filter.PackagePaths.Add(FName(*PackagePath));
	AssetRegistry.GetAssets(Filter, AssetDataList);
	
	for (const FAssetData& AssetData : AssetDataList)
	{
		if (AssetData.AssetName.ToString() == AssetName || AssetData.GetFullName().Contains(AssetName))
		{
			UObject* Asset = AssetData.GetAsset();
			if (UWidgetBlueprint* WidgetBP = Cast<UWidgetBlueprint>(Asset))
			{
				return WidgetBP;
			}
		}
	}
	
	OutError = FString::Printf(TEXT("Widget Blueprint not found: %s"), *Path);
	return nullptr;
#else
	OutError = TEXT("LoadWidgetBlueprint is only available in editor mode");
	return nullptr;
#endif
}

UWidget* FUAL_WidgetCommands::FindWidgetByName(UWidgetTree* WidgetTree, const FString& WidgetName)
{
	if (!WidgetTree)
	{
		return nullptr;
	}
	
	// 如果名称为空或 "root"，返回根控件
	if (WidgetName.IsEmpty() || WidgetName.Equals(TEXT("root"), ESearchCase::IgnoreCase))
	{
		return WidgetTree->RootWidget;
	}
	
	UWidget* FoundWidget = nullptr;
	WidgetTree->ForEachWidget([&FoundWidget, &WidgetName](UWidget* Widget)
	{
		if (Widget && Widget->GetName().Equals(WidgetName, ESearchCase::IgnoreCase))
		{
			FoundWidget = Widget;
		}
	});
	
	return FoundWidget;
}

UClass* FUAL_WidgetCommands::FindWidgetClass(const FString& ClassName)
{
	FString Ignored;
	return ResolveWidgetClass(ClassName, Ignored);
}

/**
 * 控件类型名 → 类。原生类名、控件蓝图名、资产路径都认。
 *
 * 原来只有一张 24 项的表，表外按 `U<名字>` 去找 —— 而类对象的名字本来就不带
 * U 前缀（UButton 的类对象叫 Button），所以那一步从来没找到过东西；工程自己
 * 做的控件蓝图（WB_Text_Button 这类，CommonUI 项目里按钮全是它）更是完全够不着。
 * 用户说「把登录按钮换成导航那种」，第一步就卡在这里。
 */
UClass* FUAL_WidgetCommands::ResolveWidgetClass(const FString& InName, FString& OutError)
{
	// 常见控件类型映射
	static TMap<FString, UClass*> WidgetClassMap;
	if (WidgetClassMap.Num() == 0)
	{
		WidgetClassMap.Add(TEXT("Button"), UButton::StaticClass());
		WidgetClassMap.Add(TEXT("Text"), UTextBlock::StaticClass());
		WidgetClassMap.Add(TEXT("TextBlock"), UTextBlock::StaticClass());
		WidgetClassMap.Add(TEXT("Image"), UImage::StaticClass());
		WidgetClassMap.Add(TEXT("CanvasPanel"), UCanvasPanel::StaticClass());
		WidgetClassMap.Add(TEXT("VerticalBox"), UVerticalBox::StaticClass());
		WidgetClassMap.Add(TEXT("HorizontalBox"), UHorizontalBox::StaticClass());
		WidgetClassMap.Add(TEXT("Overlay"), UOverlay::StaticClass());
		WidgetClassMap.Add(TEXT("Border"), UBorder::StaticClass());
		WidgetClassMap.Add(TEXT("ScrollBox"), UScrollBox::StaticClass());
		WidgetClassMap.Add(TEXT("SizeBox"), USizeBox::StaticClass());
		WidgetClassMap.Add(TEXT("Spacer"), USpacer::StaticClass());
		WidgetClassMap.Add(TEXT("ProgressBar"), UProgressBar::StaticClass());
		WidgetClassMap.Add(TEXT("Slider"), USlider::StaticClass());
		WidgetClassMap.Add(TEXT("CheckBox"), UCheckBox::StaticClass());
		WidgetClassMap.Add(TEXT("ComboBox"), UComboBoxString::StaticClass());
		WidgetClassMap.Add(TEXT("ComboBoxString"), UComboBoxString::StaticClass());
		WidgetClassMap.Add(TEXT("EditableText"), UEditableText::StaticClass());
		WidgetClassMap.Add(TEXT("EditableTextBox"), UEditableTextBox::StaticClass());
		WidgetClassMap.Add(TEXT("SpinBox"), USpinBox::StaticClass());
		WidgetClassMap.Add(TEXT("RichTextBlock"), URichTextBlock::StaticClass());
		WidgetClassMap.Add(TEXT("GridPanel"), UGridPanel::StaticClass());
		WidgetClassMap.Add(TEXT("WrapBox"), UWrapBox::StaticClass());
		WidgetClassMap.Add(TEXT("UniformGridPanel"), UUniformGridPanel::StaticClass());
	}
	
	const FString Name = InName.TrimStartAndEnd();
	if (Name.IsEmpty())
	{
		OutError = TEXT("Control type is empty");
		return nullptr;
	}

	if (UClass** FoundClass = WidgetClassMap.Find(Name))
	{
		return *FoundClass;
	}

	auto AcceptClass = [&OutError, &Name](UClass* Class) -> UClass*
	{
		if (!Class->IsChildOf(UWidget::StaticClass()))
		{
			OutError = FString::Printf(TEXT("'%s' is %s, which is not a widget class"), *Name, *Class->GetPathName());
			return nullptr;
		}
		if (Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists))
		{
			OutError = FString::Printf(TEXT("'%s' (%s) is abstract or deprecated and cannot be placed; use a concrete subclass"),
				*Name, *Class->GetName());
			return nullptr;
		}
		return Class;
	};

#if WITH_EDITOR
	// 控件蓝图 → 它的生成类。还没编译过的蓝图没有生成类，放不进去
	auto ClassOfWidgetBlueprint = [&OutError, &AcceptClass](UWidgetBlueprint* WidgetBP) -> UClass*
	{
		if (!WidgetBP->GeneratedClass)
		{
			OutError = FString::Printf(TEXT("Widget Blueprint %s has never been compiled; compile it first"), *WidgetBP->GetPathName());
			return nullptr;
		}
		return AcceptClass(WidgetBP->GeneratedClass);
	};
#endif

	// 1. 路径：/Script/CommonUI.CommonButtonBase，或控件蓝图 /Game/UI/WB_X（带不带 .WB_X、_C 都行）
	if (Name.StartsWith(TEXT("/")))
	{
		if (Name.StartsWith(TEXT("/Script/")))
		{
			if (UClass* Native = LoadObject<UClass>(nullptr, *Name, nullptr, LOAD_NoWarn | LOAD_Quiet))
			{
				return AcceptClass(Native);
			}
			OutError = FString::Printf(TEXT("No class at '%s' (is its module or plugin enabled?)"), *Name);
			return nullptr;
		}
#if WITH_EDITOR
		FString ObjectPath = Name;
		ObjectPath.RemoveFromEnd(TEXT("_C"));
		if (!ObjectPath.Contains(TEXT(".")))
		{
			ObjectPath += TEXT(".") + FPackageName::GetShortName(ObjectPath);
		}
		if (UWidgetBlueprint* WidgetBP = LoadObject<UWidgetBlueprint>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn | LOAD_Quiet))
		{
			return ClassOfWidgetBlueprint(WidgetBP);
		}
#endif
		OutError = FString::Printf(TEXT("No Widget Blueprint at '%s'"), *Name);
		return nullptr;
	}

	// 2. 原生类。类对象的名字不带 U 前缀；调用方写了 U 前缀（UCommonButtonBase）也认
	TArray<FString> NativeCandidates = { Name };
	if (Name.Len() > 2 && Name[0] == TEXT('U') && FChar::IsUpper(Name[1]))
	{
		NativeCandidates.Add(Name.Mid(1));
	}
	for (const FString& Candidate : NativeCandidates)
	{
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
		UClass* Native = FindFirstObject<UClass>(*Candidate, EFindFirstObjectOptions::None);
#else
		UClass* Native = FindObject<UClass>(ANY_PACKAGE, *Candidate);
#endif
		if (Native && Native->HasAnyClassFlags(CLASS_Native) && Native->IsChildOf(UWidget::StaticClass()))
		{
			return AcceptClass(Native);
		}
	}

#if WITH_EDITOR
	// 3. 控件蓝图按资产名（WB_Text_Button / WB_Text_Button_C）。重名就让调用方给路径，不替它挑
	FString AssetName = Name;
	AssetName.RemoveFromEnd(TEXT("_C"));
	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry").Get();
	FARFilter Filter;
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	Filter.ClassPaths.Add(UWidgetBlueprint::StaticClass()->GetClassPathName());
#else
	Filter.ClassNames.Add(UWidgetBlueprint::StaticClass()->GetFName());
#endif
	Filter.bRecursiveClasses = true;
	TArray<FAssetData> AllWidgetBPs;
	AssetRegistry.GetAssets(Filter, AllWidgetBPs);

	TArray<FAssetData> Matches;
	for (const FAssetData& AssetData : AllWidgetBPs)
	{
		if (AssetData.AssetName.ToString().Equals(AssetName, ESearchCase::IgnoreCase))
		{
			Matches.Add(AssetData);
		}
	}
	if (Matches.Num() == 1)
	{
		if (UWidgetBlueprint* WidgetBP = Cast<UWidgetBlueprint>(Matches[0].GetAsset()))
		{
			return ClassOfWidgetBlueprint(WidgetBP);
		}
	}
	if (Matches.Num() > 1)
	{
		TArray<FString> Paths;
		for (const FAssetData& Match : Matches)
		{
			Paths.Add(Match.PackageName.ToString());
		}
		OutError = FString::Printf(TEXT("'%s' matches %d Widget Blueprints, pass the full path instead: %s"),
			*Name, Matches.Num(), *FString::Join(Paths, TEXT(", ")));
		return nullptr;
	}
#endif

	OutError = FString::Printf(
		TEXT("Unknown control type '%s': not a widget class and no Widget Blueprint has that name. ")
		TEXT("Native classes go without the U prefix (Button, CommonButtonBase); project widgets by asset name (WB_Text_Button) or path (/Game/UI/WB_Text_Button)."),
		*Name);
	return nullptr;
}

TSharedPtr<FJsonObject> FUAL_WidgetCommands::BuildWidgetJson(UWidget* Widget)
{
	if (!Widget)
	{
		return nullptr;
	}
	
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	
	// 基本信息
	Obj->SetStringField(TEXT("name"), Widget->GetName());
	Obj->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
	Obj->SetBoolField(TEXT("is_variable"), Widget->bIsVariable);
	// 报**设计期的 Visibility 属性**，不是 IsVisible()。
	//
	// IsVisible() 问的是「此刻在屏幕上看得见吗」，而这里遍历的是
	// WidgetBlueprint 里的模板控件 —— 它们没有对应的 Slate 实例，
	// 所以**恒为 false**。调用方据此会以为整个界面都被隐藏了，
	// 然后去「修」一个本来就没问题的可见性。
	Obj->SetStringField(TEXT("visibility"),
		StaticEnum<ESlateVisibility>()
			? StaticEnum<ESlateVisibility>()->GetNameStringByValue((int64)Widget->GetVisibility())
			: TEXT("Unknown"));
	
	// Slot 信息
	if (UPanelSlot* Slot = Widget->Slot)
	{
		Obj->SetStringField(TEXT("slot_type"), Slot->GetClass()->GetName());
		
		// 根据 Slot 类型导出具体属性
		if (UCanvasPanelSlot* CanvasSlot = Cast<UCanvasPanelSlot>(Slot))
		{
			Obj->SetObjectField(TEXT("slot_data"), BuildCanvasSlotJson(CanvasSlot));
		}
		else if (UVerticalBoxSlot* VSlot = Cast<UVerticalBoxSlot>(Slot))
		{
			Obj->SetObjectField(TEXT("slot_data"), BuildVerticalSlotJson(VSlot));
		}
		else if (UHorizontalBoxSlot* HSlot = Cast<UHorizontalBoxSlot>(Slot))
		{
			Obj->SetObjectField(TEXT("slot_data"), BuildHorizontalSlotJson(HSlot));
		}
		else if (UOverlaySlot* OSlot = Cast<UOverlaySlot>(Slot))
		{
			// Overlay Slot
			TSharedPtr<FJsonObject> SlotData = MakeShared<FJsonObject>();
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
			SlotData->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(OSlot->GetHorizontalAlignment()));
			SlotData->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(OSlot->GetVerticalAlignment()));
#else
			SlotData->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(TEXT("EHorizontalAlignment"), OSlot->HorizontalAlignment));
			SlotData->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(TEXT("EVerticalAlignment"), OSlot->VerticalAlignment));
#endif
			Obj->SetObjectField(TEXT("slot_data"), SlotData);
		}
		else if (UGridSlot* GSlot = Cast<UGridSlot>(Slot))
		{
			// Grid Slot
			TSharedPtr<FJsonObject> SlotData = MakeShared<FJsonObject>();
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
			SlotData->SetNumberField(TEXT("row"), GSlot->GetRow());
			SlotData->SetNumberField(TEXT("column"), GSlot->GetColumn());
			SlotData->SetNumberField(TEXT("row_span"), GSlot->GetRowSpan());
			SlotData->SetNumberField(TEXT("column_span"), GSlot->GetColumnSpan());
#else
			SlotData->SetNumberField(TEXT("row"), GSlot->Row);
			SlotData->SetNumberField(TEXT("column"), GSlot->Column);
			SlotData->SetNumberField(TEXT("row_span"), GSlot->RowSpan);
			SlotData->SetNumberField(TEXT("column_span"), GSlot->ColumnSpan);
#endif
			Obj->SetObjectField(TEXT("slot_data"), SlotData);
		}
	}
	
	// 如果是容器控件，递归处理子控件
	if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
	{
		TArray<TSharedPtr<FJsonValue>> Children;
		for (int32 i = 0; i < Panel->GetChildrenCount(); i++)
		{
			UWidget* Child = Panel->GetChildAt(i);
			TSharedPtr<FJsonObject> ChildJson = BuildWidgetJson(Child);
			if (ChildJson.IsValid())
			{
				Children.Add(MakeShared<FJsonValueObject>(ChildJson));
			}
		}
		
		if (Children.Num() > 0)
		{
			Obj->SetArrayField(TEXT("children"), Children);
		}
	}
	
	return Obj;
}

TSharedPtr<FJsonObject> FUAL_WidgetCommands::BuildCanvasSlotJson(UCanvasPanelSlot* Slot)
{
	if (!Slot)
	{
		return nullptr;
	}
	
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	
	// Anchors
	FAnchors Anchors = Slot->GetAnchors();
	TSharedPtr<FJsonObject> AnchorsObj = MakeShared<FJsonObject>();
	AnchorsObj->SetNumberField(TEXT("min_x"), Anchors.Minimum.X);
	AnchorsObj->SetNumberField(TEXT("min_y"), Anchors.Minimum.Y);
	AnchorsObj->SetNumberField(TEXT("max_x"), Anchors.Maximum.X);
	AnchorsObj->SetNumberField(TEXT("max_y"), Anchors.Maximum.Y);
	Obj->SetObjectField(TEXT("anchors"), AnchorsObj);
	
	// Offsets (Position/Size)
	FMargin Offsets = Slot->GetOffsets();
	TSharedPtr<FJsonObject> OffsetsObj = MakeShared<FJsonObject>();
	OffsetsObj->SetNumberField(TEXT("left"), Offsets.Left);
	OffsetsObj->SetNumberField(TEXT("top"), Offsets.Top);
	OffsetsObj->SetNumberField(TEXT("right"), Offsets.Right);
	OffsetsObj->SetNumberField(TEXT("bottom"), Offsets.Bottom);
	Obj->SetObjectField(TEXT("offsets"), OffsetsObj);
	
	// Position
	FVector2D Position = Slot->GetPosition();
	TSharedPtr<FJsonObject> PosObj = MakeShared<FJsonObject>();
	PosObj->SetNumberField(TEXT("x"), Position.X);
	PosObj->SetNumberField(TEXT("y"), Position.Y);
	Obj->SetObjectField(TEXT("position"), PosObj);
	
	// Size
	FVector2D Size = Slot->GetSize();
	TSharedPtr<FJsonObject> SizeObj = MakeShared<FJsonObject>();
	SizeObj->SetNumberField(TEXT("width"), Size.X);
	SizeObj->SetNumberField(TEXT("height"), Size.Y);
	Obj->SetObjectField(TEXT("size"), SizeObj);
	
	// Alignment
	FVector2D Alignment = Slot->GetAlignment();
	TSharedPtr<FJsonObject> AlignObj = MakeShared<FJsonObject>();
	AlignObj->SetNumberField(TEXT("x"), Alignment.X);
	AlignObj->SetNumberField(TEXT("y"), Alignment.Y);
	Obj->SetObjectField(TEXT("alignment"), AlignObj);
	
	// Auto Size
	Obj->SetBoolField(TEXT("auto_size"), Slot->GetAutoSize());
	
	// Z Order
	Obj->SetNumberField(TEXT("z_order"), Slot->GetZOrder());
	
	return Obj;
}

TSharedPtr<FJsonObject> FUAL_WidgetCommands::BuildVerticalSlotJson(UVerticalBoxSlot* Slot)
{
	if (!Slot)
	{
		return nullptr;
	}
	
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	
	// Padding
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	FMargin Padding = Slot->GetPadding();
#else
	FMargin Padding = Slot->Padding;
#endif
	TSharedPtr<FJsonObject> PaddingObj = MakeShared<FJsonObject>();
	PaddingObj->SetNumberField(TEXT("left"), Padding.Left);
	PaddingObj->SetNumberField(TEXT("top"), Padding.Top);
	PaddingObj->SetNumberField(TEXT("right"), Padding.Right);
	PaddingObj->SetNumberField(TEXT("bottom"), Padding.Bottom);
	Obj->SetObjectField(TEXT("padding"), PaddingObj);
	
	// Size
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	FSlateChildSize Size = Slot->GetSize();
	Obj->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(Slot->GetHorizontalAlignment()));
	Obj->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(Slot->GetVerticalAlignment()));
#else
	FSlateChildSize Size = Slot->Size;
	Obj->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(TEXT("EHorizontalAlignment"), Slot->HorizontalAlignment));
	Obj->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(TEXT("EVerticalAlignment"), Slot->VerticalAlignment));
#endif
	Obj->SetStringField(TEXT("size_rule"), Size.SizeRule == ESlateSizeRule::Automatic ? TEXT("Auto") : TEXT("Fill"));
	Obj->SetNumberField(TEXT("size_value"), Size.Value);
	
	return Obj;
}

TSharedPtr<FJsonObject> FUAL_WidgetCommands::BuildHorizontalSlotJson(UHorizontalBoxSlot* Slot)
{
	if (!Slot)
	{
		return nullptr;
	}
	
	TSharedPtr<FJsonObject> Obj = MakeShared<FJsonObject>();
	
	// Padding
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	FMargin Padding = Slot->GetPadding();
#else
	FMargin Padding = Slot->Padding;
#endif
	TSharedPtr<FJsonObject> PaddingObj = MakeShared<FJsonObject>();
	PaddingObj->SetNumberField(TEXT("left"), Padding.Left);
	PaddingObj->SetNumberField(TEXT("top"), Padding.Top);
	PaddingObj->SetNumberField(TEXT("right"), Padding.Right);
	PaddingObj->SetNumberField(TEXT("bottom"), Padding.Bottom);
	Obj->SetObjectField(TEXT("padding"), PaddingObj);
	
	// Size
#if ENGINE_MAJOR_VERSION >= 5 && ENGINE_MINOR_VERSION >= 1
	FSlateChildSize Size = Slot->GetSize();
	Obj->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(Slot->GetHorizontalAlignment()));
	Obj->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(Slot->GetVerticalAlignment()));
#else
	FSlateChildSize Size = Slot->Size;
	Obj->SetStringField(TEXT("h_align"), UEnum::GetValueAsString(TEXT("EHorizontalAlignment"), Slot->HorizontalAlignment));
	Obj->SetStringField(TEXT("v_align"), UEnum::GetValueAsString(TEXT("EVerticalAlignment"), Slot->VerticalAlignment));
#endif
	Obj->SetStringField(TEXT("size_rule"), Size.SizeRule == ESlateSizeRule::Automatic ? TEXT("Auto") : TEXT("Fill"));
	Obj->SetNumberField(TEXT("size_value"), Size.Value);
	
	return Obj;
}

FAnchors FUAL_WidgetCommands::ParseAnchors(const FString& AnchorsStr)
{
	// 预设锚点映射
	if (AnchorsStr.Equals(TEXT("TopLeft"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.0f, 0.0f, 0.0f, 0.0f);
	}
	else if (AnchorsStr.Equals(TEXT("TopCenter"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.5f, 0.0f, 0.5f, 0.0f);
	}
	else if (AnchorsStr.Equals(TEXT("TopRight"), ESearchCase::IgnoreCase))
	{
		return FAnchors(1.0f, 0.0f, 1.0f, 0.0f);
	}
	else if (AnchorsStr.Equals(TEXT("CenterLeft"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.0f, 0.5f, 0.0f, 0.5f);
	}
	else if (AnchorsStr.Equals(TEXT("Center"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.5f, 0.5f, 0.5f, 0.5f);
	}
	else if (AnchorsStr.Equals(TEXT("CenterRight"), ESearchCase::IgnoreCase))
	{
		return FAnchors(1.0f, 0.5f, 1.0f, 0.5f);
	}
	else if (AnchorsStr.Equals(TEXT("BottomLeft"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.0f, 1.0f, 0.0f, 1.0f);
	}
	else if (AnchorsStr.Equals(TEXT("BottomCenter"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.5f, 1.0f, 0.5f, 1.0f);
	}
	else if (AnchorsStr.Equals(TEXT("BottomRight"), ESearchCase::IgnoreCase))
	{
		return FAnchors(1.0f, 1.0f, 1.0f, 1.0f);
	}
	else if (AnchorsStr.Equals(TEXT("Stretch"), ESearchCase::IgnoreCase) || 
	         AnchorsStr.Equals(TEXT("Fill"), ESearchCase::IgnoreCase))
	{
		return FAnchors(0.0f, 0.0f, 1.0f, 1.0f);
	}
	
	// 默认左上角
	return FAnchors(0.0f, 0.0f, 0.0f, 0.0f);
}

FVector2D FUAL_WidgetCommands::ParseVector2D(const TSharedPtr<FJsonObject>& Obj)
{
	if (!Obj.IsValid())
	{
		return FVector2D::ZeroVector;
	}
	
	double X = 0.0, Y = 0.0;
	
	// 支持 x/y 或 width/height
	if (!Obj->TryGetNumberField(TEXT("x"), X))
	{
		Obj->TryGetNumberField(TEXT("width"), X);
	}
	if (!Obj->TryGetNumberField(TEXT("y"), Y))
	{
		Obj->TryGetNumberField(TEXT("height"), Y);
	}
	
	return FVector2D(X, Y);
}
