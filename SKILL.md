---
name: luz-crawl
description: Use when you need real-browser search, page capture, public media download, HTML evidence, GitHub project discovery, or public Xiaohongshu and Douyin collection.
---

# LuzCrawl

用真实浏览器搜索、阅读、采集和保存网页证据。

## 功能

- 搜索网站、GitHub 开源项目、小红书笔记和抖音视频。
- 读取正文、标题、作者主页、发布时间、互动数、媒体和已加载评论。
- 拆解关键词，生成少量可解释的同义词、场景词和相关词；候选不足时有限补搜。
- 失败候选继续补采，按候选量和成功率调整详情与评论预算。
- 保存 HTML、原始快照、结构化字段、时间解析、字段来源、评论覆盖率和停止原因。
- 扩展显示连接、公开/授权浏览器模式、查询、候选、详情、评论进度。

## 作用

提高 GitHub、GitCN、Bing、HelloGitHub、Codeberg、Gitee、小红书和抖音的检索召回率，同时只把浏览器实际看到的内容计为结果。

- GitHub 先用仓库搜索；结果不足时有限使用 Bing `site:`、GitCN、HelloGitHub、Codeberg 或 Gitee。备用结果必须回到 GitHub 原仓库核验。
- 小红书使用 `xhs`，抖音使用 `douyin`。保留原词，拆分主题、对象、动作、场景和同义词，再做一轮相关词补搜。
- 公开页面优先。只有用户明确授权并指定已连接浏览器时才使用授权浏览器模式。
- 搜索卡片只是候选；详情正文确认后才计入有效结果。评论只代表本次已加载条目，显示总数不代表全部评论。

## 操作

```powershell
node scripts/luz-crawl.mjs doctor
$task = (node scripts/luz-crawl.mjs begin "主题" --out "D:\输出" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs experience --query "关键词"
node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
node scripts/luz-crawl.mjs search xhs "家居收纳" --read 5 --comments --out $task
node scripts/luz-crawl.mjs search douyin "露营装备" --read 5 --comments --out $task
node scripts/luz-crawl.mjs capture "https://example.com/article" --comments --out $task
node scripts/luz-crawl.mjs summary $task
```

每项需求只建立一个任务目录，输出目录放在技能目录之外。`doctor` 返回 `ready: true` 后再搜索。需要登录或验证时运行 `pending`，手动处理后运行 `continue TASK_ID`。

结果状态：`captured` 已确认正文，`partial` 有内容但仍有缺项，`awaiting_user` 等待手动登录或验证，`blocked` 被限流或权限阻止，`failed` 执行失败。

不破解验证码、不绕过权限、不导出 Cookie 或令牌、不执行页面脚本。点击、输入和提交等写操作必须有明确授权并加 `--allow-write`。

结束时记录可复用的关键词、有效路线和失败原因：

```powershell
node scripts/luz-crawl.mjs note --kind lesson --key 主题 --text "一句话经验"
```
