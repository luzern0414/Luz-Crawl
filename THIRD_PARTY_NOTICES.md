# 第三方许可

原创 Skill、文档与采集代码适用根目录 [LICENSE](LICENSE) 中的 PolyForm Noncommercial 1.0.0。

浏览器扩展基于 [OpenCLI Browser Bridge 1.0.24](https://github.com/jackwener/opencli)，保留 [Apache-2.0 许可](browser-extension/LICENSE) 和 [修改说明](browser-extension/NOTICE)。

本机连接服务 `lib/bridge/`（daemon.mjs、client.mjs、stealth.mjs）改编自 [OpenCLI 1.8.8](https://github.com/jackwener/opencli) 的守护进程、浏览器客户端与反检测脚本，适用 Apache-2.0（见 [browser-extension/LICENSE](browser-extension/LICENSE)），`stealth.mjs` 原样保留上游代码。运行时不再安装或调用 OpenCLI。仓库不包含 node_modules、个人采集内容、搜索记忆、浏览器配置或登录凭据。

网页原文、图片和视频的权利归各自来源所有。
