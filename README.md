# LuzCrawl

用真实浏览器搜索、阅读和保存网页。结果包含正文、可见图片、可下载媒体、已加载评论和本地 HTML 证据。

## 功能

- 搜索网站、GitHub 项目和开源项目。
- 采集网页正文、图片、视频、音频和已加载评论。
- 批量处理链接或搜索任务。
- 自动保存 HTML、原始快照、媒体和校验信息。
- 无头浏览器失败时转到可见浏览器；需要登录时保留任务供手动接续。
- 记录有效关键词、站点路线和失败原因，帮助后续搜索。

## 安装

需要 Node.js 24.5+、Microsoft Edge 和本目录的浏览器扩展。

1. 将仓库目录放入 Agent 的技能目录。
2. 在 Edge 的扩展管理页开启“开发者模式”，加载 `browser-extension/`。
3. 在仓库根目录运行：

   ```powershell
   node scripts/luz-crawl.mjs install
   node scripts/luz-crawl.mjs doctor
   ```

`doctor` 返回 `ready: true` 且扩展已加载后即可使用。扩展更新后，在扩展管理页重新加载。

## 操作

每项需求使用一个输出目录，目录放在技能目录之外：

```powershell
node scripts/luz-crawl.mjs doctor
$task = (node scripts/luz-crawl.mjs begin "浏览器自动化工具" --out "D:\输出" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs experience --query "浏览器自动化"
node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
node scripts/luz-crawl.mjs capture "https://example.com/article" --comments --download --out $task
node scripts/luz-crawl.mjs collect "浏览器自动化工具" --read 1 --out $task
```

常用命令：

| 命令 | 作用 |
|---|---|
| `doctor` | 检查 Node、Edge、服务和扩展 |
| `begin` | 创建任务目录 |
| `experience` | 查看关键词和已知路线 |
| `search` | 在真实浏览器中搜索 |
| `capture` | 读取一个 URL |
| `collect` | 按主题搜索并汇总 |
| `batch` | 批量读取 URL 或搜索任务 |
| `download` | 补下载已观察到的媒体 |
| `pending` / `continue` | 查看并接续登录或验证任务 |
| `summary` | 从已有证据重建总结 |

## 搜索规则

先拆分主题、功能、技术词、硬约束和偏好，再分开查询同义词。GitHub 保留用户明确的 `org:`、`language:`、`is:`、`fork:`、`archived:` 等条件；GitCN、HelloGitHub、Codeberg 等备用入口使用普通功能词，结果回到原仓库核验。

搜索结果只是候选。只有打开详情并确认目标正文后才算有效来源。导航、推荐、搜索摘要、镜像和无关卡片不会计入结果。查询未生效、没有候选、限流、登录和浏览器故障分别报告。

## 输出

任务目录包含搜索结果、详情、媒体、`manifest.json` 和 `爬取总结.html`。完成后的 HTML 与 `raw/` 位于输出根目录。captured 表示正文已读，partial 表示有内容但不完整，awaiting_user 表示等待登录或验证，blocked 表示被站点限制，failed 表示执行失败。

## 安全边界

只读取浏览器中可见或公开的内容；不破解验证码、不绕过付费或权限、不导出 Cookie。点赞、发送、提交等写操作必须有明确授权，并使用 `--allow-write`。

更多参数见 [安装说明](references/install.md)、[浏览器操作 API](references/browser-api.md)、[GitHub 检索指南](references/github-search.md) 和 [证据规范](references/evidence.md)。

许可见 [LICENSE](LICENSE)。
