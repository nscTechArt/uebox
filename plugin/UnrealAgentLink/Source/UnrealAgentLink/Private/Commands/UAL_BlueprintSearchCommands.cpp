#include "UAL_BlueprintSearchCommands.h"

#include "UAL_CommandUtils.h"

#include "Async/TaskGraphInterfaces.h"
#include "Containers/Ticker.h"
#include "CoreGlobals.h"
#include "FindInBlueprintManager.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"
#include "HAL/RunnableThread.h"
#include "Misc/PackageName.h"

/*
 * 「Index All」的权限开关（Blueprint Editor Settings → Find in Blueprints → AllowIndexAllBlueprints）
 * 5.4 才有：枚举在 Kismet 的 FindInBlueprints.h，设置项在 BlueprintGraph 的
 * BlueprintEditorSettings.h（后者自己 include 前者）。5.0–5.3 没有这个开关，按钮总是可用。
 * 九个引擎逐版本 grep 过。
 */
#if ENGINE_MAJOR_VERSION > 5 || (ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 4)
#include "BlueprintEditorSettings.h"
#define UAL_FIB_HAS_INDEX_ALL_PERMISSION 1
#else
#define UAL_FIB_HAS_INDEX_ALL_PERMISSION 0
#endif

DEFINE_LOG_CATEGORY_STATIC(LogUALBlueprintSearch, Log, All);

/*
 * 用到的引擎 API（Editor/Kismet/Public/FindInBlueprintManager.h，5.0–5.8 九个版本逐个比对过）：
 *
 *   FStreamSearch(const FString&, const FStreamSearchOptions& = {})  构造即开线程
 *   FStreamSearch::IsComplete / GetFilteredItems / Stop / EnsureCompletion / GetOutOfDateCount
 *   FStreamSearch::Thread（public 的 TUniquePtr<FRunnableThread>）
 *   FFindInBlueprintSearchManager::Get / GetNumberUnindexedAssets / GetFailedToCacheCount /
 *     IsCacheInProgress / IsAssetDiscoveryInProgress / CacheAllAssets
 *   FFindInBlueprintsResult::DisplayText / Children / FinalizeSearchData / GetCategory
 *
 * 签名九版一致：5.0–5.6 导出宏挂在类上（KISMET_API），5.7 起挂在每个成员上（UE_API），
 * 调用方不受影响。5.1 起 FSearchData::AssetPath 从 FName 换成 FSoftObjectPath ——
 * 这里不碰 FSearchData，所以不用分版本。
 *
 * 搜索结果树的形状（ImaginaryBlueprintData.cpp 的 CreateSearchResult_Internal）：
 * 根节点一个蓝图，DisplayText 是它的对象路径（FiB_Path，形如 /Game/A/BP_X.BP_X）；
 * 下面是图表 / 变量 / 组件等分类，再往下是节点和引脚。引擎只把有子节点的根交出来，
 * 叶子就是命中的那一项，上面那串祖先是它在哪。
 */
namespace UALFiB
{
	constexpr int32 DefaultLimit = 50;
	constexpr int32 MaxLimit = 500;
	/** 每个蓝图最多列几条命中。总数照报（match_count），模型要细看就开那个蓝图 */
	constexpr int32 MaxMatchesPerBlueprint = 10;
	/**
	 * 超时。正常一次搜索几秒内完成；但编辑器启动后的**第一次**全局搜索会放开引擎推迟的
	 * 整批索引（bHasFirstSearchOccurred），搜索线程要等那批建完才搜得到它们 ——
	 * 大工程可能要好一阵。超时就交出已经搜到的部分，并标 timed_out。
	 */
	constexpr double TimeoutSeconds = 60.0;

	struct FMatch
	{
		FString Text;
		FString Category;
		FString Context;
	};

	/** 把一棵结果树压成叶子列表，每条带上祖先链（不含根上的蓝图路径） */
	void CollectLeaves(const TSharedPtr<FFindInBlueprintsResult>& Node, TArray<FString>& Trail, TArray<FMatch>& Out)
	{
		if (!Node.IsValid())
		{
			return;
		}

		// 有些字段（节点的 UClass、引脚类型）在搜索线程上不能碰，引擎留到游戏线程再补；
		// GetCategory 靠它分辨「函数调用 / 事件 / 变量」。编辑器的结果窗口也是先调这个再显示
		Node->FinalizeSearchData();

		if (Node->Children.Num() == 0)
		{
			FMatch Match;
			Match.Text = Node->DisplayText.ToString();
			Match.Category = Node->GetCategory().ToString();
			Match.Context = FString::Join(Trail, TEXT(" > "));
			Out.Add(MoveTemp(Match));
			return;
		}

		Trail.Add(Node->DisplayText.ToString());
		for (const TSharedPtr<FFindInBlueprintsResult>& Child : Node->Children)
		{
			CollectLeaves(Child, Trail, Out);
		}
		Trail.Pop();
	}

