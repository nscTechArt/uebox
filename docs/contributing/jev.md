# Jev 1.14 适配

> **English TL;DR** — Select `jev-1.14.0` in Settings → Models for reproducible
> results. The judge adapter accepts explicit image assets, Box questions and opt-in
> long context. Existing text callers keep their current behavior. Experimental
> features are unsupported by the Box Plan judge endpoint. Image input is supported
> by Jev 1.13 too; Box needs 1.14. Never treat a returned box as proof of presence.

## 模型选择

设置 → 模型 → TypeSafe → 管理模型，可从内置目录补入 `jev-1.14.0` 和
`jev-preview`，保存后按需绑定「判定」角色。已有配置不会自动切换版本。
`jev-latest` 和 `jev-preview` 都是会变化的别名；需要可复现结果时选择固定版本。

## 图片与定位

主进程入口仍是 `src/main/ai/judge.ts` 的 `judge(state, questions, options)`。
传入 `options.assets` 才会发送图片并开启图片实验请求头。图片引用可以放在
state、instructions、criteria 中，建议使用 UUID，防止意外匹配普通文本。

```ts
import { randomUUID } from 'node:crypto'
import { confidentBox, judge } from '../../src/main/ai/judge'

// pngBase64 由调用方提供：已获准发送、方向正确且尺寸符合要求的 PNG 原始 base64。
async function locateMug(pngBase64: string) {
  const ref = randomUUID()
  const result = await judge(
    { photo: ref },
    {
      visible: { type: 'noul', instructions: 'Is there a mug in `photo`?' },
      target: { type: 'box', instructions: 'The mug in `photo`.' }
    },
    { assets: { [ref]: { type: 'image', format: 'png', data_base64: pngBase64 } } }
  )
  // 阈值仅为示例，要按实际图片评估。找不到、置信度不足或坐标无效时返回 null。
  return confidentBox(result?.answers.target, 0.9, result?.answers.visible, 0.9)
}
```

Box 每题只返回一个框，坐标相对原图宽高归一化到 0~1。**目标不存在时也会返回框**，
所以读取时必须同时检查存在性。现有自动试玩与语音判定不会因此自动采集或上传截图。

TypeSafe 图片协议不接受 URL，因此这里使用其支持的 JSON/base64 方式，复用调用方
已经准备好的图片，不新增对象存储上传路径。PNG/JPEG 每边须为 280~1568 像素，
单图不超过 16MiB，JSON 请求体不超过 32MiB（含 base64 膨胀）。
适配层检查格式、编码和字节上限；文件解码、像素尺寸、引用展开和 token 限制由服务端校验。
一张图片多次引用会多次计入服务端展开后的请求大小和 token 数。

## 长上下文和失败处理

`options.longContext: true` 开启实验长上下文请求头，官方请求与单题上限均为
262k tokens。适配层仍用保守字符预算：默认 48,000，开启后 262,000；它不是 tokenizer，
真正的 token 上限由服务端执行。图片不计入文字字符预算，但占请求字节与服务端 token 预算。
较大的请求可由调用方按需增加 `timeoutMs`；默认仍为 4 秒。

`judge()` 失败返回 `null` 并调用 `onError`，调用方沿用既有回退策略；
`requestJudgement()` 会抛错，适用于连接探测。其第七个参数接受相同的
`assets` / `longContext` 选项，原有参数顺序保持兼容。
套餐 `/judge` 接口收到图片、Box 或长上下文选项时会在本地拒绝，不静默丢弃输入。

未开启厂商的请求数据共享选项。多语言改善属于模型本身，选择新版即可生效。

官方协议：[发布公告](https://typesafe.ai/blog/jev-1-14)、
[图片](https://docs.typesafe.ai/images)、[Box](https://docs.typesafe.ai/primitives/box)、
[模型与长上下文](https://docs.typesafe.ai/models)。
