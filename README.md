<p align="center"><img src="assets/logo.png" width="160" alt="LuzCrawl"></p>

<h1 align="center">Luz Crawl</h1>

<p align="center">给一个链接或主题，用真实浏览器检索和采集，得到一份含原文、图片、视频与评论的 HTML 证据包。</p>

<p align="center"><img src="assets/readme-workflow.svg" width="720" alt="浏览器搜索 → 原文采集 → 归档与记忆"></p>

## 能做什么

- **真实浏览器检索**：在你自己的 Edge / Chrome 里打开页面执行搜索，结果与人工浏览一致；支持小红书、微信公众号、知乎、抖音、哔哩哔哩、GitHub、CSDN、政府采购网等数十个站点，以及任意网站的站内搜索。
- **原文采集与归档**：保存正文、作者与来源账号、图片、可访问的视频、互动数和已加载的评论，生成一个可离线阅读的 HTML，原始证据按任务目录归档。
- **多站并发与接续**：一次调研可以并发多个站点；遇到登录、验证码或限流时只暂停对应站点，等你在浏览器里手动完成后从原处接续。
- **本地记忆**：记住搜过的词、好用的入口和站点经验，下次先给出更好的路线，但每次仍重新访问真实页面。
- **边界清楚**：不破解验证码、不导出 Cookie、不绕过付费与权限；登录状态只留在你本机的浏览器配置里。

## 典型用法

把本目录放进 Agent 的技能目录，并按安装说明加载浏览器扩展后，直接提需求，例如：

- “调研一下小红书和公众号上大家怎么评价自助健身房，整理成一份带原文的 HTML。”
- “把这个抖音视频下载下来。”
- “查一下政府采购网上最近的人脸门禁招标公告。”
- “抓取这篇文章和下面的评论。”

## 工作方式

1. 自检浏览器扩展与连接状态。
2. 为本次需求建一个任务目录，按主题规划平台与关键词。
3. 在真实浏览器里搜索，先建候选池，再逐个打开原文确认内容是否相关。
4. 保存原文、媒体与评论，生成采集总结 HTML。
5. 把有用的检索路线写回本地记忆。

## 目录结构

```text
SKILL.md              技能入口：调用顺序、判定规则与边界
scripts/luz-crawl.mjs 命令行入口（自检、建任务、搜索、采集、批量、下载、接续）
opencli/              采集运行文件、站点目录、访问策略与经验种子
browser-extension/    浏览器扩展（Edge / Chrome）
references/           安装、平台、证据、校验、网站调研说明与网站库
```

采集记忆（`opencli/memory/`）只保存在本机，不进入仓库。

## 依赖

- Node.js 24.5 及以上。
- Microsoft Edge 或 Google Chrome，并加载本目录里的浏览器扩展（步骤见 `references/install.md`）。

## 来源与开发

本仓库是可直接安装运行的技能版本。完整源代码、测试与发布包在 [LuzernRR/luz-crawl](https://github.com/LuzernRR/luz-crawl)；更新记录见 [CHANGELOG.md](CHANGELOG.md)，问题与贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## 相关技能

[Luz-System](https://github.com/luzern0414/Luz-System)、[Luz-Design](https://github.com/luzern0414/Luz-Design)、[Luz-Dev](https://github.com/luzern0414/Luz-Dev)、[Luz-Writing](https://github.com/luzern0414/Luz-Writing) 都通过 Luz Crawl 做调研。

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：非商业用途可以自由使用、复制、修改和分发，禁止任何商业用途；如需商用请先联系作者。浏览器扩展中来自上游的部分保留 Apache-2.0 声明，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
