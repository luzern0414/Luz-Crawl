# 网站入口与历史验证

以下为 2026-10-24 的 29 个历史正文样本，不是当前可用性承诺，也不是网站白名单。更多入口及逐项验证状态见 [可扩展网站库](site-library.json)；执行前读 [网站调研流程](site-research.md)，结合本轮目的补充新站。每次仍须核验真实页面、搜索、详情与权限。

| 网站 | 命令 ID | 已验证范围 |
| :--- | :--- | :--- |
| [小红书](https://xiaohongshu.com/) | `xhs` | 目标正文 / 简介、账号与可访问媒体；逐站范围见下表 |
| [X](https://x.com/) | `x` | 作者、指标、视频下载；本次回复未加载 |
| [知乎](https://zhihu.com/) | `zhihu` | 回答、账号、赞同 / 收藏、已加载评论 |
| [豆瓣](https://douban.com/) | `douban` | 日记、作者、点赞、已加载评论 |
| [Reddit](https://reddit.com/) | `reddit` | 图片帖、作者、得分、评论、图片下载 |
| [抖音](https://douyin.com/) | `douyin` | 作者、简介、赞评藏、已加载评论、视频下载 |
| [哔哩哔哩](https://bilibili.com/) | `bilibili` | UP 主、简介、赞评藏、封面、视频；评论未逐条验收 |
| [TikTok](https://tiktok.com/) | `tiktok` | 账号、简介、赞评藏、封面、视频；本次评论未加载 |
| [YouTube](https://youtube.com/) | `youtube` | 作者、简介、已加载评论、封面、视频下载 |
| [微信公众号](https://mp.weixin.qq.com/) | `wechat` | 公众号公开文章正文 |
| [微博](https://weibo.com/) | `weibo` | 公开帖子正文 |
| [Instagram](https://instagram.com/) | `instagram` | 公开帖子页面文字 |
| [GitHub](https://github.com/) | `github` | 公开仓库、文章、问题与可见讨论 |
| [Gitee](https://gitee.com/) | `gitee` | 公开仓库、文章、问题与可见讨论 |
| [CSDN](https://csdn.net/) | `csdn` | 公开仓库、文章、问题与可见讨论 |
| [博客园](https://cnblogs.com/) | `cnblogs` | 公开仓库、文章、问题与可见讨论 |
| [掘金](https://juejin.cn/) | `juejin` | 公开仓库、文章、问题与可见讨论 |
| [Stack Overflow](https://stackoverflow.com/) | `stackoverflow` | 公开仓库、文章、问题与可见讨论 |
| [DEV Community](https://dev.to/) | `devto` | 公开仓库、文章、问题与可见讨论 |
| [Hacker News](https://news.ycombinator.com/) | `hackernews` | 公开仓库、文章、问题与可见讨论 |
| [V2EX](https://v2ex.com/) | `v2ex` | 公开仓库、文章、问题与可见讨论 |
| [Google](https://google.com/) | `google` | 浏览器检索与来源发现 |
| [Bing](https://bing.com/) | `bing` | 浏览器检索与来源发现 |
| [中国政府采购网](https://ccgp.gov.cn/) | `ccgp` | 公开公告正文 |
| [全国公共资源交易平台](https://www.ggzy.gov.cn/) | `ggzy` | 公开公告正文 |
| [中国国际招标网](https://www.chinabidding.com/) | `chinabidding` | 公开公告正文 |
| [千里马招标网](https://www.qianlima.com/) | `qianlima` | 公开公告正文 |
| [采招网](https://www.bidcenter.com.cn/) | `bidcenter` | 公开公告正文 |
| [中国制造网](https://made-in-china.com/) | `made-in-china` | 公开商品列表 |

`node scripts/luz-crawl.mjs search ID "关键词" --read 1`；需评论 / 媒体时加 `--comments --download`。

### 抖音单视频免登录下载（2026-10-28 实测）

匿名访问 `v.douyin.com` 短链或 `www.douyin.com/video/ID` 可直接播放并下载，无需登录。页面会弹出可关闭的登录框、右上角显示“登录”，这都不是登录门；抖音、哔哩哔哩、TikTok、YouTube 页面上只要有正在显示的 `video` 元素，插件就不判 `login_required`。

- 最快路线：直接用当前已连接的浏览器配置，一条命令完成：`capture "短链" --download --profile <已连接 context_id> --out TASK_FOLDER`。短链会自动跳到 `/video/ID`。实测约 18 秒，视频保存为 `raw/media/video-*.mp4`，同时含音轨和视频轨，无需 FFmpeg 合并。
- 不要运行 `headless-login` / `continue`，也不要换配置重试：即使旧任务停在 `login_required`，也应直接对原链接重新 capture，不必让用户登录。
- 用户只要视频文件时，任务目录放到临时目录，只把 `raw/media/video-*.mp4` 用视频标题重命名后复制到目标位置；不要把 `--out` 指向桌面这类交付位置，否则会在那里生成 raw 和 HTML。
- `doctor` 里同时连接多个浏览器配置时，必须加 `--profile`，否则前台重试会报 `Multiple Browser Bridge profiles are connected`。

其他站点须重新验证。搜索候选、后台外壳和产品介绍页不算目标正文；浏览器动作见 [README](browser-api.md)。


蒲公英使用 `pgy`（别名 `pugongying`、`蒲公英`），入口 `https://pgy.xiaohongshu.com/`。这是需要账号权限的后台，介绍页和登录页不能视为数据采集完成；保留人工续接任务。分类与关键词计划见 [分类工作流](workflows.md)。
