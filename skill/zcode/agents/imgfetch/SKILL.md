---
name: imgfetch
description: 从伪装成普通链接的多级跳转落地页中提取深藏的图片资源。当 URL 用 curl 访问返回 HTML 而非媒体文件、电脑浏览器打开空白但手机/QQ 能打开、页面出现"安全确认/安全观看/分享解锁"门槛、或图片是点击按钮后动态注入时使用。适用于快手系（wsukwai/kwimgs）引流落地页及同结构的营销页、强分享解锁页。当用户说"提取这个链接里的图片""把页面里藏的图片扒下来"且链接不是直接的图片地址时，也应使用本 skill。
---

# imgfetch：多级跳转落地页图片提取

目标：给定一个"表面是资源链接、实际是落地页"的 URL，把其中深藏的几十张内容图片完整下载到本地。

## 总体流程（四个阶段）

```
探测 → 追跳转链 → 手机环境模拟运行 → 下载+魔数验证
```

**不要**直接对着最终 URL 反复试探。先跑脚本（`scripts/imgfetch.js`），它封装了全部四个阶段；只有脚本失败时才手工分析（见"手工兜底"）。

## 快速开始

```bash
# 完整流程：自动探测/新建空文件夹保存图片
node "<skill目录>/scripts/imgfetch.js" "<URL>" --out ./安全确认图片

# 只列出图片 URL 不下载（先确认能挖到再下载）
node "<skill目录>/scripts/imgfetch.js" "<URL>" --no-download

# 常用参数
#   --click "安全观看"   点击按钮的文本（默认自动找：id 含 confirm 或文本含 确认/观看/验证/继续/解锁/开始）
#   --wait 60            点击后观察秒数（默认 60，图片数量稳定 15 秒可提前结束）
#   --all                下载全部图片（默认 content-only：只下载动态注入的正文图，跳过页面装饰图）
#   --desktop            用桌面 Chrome UA（默认 iPhone QQ UA，手机能开电脑空白的页面必须用默认值）
#   --keep-temp          保留各跳转层的 HTML 快照便于分析
# 注：无论是否传 --out，下载前都会做空文件夹探测，不会覆盖已有图片的文件夹
```

输出：`--out` 目录下按序号命名的图片（扩展名按文件魔数纠正，如内容是 GIF 会存成 .gif），外加 `manifest.json`（URL → 文件、类型、动态/静态来源的映射）。

**空文件夹保证**：图片和视频各自独立分放，每次下载前先探测输出文件夹，成果永远不会混进旧的文件夹里——
1. 图片默认落 `安全确认图片*`、视频默认落 `安全确认视频*`（探测函数 `resolveOutDir(null, '图片'|'视频')`）；遍历工作目录下对应家族的所有文件夹，其中**没有任何媒体文件**的 → 直接复用该文件夹（视频文件夹按 .ts/.mp4/.m3u8 等扩展名判断）；
2. 全部已有内容 → 新建顺延编号的文件夹（`安全确认图片 2`、`安全确认视频 3`…）；
3. 显式 `--out` 同样受保护：指向已有媒体文件的文件夹时自动顺延（`<out> 2`），绝不覆盖；想让本次成果落进某个文件夹，把它清空即可被复用。

## 各阶段要点

### 1. 探测
先 GET 目标 URL 看响应：`Content-Type: image/*` 或 `video/*` 说明是直链，直接下载完事。返回 `text/html` 且体积只有 1-4KB → 是跳转壳页，进入阶段 2。

### 2. 追跳转链（纯静态，不需要浏览器）
这类页面通常 2-3 跳：`CDN壳页 → (JS location.replace / mqq.invoke) → 二级壳页 → (iframe) → 真落地页`。脚本会从内联 JS 里提取候选 URL（绝对 URL、iframe src 及可解析的相对路径变量）逐个抓取。用 `--keep-temp` 把每层 HTML 存下来，失败时人工看快照找线索。

### 3. 手机环境模拟（核心）
这类页面的共性是**环境门槛**：电脑打开空白、手机/QQ 里正常，因为脚本检测 UA 和 QQ 桥接对象。所以必须在 jsdom 里伪装手机 QQ 运行真落地页，让页面自己把图片渲染出来：

- UA 必须带 `QQ/9.x` + `MQQBrowser` 标识；`beforeParse` 里塞 `window.mqq` 桩（含 `invoke/on`）
- **`window.fetch` 在 jsdom 里不存在**——钩子必须基于 Node 全局 `fetch` 实现并挂回 `window.fetch`，否则页面发不出请求（这是最常见的失败点）
- 用 `MutationObserver`（挂在 `window.MutationObserver` 上，观察 `documentElement` 的 subtree childList）抓动态注入的 `img/video/source/背景图`——图片几乎都是点击解锁按钮后异步注入的
- 如果页面用了 canvas（"少女祈祷中"验证动画），必须安装 `canvas` 包，否则流程在验证阶段中断。脚本首次运行会自动在 skill 目录里 `npm i jsdom canvas`
- 点击后轮询观察，图片数量连续 3 个周期不变即认为加载完毕

### 4. 下载与验证
- 带 iPhone UA + `Referer` 下载，并发 4
- **必须验证魔数**（JPEG `\xff\xd8`、PNG `\x89PNG`、GIF `GIF8`、WEBP `RIFF..WEBP`），按实际类型改扩展名——URL 以 .jpg 结尾不代表内容是 JPEG
- 注意 `x-expires` / `x-signature` 查询参数：这类 CDN 图片链接是有签名的、会过期（常见 1 年内）。下载要趁早；过期后只能重跑模拟流程拿新签名

