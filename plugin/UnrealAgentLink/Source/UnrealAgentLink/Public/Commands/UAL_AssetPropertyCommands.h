#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * 资产级属性写入：细节面板里能改的那些设置，按路径一次改一批。
 *
 * 专家在细节面板里点几下的事 —— 静态网格开关 Nanite、碰撞复杂度、LOD 组，
 * 贴图的 sRGB、压缩设置、最大尺寸、翻转绿通道 —— 以前只能让模型现写 Python。
 * Python 容易写错（属性名、枚举写法逐版本不同），而且审批和撤销都看不见它。
 *
 * 走的是细节面板同一条通知路：事务 → Modify → PreEditChange（属性链）→ 写 →
 * PostEditChangeChainProperty（带成员属性）。引擎自己据此重建该重建的东西：
 * 静态网格重新 Build（含 Nanite 数据），贴图重新压缩、刷新资源。
 *
 * 只改细节面板里看得见、能编辑的属性（CPF_Edit 且非 EditConst），路径只能穿进
 * 这个资产自己的子对象（如 StaticMesh 的 BodySetup），不会顺着引用改到别的资产上。
 *
 * content.set_asset_properties
 *   请求: { asset_path, properties: { "<属性路径>": 值, ... }, save?: bool = true }
 *   响应: { ok, asset_path, asset_class, results:[{property, requested, before?, actual?, ok, unchanged?, reason?, error?}],
 *           succeeded_count, failed_count, changed_count, saved, save_error?, dirty, reopened_editor, notes:[] }
 *         reason ∈ not_found | invalid_path | not_editable | read_only | type_mismatch | value_mismatch
 *         全部失败时 ok=false，error 里逐条写原因
 */
class FUAL_AssetPropertyCommands
{
public:
	using FHandlerFunc = TFunction<void(const TSharedPtr<FJsonObject>&, const FString)>;

	static void RegisterCommands(TMap<FString, FHandlerFunc>& CommandMap);

	static void Handle_SetAssetProperties(const TSharedPtr<FJsonObject>& Payload, const FString RequestId);
};
