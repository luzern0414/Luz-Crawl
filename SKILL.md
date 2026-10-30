---
name: luz-crawl
description: Search and capture real browser pages with the bundled LuzCrawl extension. Save HTML, source accounts, observed media, interaction counts and loaded comments; download accessible media and reuse local search memory. Reads silently in a headless browser first, retries once in a minimized visible browser, and only then asks the user to log in and resumes; safe for concurrent sessions. Use for social content, technical sites, procurement and analytics dashboards. Start every call with doctor, begin and experience --query — they return the task folder, the user's preferences, lessons and route hints; follow SKILL.md 调用协议.
---

# LuzCrawl

本 Skill（scripts/ 命令入口、lib/ 采集代码、lib/bridge/ 本机连接服务）→ browser-extension/ → 真实 Edge 页面 → 任务目录里的 HTML 与 raw 证据；站点目录、访问策略与路线提示在 data/，本机经验在 data/memory/。除 Node.js 24.5+ 和 Microsoft Edge 外不依赖任何外部插件或工具（不需要 OpenCLI、Playwright、FFmpeg）。保留完整目录；采集必须经过真实浏览器，不用 HTTP 摘要代替浏览器阅读。

## 调用协议（每次调用都按顺序做，不可跳过）

命令行和模板只是工具；怎么检索、读不到怎么办、哪些结果算数，由本文件的规则、用户偏好和以往经验决定。只看命令示例就开搜，最容易漏掉登录兜底、任务目录和经验沉淀。

1. **路由**：只做网页检索、采集和下载。结果写成文章交给 Luz-Writing；报告、表格与文档排版交给 Luz-Design；系统方案、界面、原型与硬件交给 Luz-System；后端技术方案的调研由 Luz-Dev 的 `tech_plan.py research` 按本协议调用本技能。
2. **自检**：`node scripts/luz-crawl.mjs doctor`，`ready` 为 true 再继续。
3. **一个需求一个任务目录**：主线程运行一次 `begin "主题" --out <输出根> --new`，保存返回的绝对 `folder`；之后每条命令都带 `--out <folder>`。输出根必须在技能目录之外，由用户偏好或调用方指定；需要按成果分类时用 `<输出根>/<分类>`（见[分类工作流](references/workflows.md)）。子 Agent 用发起方给的 folder，不运行 begin。
4. **先读经验（本技能的规则卡）**：`node scripts/luz-crawl.mjs experience --query "关键词" [--platform ID]`。读完返回的四部分再动手：`notes`（用户偏好与教训，必须遵守）、`route_hints`（已验证的路线与坑；带 `--platform` 时只返回该平台与通用 web 提示）、`events`（近期同类采集结果）、`keywords`（好用的关键词）。多站调研还要先读[网站调研流程](references/site-research.md)，并按下文“搜索与采集”的方法从[网站库](references/site-library.json)选站。
5. **按本文件的规则执行**：读取顺序（先静默、再可见、最后请用户登录）、网址纠错、限流即停、批量与二次补采，见下文各节；不用 HTTP 摘要冒充浏览器阅读。
6. **如实验收**：逐条报告 captured / partial / awaiting_user / blocked / failed，确认 `爬取总结.html` 已更新；需要登录时告诉用户具体网站和操作，用 `continue` 续接，不直接报失败。
7. **沉淀（必做）**：采集结果、站点库实测结论和本主题的爬取范围会自动记下；用户新说的偏好、规则纠正、实测有效或失败的路线和关键词，结束前用 `note --kind preference|lesson|fact --key 主题 --text "一句话"` 记下；对所有人有用的经验加 `--public --when "适用场景"`（见“每次调用后沉淀”）。

## 开始

相对路径从本 SKILL.md 解析，命令从本目录运行；产出只通过 `--out` 写到技能目录之外：

```powershell
node scripts/luz-crawl.mjs doctor
$f = (node scripts/luz-crawl.mjs begin "本次需求主题" --out "<OUTPUT_ROOT>" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs experience --query "关键词" --platform xhs
node scripts/luz-crawl.mjs search xhs "关键词" --read 0 --out $f
node scripts/luz-crawl.mjs capture "https://example.com/article" --out $f
node scripts/luz-crawl.mjs collect "主题或 URL" --read 1 --out $f
```