## 判定"正文图" vs "页面装饰图"
默认 content-only：只保存**动态注入**（MutationObserver 捕获）的图。页面自带的装饰图（jquery/fancybox/hls.js/artplayer/qqapi、bilibili logo、客服二维码等）不算正文。加 `--all` 可全部保存。manifest.json 里记录了每张图的来源便于人工复核。

## 手工兜底（脚本失败时）
1. `curl -s <URL>` 逐层存 HTML，人工读内联 JS：找 `location.replace`、iframe `src` 变量、被混淆前的明文 URL 片段
2. 遇到 obfuscator.io 混淆的 boot JS（字符串表 + RC4），不要静态逆向——把整页放进 Node VM 沙箱跑：伪造 `document/navigator(mobile QQ UA)/location`，钩 `fetch/XMLHttpRequest/Image.src`，截获它发出的请求和响应体
3. **解密后的配置截获**：这类页面的图片清单几乎都来自边缘函数返回的加密配置（`ENC1.<base64>`），解密在 boot JS 里完成。在 jsdom `beforeParse` 里包一层 `window.JSON.parse`（记录含 `http|img|article|m3u8` 的入参）即可拿到解密后的明文 JSON。已知配置结构：`t` 字段是内容类型——`"article"`=图文壳（含几十张正文图），`"video"`=纯视频/单图（可能只有 1×1 占位图，即服务端内容已清空）；`c.exat` 是活动过期时间
4. **视频真实地址在双层加密里**：`t:"video"` 时外层配置的 `u` 只是解锁前封面（常是占位图），真正的 `cfg.video_url`（m3u8）在 boot 解密出的 `__ctx._p.cfg` 载荷里。截获手法：`beforeParse` 里包装 `window.Function`，当函数体含 `__P_CTX` 标记时在开头注入 `window.__CTX_DUMP=arguments[0]`，运行后读 `__CTX_DUMP._p.cfg.video_url`（注意循环引用，序列化要用 WeakSet）。坑：注入代码里 initPlay 会因 jsdom 缺 `URL.createObjectURL/revokeObjectURL` 抛未捕获异常杀死进程——beforeParse 里补这两个桩并加 `process.on('uncaughtException')` 守护。**识别视频还是图片**：`_p.cfg.video_url` 可能无扩展名且 `cfg.type` 可能是 `"unknown"`，用魔数判断——请求头 32 字节含 `ftyp` 为 MP4（直接下成 .mp4），文本且含 `#EXTM3U` 为 HLS（按第 7 条走）
5. **自托管文章壳（lingliaorengzheng.cn / sy.xcy6.cn 一族）有假锁**：页面是单文件大 HTML（>200KB 全内联 JS），正文来自 `API_BASE + '/api/fission/article_info.php?key=<URL里的key>&id=<URL里的id>'`，JSON 的 `content` 字段就是**完整文章 HTML**（含全部 `<img>`）——"密码/倒计时锁"只是前端把后 70% 藏起来，API 不做鉴权，直接 curl 即可，无需模拟解锁。图片多在美团图床（img.meituan.net）。快手系图文活动同理：带锁时正文藏在 `__ctx._m.raw_content`，整包 dump 后直接搜 `<img src>`。**坑：从 HTML 属性里抠出的 URL 含 `&amp;` 转义，下载前必须 `html.unescape`，否则签名参数错误全部 403**
6. 同一模板的落地页可能只差一个 meta（如 `STYN_GROUP_B_VIDEO` vs `STYN_GROUP_B_COMPREHENSIVE`），但**分支由服务端按 `s` 参数下发的配置决定**，本地改 meta 无效；`act=view` 请求只出现一次，重试/分享按钮不会触发第二次配置请求，别在兜底流程上浪费时间
7. **m3u8 下载**：分片常伪装成 .png/.jpg 扩展名（实为 MPEG-TS，魔数 0x47），带手机 UA + Referer 并发下载，逐片校验同步字节后二进制拼接成单个 .ts 即为原始格式（不转码=不改文件类型）；把原始远端播放列表也存档一份
8. 注意区分真实内容与占位：`picgzc.qpic.cn` 的 `consult_viewer_pic__*.jpg` 是客服引流/追踪图，常见 1×1 像素；`artplayer.org/assets/img/state.svg` 是播放器错误占位图标，都不是正文图
9. 需要可视化确认页面状态时，用 control-browser skill 的 IAB：先在顶层导航到 iframe 的真实 src（嵌套 iframe 里 domSnapshot 看不到内容，必须置顶），再截图/evaluate。桌面 IAB 里同样会遇到"点击后白屏"，那是环境检测，回退到 jsdom 方案
10. **不要把壳页 URL 直接喂给 jsdom**：壳页靠 `location.replace` 跳转，jsdom 不执行跨文档导航，页面会原地不动、什么也不发生——必须先用链路解析（curl 逐层）拿到最终落地页 URL，再对它做模拟。给 jsdom 的 fetch 钩子加超时（如 `AbortSignal.timeout(15000)`），否则某个挂死的候选连接会让整个流程卡住

## 报告格式
完成后向用户报告：图片数量、保存位置、图片实际来源 CDN、签名过期时间（若有）、以及是否只含正文图（装饰图排除情况）。若页面存在"分享解锁视频"等后续门槛（本流程只解到图片层），如实说明。
