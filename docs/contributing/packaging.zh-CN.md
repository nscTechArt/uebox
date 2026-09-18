# 打包、发布与原生模块

English: [packaging.md](packaging.md)

日常开发不需要这一篇 —— `pnpm install`、`pnpm dev`、`pnpm verify` 就够了，见
[README](../../README.md)。要出安装包、要发版、或者被 `better-sqlite3` 的
ABI 卡住时再读这里。

---

## 开发环境的 Node 版本

开发环境使用 [Node.js 24.21.0](https://nodejs.org/) 和 pnpm 10.28.2（`npm i -g pnpm@10.28.2`）。
项目已配置 pnpm 自动下载并使用指定的 Node 版本；本机已有能运行 pnpm 的 Node 即可开始。
用 `pnpm exec node --version` 检查项目 Node 版本，`pnpm dev`、测试和打包都会使用它。

首次 `pnpm install` 会编译原生模块，需要几分钟。

---

## 打包

仅检查桌面打包与启动，可运行 `pnpm verify --with-build`。
正式安装包还要求 UE **5.0–5.8 共九份**插件全部存在且与源码一致；
只有 5.5 一份不能发版。完整构建需安装对应引擎与 C++ 构建工具，然后执行：

```bash
node scripts/build-all-plugins.mjs
```

日常开发只编 5.5 可用 `node scripts/build-all-plugins.mjs --only 5.5`。
全套插件准备好后再打正式安装包：

```bash
pnpm build:win      # Windows
pnpm build:mac      # macOS
pnpm build:linux    # Linux
```

Mac 构建在 macOS 上运行，生成带架构名的 DMG 和 ZIP。配置 `updateGithubRepo`
后会同时生成 GitHub 更新元数据；未配置时不写入更新源。构建命令不会上传产物。

---

## 发布

上传是单独一步——「检查更新」读的就是 `updateGithubRepo` 指向的那个仓库的
GitHub Releases：

```bash
pnpm release:app              # 演练：只打印要发什么，不动网络
pnpm release:app --publish    # 真发
```

它只上传更新要用到的三个文件（安装包、`.blockmap`、`latest.yml`），发之前会校验
三者出自同一次构建、版本号与 `package.json` 一致、源码已推送。未配置
`updateGithubRepo` 时直接拒绝运行——那样的包本来就不检查更新。

### Mac 签名与公证

Mac 自动更新发布前还需验证签名、公证和真实升级流程，生成安装包不代表已通过这些验收。

准备公证发布包时，先配置 Developer ID Application 签名证书，并按
[electron-builder 公证说明](https://www.electron.build/docs/notarization/)配置 Apple 凭据
（推荐使用 `APPLE_KEYCHAIN_PROFILE` 引用钥匙串中的凭据）。然后运行
`UEBOX_MAC_NOTARIZE=1 pnpm build:mac`；此模式要求签名成功，并向 Apple 提交公证。
缺少凭据或签名证书会失败。普通构建不提交公证，发布到 GitHub 仍需单独操作。

---

## 关于 better-sqlite3 的原生模块

`better-sqlite3` 是原生模块，Node 与 Electron 要的 ABI 不同；脚本会从当前运行时读取实际 ABI。
两份产物各缓存一份，互不覆盖：

- `node_modules` 里那份始终是 **Electron** 版，给 `pnpm dev` 用
- 测试经 vitest 别名读缓存里的 **Node** 版（见 `vitest.config.ts`）

所以**开着应用也能跑测试**，不需要来回切换、也不需要重新编译。

```bash
node scripts/better-sqlite3-abi.mjs status
```

看缓存状态。缺 Node 那份时跑 `ensure node` 补上 —— 它优先下载官方预编译包，
不碰 `node_modules`，因此应用开着也能补。