命令的标准输出是一份 UTF-8 JSON（提示与进度走 stderr），同样的结果也存在任务目录里（批量为 `batch-*.json`，单页为各自的 `content.json`）。程序解析优先读这些文件；要接管道时，Windows 上用 `py -X utf8`、PowerShell 的 `ConvertFrom-Json` 或 Node。不加 `-X utf8` 的 Python 按 GBK 读管道，中文会吞掉引号，报 JSON 解析错误，这不是采集失败。

`doctor.ready` 证明连接；`extension_install.bundled_loaded` 核对本目录 LuzCrawl 扩展。登录和正文需要实际页面验收，断连按[安装文档](references/install.md)排查具体缺项。全部命令见 `node scripts/luz-crawl.mjs --help`；本文未展开的有：`sites [--category procurement]` 列出运行目录里的平台 ID，`install` 检查运行环境并说明如何加载扩展，`--scrolls N` 调整单页滚动预算（默认 20，0–500），`remember --browser edge --profile ID [--no-reuse-profile]` 保存或停用补读用的可见浏览器配置。

## 任务目录与多会话

一项用户需求只用一个任务目录。主线程开始新需求时运行一次 `begin "任务主题" --out <输出根> --new`，保存返回的绝对 `folder`，后续搜索、采集、批量、collect、下载、报告、校验和续接都显式传 `--out <folder>`；不按关键词、平台、阶段或执行者另建目录。拆给子 Agent 时，由发起方把同一个 `folder` 写进每个任务说明，子 Agent 不运行 `begin`；没收到路径就向发起方索取，不自行建目录。

目录按会话绑定（`CODEX_THREAD_ID` 或 `CLAUDE_CODE_SESSION_ID`），不同会话之间不会共用；同一会话再次 `begin` 不带 `--new` 时复用本会话的目录；拿不到会话号时复用同一 raw 根下最近的活动任务。`begin` 不带 `--out` 时用已保存的输出偏好，没有偏好才回退到当前目录的 `outputs/luz-crawl`（已被 .gitignore 排除，不作为交付位置）。

```text
<输出根>/
  NNN_原标题.html            成品（单页、合集），与 raw 同级
  raw/
    NNN_任务主题/            begin 建的任务目录，一项需求一个
      luz-task.json  search-*.json  batch-*.json
      raw/NNN_来源或合集/    来源证据、快照、媒体、哈希、collection.json
      raw/爬取总结.html      自动更新的采集记录
```

collect 的合集证据在 `<任务>/raw/NNN_合集名/`，合集 HTML 写在输出根；其他技能导入合集时用 collect 返回的路径，不按序号猜。

```powershell
$taskFolder = (node scripts/luz-crawl.mjs begin "小红书与微信检索" --out "<OUTPUT_ROOT>" --new | ConvertFrom-Json).folder
node scripts/luz-crawl.mjs search xhs "关键词一" --out $taskFolder
node scripts/luz-crawl.mjs search wechat "关键词二" --out $taskFolder
```

多个会话可以同时调用：每个静默会话占用独立的浏览器配置槽（最多 4 个，`browser-profile-edge`、`-2`…`-4`），槽满时排队最多 90 秒，仍满就改用可见浏览器；目录分配、限流状态和续接任务都有文件锁。同一任务目录里重复 capture 同一网址会先校验旧存档再自动续接，不报“已存在”；存档被改动或不完整时拒绝续接。collect 合集里的来源存在合集目录内，不参与这条续接，单独 capture 时会另建存档。raw 根目录里出现散落文件时，会移进新的 `NNN_散落文件归档` 后继续，不删除任何文件。

## 读取顺序：先静默、再可见、最后请你登录

