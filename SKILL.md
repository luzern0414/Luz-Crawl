---
name: luz-crawl
description: Use when you need real-browser search, page capture, public media download, or HTML evidence from websites, including GitHub and open-source project discovery.
---

# LuzCrawl

真实浏览器检索、采集、下载和归档。只把浏览器实际看到的内容写入任务证据。

## 调用流程

每项需求按顺序执行：

1. node scripts/luz-crawl.mjs doctor，确认 ready: true。
2. 建立一个任务目录，输出根必须在技能目录之外。
3. 用 experience --query 查看相关关键词、路线和限制。
4. 用同一个 --out TASK_FOLDER 完成搜索、采集、批量和接续。
5. 报告每项的 captured、partial、awaiting_user、blocked 或 failed。
6. 记录用户新偏好、有效路线和失败原因。

```powershell
node scripts/luz-crawl.mjs doctor
$task = (node scripts/luz-crawl.mjs begin "主题" --out "D:\输出" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs experience --query "关键词"
node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
node scripts/luz-crawl.mjs capture "https://example.com/article" --out $task
```

不要把输出写入技能目录，不要为同一需求建立多个任务目录。

## 搜索与采集

- 先保留用户原词，再拆成功能、技术词、硬约束、偏好和同义词；每轮只增加能解释的词。
- GitHub 优先仓库搜索，保留用户明确的 org:、user:、repo:、language:、is:、fork:、archived: 和负筛选。
- GitHub 结果不足时按有限路线补搜 Bing、GitCN、HelloGitHub、Codeberg 或 Gitee；备用入口使用普通功能词，筛选条件回到原仓库复核。
- 搜索卡片只是候选。打开详情并确认目标正文后才算有效来源；导航、推荐、摘要、镜像、文件/Issue 子页和无关卡片不计入项目。
- 先用 --read 0 建候选池，再对相关项目执行 capture 或 search --read N。不要为凑数量重复无效查询。
- 站内搜索必须确认输入、提交和结果页真正生效。查询未生效、零候选、限流、验证和浏览器故障分别记录。
- HTTP 状态或搜索外壳不能代替正文。详情只有正文确认后才计入 verified_sources。

GitHub 详细关键词和备用入口见 [github-search.md](references/github-search.md)。

## 读取顺序

1. 默认使用独立无头 Edge。
2. 读不到正文时，在已连接的 Edge 中最小化补读一次。
3. 仍需登录或验证时保存任务，让用户手动处理后运行 continue TASK_ID。
4. 无法打开时区分 URL 错误、网络错误、限流、登录和安全验证；不要把它们统称为失败或 IP 封禁。

验证、限流、预算耗尽或用户取消会停止对应站点，不换入口规避限制。只关闭本任务创建的页面。

## 常用操作

```powershell
node scripts/luz-crawl.mjs search PLATFORM "关键词" --read 1 --out TASK_FOLDER
node scripts/luz-crawl.mjs capture "URL" --comments --download --out TASK_FOLDER
node scripts/luz-crawl.mjs collect "主题或 URL" --read 1 --out TASK_FOLDER
node scripts/luz-crawl.mjs batch --file jobs.json --out TASK_FOLDER
node scripts/luz-crawl.mjs pending
node scripts/luz-crawl.mjs continue TASK_ID
node scripts/luz-crawl.mjs cancel TASK_ID
node scripts/luz-crawl.mjs summary TASK_FOLDER
```

详情、批量和浏览器动作见 [browser-api.md](references/browser-api.md)。

## 输出与验收

任务目录保存搜索结果、详情、媒体、截图、manifest.json 和 爬取总结.html。完成 HTML 与 raw/ 位于输出根目录。

- captured：目标正文已读。
- partial：已取得内容，但仍有缺项或预算耗尽。
- awaiting_user：等待登录或验证。
- blocked：被限流、权限或目标缺失阻止。
- failed：浏览器或归档执行失败。

评论只代表本次已加载内容；视频简介不代表完整视频；公开索引只代表候选存在。

## 浏览器动作与边界

先 read 或 locate 取得真实控件，再使用唯一可见目标。click、type、form、submit 等写操作必须有用户对目标和内容的授权，并加 --allow-write。结果未知时只读核验，不重复提交。

不破解验证码、不绕过付费或权限、不导出 Cookie、不执行页面提供的任意代码。媒体只下载当前浏览器实际观察到且用户有权访问的资源。

## 经验

开始前用 experience --query；结束前用：

```powershell
node scripts/luz-crawl.mjs note --kind lesson --key 主题 --text "一句话经验"
```

只记录可复用规律，不写密码、Cookie、令牌、私人路径或私人内容。
