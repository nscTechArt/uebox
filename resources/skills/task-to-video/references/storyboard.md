# 分镜调用

精细制作默认使用 `kind: composition`。下面的 image/text 示例保留给简单插入镜头，不作为整条视频的默认模板。

`prepare_task_video` 返回 `projectDir`。本页例子的素材路径仅展示形状，执行时使用真实工具返回路径。

```json
{
  "projectDir": "C:/Users/Me/Videos/UnrealBox/TaskVideos/task-video-example",
  "storyboard": {
    "title": "火焰材质制作教程",
    "mode": "tutorial",
    "ratio": "16:9",
    "voice": "auto",
    "musicVolume": 0.12,
    "scenes": [
      {
        "id": "result",
        "kind": "image",
        "source": "C:/Users/Me/Videos/UnrealBox/TaskVideos/task-video-example/assets/result.png",
        "sourceNote": "当前任务最终材质预览截图",
        "title": "先看最终效果",
        "caption": "噪声纹理叠加渐变，形成火焰轮廓。",
        "narration": "这次我们用噪声纹理与渐变，做出了这个火焰材质。",
        "duration": 6,
        "zoom": 1.03
      }
    ]
  }
}
```

## 字段

- `mode`：`tutorial` / `promo` / `creative`，用于保存创作意图。
- `ratio`：`16:9`（2560×1440）、`9:16`（1440×2560）、`1:1`（1440×1440）。
- `voice`：`auto` 或 `off`。前者只用用户已绑定的 TTS。
- `musicPath`：可选，本地音乐绝对路径。无音乐时省略，不传空字符串。
- `musicVolume`：0～1，通常 0.08～0.18；旁白不清晰时再降低。
- `scenes`：1～40 个镜头，总计不超过 600 秒。`id` 唯一，英文、数字、下划线或连字符，最多 40 字符。
- `source`：composition 为本地 HTML；image 为图片（PNG/JPG/WebP/BMP）；video 为视频（MP4/MOV/WebM/MKV）。远程素材先保存。`kind` 必须匹配。
- 无合适图片时可用 `kind: text`，省略 `source`，在 `body` 写最多 300 字的中心正文；适合步骤说明和图解卡片，不产生生图费用。
- `sourceNote`：来源依据；补充素材明确标注。
- `title`：最多 60 字；`caption` 最多 180 字，但建议远短于上限，字幕与实际旁白内容一致。
- `narration`：单镜头最多 600 字；实际应用写短句，长段落拆分。
- `duration`：2～600 秒，单镜头通常不超过 45 秒；配音或阅读时间过长时会延长，以工具返回的实际时长为准。保存后的分镜可按实际时长继续修改，整条视频仍不超过 600 秒。
- `start`：视频截取起点秒数，默认 0；短于镜头时长则定格尾帧，不伪造运动。
- `zoom`：图片缓慢放大倍数 1～1.15；教学界面通常保持 1，避免裁掉参数。
- `focus`：图片放大时的关注点，`{ "x": 0.5, "y": 0.5 }` 为中心，范围 0～1。

标题和字幕有独立上下安全区域；视频原始音轨不混入。工具输出当前版本的 `storyboardPath`，后续修改从它读取。
