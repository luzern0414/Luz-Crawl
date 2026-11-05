---
name: luz-crawl
description: Use when you need real-browser search, page capture, public media download, HTML evidence, GitHub project discovery, or public Xiaohongshu and Douyin collection.
---

# LuzCrawl

用真实浏览器搜索、阅读、采集和保存网页证据。

## 调用协议（每次业务任务必做）

先 doctor；主会话每项需求 begin --new 一次；experience --query；实际 search/capture 并确认详情正文；summary 生成 HTML。已有同一需求的任务时复用，所有采集命令携带 --out；多任务互不共用任务目录。**同一网址再次采集不会覆盖旧归档**：每次都另存为新序号的归档（manifest 和 identity 里写 `recapture_of`，指向它接着的那一份），旧归档的哈希保持原样，已经登记它的阶段、报告和结论仍能核验；只有明确加 `--resume` 才续接该网址最新的一份。

为其他技能提供前置检索时，使用 [references/preflight.md](references/preflight.md) 的 `scripts/crawl_preflight.py run → 阅读正文 → conclude → check`，分别记录 caller/stage、来源快照、补充信息、采用位置和未覆盖范围；同一需求传同一个 `--task`，项目阶段传 `--stage`。Crawl 自己的结论同样可用 `--caller luz-crawl` 留证，不递归启动另一个技能。只有连接就绪或搜索卡片不算完成，失败/空结果保留 blocked。此协议不把内部检查命令当作新的业务需求。

## 功能

- 搜索网站、GitHub 开源项目、小红书笔记和抖音视频。
- 读取正文、标题、作者主页、发布时间、互动数、媒体和已加载评论。
- 拆解关键词，生成少量可解释的同义词、场景词和相关词；候选不足时有限补搜。
- 失败候选继续补采，按候选量和成功率调整详情与评论预算。
- 保存 HTML、原始快照、截图、结构化字段、时间解析、字段来源、评论覆盖率和停止原因。
- 前置检索结论页和爬取总结页使用同一份正式文档版式：`lang="zh-CN"`、标题在先、每节一张带表题的表（没有内容的节不写）、单一字体族、不禁用缩放、无装饰；字号按 Markdown 层级（桌面正文 18、手机 16）。
- 扩展显示连接、公开/授权浏览器模式、查询、候选、详情、评论进度。

## 作用

提高 GitHub、GitCN、Bing、HelloGitHub、Codeberg、Gitee、小红书和抖音的检索召回率，同时只把浏览器实际看到的内容计为结果。

- GitHub 先用仓库搜索；结果不足时有限使用 Bing `site:`、GitCN、HelloGitHub、Codeberg 或 Gitee。备用结果必须回到 GitHub 原仓库核验。批量或持续检索改用官方 API。
- 小红书使用 `xhs`，抖音使用 `douyin`。保留原词，拆分主题、对象、动作、场景和同义词，再做一轮相关词补搜。
- 公开页面优先。只有用户明确授权并指定已连接浏览器时才使用授权浏览器模式。
- 搜索卡片只是候选；详情正文确认后才计入有效结果。评论只代表本次已加载条目，显示总数不代表全部评论。搜索引擎的回答卡和厂商帮助页不是来源。
- 来源按级别使用，结论只靠官方原文和一手来源；引用字段和调研结论的结构见 [references/research-method.md](references/research-method.md)。

## 操作

```powershell
node scripts/luz-crawl.mjs doctor
$task = (node scripts/luz-crawl.mjs begin "主题" --out "D:\Codes\skill输出\Luz-Crawl" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs experience --query "关键词"
node scripts/luz-crawl.mjs robots "https://example.com/path"
node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
node scripts/luz-crawl.mjs search xhs "家居收纳" --read 5 --comments --out $task
node scripts/luz-crawl.mjs search douyin "露营装备" --read 5 --comments --out $task
node scripts/luz-crawl.mjs capture "https://example.com/article" --comments --out $task
node scripts/luz-crawl.mjs summary $task
```

每项需求只建立一个任务目录（`<输出根>\NNN-主题`），输出根放在技能目录之外。`doctor` 返回 `ready: true`（已连接可见 Edge）或 `silent_ready: true`（可以启动静默 Edge）后再搜索，两者都不是时先按 [references/install.md](references/install.md) 处理。需要登录或验证时运行 `pending`，手动处理后运行 `continue TASK_ID`。

结果状态：`captured` 已确认正文，`partial` 有内容但仍有缺项，`awaiting_user` 等待手动登录或验证，`blocked` 被限流或权限阻止，`failed` 执行失败。

## 目录

输出根默认 `D:\Codes\skill输出\Luz-Crawl`（`--out` 或环境变量 `LUZ_CRAWL_OUTPUT` 可改），下面只有“序号-主题”文件夹；每个文件夹是一个任务，根目录只有 `raw\` 和同名总结页：`raw\` 存放爬取的全部内容和机器记录，总结页 `NNN-主题.html` 与 `raw\` 同级。

```text
<输出根>\
  085-主题\                    begin 返回的 folder，之后每条命令 --out 它
    raw\                       爬取的全部内容与机器记录
      luz-task.json  preflight.json  search-*.json  batch-*.json  tasks\
      00-crawl\                前置检索记录与结论页（crawl_preflight.py 写入）
      0001_页面标题\           每个页面一份存档，文件直接放在这一层
        content.json  manifest.json  identity.json  page.png  snapshots\  media\  0001_页面标题.html
    085-主题.html              总结页（begin 建立，summary 重写），与 raw\ 同级
```

任务序号是三位数字，取输出根下所有一级文件夹的最大序号加一，不补洞、不复用；旧的 `NNN_主题`（下划线）文件夹也计入。页面序号在同一输出根内递增；输出根里不放散落文件。旧任务不改名：`NNN_主题` 目录和标记在 `raw\` 旁边的旧任务，给 `--out` 仍可读取和续接，`summary` 照常生成。输出根里还有旧版散落文件时 `begin` 会报错：先运行 `py -X utf8 scripts/migrate_layout.py --root <输出根>` 看迁移计划，确认后加 `--apply`（`--revert` 撤回）。

## 边界

不破解验证码、不绕过权限、不导出 Cookie 或令牌、不执行页面脚本。点击、输入和提交等写操作必须有明确授权并加 `--allow-write`。

采集前按 [references/compliance.md](references/compliance.md) 核对：批量或重复读取同一站点前运行 `robots`；小红书、抖音和 GitHub 的条款与 robots 对自动化读取有限制，只做用户指定的少量公开页面；个人信息只保留回答问题所需的字段；下载的媒体只作调研依据。

## 经验

结束时记录可复用的关键词、有效路线和失败原因；调研所依据的来源和结论用 `fact` 记录：

```powershell
node scripts/luz-crawl.mjs note --kind lesson --key 主题 --text "一句话经验"
node scripts/luz-crawl.mjs note --kind fact --key 来源名 --text "来源网址与它给出的结论"
```

## 项目模式

提供 `luz-project` 上下文时，每个阶段仍按 doctor、共享任务、experience、capture/search 的顺序执行，但复用同一个项目 Crawl 任务（`project.json` 的 `crawl.task_root`，任务就在上面的输出根下），不为每个技能另建任务。项目不保存爬取的原始内容；前置检索记录和结论页写在状态根（含 `project.json` 的目录，即 `D:\Codes\skill输出\Luz-Project\<项目目录名>\raw`）的 `00-crawl\`，来源编号与覆盖范围登记到项目数据，每个阶段提供可复核的 HTML 结论。没有项目上下文时保持独立的输出目录和任务生命周期。
