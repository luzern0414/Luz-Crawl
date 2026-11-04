# 网站与平台

本文件说明可直接使用的站点 ID。运行前仍需用 doctor 检查浏览器连接；搜索和详情是否成功以本次结果为准。

## 常用平台

| 平台 | ID | 可用操作 |
|---|---|---|
| 小红书 | xhs | 搜索、正文、账号、公开媒体 |
| 微信公众号 | wechat | 搜索、公开文章 |
| 知乎 | zhihu | 搜索、回答、评论 |
| 抖音 | douyin | 搜索、视频页、公开视频 |
| 哔哩哔哩 | bilibili | 搜索、视频页、公开媒体 |
| TikTok | tiktok | 搜索、视频页、公开媒体 |
| YouTube | youtube | 搜索、视频页、公开媒体 |
| X | x | 搜索、公开帖子 |
| Reddit | reddit | 搜索、帖子、图片 |
| GitHub | github | 仓库、Issue、PR、公开讨论 |
| Gitee | gitee | 仓库和文章 |
| CSDN | csdn | 文章和仓库 |
| Google / Bing | google / bing | 浏览器检索和公开索引 |
| 政府采购网 | ccgp | 公告搜索和正文 |

查看完整目录：

    node scripts/luz-crawl.mjs sites

## 开源项目入口

以下入口用于补充项目候选：

| 入口 | ID | 用途 |
|---|---|---|
| GitCN | gitcn | 中文项目搜索 |
| HelloGitHub | hellogithub | 中文开源项目介绍 |
| Codeberg | codeberg | 独立代码托管搜索 |
| Gitee | gitee | 国内代码托管搜索 |

GitLab、AtomGit/GitCode、LibHunt、OpenAlternative、Awesome Open Source、SourceForge、OSCHINA、AlternativeTo、Awesome-Selfhosted 保留在网站库中，使用前按当前需求重新验证，不自动当作可用路线。

## 搜索

    node scripts/luz-crawl.mjs search ID "关键词" --read 0 --out TASK_FOLDER

需要详情时将 read 改为数量，或先筛选候选再使用 capture。搜索卡片、社区介绍和镜像只算候选，详情正文确认后才算有效项目。

## 特殊情况

抖音公开视频页有可见 video 时可以直接 capture --download，不要因为登录弹窗自动判为登录失败。需要账号权限的后台必须由用户手动登录，登录页不能算数据已采集。

小红书、抖音和 GitHub 的 robots.txt 与用户条款对自动化读取有限制，只读用户指定的少量公开页面，不批量、不转售、不商用；站点规则用 `robots URL` 查看，依据见 [compliance.md](compliance.md)。

## 小红书与抖音的记录

- 每个字段保留来源类型（page_state、json_ld、dom、visible_text、observed_media）和原始值；无法确认的时间写 `iso: null`，相对时间同时记录采集时刻和时区。
- 评论只代表本次页面实际加载的条目，按评论 ID（缺失时按作者、时间和正文）去重，并记录页面显示的总数、已加载数、覆盖率和停止原因。
- 不接入签名破解、逆向接口、代理池、验证码绕过或 Cookie 导出；登录内容只在用户明确授权并指定已连接浏览器时读取，并与公开结果分开标记。
- 详情页必须确认目标内容 ID；页面壳、登录页和搜索卡片不能升级为正文成功。

站点库见 [site-library.json](site-library.json)，检索策略见 [github-search.md](github-search.md)。
