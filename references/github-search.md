# GitHub 与开源项目检索

## 作用

把自然语言需求拆成可搜索的关键词，组合 GitHub 原生搜索和备用入口，返回有证据的项目候选，并按需读取仓库正文。

## 搜索方法

先保留用户原话，再拆成：

- 功能：browser automation、OCR、helpdesk。
- 技术：Python、TypeScript、Playwright。
- 约束：Windows、本地部署、许可证、是否归档或 fork。
- 偏好：中文界面、近期维护、部署难度、项目成熟度。

未知领域先补充专业英文词、产品类别和相邻术语。相近词分开搜索，避免把过多词放进同一个查询。

常用 GitHub 查询：

| 目标 | 示例 |
|---|---|
| 找项目 | browser automation in:name,description,readme |
| 限组织 | browser automation org:microsoft |
| 限语言 | crawler language:Python |
| 限主题 | self-hosted helpdesk topic:self-hosted |
| 限维护 | helpdesk pushed:>2025-01-01 |
| 限许可证 | helpdesk license:mit |
| 限质量 | crawler stars:>10 |

保留用户明确写出的 org、user、repo、language、in、is、fork、archived、stars、pushed、license 和负筛选。备用入口不识别 GitHub 语法时，改用普通功能词，并把筛选条件标记为“详情待复核”。

## 路线

自动搜索按以下顺序选择有限路线：

1. GitHub 仓库搜索。
2. Bing 的 site:github.com 公开索引。
3. GitCN、HelloGitHub、Codeberg、Gitee 等开源入口。

GitHub 已明确限流或验证时停止该站；不要用其他入口规避限流。无候选时改一个功能词、生态词或约束，不能重复同一句查询。

PowerShell 示例：

    node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out TASK_FOLDER
    node scripts/luz-crawl.mjs search gitcn "browser automation" --read 0 --out TASK_FOLDER
    node scripts/luz-crawl.mjs search hellogithub "浏览器" --read 0 --out TASK_FOLDER
    node scripts/luz-crawl.mjs search codeberg "browser automation" --read 0 --out TASK_FOLDER

## 结果规则

候选必须同时具备：

- 合法的仓库 URL；
- 本次搜索的真实卡片或页面证据；
- 与功能词相关的标题、简介或 README 线索。

排除导航、推荐、趋势榜、搜索建议、搜索引擎自身链接、文件/Issue/Star 子页、裸链接和无关卡片。整张卡片本身是链接时，保留卡片文字作为证据；不能跨卡片拼接上下文。

搜索结果只是候选。打开仓库详情并确认 README、许可证、维护状态、安装方式和限制后，才计入 verified_sources。社区介绍和镜像页面不能代替原仓库。

## 失败分类

- search_not_confirmed：输入或提交后没有确认查询生效。
- no_candidates：查询已生效但没有候选。
- no_verified_candidates：有结果但没有合格仓库卡片。
- partial：搜索完成，但详情或正文不足。
- awaiting_user：需要用户登录或完成验证。
- blocked：限流、权限或安全策略阻止。
- failed：浏览器、传输或归档执行失败。

HTTP 200 只能证明连接，不代表搜索或 README 已读。单次 about:blank、超时或连接重置也不能证明 IP 被封；分别检查浏览器、API 根页、Status 和同域连通性。

## 继续核验

先用 --read 0 建候选池，再选择符合需求的仓库读取。--read N 只打开有限数量详情，失败候选会有限补位。没有足够正文就报告 partial，不用项目数量充数。
