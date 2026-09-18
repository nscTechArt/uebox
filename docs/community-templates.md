# 社区模板源

> 面向想搭一个模板源的人（公开社区库、公司内网库都适用）。
> 代码在 `src/main/services/project/`，界面在「新建工程」。

---

## 界面上只有两种模板

**社区的**和**我自己的**。没有「预设模板」这一类 —— 界面按「来源 / 用途 / 引擎版本」
三个维度筛，来源就这两个值。以前那个按来源分标签页的设计（预设 / 我的 / 社区 / EPIC /
导入项目）已经拆掉了：标签页是抽屉，模板一多，找东西就得挨个抽屉翻。

「导入已有工程」也从这个弹窗搬走了 —— 它是「打开我电脑上已有的工程」，
跟「用模板造一个新工程」是两件事，入口在首页工程列表旁边（`ImportProjectModal.vue`）。

---

## 为什么是「源」而不是「服务器」

这个仓库是社区核心版，[AGENTS.md](../AGENTS.md) 第 5 条硬规则写着：**不许给社区版代码路径加
远程调用、遥测或账号要求**。社区模板天然要联网，两者的调和办法是把它做成**模板源**：

- 核心不认识任何官方服务端，只认识一个**清单地址**；
- 内置源存在，但**默认 enabled = false** —— 用户不点「启用」，应用一个请求都不会发；
- 上传、点赞、审核这些需要账号的能力不在核心里。

改这块代码时请守住第二条：不要给内置源写死 `enabled: true`，也不要在启动流程里自动抓清单。
「装好之后完全离线」是这个版本对用户的承诺，不是一句宣传语。

---

## 安装包里不带模板

**模板全部走线上。** `resources/project/` 那个随包发模板的目录已经删掉了，
`electron-builder.yml` 里对应的 extraResources 条目也一并去掉。本地模板只有一个位置：
`userData/templates`，里面要么是用户自己打包的，要么是从源下载来的。

直接后果：**全新安装、一个源都没启用时，模板列表是空的。** 这不是 bug，是这个选择的代价。
界面上因此有一整屏引导（`onboardTitle` / `onboardDesc` 那几条文案）：说清楚模板在线上、
默认不联网、点一下启用官方源。不要为了让首屏有东西就把内置源改成默认启用 ——
那等于用离线承诺换一个首屏。

---

## 内置两个官方源：GitHub + 国内镜像

`raw.githubusercontent.com` 在国内经常连不上。只内置一个源，等于让一部分用户点了「启用」
之后只看到一条获取失败。所以内置源有两条，**装的是同一份内容**：

| id | 托管 |
|---|---|
| `official` | `raw.githubusercontent.com/ueboxai/community-templates` |
| `mirror-cn` | `gitee.com/ueboxai/community-templates` |

界面上的「启用官方社区库」按钮**一次把两个都打开**，哪个通就用哪个 —— 自带容灾。
两个都通也不会重复显示：清单条目按 **sha256 跨源去重**（见 `templateRows.ts`），
字节相同就是同一个模板，只留一行。

由此对镜像仓库有一条要求：**它必须是主仓库的镜像，包体字节一致**。
自己重新打一遍包会让 sha256 不同，用户就会看到每个模板两条。Gitee 上开自动同步即可。

一个源挂了另一个成功时，界面只压一行灰字提示（`communitySomeSourcesFailed`），
不摆红色警告 —— 用户此刻不需要处理什么。全都失败时才把每个源的错误原因摊开。

---

## 搭一个源需要什么

两样东西，都是静态文件，随便什么 HTTP 服务都能托管（GitHub raw、对象存储、内网 nginx）：

1. 一份 `manifest.json`
2. 若干个模板包 `.zip`

### manifest.json

