# 安装与使用

## 安装

1. 安装 Node.js 24.5+ 与 Microsoft Edge。不需要再装其他东西：连接服务、静默浏览器启动和音视频合并都在本目录里（不用 OpenCLI、Playwright、FFmpeg，也没有 npm 依赖）。
2. 本仓库根目录就是技能目录（根目录直接有 SKILL.md）。克隆后整个放进 Agent 的技能目录，例如 `~/.claude/skills/luz-crawl/` 或 `~/.codex/skills/luz-crawl/`；也可以放在别处，再用目录链接指过去。
3. 在最终的技能目录里运行 `node scripts/luz-crawl.mjs install`：检查 Node 与 Edge，启动本机连接服务（127.0.0.1:19835），并说明下一步。
4. Edge / Chrome 扩展页 → 开发者模式 → 加载解压缩的扩展 → 技能目录内的 **browser-extension/**（文件夹中直接有 manifest.json，不能选上一级）。旧的 OpenCLI / Browser Bridge 扩展可以保留或移除，互不影响（它们连 19825，LuzCrawl 连 19835）。
5. `node scripts/luz-crawl.mjs doctor`：`ready` 与 `extension_install.bundled_loaded` 均为 true。多个浏览器资料用 `--profile ID` 区分。
6. 在 Agent 里按名称调用技能（Claude Code 按描述自动触发，Codex 用 `$luz-crawl`）。移动技能目录后加载最终路径中的扩展。

运行的就是仓库里的源码（`scripts/luz-crawl.mjs`、`lib/`、`browser-extension/`），不需要构建；测试在 `tests/`，用 `node --test tests/` 运行。升级时保留个人 `data/memory/`：替换文件后恢复该目录，并在扩展管理页“重新加载”LuzCrawl。旧版本的 `opencli/memory/` 会在第一次运行时自动搬到 `data/memory/`。仓库不包含个人记忆。

## 使用与下载

### 静默浏览器

读取顺序（静默 → 最小化窗口的可见补读 → 请用户登录）以 [SKILL.md“读取顺序”](../SKILL.md#读取顺序先静默再可见最后请你登录)为准，这里只写安装与配置。

- 静默读取实际启动 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（由技能直接启动：无头模式，加载本目录扩展，通过 Edge 自带的调试管道识别扩展并正常关闭），找不到时不改用其它浏览器。不自动安装、不上传浏览器配置。
- 静默配置位于 `data/memory/browser-profile-edge/`（并发会话依次用 `-2`…`-4`），不复制、不提交、不打包，也不与用户 Default 资料混用。User-Agent 按已安装的 Edge 主版本生成桌面版（不带 HeadlessChrome）；继承 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 中的代理，带用户名密码的代理不支持（请用本机无认证代理转发）。
- 采集、搜索、批量、collect、download、continue 和浏览器动作不带 `--profile` 时默认走静默配置。`--headless` 只表示“静默浏览器启动失败时直接报错、不转可见浏览器”；`doctor --headless` 用来检查静默浏览器能否启动。
- 已有登录的 Edge 用 `--profile ID` 直接使用；经用户明确要求后用 `remember --profile ID` 保存为补读用的可见浏览器，`remember --no-reuse-profile` 停用。同一 exe 配不同资料不代表复用登录。
- 静默配置里的任务需要登录时运行 `headless-login TASK_ID`，用户完成并关闭后再 `continue TASK_ID`。设 `LUZ_NO_BROWSER_LAUNCH=1` 可禁止在没有已连接浏览器时自动打开 Edge。

```powershell
node scripts/luz-crawl.mjs doctor --headless
node scripts/luz-crawl.mjs headless-login TASK_ID
```

### 采集与补下载

```powershell
node scripts/luz-crawl.mjs search xhs "关键词" --read 1 --comments --download --out TASK_FOLDER
node scripts/luz-crawl.mjs capture "https://example.com/article" --comments --download --out TASK_FOLDER
node scripts/luz-crawl.mjs download "TASK_FOLDER\raw\001_原标题"
```

TASK_FOLDER 是 `begin` 返回的任务目录（见 [SKILL.md“任务目录与多会话”](../SKILL.md#任务目录与多会话)）；补下载用采集返回的 folder。复制给 Agent 的提示词示例：

> 使用 luz-crawl 抓取这条链接：粘贴 URL。保存到我的输出目录，下载帖子图片与可访问视频，记录作者、互动数与已加载评论。遇登录让我手动完成，结束后关闭工具页。

## 保存目录

扩展弹窗 → 默认保存目录 → 绝对路径 → 保存；下一次命令 / Agent 采集生效。也可：

```powershell
node scripts/luz-crawl.mjs remember --out "<OUTPUT_ROOT>" --format html
```

本次 `--out` 优先，其次浏览器 / 命令最新保存的目录，都没有时回退到当前目录的 `outputs/luz-crawl`。输出根要放在技能目录之外。任务目录、raw 布局和成品位置只在 [SKILL.md“任务目录与多会话”](../SKILL.md#任务目录与多会话)维护，分类规则见[分类工作流](workflows.md)。

## 登录与关闭

`pending` 查看待办，手动完成后 `continue TASK_ID`；明确取消用 `cancel TASK_ID`。规则见 [SKILL.md“URL 与人工接续”](../SKILL.md#url-与人工接续)。

## 浏览器动作

保存 actions.json：

```json
[
  { "action": "read" },
  { "action": "scroll", "direction": "down", "amount": 600 },
  { "action": "screenshot" }
]
```

```powershell
node scripts/luz-crawl.mjs browser "https://example.com" --file actions.json --out TASK_FOLDER
```

动作定义、写操作授权、批量与节流见[浏览器接口](browser-api.md)。

## 排错

- 断连：先看 doctor 的 `state` 与 `hint`；检查扩展路径、--profile，更新后在扩展管理页重载 LuzCrawl。连接服务的端口是 19835，被占用时 doctor 报 `daemon_stopped`。
- 目录未同步：重载 LuzCrawl，再运行采集；本次 --out 优先。
- partial：查看 limitations。404、限流、下载失败不等于未登录。
- 旧的 OpenCLI / Browser Bridge 扩展与 LuzCrawl 互不影响；不再使用 OpenCLI 时可在扩展管理页移除。

LuzCrawl 项目与扩展版本为 3.0.0；扩展基于 OpenCLI Browser Bridge 1.0.24，连接服务改编自 OpenCLI 1.8.8，上游标识与 Apache-2.0 法律文件保留。`browser-extension/` 的文件更新后，需要在扩展管理页手动“重新加载”LuzCrawl，再运行 doctor 确认连接正常；仅替换文件不会更新已运行的扩展。