1. **静默读取**：默认用独立的无头 Edge 配置（`data/memory/browser-profile-edge/`，不含你日常浏览器的登录），不弹窗口。已保存的 browser_profile 只作为第 2 步的可见浏览器，不再抢先使用；只有显式 `--profile ID` 才直接用可见浏览器。
2. **可见浏览器补读一次**：静默结果没有确认正文（登录墙、验证、空白、partial）或静默浏览器启动失败时，自动在已连接的 Edge 里重试一次，沿用你在该浏览器里的登录；任务窗口以最小化方式打开，不弹到前面、不抢焦点。没有已连接的浏览器就自动打开 Edge 再试（`LUZ_NO_BROWSER_LAUNCH=1` 可禁止）；这时 Edge 自身的启动窗口会正常显示，任务页仍在最小化窗口里。补读结果比静默差时保留静默结果。
3. **请你登录**：可见浏览器仍读不到正文、需要你登录或完成验证时，才把这个窗口恢复并调到前台，结果为 `awaiting_user` 并给出 `continue TASK_ID`。告诉用户具体网站和要做的操作，完成后续接核验正文；不报失败、不重复换入口。静默配置里的任务用 `headless-login TASK_ID` 打开同一配置登录。

**网址与打不开的站**：输入网址先自动纠错（首尾空格与引号、中文标点、全角字符、`htps` 等协议拼写、缺少协议），纠正内容写进日志。浏览器停在 `chrome-error://` 错误页或空白页时，依次试 https/http 与加减 www 的变体并逐次加长等待；都不行就报“网站在当前网络下打不开”并列出已试地址和可能原因（拼写、网络限制或需要代理、证书或安全拦截），不当作登录问题。

不进入这条补读链的情况：来源页明确显示冷却或限流（保存原址与提示文字、展示给用户后停止该站）、只有 HTTP 限流信号（立即停下并如实说明）、操作预算耗尽、用户取消。浏览器路径、类型、资料 ID 分开记录，不能凭 exe 路径认定已登录；匿名正文与登录后检索分别验收，不能用 HTTP 200 或搜索外壳代替正文。正常成功不新增可见窗口，任务结束只关闭本任务的标签页。