```json
{
  "formatVersion": 1,
  "templates": [
    {
      "id": "third-person-starter",
      "name": "第三人称起步工程",
      "description": "带角色控制器和基础场景的第三人称模板",
      "category": "game",
      "engineVersion": "5.4",
      "packageUrl": "packages/third-person-starter.zip",
      "size": 348127424,
      "sha256": "3b1f…（64 位小写十六进制）",
      "version": "1.2.0",
      "author": "某人",
      "license": "CC-BY-4.0",
      "previewUrl": "previews/third-person.png",
      "homepage": "https://example.com/third-person"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 源内唯一。重复的只认第一条 |
| `name` | 是 | 界面上显示的名字 |
| `packageUrl` | 是 | 可以是相对于清单的相对路径 |
| `sha256` | 是 | 64 位小写十六进制。**缺失或不合法的条目会被整条丢弃** |
| `size` | 否 | 字节数，用于下载前提示和进度条 |
| `category` | 否 | `game` / `render` / `film` / `architecture` / `automotive` / `other`，不认识的归到 `other` |
| `engineVersion` | 否 | 默认 `5.3` |
| `description` `version` `author` `license` `previewUrl` `homepage` | 否 | 展示用 |

### 模板包

就是一个 zip，里面任意层级下有一个 `.uproject` 文件。建工程时会解压、找到那个
`.uproject`、把它所在目录复制到目标位置并按用户填的工程名改名。

**别用资源管理器的「压缩」**，用仓库里的打包脚本：

```bash
node scripts/pack-project-template.mjs <工程目录> <输出 zip 路径>
```

它比手工压缩多做四件事，每一件都踩过：

1. **条目名写成 UTF-8。** Windows 自带的压缩走本地代码页（GBK）且不设 UTF-8 标志位，
   中文路径到别人机器上就是乱码。
2. **剔掉 `Content/Developers/**`。** 这是 UE 给每个开发者建的私人目录，名字就是本机
   用户名 —— 打包者的真名会跟着模板分发出去。
3. **排掉 `Binaries` / `Intermediate` / `Saved` / `.git`** 等产物目录。
4. **输出可复现。** 固定条目时间戳并按路径排序，同样的输入永远得到同样的字节，
   否则每打一次包 sha256 都会变，没人能回答「这个 zip 到底改了什么」。

打包前记得把工程用引擎开一次再关掉，然后**删掉 `Saved/`**：UE 启动时会往
`Config/DefaultEngine.ini` 里写回一段带逐机生成 `SecurityToken` 的
`[/Script/AndroidFileServerEditor...]`，这段不该跟着模板走（下次谁打开都会重新生成）。

---

## 三条不宽容的规则

清单是**别人写的 JSON**，解析整体上很宽容 —— 字段缺、类型错、多写不认识的键都只丢掉那一条，
不会让整个源废掉。但下面三条会直接拒绝，因为它们都关系到「下载下来的东西会不会被 UE 执行」：

1. **没有合法 sha256 的条目直接丢弃。** 没有校验值就没法确认下到的字节是清单作者写的那份。
   下载完对不上会删掉临时文件并报错。
2. **https 的清单不许把包指向 http。** 否则 https 白走了，中间人可以换包。
   http 清单配 http 包是允许的（内网自建源的常见形态）。
3. **模板包里的越界路径条目会让整包被拒。** 条目名里出现 `..`、绝对路径或盘符时，
   解压会抛 `UnsafeZipEntryError`，不是跳过那一条 —— 一个包里出现越界条目，
   这个包本身就该被当成恶意的。见 `safeExtract.ts`。

---

## 一个源的内容是不受审核的

模板包解压出来是一个完整的 UE 工程，里面可以有 C++ 源码、插件 DLL、Python 脚本，
用户打开工程时这些东西就会跑。sha256 保证的是「下到的字节没被篡改」，**不是**
「这个包是安全的」。界面上因此常驻一条提示，请不要因为觉得碍眼就把它删掉。

---

## 相关文件

| 文件 | 职责 |
|---|---|
| `src/shared/projectTemplate.ts` | 共享类型 |
| `src/main/services/project/templateSource.ts` | 源配置读写（`userData/template-sources.json`） |
| `src/main/services/project/templateManifest.ts` | 清单解析与校验 |
| `src/main/services/project/templateDownload.ts` | 抓清单、下包、sha256 校验、取消 |
| `src/main/services/project/safeExtract.ts` | Zip Slip 防护 |
| `src/main/ipc/projectTemplate.ts` | IPC 入口 |
| `src/renderer/src/api/projectTemplate.ts` | 渲染层 API |
| `src/renderer/.../templateRows.ts` | 本地模板 + 各源清单合成一份列表（含跨源去重） |
| `src/renderer/.../CreateProjectFromTemplateModal.vue` | 新建工程（搜索 + 筛选 + 列表） |
| `src/renderer/.../ImportProjectModal.vue` | 导入本机已有工程（跟模板无关） |
