# ZCode Coding Plan

中文：[zcode.zh-CN.md](zcode.zh-CN.md)

In Settings → Models → Add provider → Subscriptions, select **ZCode Coding Plan**
and sign in. The browser opens ZCode's Z.ai authorization flow. Authorize the account
in ZCode and activate its subscription first. A subscription JWT can also be entered
in the encrypted key field. No separate Python gateway is needed.

The provider sends Anthropic Messages directly to
`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`. GLM-5.2 is preset;
other models can be added using the case-sensitive IDs available to the account.
This is separate from the existing GLM Coding Plan API-key providers. It never
exchanges an API key or falls back to an API balance when the subscription fails.

Tokens use the existing Electron safeStorage vault. Sign in again after expiry;
the reference protocol has no verified refresh endpoint. The UI does not promise
automatic renewal. Cancelling sign-in stops polling; cancelling a model request
stops waiting for verification and prevents that request from being sent.

Verification settings are fetched only when using ZCode. The current server's
`skip_model_request` flag is honored. If verification is required, the official
Aliyun SDK runs in an isolated, nonpersistent Electron browser with no Node access,
preload bridge or account token. A minimal local page replaces the site's frontend.
Verification is cached for 45 seconds and refreshed once after a captcha rejection.
Failures surface to the caller; there is no alternate billing route.

Protocol reference: [maskeb34/zcode](https://github.com/maskeb34/zcode/tree/1-2),
especially `app/oauth.py`, `app/routes/admin_api.py`, `app/agent.py` and
`app/captcha.py`. The implementation is native TypeScript; no upstream Python or
jsdom solver code is bundled. Verified on 2026-10-13: login initialization returns
an authorization URL at `chat.z.ai`; `/api/v1/client/configs` works without query
parameters, while the reference's version/platform parameters return HTTP 400.

Automated coverage includes sign-in, cancellation, expiry, endpoint confinement,
verification policy/cleanup, streamed tool calls through the real pi adapter and
bilingual UI guidance. Paid-account authorization, upstream generation and actual
subscription debit still require manual acceptance: sign in, send a short message,
run a read-only Unreal tool, and check the account's subscription usage in ZCode.
