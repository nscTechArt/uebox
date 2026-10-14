#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * 静态 / 骨骼网格命令。
 *
 * 设计与裁决。一句话版本：**这块走 C++ 不走 Python**，
 * 理由是跨九个引擎版本的正确性需要编译器来保证，而不是靠运行时 getattr 探测
 * ——— Python 那条路上 API 变了只会在用户机器上炸，C++ 在我们发版前就炸。
 *
 * ## 已实现
 *
 *   - `mesh.describe` —— 一次读完一个网格资产的全部信息
 *   - `mesh.optimize` —— 静态网格：生成 LOD、生成简单碰撞（盒/球/胶囊/凸包分解），
 *                       前后都从引擎读回事实
 *
 * ## 为什么只有一个命令，而 Epic 有 38 个
 *
 * Epic 的 38 个里 24 个是纯 getter（`get_lod_count`、`get_triangle_count`、
 * `get_bounds`……）。按那个粒度，模型问一句「这模型能不能优化」要连着调七八次。
 * 我们把读取合成一个 `mesh.describe`，一次答完。
 *
 * 后续（见设计文档 §7）：`mesh.audit`（批量体检，走 AssetRegistry 标签，
 * 不加载资产）、`mesh.sockets`。
 *
 * ## 版本兼容策略
 *
 * 本文件里用到的访问器**全部在引擎源码里逐个确认过**（比对 UE 5.6 头文件），
 * 且都带 `UE_DEPRECATED(4.27, "…use GetXxx()…")` 标记 —— 说明这套 Get/Set
 * 访问器 4.27 就已存在，覆盖我们支持的 5.0–5.8 全区间。
 *
 * `mesh.optimize` 的碰撞部分走 `UStaticMeshEditorSubsystem`（StaticMeshEditor 模块）。
 * 这里原先写着「那些 API 5.6 之前不存在，别往 Build.cs 加 StaticMeshEditor」——
 * 逐版本 grep 过，**那条结论是错的**：`Engine/Source/Editor/StaticMeshEditor/Public/
 * StaticMeshEditorSubsystem.h` 在 5.0–5.8 九个版本里都在，用到的
 * `AddSimpleCollisionsWithNotification` / `RemoveCollisionsWithNotification` /
 * `SetConvexDecompositionCollisionsWithNotification` 签名九版一字不差（5.0–5.6 导出宏挂在类上，
 * 5.7 起挂在每个函数上，调用方不受影响）。它是引擎本体的编辑器模块，不是插件，
 * 加依赖不会引入对插件 DLL 的硬导入。
 *
 * LOD 部分不走子系统的 `SetLodsWithNotification`：它先 `SetNumSourceModels(1)`，
 * 导入的 LOD 一律丢掉，做不了 keep_imported。直接改 SourceModel 的 ReductionSettings
 * 再 PostEditChange —— 和 SetLods 内部是同一条构建路。
 */
class FUAL_MeshCommands
{
public:
	/** 注册所有网格相关命令到 CommandMap */
	static void RegisterCommands(TMap<FString, TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>>& CommandMap);

	/** mesh.describe —— 读取一个静态/骨骼网格资产的完整信息 */
	static void Handle_Describe(const TSharedPtr<FJsonObject>& Payload, const FString RequestId);

	/** mesh.optimize —— 静态网格生成 LOD / 简单碰撞，回执给前后读回的事实 */
	static void Handle_Optimize(const TSharedPtr<FJsonObject>& Payload, const FString RequestId);
};