静默浏览器由技能直接启动 msedge.exe（无头模式，加载本目录扩展，桌面版 User-Agent），不经过 Playwright。静默配置与日常浏览器之间不迁移 Cookie、不打包，登录、续接与采集须使用同一浏览器。具体命令见[静默浏览器安装说明](references/install.md#静默浏览器)。

## 搜索与采集

每次搜索都打开真实浏览器执行新的检索。历史经验只影响路线顺序、关键词建议，不能替代本次访问。优先用户原词，结合已保存偏好和专业词扩展查询，不悄悄改换主题。支持任意合法 HTTP(S) 网站，不把平台目录当作白名单：适配站优先站内搜索；未知域名可直接 `capture URL`、`search example.com "关键词"` 或使用 browser 定位真实站内表单，无需事先登记。只有需要复用时才用 `remember --site` 保存已验证站内模板。候选、页面外壳与已核实详情分开记录。

**搜索引擎与公开索引**：`search web "关键词" --site example.com` 是搜索引擎的域名限定查询，不是原站搜索；用户要求原站时不使用该命令替代。已登记的社交与技术平台（`sites` 里 `public_index` 为 true）在站内搜索拿不到候选或受阻时，会按顺序再试已登记的公开备用入口和 Bing `site:` 公开索引；这些结果只算候选，必须打开原文确认。未登记站点只在用户允许时才用搜索引擎发现入口。

**批量**：多站并发和大量检索用 `batch --file jobs.json --out TASK_FOLDER`：可混合网址、`{id,url,steps}` 与搜索任务 `{id,platform,query,read}`，每批 1–500 项；已登记平台按 ID 排队，其余按完整 hostname 排队，默认 4 条、最多 6 条队列同时执行（`--concurrency 1–6`）。批量结束后，命令行入口对没拿到正文的网址和没有候选的搜索逐条补采一次（必要时转可见浏览器），结果标在 `second_pass`。动作含输入/点击时加 `--allow-write`。登录、验证与限流只停对应站点，任务停放后由 `continue` 接续；不另开多个批次扩大同站并发。详见[批量接口](references/browser-api.md#多站并发)。

**collect**：主题先按分类工作流规划平台和关键词，以 `search --read 0` 建候选池；Agent 检查标题和已取得正文是否回答用户问题，剔除广告、培训招生等不符合本次需求的结果后再逐条采集。已明确站点与查询时可用 `collect --file plan.json`（每份计划 1–60 条）；`--platform all` 按已验证可用路线逐站执行，不能保证每站或首条结果都相关。输入里的链接直接逐条读取原页面。collect 默认下载可访问媒体与已加载评论，输出一份包含已取得文字、图片、视频和评论的 HTML。合集遇到第一个需要登录的任务就停下，后面的任务不再执行；用户登录后 `continue`，再用 `report COLLECTION_DIRECTORY` 刷新合集并另行补跑剩余任务；不把未取得的内容标为完整。

**多站调研**：必须先思考、建网站池再逐站实测，执行[网站调研流程](references/site-research.md)。网站库（数百个入口）按 `kind` 分类（如 government、tender_aggregator、company_registry、commerce_analytics、design_inspiration、design_system）、按 `verification` 记录各项实测状态，选站时按需过滤，不整份读入：

```powershell
$lib = Get-Content references/site-library.json -Raw -Encoding utf8 | ConvertFrom-Json
$lib.sites | Where-Object kind -eq 'design_inspiration' | Select-Object id, name, url, @{n='search';e={$_.verification.search}}
$lib.sites | Group-Object kind | Select-Object Name, Count
```

网站库不是白名单；主动发现、补充本轮的新站。任务内 `platform-plan.json` 保存候选与验证进度。招投标、企业、电商统计、创作者后台、设计与素材均优先原站搜索与详情；低信息页面先检查加载、真实控件、分类和分页，不转搜索引擎冒充站内结果。未经验证的候选不进入运行 catalog；page / search / detail / statistics / media 分别验收，并将有证据的路线和失败经验回写网站库。

[平台目录](references/platforms.md)列出适配器与历史验证边界，不限制可访问域名；搜索候选不能证明详情正文可读，判定规则见[验证结果](references/validation.md)。抖音单视频免登录下载的做法见平台目录同名小节。

```powershell
node scripts/luz-crawl.mjs search github "browser automation" --read 1 --out $f
node scripts/luz-crawl.mjs search ccgp "计算机" --read 1 --out $f
node scripts/luz-crawl.mjs search web "关键词" --site "example.com" --read 1 --out $f
node scripts/luz-crawl.mjs capture "https://example.com/article" --comments --download --out $f
node scripts/luz-crawl.mjs batch --file "链接清单.md" --out $f
```

搜索结果只算候选；打开原始详情并确认目标正文后才算来源阅读。小红书优先点击真实搜索卡片，保留页面生成的入口；1688 中文检索用浏览器 GBK 表单。GitHub 仓库检索排除 stars/forks/导航，文件、Issue、PR 直接按 URL capture。

## URL 与人工接续

拒绝、空白、无效链接或 404 时核对原地址、落地地址、域名、内容 ID 和错误提示，优先从真实站内入口重进，再尝试已登记的同一内容公开入口。记录错误 URL、修正与实际结果，只有当前浏览器读到目标才记为成功经验。网址可能过期，每次仍复核。

先尝试可关闭的登录提示、公开原文、已登记的旧版公开入口与公开索引。索引只能证明候选存在，不能替代受限原文或后台数据。需要登录、验证码或安全验证时让用户手动完成；不破解验证、不复制凭据、不越过付费与权限控制。判为 login_required 时插件会先点击页面自带的关闭 / 稍后 / 图标关闭按钮或按 Esc，最多两次，再重读正文；结果记录在 `login_bypass`（bypassed / still_gated / no_dismiss_control），只有仍读不到正文才转人工。不移除页面元素、不越过整页登录墙。请用户登录前还要排除误判：截图里正文或视频已显示、公开文档页、网址只在中间含 login / error、直接采集的图片网址，按[判定规则](references/validation.md)直接重采或读截图，不发起人工登录。

正常完成立即关闭本任务工具页，不能关闭用户原有标签。awaiting_user 保存任务 ID，最多保留一个页面让用户操作，其他任务保存为 parked 并关闭。测试结束也停放人工任务，不能擅自取消。向用户说明具体网站与操作；等待期间可以继续处理不依赖该站的工作。

```powershell
node scripts/luz-crawl.mjs pending
node scripts/luz-crawl.mjs continue TASK_ID
node scripts/luz-crawl.mjs cancel TASK_ID
```

续接使用已保存的浏览器资料和任务；停放任务会重开，其他人工页先保存关闭。成功后核验工具页关闭。显式 --profile 优先于保存的 browser_profile；限流、故障和 URL 错误不误称未登录。

## 每次调用后沉淀

五个 Luz 技能用同一套经验格式（偏好、教训、事实，按主题键替换）。开始前运行 `experience --query "关键词" [--platform ID]`，返回本机的偏好与经验、可复用的路线提示、近期同类采集结果和好用的关键词，照此安排路线（仍要重新访问真实页面）。结束前记下本次学到的东西：

| 层 | 位置 | 内容与写法 |
|---|---|---|
| 采集结果（自动） | `data/memory/events/`（本机） | 同一平台、网址和关键词只留一条，新结果替换旧结果，旧状态记在 `previous_outcome`；超过 900 条自动合并到最新 800 条，`experience --compact` 可手动整理 |
| 偏好与经验 | `data/memory/notes.json`（本机） | `note --kind preference\|lesson\|fact --key 主题 --text "一句话" [--why 原因] [--platform ID]`；同一主题再记就替换原文、只留上一版；偏好 60、经验 120、事实 120 条上限，超出先删用得少、最久未确认的；`list`、`prune`、`check` 查看和整理 |
| 公开路线提示 | `data/experience/seeds.json`（随仓库发布） | 对所有用户都有用的经验加 `--public --when "适用场景"`，按主题键写入、同主题替换、最多 60 条；`--when` 写适用场景，不写任务经过；偏好不能公开 |
| 站点库 | `references/site-library.json`（随仓库发布） | 采集、搜索、批量结束后自动更新已收录站点的实测结论（打开、搜索、详情）与观测时间；不自动收录新站点，新站按网站调研流程手动补充 |
| 爬取范围（自动） | `data/memory/notes.json` 里的 `scope:<任务主题>`（本机） | 每次采集、搜索、批量结束后按任务主题合并：有效来源及取到的条数、有结果的检索、无效站点与原因；同一主题只留一条，新结果合并进去。下次同类主题用 `experience --query` 先看它再定范围 |

`notes.json` 的格式与其他技能一致：`{"schema_version":"1.0","caps":{...},"notes":[{key, kind, text, why, uses, first_seen, last_confirmed, previous}]}`。只记一般规律，不记一次性任务细节；写入时拒绝手机号、邮箱、微信号、个人路径和带值的密码、令牌，客户名称自行避免。旧命令 `remember --note` 仍可用。

## 保存、下载与记忆

每次采集、搜索、浏览器动作、批量或合集结束后，自动更新本任务 `TASK_FOLDER/raw/爬取总结.html`；最后检查文件已生成，失败时保留原始结果并运行 `node scripts/luz-crawl.mjs summary TASK_FOLDER` 重建，无需重新访问网站。总结按网站分组，每页用一句话说明本次实际取得的内容，区分可见正文、搜索候选、仅观察到的媒体、失败与登录/验证状态；网站名与页面标题均为可点击超链接，不展示裸网址。该总结属于 raw 中允许保留的采集记录 HTML，成品仍放在 raw 同级；不生成 `参考链接.md`，也不自动删除其他任务的历史文件。

输出根与任务目录见上文“任务目录与多会话”；分类、关键词扩展、逐条原文核验与各类交付验收见[分类工作流](references/workflows.md)。用户可在扩展弹窗保存绝对目录，或用 `remember --out` 指定；本次 `--out` 优先，单次 `--out` 不改变默认。成品 HTML 不复制进来源证据目录；`manifest.delivery` 保存文件名、大小和 SHA-256。目录偏好未同步时重载 LuzCrawl 扩展。用户要求精简已整理 raw 时，核验来源 URL 和交付 HTML 哈希后再生成、审查清理计划；可移除可复采的页面快照，移除文件前保留来源、交付和候选文件的哈希记录。不得把唯一设计图片当作重复快照删除。

post 保存当前目标账号、正文、图片/视频与互动；comments 保存本次加载的条目。隐藏数据为 null，缩写数保留 raw 与 approximate。不要把视频简介称为完整视频、把可见评论称为全量评论。图片、字体和视频由 LuzCrawl 扩展在浏览器内取回（单图 25 MiB、单视频 250 MiB 以内）：扩展后台用浏览器自己的网络读取，分块传回本地写盘，不经过浏览器下载管理器，因此不弹下载面板、不留下载记录。这条请求不带页面的 SameSite 登录 Cookie，所以遇到 401/403 或取回的是网页时，改用浏览器下载再取一次；这期间临时隐藏下载面板，完成后删除下载记录。下载完成后关闭来源页；不重放平台 API、不用 HTTP 或外部视频下载器替代浏览器。已经下载的音视频分轨（哔哩哔哩、YouTube 等 DASH）由内置的 MP4 合并模块合成一个文件，只拷贝轨道、不转码；WebM 等非 MP4 分轨保留原文件并在结果中说明。失败另报，不导出 Cookie。字段、接口和目录见[使用说明](references/install.md#使用与下载)与[证据规范](references/evidence.md)。

```powershell
node scripts/luz-crawl.mjs download DIRECTORY
node scripts/luz-crawl.mjs verify DIRECTORY
node scripts/luz-crawl.mjs remember --out "<OUTPUT_ROOT>" --format html
node scripts/luz-crawl.mjs remember --profile "浏览器配置 ID"
node scripts/luz-crawl.mjs remember --platform "xhs,wechat" --keywords "采购,家具"
node scripts/luz-crawl.mjs remember --site "https://example.com" --name example --template "https://example.com/search?q={query}"
```

DIRECTORY 用采集返回的 folder。只有用户明确“记住”才更新长期偏好。新域名可直接搜索；重复使用才登记已验证站内模板，模板必须属于登记域名。记忆保存在 data/memory/，不写其他 Agent 的全局记忆，不保存密码、Cookie 或浏览器资料。仓库不包含 data/memory/：个人事件、待办、偏好、浏览器配置与归档都只在本机。

浏览器未连接、登录等待等状态也在任务目录内留存结果。分配锁与目录登记保存在 raw 根之外，raw 根始终只含文件夹。

## 浏览器接口与验收

[浏览器接口与策略](references/browser-api.md) 使用 JSON 的 read / locate / scroll / type / form / click / submit / wait_for / wait / extract / screenshot，最多 20 步；schema 输出机器可读定义。先 read / locate 取得真实控件，再使用唯一可见 selector 或 role/name。写操作要有用户对目标和内容的授权并显式 --allow-write，用 expect 核验结果；outcome_unknown 只读核验，不重新派发。真实点赞、发送尚无已验收的平台适配器。任意 JavaScript、Cookie 和 shell 不属于该接口。

浏览器、正文资源与下载按站点自适应节流（页面打开与资源分开计数，无失败时额度增长，限流时减半，见[浏览器接口](references/browser-api.md#平台节流)）；读取只对短暂故障作有界退避，写动作一次派发，wait_for 自适应轮询。policy 可查看或保存每站等待与预算。429 / 频繁访问立即保存冷却并停止后续访问，不能换入口规避；登录和安全验证保存人工任务。冷却状态位于 data/memory/execution/，不进入仓库。节流降低访问频率，不能保证账号不受限制。

X 长文与状态 ID 对齐、没有展开/加载控件、配图解析完、连续两次正文与资源一致时可走 article_dom_complete，不必滚到回复区；请求评论时继续加载。只从浏览器实际收到的目标响应补齐媒体，不重放私人 API。回复输入框不是长文。

其他页面默认最多 20 次滚动（`--scrolls` 调整）；普通页面连续两次无变化即稳定，搜索、评论和列表页要三次；内容不再变化但还没到底时直接跳到页尾。预算耗尽为 partial。虚拟列表按 ID 合并；音视频只采页面提供的简介、字幕和可见评论，未提供字幕不自行宣称转录完整。原始快照不能改写。

报告实际 captured / partial / awaiting_user / blocked / failed，分别说明搜索、目标正文、账号/互动字段、评论、下载、文件完整性与关闭状态。verify 只证明 SHA-256；平台介绍页不是后台数据。测试、构建、打包通过不能替代真实平台验收。
