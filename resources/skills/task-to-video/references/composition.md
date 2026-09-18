# 可自由设计的镜头

默认使用 `kind: composition`。底层是随盒子提供的 HyperFrames 0.8.36 浏览器运行库和 GSAP 3.14.2。
无需安装 CLI，不调用 CDN，不增加账号。普通 HTML、CSS、SVG、GSAP 的表现空间开放；不限制为某几种模板。

## 工作顺序

1. 拟定旁白和镜头，调用 `prepare_task_video_audio`。尚未写 HTML 的草案可先用文字镜头；该工具只锁定旁白和实际时长。
2. 按返回 `storyboard.scenes[].duration` 编排 HTML；转为 `kind: composition`，设置真实 `source`，保留对应旁白、id、时长。
3. 调用 `preview_task_video`，检查每镜头返回的四个时间点。修改受影响的 HTML。

   一个 HTML 编排多段时，额外传 `sampleTimes` 秒数数组（最多 24 个），覆盖每段的揭示、停留和衔接，不能只看全片四张图。
4. 调用 `render_task_video`。音频从同一工程缓存复用；每次保留新版本。

## 输入

```json
{
  "id": "reveal",
  "kind": "composition",
  "source": "C:/actual-video-project/reveal.html",
  "sourceNote": "真实成果原图；旁白基于本次任务",
  "compositionAssets": [{"name":"result.png","source":"C:/actual-source/result.png"}],
  "title": "创作意图记录，HTML 自己决定是否显示",
  "caption": "",
  "narration": "与音频准备时相同的旁白",
  "duration": 6
}
```

素材 `name` 使用英文、数字、连字符或下划线及允许的扩展名；在 HTML 中写 `assets/result.png`。
每个名字唯一。PNG/JPEG/WebP/SVG、字体 WOFF/WOFF2/TTF/OTF、MP4/WebM 可作为素材；原始字节复制到镜头版本中。
不要依赖任意磁盘路径、远程 URL、CDN、外部脚本或另一镜头的文件；未声明素材会报错。脚本和样式写在 HTML 内，运行库除外。

## 最小可用结构

以下只是技术骨架，不是推荐的成片设计。根据内容设计真正的构图与动作。

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <script src="uebox-gsap.js"></script>
  <script src="uebox-runtime.js"></script>
  <style>
    body { margin:0; background:#172426; color:#f1e9dc; }
    #film { width:2560px; height:1440px; position:relative; overflow:hidden; }
    .scene { position:absolute; inset:0; }
    .visual { width:100%; height:100%; object-fit:cover; }
    h1 { position:absolute; inset:160px auto auto 160px; font:700 132px 'Microsoft YaHei'; }
  </style>
</head>
<body>
  <div id="film" data-composition-id="main" data-width="2560" data-height="1440" data-duration="6">
    <section class="scene clip" data-start="0" data-duration="6">
      <img class="visual" src="assets/result.png">
      <h1>一句有依据的主张</h1>
    </section>
  </div>
  <script>
    const tl = gsap.timeline({paused:true});
    tl.from('.visual', {scale:1.06, duration:2, ease:'power2.out'}, 0)
      .from('h1', {y:70, opacity:0, duration:0.9, ease:'power3.out'}, 1.4);
    window.__timelines.main = tl;
  </script>
</body>
</html>
```

画布必须与分镜匹配：16:9 为 2560×1440；9:16 为 1440×2560；1:1 为 1440×1440。
根 `data-duration` 必须与实际镜头时长相等。不要偷偷延长片尾或截掉旁白。
可以在同一个 HTML 内编排多个连续场景与跨镜头转场；总时长仍以这个 composition 的 `duration` 为准。

## 时间轴与播放约束

- 时间从 0 秒开始。创建 `gsap.timeline({paused:true})`，完成全部构建后登记 `window.__timelines.main`，键与 `data-composition-id` 一致。
- 使用 `from`、`to`、`fromTo`、`set`、位置参数、stagger、遮罩、SVG 路径等设计动作。`transform` 的文字节点应是 block/inline-block。
- 镜头任何时刻都能被独立取样；不依赖 `Date.now`、`Math.random`、定时器、点击或滚动。不要调用 `tl.play()`，不要无限循环动画。
- 图片解码和字体会等待完成。自带字体用 `@font-face` 引用声明的本地素材；没有字体素材时使用明确的系统字体回退。
- 视频使用 `class="clip" data-start="..." data-duration="..." data-media-start="..."` 交给运行库定位；不要依赖浏览器自动播放。已有视频原声不会输出。
- HTML 中的声音不进入成片；旁白和 `musicPath` 由盒子合成。字幕、标注、标题由 HTML 编排，工具不会自动叠加旧版字幕条。
- 如果脚本、尺寸、素材或时间轴出错，修复错误后再导出，不降级为静态截图来绕过失败。

## 版本与验收

工具将 HTML 和显式素材保存到工程 `compositions` 中，改原文件不会改变旧版本。
改片以自己的创作 HTML 为源，更新素材列表后再渲染；不能把压缩预览替换为原图。
预览只取若干时刻，不是审美评分，也不能保证没有中间帧问题。最终仍需要播放成片并逐镜头审视。
