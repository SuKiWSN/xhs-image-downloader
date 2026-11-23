# 小红书图片下载（Chrome / Edge 插件）

[![测试](https://github.com/SuKiWSN/xhs-image-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/SuKiWSN/xhs-image-downloader/actions/workflows/ci.yml)
[![最新版本](https://img.shields.io/github/v/release/SuKiWSN/xhs-image-downloader?label=%E4%B8%8B%E8%BD%BD)](https://github.com/SuKiWSN/xhs-image-downloader/releases/latest)
[![许可证](https://img.shields.io/github/license/SuKiWSN/xhs-image-downloader)](LICENSE)

在小红书网页版的每篇笔记下方加一个「下载」按钮，点一下就把这篇笔记里的**全部图片**保存到电脑的「下载」目录，
并且放进一个**和笔记标题同名的文件夹**里：

```
下载/
└── 是199不是1999啊，199全国随心飞还不冲？/
    ├── 01.jpg
    ├── 02.jpg
    └── 03.jpg
```

## 支持的系统和浏览器

| 系统 | 每次更新都自动测试的浏览器 |
| --- | --- |
| Windows 10 / 11 | Chrome、Edge |
| Linux（Ubuntu、Debian、Fedora、Arch 等） | Chrome、Edge |
| macOS | Chrome |

需要浏览器版本 111 或更新。macOS 上的 Edge，以及 Chromium、Brave、Vivaldi 等其他 Chromium 内核浏览器
用的是同一套插件接口，一般也能用，只是没有放进自动测试。

自动测试会在上面每个系统和浏览器里真正加载插件、点击下载按钮，逐个检查文件夹名、文件名和文件内容（见下方「开发与测试」）。

## 安装

1. 到 [Releases 页面](https://github.com/SuKiWSN/xhs-image-downloader/releases/latest) 下载 `xhs-image-downloader-v版本号.zip`，
   解压到一个以后不会删掉的位置（例如 `文档/xhs-image-downloader`）。
   也可以在本页点绿色的「Code → Download ZIP」，效果一样。
2. 打开扩展程序页面：Chrome 在地址栏输入 `chrome://extensions`，Edge 输入 `edge://extensions`。
3. 打开「开发者模式」（Chrome 在右上角，Edge 在左侧栏）。
4. 点「加载已解压的扩展程序」（Edge 叫「加载解压缩的扩展」），选择**里面直接有 `manifest.json` 的那个文件夹**。
5. 刷新已经打开的小红书页面。

> Windows 用「全部解压缩」时可能多套一层同名文件夹；如果提示「清单文件缺失或不可读取」，往里再进一层选择即可。
>
> 解压出来的文件夹就是插件本身，删掉或移动后插件会失效。

**更新**：下载新版 zip，覆盖解压到原来的文件夹，然后在扩展程序页面点插件上的「重新加载」按钮（↻）。

## 使用

- **笔记卡片**（首页推荐、搜索结果、个人主页）：每张卡片底部「作者 · 点赞」那一行会多出一个红色「下载」按钮。
- **笔记详情**（点开笔记后的弹窗或笔记页面）：正文和日期下方有一个「下载全部图片（N 张）」按钮，
  按钮下面会提示这次会保存到哪个文件夹。

下载过程中按钮会显示进度（如 `3/8`），完成后页面底部弹出提示，点「打开文件夹」可以直接在
资源管理器（Windows）/ 访达（macOS）/ 文件管理器（Linux）里看到文件。

## 设置

点浏览器工具栏上的插件图标即可修改，改完自动保存：

| 设置 | 说明 |
| --- | --- |
| 图片格式 | **原图**（默认）：原始分辨率和画质，原图是 JPG / PNG / WEBP 的原样保存，苹果 HEIC 格式自动转成高质量 JPG；<br>**JPG**：全部存为 JPG（本来就是 JPG 的不重新压缩）；**PNG**：全部存为 PNG（无损，文件很大） |
| 视频笔记下载视频 | 默认开。视频笔记保存为 `视频.mp4` 和一张 `封面` 图；关掉则只下载封面 |
| 实况图同时下载动态视频 | 默认关。打开后 Live Photo 会多保存一个 `01_实况.mp4` |
| 上级文件夹 | 默认留空（直接放在「下载」目录）。填 `小红书` 则保存到 `下载/小红书/标题/`，多级用 `/` 或 `\` 分隔 |

> 浏览器插件只能把文件存到浏览器的「下载」目录里面。想存到 D 盘或其他文件夹，请在浏览器设置里修改下载位置
> （Chrome：`chrome://settings/downloads`，Edge：`edge://settings/downloads`）。

## 说明与常见问题

- **文件夹名**：使用笔记标题。系统不允许出现在文件名里的字符会换成相近的全角字符（如 `/` → `／`、`?` → `？`、`:` → `：`），
  表情里的不可见连接符会被去掉；没有标题的笔记用正文第一句话命名。两篇笔记标题相同时会放进同一个文件夹，
  文件自动改名为 `01 (1).jpg`，不会互相覆盖。三个系统上的命名规则完全一样。
- **Windows 的特别处理**：
  - `CON`、`NUL`、`COM1` 这类 Windows 保留名会自动在前面加 `_`（如 `_CON`），否则文件夹建不出来；
  - Windows 规定完整路径不能超过 260 个字符，所以文件夹名最多 60 个字符、上级文件夹最多 50 个字符。
    只要浏览器的下载目录本身不超过约 115 个字符（默认的 `C:\Users\用户名\Downloads` 只有二三十个字符）就不会超限；
    万一超限，插件会自动改用更短的 `xiaohongshu_笔记ID` 文件夹，不会下载失败。
- **Linux 的特别处理**：Linux 每一级文件名最长 255 字节（一个汉字占 3 字节），加密的 home 目录更短，
  所以文件夹名限制在 140 字节以内，在各种文件系统上都能创建。
- **每张图都弹出保存框？** 说明浏览器开启了「下载前询问每个文件的保存位置」，到 `chrome://settings/downloads`（Edge 为 `edge://settings/downloads`）关掉即可。
- **提示需要登录或安全验证**：小红书对未登录用户只允许看少量笔记（浏览十几篇后就会跳到登录页），
  访问过于频繁也会要求验证。登录、完成页面上的验证后重试即可；也可以先点开笔记，再用详情里的按钮下载。
- **图片清晰度**：默认下载原图（分辨率和作者上传时一致，常见 2000～4000 像素），比网页上显示的压缩图清晰得多；
  原图不可用时会自动退回网页图。注意部分原图是 PNG，单张可能有 10MB 以上。
- **隐私**：插件只在 `www.xiaohongshu.com` 上运行，只访问小红书自己的页面和图片服务器，不收集、不上传任何数据。

## 工作原理

```
manifest.json          插件配置（Manifest V3）
src/bridge.js          运行在页面环境，读取页面已加载的笔记数据（window.__INITIAL_STATE__）
src/content.js         插入按钮、获取笔记完整图片列表、显示进度和提示
src/content.css        按钮与提示条样式
src/shared.js          公共工具：文件名清理、原图地址生成、文件格式识别等
src/background.js      后台：识别真实格式并用 chrome.downloads 保存到「下载/标题/」
popup/                 工具栏弹窗（设置）
icons/                 图标
test/                  自动化测试（不属于插件本身，打包时不包含）
```

1. 点击按钮后，先从页面已有的数据里找这篇笔记；没有的话就请求一次笔记页面（和点开笔记时的地址相同），
   从中解析出完整的图片列表。
2. 每张图生成原图地址 `https://sns-img-bd.xhscdn.com/<图片 ID>`，并准备网页图作为备用地址。
3. 后台先读取文件头确认真实格式（jpg / png / webp / heic …），需要时让 CDN 按原分辨率转格式
   （`?imageView2/format/jpg/q/95`），再通过 `chrome.downloads` 保存，文件名形如 `标题/01.jpg`，浏览器会自动创建文件夹。

小红书网页改版后如果按钮不出现或下载失败，通常是页面结构变了，需要相应更新 `src/content.js` 里的选择器。

## 开发与测试

需要 Node.js 22.12 或更新版本，以及本机安装的 Chrome。

```bash
npm ci              # 安装测试工具（不影响插件本身）
npm test            # 单元测试：文件名清理、路径长度、地址解析等
npm run test:e2e    # 端到端测试：在真正的 Chrome 里加载插件并下载
```

端到端测试会在本机启动一个「假」的小红书网站（页面结构和数据格式照真实网站做，图片也由它提供），
让浏览器把 `www.xiaohongshu.com`、`*.xhscdn.com` 都指向它，然后像用户一样点击下载按钮，
最后逐个检查下载目录里的文件夹名、文件名和文件内容。整个过程不需要登录、不访问外网，几秒钟就能跑完。
为了覆盖 Windows 的路径长度限制，测试特意把下载目录设成 115 个字符那么深。

- 用 Edge 测试：`XHSDL_BROWSER=msedge npm run test:e2e`
- 指定浏览器程序：`CHROME_PATH=/path/to/chrome npm run test:e2e`
- 显示浏览器窗口：`HEADFUL=1 npm run test:e2e`

GitHub Actions 会在每次提交时于 Windows、Linux、macOS 上运行以上全部测试；
推送 `v*` 标签（如 `v1.0.1`）时会自动打包插件并发布到 Releases。

## 许可证

[MIT](LICENSE)