	struct FJob
	{
		FString RequestId;
		FString Query;
		int32 Limit = DefaultLimit;
		bool bIndexUnindexed = false;
		double StartedAt = 0.0;
		TSharedPtr<FStreamSearch> Search;
		TArray<TSharedPtr<FFindInBlueprintsResult>> Roots;
	};

	/**
	 * 「Index All」按钮背后的同一个调用：加载所有未索引 / 索引过期的蓝图并重建索引。
	 *
	 * 不由我们直接加载：`CacheAllAssets(CacheUnindexedAssets)` 会先弹**引擎自己的确认框**
	 * （要加载多少个、编辑器可能卡一阵、要不要签出重存），用户点了才开始，进度在右下角通知里。
	 * 那个框是模态的，所以挪到回包之后的下一拍再调 —— 否则这次搜索的结果要等用户点完才回得去。
	 *
	 * 返回状态字符串，写进回执的 index_all.status。
	 */
	FString RequestIndexAll(int32 Unindexed, int32 OutOfDate)
	{
		FFindInBlueprintSearchManager& Manager = FFindInBlueprintSearchManager::Get();

#if UAL_FIB_HAS_INDEX_ALL_PERMISSION
		// 项目把「Index All」关了（大工程常这么做：一次全加载内存吃不消），编辑器里那个按钮也是灰的
		if (GetDefault<UBlueprintEditorSettings>()->AllowIndexAllBlueprints == EFiBIndexAllPermission::None)
		{
			return TEXT("disabled_by_settings");
		}
#endif
		if (Manager.IsCacheInProgress())
		{
			return TEXT("already_running");
		}
		if (Unindexed + OutOfDate <= 0)
		{
			return TEXT("nothing_to_index");
		}

		FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateLambda([](float) -> bool
			{
				if (IsEngineExitRequested())
				{
					return false;
				}
				FFindInBlueprintSearchManager& Mgr = FFindInBlueprintSearchManager::Get();
				if (!Mgr.IsCacheInProgress())
				{
					FFindInBlueprintCachingOptions Options;
					Options.OpType = EFiBCacheOpType::CacheUnindexedAssets;
					// 不挂结果窗口（传空）：引擎照样弹确认框、右下角通知里显示进度
					Mgr.CacheAllAssets(TWeakPtr<SFindInBlueprints>(), Options);
				}
				return false;
			}),
			0.5f);

