# 第三方组件声明 / Third-Party Notices

虚幻盒子本体使用 Apache-2.0；第三方组件与 UnrealAgentLink 插件保留各自许可证。
本声明、`licenses/` 全文、依赖自带的 LICENSE / COPYING / NOTICE 文件均随安装包保留。
`scripts/check-packaged-deps.mjs` 会检查实际安装包的文件边界和许可证，缺失时阻止出包。

## Task video browser runtimes / 任务成片浏览器运行库

`src/renderer/public/task-video-runtime/` contains unmodified HyperFrames 0.8.36 browser runtime
(Apache-2.0, [source](https://github.com/heygen-com/hyperframes)) and GSAP 3.14.2
([GSAP standard license](https://gsap.com/standard-license/)). Versions and SHA-256
checksums are recorded in its README. The adjacent `HYPERFRAMES-LICENSE` and
`GSAP-LICENSE.html` are distributed with these files. The application uses local
browser rendering; neither a HyperFrames cloud account nor a runtime CDN is required.

以上运行库以原样文件随包提供，保留原始版权声明及各自许可证；本体的 Apache-2.0
不改变 GSAP 的授权条款。

## UnrealAgentLink — MIT

源码位于 [`plugin/UnrealAgentLink`](plugin/UnrealAgentLink)，完整授权见
[`LICENSE`](plugin/UnrealAgentLink/LICENSE)。每份插件 ZIP 也包含这份许可证。
插件通过 Unreal Engine 的接口工作；引擎本身不属于本仓库的开源授权范围。

## elkjs — EPL-2.0

用于蓝图自动布局，既有主进程调用，也会被打包进渲染层 JavaScript。
本项目使用未修改的 elkjs 0.11.0。完整许可证见 [`licenses/EPL-2.0.txt`](licenses/EPL-2.0.txt)，
同时保留依赖原有的 `node_modules/elkjs/LICENSE.md`。

对应源码及构建说明：[elkjs v0.11.0](https://github.com/kieler/elkjs/tree/0.11.0)。
elkjs 及其 EPL 覆盖的内容继续按 EPL-2.0 提供，本体的 Apache-2.0 不替代它。

## sharp / libvips — Apache-2.0 / LGPL-3.0-or-later

sharp 用于图片缩放与格式转换，自身使用 Apache-2.0；其预编译 libvips 使用
LGPL-3.0-or-later。完整条款见 [`LGPL-3.0.txt`](licenses/LGPL-3.0.txt) 及其引用的
[`GPL-3.0.txt`](licenses/GPL-3.0.txt)。

当前 Windows x64 构建使用 `@img/sharp-win32-x64` 0.35.4、libvips 8.18.6。
库文件放在 `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/`，
该目录的 `versions.json` 列出各组成库的实际版本，`LICENSE` 保留包自身的声明。
对应 Windows 发行版的[组成库清单与来源](licenses/libvips-Windows-NOTICES.md)也随包保留；
其中 cairo 使用 [MPL-2.0](licenses/MPL-2.0.txt)，LGPL 组件按上游声明采用第 3 版。
同时保留原始 Windows 库所附的 [LGPL-2.1](licenses/LGPL-2.1.txt) 全文。
库以独立动态库形式分发；用户可使用兼容的修改版替换它，并为调试这些修改而逆向工程。
本项目未修改这些库的源码。

源码与构建入口：

- [libvips 源码](https://github.com/libvips/libvips)（按 `versions.json` 选择对应版本）
- [sharp-libvips 构建脚本及组成库声明](https://github.com/lovell/sharp-libvips)
- [Windows libvips 构建与依赖来源](https://github.com/libvips/build-win64-mxe)
- [sharp 源码](https://github.com/lovell/sharp)

正式发布时，应在同一下载位置同时提供这些 LGPL 组件的对应源码与构建材料，
并保留上游版权声明；不能仅凭本文件就认定源码交付已完成。
如需取得本发行版对应的源码材料，请联系 [admin@uebox.ai](mailto:admin@uebox.ai)。

## Lore CLI (lore.exe) — MIT

服务端资产库的导入（提交、推送）和下载（稀疏取文件）由 Epic Games 的官方 Lore 命令行完成，
字节只走 Lore 自己的 QUIC/TLS 通道。随包提供未修改的官方 Windows 二进制 `lore 0.9.0+783`
（release [v0.9.0](https://github.com/EpicGames/lore/releases/tag/v0.9.0)，
commit `3c8f346435aab021dd5da3a048ada7c8fb647385`），安装后位于 `resources/lore/win32-x64/lore.exe`。
版本与 SHA-256 记录在 [`resources/lore/lore-cli.json`](resources/lore/lore-cli.json)，
二进制不进本仓库，由 `scripts/fetch-lore-cli.mjs` 核对哈希后放入。完整许可证见
[`licenses/Lore-MIT.txt`](licenses/Lore-MIT.txt)（Copyright (c) 2026 Epic Games, Inc.）。
本体的 Apache-2.0 不替代它。

## 其他双许可组件

| 组件 | 上游许可选项 | 本项目采用 |
| --- | --- | --- |
| jszip | MIT 或 GPL-3.0-or-later | MIT |
| dompurify | MPL-2.0 或 Apache-2.0 | Apache-2.0 |

其余依赖的授权以随包保留的各组件许可证为准。依赖版本以 `pnpm-lock.yaml`
及实际安装包内的 `package.json` 为准，不以手工统计的依赖数量作为证明。

## 不随包提供的工具

- **FFmpeg**：由用户自行安装，应用只检测并调用。具体许可取决于用户选择的构建。
- **Poppler / pdf-poppler**：已从当前依赖和分发中移除；PDF 解析由本地 anydoc 完成。
- **FBX2glTF**：当前工作树和安装包均不提供该程序。FBX 预览使用渲染层加载器。
  工具源码与特定预编译包可能有不同的授权条件，不把源码许可证当成二进制再分发许可。
  开源发布应使用不含该旧二进制的导出；保留旧 Git 历史时必须先清理历史中的副本。

升级依赖、修改第三方源码或改变动态链接方式时，请同步更新本声明与对应源码材料。
