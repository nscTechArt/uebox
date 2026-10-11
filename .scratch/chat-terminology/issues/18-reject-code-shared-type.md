# 18: 拒绝码收进 shared 类型

Status: done
Blocked by: None
组：第 5 组（用户可见的错误改走错误码）

依据：`../spec.md`「用户可见的错误改走错误码（第 5 组）」中「拒绝码收进 shared 类型」一段；Testing Decisions 同名一条。
来源：实现期两轴评审（Standards 第一条）。

**What to build:** 续跑与插话被拒时主进程回的码，和渲染层按码查文案的两张表，共用一份类型。
任何一边把码改名或写错，类型检查报错，而不是渲染层悄悄退回显示带「会话」的主进程原文。只改类型，行为不变。

- [x] 新建 `src/shared/agentRunRejection.ts`，按通道分两个类型：`AgentStartRejectionCode`（`SESSION_BUSY`，execute / continue）、
  `SteerRejectionCode`（`NOT_RUNNING`、`PROJECT_MISMATCH`，steer）
- [x] 主进程 `ipc/agentV3.ts` 五处回码用 `satisfies` 约束
- [x] `agentControlHandlers.ts` 的 `STARTUP_ERROR_COPY`、`STEER_REJECTION_COPY` 用 `satisfies Record<码类型, …>` 约束；
  声明类型保持 `Record<string, …>`，查表函数的签名与函数体不变
- [x] 不收窄 preload `index.d.ts` 与 `api/ai.ts` 的 `code?: string`（理由见 spec 同名一段）
- [x] 类型检查通过；三种反向情况都报错（主进程写错码 / 文案表删一项 / 文案表加一项，已做一次性反向验证并撤回）；相关测试通过
- [x] 提交信息标明「第 5 组」，只含第 5 组的改动