		return TEXT("confirm_dialog_shown");
	}

	void Finish(const TSharedPtr<FJob>& Job, bool bTimedOut)
	{
		FStreamSearch& Search = *Job->Search;

		if (!Search.IsComplete())
		{
			// 超时或编辑器要退出：叫停，等线程退出（它在两个蓝图之间、或等索引的 0.1 秒睡眠后检查停止标志），
			// 再把停下前搜到的那部分取出来。
			// 等的时候必须边等边处理游戏线程任务：搜索线程可能正卡在 FSearchableValueInfo::GetDisplayText
			// 里（AsyncTask(GameThread) 去加载 String Table，再 Promise.Get() 干等），游戏线程干等就互锁死。
			// 5.5 起引擎自己的 EnsureCompletion 也是这么等的；5.0–5.4 的直接 WaitForCompletion，不能指望它
			Search.Stop();
			while (!Search.IsComplete())
			{
				FTaskGraphInterface::Get().ProcessThreadUntilIdle(ENamedThreads::GameThread);
				FPlatformProcess::Sleep(0.01f);
			}
			if (Search.Thread.IsValid())
			{
				Search.Thread->WaitForCompletion();
			}
		}
		Search.GetFilteredItems(Job->Roots);
		const int32 OutOfDate = Search.GetOutOfDateCount();
		// 引擎的结果窗口在 Reset 前也是这么收尾的（SFindInBlueprints::UpdateSearchResults）
		Search.EnsureCompletion();
		Job->Search.Reset();

		FFindInBlueprintSearchManager& Manager = FFindInBlueprintSearchManager::Get();
		const int32 Unindexed = Manager.GetNumberUnindexedAssets();
		const int32 FailedToCache = Manager.GetFailedToCacheCount();
		const bool bIndexing = Manager.IsCacheInProgress();
		const bool bDiscovery = Manager.IsAssetDiscoveryInProgress();

		// 按路径排，同一个查询两次回包顺序一致
		Job->Roots.RemoveAll([](const TSharedPtr<FFindInBlueprintsResult>& Root) { return !Root.IsValid(); });
		Job->Roots.Sort([](const TSharedPtr<FFindInBlueprintsResult>& A, const TSharedPtr<FFindInBlueprintsResult>& B)
		{
			return A->DisplayText.ToString() < B->DisplayText.ToString();
		});

		TArray<TSharedPtr<FJsonValue>> Blueprints;
		int32 TotalMatches = 0;
		for (int32 Index = 0; Index < Job->Roots.Num(); ++Index)
		{
			const TSharedPtr<FFindInBlueprintsResult>& Root = Job->Roots[Index];

			TArray<FMatch> Matches;
			TArray<FString> Trail;
			for (const TSharedPtr<FFindInBlueprintsResult>& Child : Root->Children)
			{
				CollectLeaves(Child, Trail, Matches);
			}
			TotalMatches += Matches.Num();

			if (Index >= Job->Limit)
			{
				continue; // 只计数，不列
			}

			const FString ObjectPath = Root->DisplayText.ToString();
			TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("path"), FPackageName::ObjectPathToPackageName(ObjectPath));
			Entry->SetStringField(TEXT("object_path"), ObjectPath);
			Entry->SetNumberField(TEXT("match_count"), Matches.Num());

			TArray<TSharedPtr<FJsonValue>> MatchValues;
			for (int32 M = 0; M < Matches.Num() && M < MaxMatchesPerBlueprint; ++M)
			{
				TSharedPtr<FJsonObject> MatchObj = MakeShared<FJsonObject>();
				MatchObj->SetStringField(TEXT("text"), Matches[M].Text);
				if (!Matches[M].Category.IsEmpty())
				{
					MatchObj->SetStringField(TEXT("category"), Matches[M].Category);
				}
				if (!Matches[M].Context.IsEmpty())
				{
					MatchObj->SetStringField(TEXT("context"), Matches[M].Context);
				}
				MatchValues.Add(MakeShared<FJsonValueObject>(MatchObj));
			}
			Entry->SetArrayField(TEXT("matches"), MatchValues);
			if (Matches.Num() > MaxMatchesPerBlueprint)
			{
				Entry->SetBoolField(TEXT("matches_truncated"), true);
			}
			Blueprints.Add(MakeShared<FJsonValueObject>(Entry));
		}

		TSharedPtr<FJsonObject> Coverage = MakeShared<FJsonObject>();
		// 没有 FiB 数据的蓝图（从没在带 FiB 的版本里存过，或注册表里的数据读不了）——**根本没被搜**
		Coverage->SetNumberField(TEXT("unindexed"), Unindexed);
		// 索引格式比当前引擎旧的：搜了，但新版才记的字段可能漏
		Coverage->SetNumberField(TEXT("out_of_date"), OutOfDate);
		Coverage->SetNumberField(TEXT("failed_to_index"), FailedToCache);
		Coverage->SetBoolField(TEXT("indexing_in_progress"), bIndexing);
		Coverage->SetBoolField(TEXT("asset_discovery_in_progress"), bDiscovery);
		// 判据照编辑器结果窗口那条「Search incomplete」：未索引 + 过期 + 索引失败
		const bool bComplete = !bTimedOut && !bDiscovery && Unindexed == 0 && OutOfDate == 0 && FailedToCache == 0;
		Coverage->SetBoolField(TEXT("complete"), bComplete);

		TSharedPtr<FJsonObject> Data = MakeShared<FJsonObject>();
		Data->SetBoolField(TEXT("ok"), true);
		Data->SetStringField(TEXT("query"), Job->Query);
		Data->SetNumberField(TEXT("blueprint_count"), Job->Roots.Num());
		Data->SetNumberField(TEXT("match_count"), TotalMatches);
		Data->SetArrayField(TEXT("blueprints"), Blueprints);
		if (Job->Roots.Num() > Job->Limit)
		{
			Data->SetBoolField(TEXT("truncated"), true);
		}
		Data->SetBoolField(TEXT("timed_out"), bTimedOut);
		Data->SetNumberField(TEXT("elapsed_ms"), static_cast<double>(static_cast<int64>((FPlatformTime::Seconds() - Job->StartedAt) * 1000.0)));
		Data->SetObjectField(TEXT("coverage"), Coverage);

		FString IndexAllStatus;
		if (Job->bIndexUnindexed && !IsEngineExitRequested())
		{
			IndexAllStatus = RequestIndexAll(Unindexed, OutOfDate);
			TSharedPtr<FJsonObject> IndexAll = MakeShared<FJsonObject>();
			IndexAll->SetStringField(TEXT("status"), IndexAllStatus);
			Data->SetObjectField(TEXT("index_all"), IndexAll);
		}

		UE_LOG(LogUALBlueprintSearch, Log,
			TEXT("find_in_blueprints \"%s\": %d blueprints, %d matches, unindexed=%d out_of_date=%d timed_out=%d index_all=%s"),
			*Job->Query, Job->Roots.Num(), TotalMatches, Unindexed, OutOfDate, bTimedOut ? 1 : 0,
			IndexAllStatus.IsEmpty() ? TEXT("-") : *IndexAllStatus);

		UAL_CommandUtils::SendResponse(Job->RequestId, 200, Data);
	}
}

