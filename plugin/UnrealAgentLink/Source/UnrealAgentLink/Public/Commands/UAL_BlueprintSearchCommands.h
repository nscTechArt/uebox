#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * 全项目蓝图搜索 —— 编辑器「在所有蓝图中查找」（Find in Blueprints，FiB）的命令版。
 *
 * ## 为什么要它
 *
 * 改 C++ 的 UFUNCTION / UPROPERTY（改名、改签名、删掉）之前，行家先问一句
 * 「哪些蓝图在用它」。编辑器的答法就是 FiB：不加载蓝图，靠保存时写进资产注册表的
 * `FiBData` 标签全项目搜。以前技能只能说「没工具，改完全量编译蓝图看谁报错」。
 *
 * ## 薄封装，不另建索引
 *
 * 直接驱动引擎自己的 `FStreamSearch`（Kismet 模块，`Public/FindInBlueprintManager.h`），
 * 搜索语法、匹配规则、索引数据都是引擎那一份。`docs/UE项目索引设计-2026-10-14.md`
 * 的「蓝图内容档」以后要解 FiBData 建档时可以复用这里的搜索，不要再造一套平行索引。
 *
 * ## 不阻塞游戏线程
 *
 * `FStreamSearch` 自己开线程跑。这里只在 FTSTicker 上每帧取一次结果、
 * 搜完（或超时）再回包。注意第一次全局搜索会解开引擎推迟的整批索引，
 * 搜索线程要等那批建完 —— 所以要超时兜底。
 *
 * ## 支持的命令
 *
 *   - `blueprint.find_in_blueprints` —— { query, limit?, index_unindexed? }
 */
class FUAL_BlueprintSearchCommands
{
public:
	static void RegisterCommands(TMap<FString, TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>>& CommandMap);

	/** blueprint.find_in_blueprints —— 用引擎的 FiB 全项目搜蓝图，按蓝图分组回结果和覆盖情况 */
	static void Handle_FindInBlueprints(const TSharedPtr<FJsonObject>& Payload, const FString RequestId);
};
