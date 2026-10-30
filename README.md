<p align="center"><img src="assets/logo.png" width="160" alt="LuzCrawl"></p>

<h1 align="center">Luz Crawl</h1>

<p align="center">给一个链接、一个主题或一批关键词，用真实浏览器检索和采集，得到一份含原文、图片、视频与评论的 HTML 证据包。</p>

<p align="center">
  <img alt="许可：PolyForm Noncommercial 1.0.0" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-8FB396">
  <img alt="类型：Agent Skill" src="https://img.shields.io/badge/type-Agent%20Skill-5B7F6A">
  <img alt="运行环境：Node.js 24.5+" src="https://img.shields.io/badge/node-24.5%2B-5B7F6A">
</p>

<p align="center"><img src="assets/readme-workflow.svg" width="720" alt="浏览器搜索 → 原文采集 → 归档与记忆"></p>

## 目录

- [能做什么](#能做什么)
- [适合与不适合](#适合与不适合)
- [快速开始](#快速开始)
- [工作方式](#工作方式)
- [稳定性与降级](#稳定性与降级)
- [经验沉淀](#经验沉淀)
- [目录结构](#目录结构)
- [五个技能的分工](#五个技能的分工)
- [许可](#许可)

## 能做什么

- **真实浏览器检索**：结果与人工浏览一致。支持小红书、微信公众号、知乎、抖音、哔哩哔哩、GitHub、CSDN、政府采购网等数十个站点，也支持任意网站的站内搜索。
- **原文采集与归档**：保存正文、作者与来源账号、图片、可访问的视频、互动数和已加载的评论，生成可离线阅读的 HTML，原始证据按任务目录归档。
- **先静默、后可见、再请你登录**：默认在后台无窗口读取；读不到正文才在你的 Edge 里以最小化窗口补读一次；仍需登录时才把页面调到前台请你登录，完成后从原处接续，不直接报失败。
- **大量检索**：一个批量文件可以混合网址和多平台搜索，默认 4 条、最多 6 条队列并行；没取得正文或没有结果的条目会自动补采一次。
- **多会话并发**：多个会话可以同时调用，各自使用独立的静默浏览器配置和任务目录，互不干扰。
- **边界清楚**：不破解验证码、不导出 Cookie、不绕过付费与权限；登录状态只留在你本机的浏览器配置里。

## 适合与不适合

| 适合 | 交给其他技能 |
|---|---|
| 调研同类产品、文章、视频、评论与公告，采集带证据的原文 | 把调研结果写成文章或文案 → [Luz-Writing](https://github.com/luzern0414/Luz-Writing) |
| 下载可公开访问的图片与视频 | 做系统方案、界面或原型 → [Luz-System](https://github.com/luzern0414/Luz-System) |
| 按站内搜索找招投标、企业、电商、设计素材 | 整理成报告、表格或 Word → [Luz-Design](https://github.com/luzern0414/Luz-Design) |
| 为技术方案读官方文档与同类实现 | 后端方案的调研由 [Luz-Dev](https://github.com/luzern0414/Luz-Dev) 按本技能的调用协议驱动 |

## 快速开始

1. 本仓库根目录就是技能目录：克隆后整个放进 Agent 的技能目录（例如 `~/.claude/skills/luz-crawl` 或 `~/.codex/skills/luz-crawl`）。
2. 安装 Node.js 24.5 及以上和 Microsoft Edge，在 Edge 里加载本目录的 `browser-extension/`，步骤见 [安装说明](references/install.md)。
3. 运行一次自检，`ready` 为 `true` 即可使用：

   ```powershell
   node scripts/luz-crawl.mjs doctor
   ```

之后直接用自然语言提需求，例如：

- “调研一下小红书和公众号上大家怎么评价自助健身房，整理成一份带原文的 HTML。”
- “查一下政府采购网上最近的人脸门禁招标公告。”
- “把这个抖音视频下载下来。”
- “这 30 个链接全部抓下来，顺便在 GitHub 和 CSDN 上搜一下‘爬虫 重试’。”

## 工作方式

1. **自检**：确认浏览器扩展已连接。
2. **建任务目录**：一项需求一个目录（放在技能目录之外），所有搜索、采集和续接都写进去。
3. **先查经验**：读你的偏好、以往教训和各平台已验证的路线，再安排这次怎么搜。
4. **搜索建候选池**：按主题规划平台与关键词，先列候选，剔除广告与无关结果。
5. **逐条读原文**：打开详情确认正文后才算读过，保存原文、媒体与评论。
6. **生成总结**：每次结束自动更新任务目录里的 `爬取总结.html`。
7. **沉淀经验**：把有效路线、失败原因和你的偏好记下来，下次先用。

## 稳定性与降级

| 情况 | 处理 |
|---|---|
| 网址拼错（多了空格、中文标点、全角字符、`htps`、漏写协议） | 自动纠正后再打开，日志里写明改了什么 |
| 静默读不到正文（登录墙、验证、空白） | 在已连接的 Edge 里以最小化窗口补读一次，没有就自动打开 Edge |
| 仍需要登录或验证 | 把这个页面调到前台，请你手动完成后 `continue` 续接 |
| 浏览器停在错误页（网站在当前网络打不开） | 依次试 https/http 与 www 变体，仍不行就说明原因与下一步 |
| 平台限流或冷却 | 立即停止该站并保存证据，不换入口规避 |
| 长页面、无限滚动 | 内容不再变化就判定完成，必要时直接跳到页尾；列表与评论更谨慎 |
| 多个会话同时调用 | 最多 4 个独立静默配置并行，满了排队等待 |

访问节奏按站点自适应：成功时逐步放宽，失败或限流时收紧，页面与图片视频分开计数。

## 经验沉淀

每次调用都会留下经验，并且同一件事只留最新的一份。五个 Luz 技能用同一套经验格式；本技能的命令是 `note`、`list`、`prune`、`check` 和 `experience --query`（本技能的 `search` 是网页检索，不是查经验）。

- **采集结果**：同一平台、网址和关键词只保留一条，新结果替换旧结果；超过 900 条自动合并到最新 800 条。
- **偏好与经验**：`note --kind --key --text` 按主题记录，同主题再记就替换原文；偏好最多 60 条，经验和事实各 120 条。
- **公开经验**：对所有人有用的经验加 `--public --when "适用场景"`，写进随仓库发布的路线提示；采集后自动更新站点库里已收录站点的实测结论。
- **爬取范围**：每次采集后按任务主题自动汇总哪些来源有效、各取到几条、哪些检索有结果、哪些站点无效，同一主题只留一条，下次先看它再定范围。
- **使用时**：每次开始前先查这些记录来安排路线，但仍会重新访问真实页面，不拿旧结果当这次的结果。

本机记录在 `data/memory/`，不进入仓库；公开部分是 `data/experience/seeds.json` 和 `references/site-library.json`。

## 目录结构

```text
SKILL.md               技能入口：读取顺序、判定规则、经验沉淀与边界
scripts/luz-crawl.mjs  命令行入口（自检、建任务、搜索、采集、批量、下载、续接、记忆）
lib/                   采集、搜索、归档、下载与 MP4 合并代码；lib/bridge/ 是本机连接服务（扩展 ↔ 命令行）
data/                  站点目录、访问策略与路线提示；data/memory/ 为本机记忆（不进仓库）
tests/                 自动测试（node --test tests/）
browser-extension/     浏览器扩展（Edge / Chrome）
references/            安装、平台、证据、校验、网站调研说明与网站库
```

本仓库就是源码，直接运行、无需构建，除 Node.js 24.5+ 与 Microsoft Edge 外没有外部依赖（不需要 OpenCLI、Playwright、FFmpeg 或 npm 包）。修改记录见 [CHANGELOG.md](CHANGELOG.md)；问题反馈见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

## 五个技能的分工

| 技能 | 负责 |
|---|---|
| [Luz-System](https://github.com/luzern0414/Luz-System) | 系统设计：软件方案、界面与原型、硬件选型 |
| [Luz-Design](https://github.com/luzern0414/Luz-Design) | 视觉标准、海报与品牌视觉、文件排版 |
| [Luz-Dev](https://github.com/luzern0414/Luz-Dev) | 后端、接口、数据库、部署与上线 |
| [Luz-Writing](https://github.com/luzern0414/Luz-Writing) | 文章、文案、协议等文字内容 |
| **Luz-Crawl**（本仓库） | 真实浏览器检索与采集 |

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：非商业用途可以自由使用、复制、修改和分发，禁止任何商业用途；如需商用请先联系作者。浏览器扩展中来自上游的部分保留 Apache-2.0 声明，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