void FUAL_BlueprintSearchCommands::RegisterCommands(TMap<FString, TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>>& CommandMap)
{
	CommandMap.Add(TEXT("blueprint.find_in_blueprints"), [](const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
	{
		Handle_FindInBlueprints(Payload, RequestId);
	});
}

void FUAL_BlueprintSearchCommands::Handle_FindInBlueprints(const TSharedPtr<FJsonObject>& Payload, const FString RequestId)
{
	// 命令入口保证 Payload 非空（UAL_CommandHandler 没参数时给一个空对象）
	FString Query;
	Payload->TryGetStringField(TEXT("query"), Query);
	Query.TrimStartAndEndInline();
	if (Query.IsEmpty())
	{
		UAL_CommandUtils::SendError(RequestId, 400, TEXT("query is required (a member/node name, or a Find-in-Blueprints query string)"));
		return;
	}

	TSharedPtr<UALFiB::FJob> Job = MakeShared<UALFiB::FJob>();
	Job->RequestId = RequestId;
	Job->Query = Query;

	int32 Limit = UALFiB::DefaultLimit;
	if (Payload->TryGetNumberField(TEXT("limit"), Limit))
	{
		Job->Limit = FMath::Clamp(Limit, 1, UALFiB::MaxLimit);
	}
	bool bIndexUnindexed = false;
	if (Payload->TryGetBoolField(TEXT("index_unindexed"), bIndexUnindexed))
	{
		Job->bIndexUnindexed = bIndexUnindexed;
	}

	Job->StartedAt = FPlatformTime::Seconds();
	// 先在游戏线程把管理器建出来：Get() 首次调用会 Initialize（挂资产注册表回调等），
	// 不能让搜索线程的 BeginSearchQuery 去做第一次
	FFindInBlueprintSearchManager::Get();
	// 构造即开线程（FStreamSearch_N，低于普通优先级）。选项用默认值：
	// 不按类别过滤、低于当前 FiB 版本的算过期 —— 和编辑器的全局查找窗口一致
	Job->Search = MakeShared<FStreamSearch>(Query);

	FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateLambda([Job](float) -> bool
		{
			if (!Job->Search.IsValid())
			{
				return false;
			}

			// 先看完没完，再取结果：线程是先交结果、后置完成标志的，反过来会漏掉最后几条
			const bool bDone = Job->Search->IsComplete();
			Job->Search->GetFilteredItems(Job->Roots);

			const bool bTimedOut = !bDone && (FPlatformTime::Seconds() - Job->StartedAt) > UALFiB::TimeoutSeconds;
			const bool bExiting = !bDone && IsEngineExitRequested();
			if (!bDone && !bTimedOut && !bExiting)
			{
				return true;
			}

			UALFiB::Finish(Job, bTimedOut || bExiting);
			return false;
		}),
		0.0f);
}
