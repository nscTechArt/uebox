# 自动试玩的视觉验收 / Visual autoplay acceptance

在「设置 → AI 服务」配置直连 TypeSafe Jev（推荐 `jev-1.14.0`），设为「判定」角色，允许编辑器截图。连接 UE 工程后，对 Agent 说：

> 你自己玩给我看：捡起钥匙，再开门通关。验收 HUD 的钥匙图标和最后的通关面板。

Agent 调用现有 `ue_autoplay`，增加 `visual_checks`。普通试玩不受影响，不需要配置视觉判定。

```json
{
  "objective": "捡起钥匙，再打开门通关",
  "goal": { "until_log": "Victory" },
  "duration_seconds": 30,
  "visual_frames": 18,
  "visual_checks": [
    { "id": "key", "description": "HUD 出现钥匙图标" },
    { "id": "win", "description": "游戏画面出现通关面板" }
  ]
}
```

`until_log` 仅在游戏确实打印对应日志时使用。`visual_checks` 是按时间排序的 1–6 个可见里程碑，每项必须有更晚的独立截图；不要写隐藏逻辑、音效或无法从单帧判断的动作。默认采样 18 帧，可设 2–36 帧。控制器仍按场景结构操作，视觉验收在试玩结束后执行，不是视觉导航。

返回 `acceptance.status`（`passed` / `not_passed` / `inconclusive`）、各步骤的时间和证据路径、`replay_path`、`image_paths` 和 `report_path`。Agent 用 Markdown 图片展示回放。文件保存在应用数据目录 `autoplay-reports/<唯一编号>/`；逐帧报告会记录缺图、服务错误、判定置信度和未观察到的步骤。

回放是带时间戳的抽帧 WebP 动画，按固定节奏展示，不是实时录像。使用现有窗口采样，包含 HUD；提前结束前补抓窗口，场景截图不能代替 HUD 证据。旧插件未返回窗口采样时提示更新。关窗、最小化、画面遮挡、采样间隙和模型不确定都可能造成证据不足。未通过不等于游戏有缺陷；先看证据再重试。

引擎报错、缺少必需日志、取消操作都会阻止总体通过。视觉通过只表示这些状态曾被观察到，不证明完整玩法、键位映射或屏幕点击命中。截图只在显式启用此功能时发给配置的判定服务，不上传对象存储；本地普通试玩保持原状。

English: Configure a direct TypeSafe Jev judge and allow editor screenshots, then ask the agent to play and show the result. `visual_checks` adds ordered visible milestones to the existing autoplay tool. Each milestone needs its own later frame. Window samples include HUD; a final window capture covers early completion. The controller still uses structured game state; visual acceptance is post-run, not visual navigation. Results include acceptance status, timestamped evidence, local JSON, contact sheets and an animated WebP sampled replay. This is not continuous video or proof of input mapping, mouse hit testing, hidden logic or audio. Engine errors, missing required logs and cancellation block acceptance. Missing observations are not proof of a game defect. Screenshots go only to the configured judge when explicitly requested; ordinary autoplay remains unchanged.

## 验证 / Validation

单元与工具衔接测试：`visualAcceptance.test.ts`、`autoplay.test.ts`。真实 Jev 可选验证：设置 `TYPESAFE_API_KEY` 后运行 `pnpm exec node tests/manual/autoplay-visual-live.mjs`。该脚本用合成游戏画面验证真实请求、正反例及回放保存，不启动 UE，不能替代实际关卡验收。

Focused tests cover the pipeline and tool integration. The opt-in live script uses synthetic frames and the real Jev API; it does not validate Unreal navigation or gameplay. For actual acceptance, run the example against a connected project with matching visible milestones and inspect the saved replay and report.
