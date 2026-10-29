# 安装与使用

## 安装

1. 安装 Node.js 24.5+ 与 Microsoft Edge，再安装 OpenCLI：`npm install -g @jackwener/opencli@1.8.8`。
2. 本仓库根目录就是技能目录（根目录直接有 SKILL.md）。克隆后整个放进 Agent 的技能目录，例如 `~/.claude/skills/luz-crawl/` 或 `~/.codex/skills/luz-crawl/`；也可以放在别处，再用目录链接指过去。
3. 在最终的技能目录里运行 `node scripts/luz-crawl.mjs install`（安装或更新原生插件），再运行 `opencli daemon restart`。
4. Edge / Chrome 扩展页 → 开发者模式 → 加载解压缩的扩展 → 技能目录内的 **browser-extension/**（文件夹中直接有 manifest.json，不能选上一级）。停用旧的 OpenCLI / Browser Bridge 副本。
5. `node scripts/luz-crawl.mjs doctor`：`ready` 与 `extension_install.bundled_loaded` 均为 true。多个浏览器资料用 `--profile ID` 区分。
6. 在 Agent 里按名称调用技能（Claude Code 按描述自动触发，Codex 用 `$luz-crawl`）。移动技能目录后重新运行 install，并加载最终路径中的扩展。

`scripts/luz-crawl.mjs`、`opencli/commands.js` 和 `browser-extension/dist/` 是编译好的运行文件，不需要构建；源码在上游 [LuzernRR/luz-crawl](https://github.com/LuzernRR/luz-crawl)。升级时保留个人 `opencli/memory/`：替换文件后恢复该目录，再重新 install 并在扩展管理页“重新加载”LuzCrawl。仓库不包含个人记忆或 node_modules。高版本 OpenCLI 运行时可用 `LUZ_OPENCLI_ROOT` 指向独立的 1.8.8 安装。

## 使用与下载

### 静默浏览器

读取顺序（静默 → 最小化窗口的可见补读 → 请用户登录）以 [SKILL.md“读取顺序”](../SKILL.md#读取顺序先静默再可见最后请你登录)为准，这里只写安装与配置。

- 静默读取实际启动 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（通过 Playwright 的 `executablePath` 指定），找不到时不改用其它浏览器。需要本地 Playwright：可用 Agent 运行时自带的 Playwright，或用 `LUZ_PLAYWRIGHT_MODULE` 指向现有 Playwright 入口。不自动安装、不上传浏览器配置。
- 静默配置位于 `opencli/memory/browser-profile-edge/`（并发会话依次用 `-2`…`-4`），不复制、不提交、不打包，也不与用户 Default 资料混用。首次启动按当前 Edge 取得桌面 User-Agent 并缓存；继承 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 中的代理，不输出凭据。
- 采集、搜索、批量、collect、download、continue 和浏览器动作不带 `--profile` 时默认走静默配置。`--headless` 只表示“静默浏览器启动失败时直接报错、不转可见浏览器”；`doctor --headless` 用来检查静默浏览器能否启动。
- 已有登录的 Edge 用 `--profile ID` 直接使用；经用户明确要求后用 `remember --profile ID` 保存为补读用的可见浏览器，`remember --no-reuse-profile` 停用。同一 exe 配不同资料不代表复用登录。
- 静默配置里的任务需要登录时运行 `headless-login TASK_ID`，用户完成并关闭后再 `continue TASK_ID`。设 `LUZ_NO_BROWSER_LAUNCH=1` 可禁止在没有已连接浏览器时自动打开 Edge。

```powershell
node scripts/luz-crawl.mjs doctor --headless
node scripts/luz-crawl.mjs headless-login TASK_ID
```

只有显式选择 Playwright 自带 Chromium 时才设置下面的环境变量；资料在 `opencli/memory/browser-profile/`，另需 Playwright 对应的 Chromium。两类配置均不迁移现有浏览器 Cookie；后续登录、续接与采集须选同一浏览器，移除环境变量即恢复默认 Edge。

```powershell
$env:LUZ_HEADLESS_BROWSER = 'chromium'
node scripts/luz-crawl.mjs capture "https://example.com/article" --out TASK_FOLDER
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

- 断连：扩展路径、旧副本、daemon、--profile；更新后重载扩展。
- 目录未同步：重载 LuzCrawl，再运行采集；本次 --out 优先。
- partial：查看 limitations。404、限流、下载失败不等于未登录。
- 删除旧扩展：扩展管理页 → 旧 OpenCLI / Browser Bridge → 移除；保留 LuzCrawl 与停放任务。

LuzCrawl 项目与扩展版本为 2.7.0，底层桥接协议保持 1.0.24；上游标识与 Apache-2.0 法律文件保留。`browser-extension/` 的文件更新后，需要在扩展管理页手动“重新加载”LuzCrawl，再运行 doctor 确认连接正常；仅替换文件不会更新已运行的扩展。
