# ZCode Coding Plan

English: [zcode.md](zcode.md)

在设置 → 模型 → 添加服务商 → 订阅中选择 **ZCode Coding Plan**，点击账号登录。
浏览器会打开 ZCode 的 Z.ai 授权流程；请先在 ZCode 授权账号并开通套餐。
也可在密钥框填写订阅 JWT，由盒子的密钥库加密保存。无需另行运行 Python 网关。

服务商通过 Anthropic Messages 直连
`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`。
预置 GLM-5.2，其他模型可按账号实际可用的型号手动添加，注意大小写。
此入口与现有 GLM Coding Plan API Key 服务商独立；订阅失败时不会兑换普通 API Key，
也不会回退到 API 余额计费。

令牌沿用 Electron safeStorage 加密存储。参考协议没有已验证的续期接口，失效后需要
重新登录，界面不会承诺自动续期。取消登录会停止轮询；取消模型请求会停止等待验证，
阻止该次请求发送。

仅在使用 ZCode 时读取验证配置，并遵循服务端的 `skip_model_request`。
需要验证时，在隔离且不持久化的 Electron 浏览器中运行阿里云官方 SDK，
不开放 Node、预加载桥接，也不向页面传入账号令牌；使用最小本地页面承载 SDK，
不加载网站前端。验证结果缓存 45 秒，验证被拒后最多刷新重试一次。
失败会反馈给调用方，不切换计费通道。

协议参考：[maskeb34/zcode](https://github.com/maskeb34/zcode/tree/1-2)，主要核对
`app/oauth.py`、`app/routes/admin_api.py`、`app/agent.py` 和 `app/captcha.py`。
本实现使用原生 TypeScript，未打包上游 Python 或 jsdom 求解器代码。
2026-10-13 实测：登录初始化可返回 `chat.z.ai` 授权地址；
`/api/v1/client/configs` 无查询参数时正常，参考项目的版本/平台参数会返回 HTTP 400。

自动化测试覆盖登录、取消、过期、凭据目标约束、验证策略与清理、真实 pi 适配器中的
流式工具调用和中英文界面提示。付费账号授权、上游真实生成和套餐扣量仍需手动验收：
登录后发送一条简短消息，执行一次只读 Unreal 工具，并在 ZCode 核对订阅用量。
