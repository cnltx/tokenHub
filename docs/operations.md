# 运维与 API

## 启动

Windows：桌面 tokenHub 或 start.vbs，无 cmd 窗口。桌面 tokenHub Docker 或 start-docker.vbs 调用 Compose。脚本 install-shortcuts.ps1 可重建快捷方式；启动失败查看 data/desktop-error.log。

CLI：`node src/cli.js start --open`、`status`、`ui`、`stop`。端口优先级为 --port → TOKENHUB_PORT → settings.port；数据目录为 --data → TOKENHUB_DATA_DIR → 项目 data。默认端口 3000，Docker 容器标记 mode=docker，停止使用 docker compose stop。

后台免登录，打开地址即可使用，不保存账号、密码或管理密钥。旧版遗留的管理密钥文件在启动时自动删除。GET /api/session 无需 Cookie 即返回临时 CSRF 校验值；页面自动处理写请求校验，Host/Origin 同源限制保留。模型 API 仍使用客户端令牌。

## API

所有 /v1 使用客户端 Bearer 令牌。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /v1/models | 权限内的模型列表 |
| POST | /v1/chat/completions | 原模型 Chat JSON / SSE；配置启用时附加转发 |
| POST | /v1/responses | 原模型 Responses JSON / SSE；配置启用时附加转发 |
| GET | /api/session | 自动取得 CSRF 校验值（免登录） |
| GET | /api/status | 脱敏配置、统计、转发状态、存储错误 |
| GET | /api/config | 脱敏自身配置 |
| PUT | /api/settings | 局部更新设置，端口更改需重启 |
| PUT | /api/forwarding | 更新 enabled/source_models/target_model/max_output_tokens/max_concurrency |
| POST | /api/export | include_api_keys=true 导出含 Key 配置，默认脱敏 |
| POST/PUT/DELETE | /api/channels[/ID] | 渠道管理 |
| POST | /api/channels/ID/discover | 从上游显式拉模型 |
| POST | /api/channels/ID/keys/KEY_ID/test | 连通性测试 |
| POST | /api/channels/ID/keys/KEY_ID/reveal | 完整 Key 查看 |
| POST | /api/channels/ID/keys/KEY_ID/recover | 清除主调用及后台的该 Key 异常/冷却 |
| POST/PUT/DELETE | /api/tokens[/ID] | 客户端令牌管理 |
| POST | /api/tokens/ID/reveal | 客户端令牌查看 |
| POST | /api/debug/run | 单模型文本测试，返回 delta/reasoning/complete SSE |
| GET | /api/stats | 用量与近期请求 |
| GET | /api/stats.csv?dimension=model | 按 model/channel/key/token/date 导出统计 |
| POST | /api/batch/start | 有限批量测试 |
| POST | /api/batch/stop | 停止批量测试 |
| POST | /api/shutdown | 正常停止所属服务 |

普通列表不返回明文凭据；只有专用查看与明确选择的含 Key 导出返回完整值。请求体上限 4 MB；日志不记正文。导出下载文件默认 tokenhub-*.json，Git 已忽略。

## 行为与排障

- 主请求返回原模型结果；转发错误只出现在后台状态/日志，不能替换主响应。未启用时不附加调用。
- 源与目标都受令牌权限约束。先确认模型名、渠道状态、分组和白名单，再查看后台 skipped 原因。
- max_attempts 为每个 Key 的最大尝试次数（包含首次，默认 10，可配置 1–20），不是所有 Key 共用的总次数。所有上游非 2xx 状态码（含 3xx、400、401、403、404、408、429、5xx）和连接错误均先重试同一个 Key，耗尽后暂时冷却，再换下一个可用 Key；401 冷却结束也会自动恢复候选资格。本地令牌、权限与参数校验错误直接返回，不发送上游请求。
- 默认整体期限 120 秒、空闲 30 秒、冷却 10 秒；主并发默认 16、后台默认 2。转发的输出上限默认 2048。
- 产生成功响应后不重放中断请求。取消贯穿上游；后台自身受整体期限约束。
- usage 缺失为未知，缓存包含在输入中；forward 来源可在日志过滤器单独查看。
- 日志默认每份 5 MB，当前+三份轮转，7 天清理。统计每秒快照，正常停止落盘。
- Docker 无法写 data 时核对卷权限；无法连接时先看 docker compose ps / logs 和宿主端口，不能把容器内监听回环误当宿主发布。
- 私有配置恢复使用自己保存的 data 目录备份；界面只提供配置导出，不读取其它项目目录。

## DSH 接入

DSH 的 llm-pi-ai.providers.tokenhub 使用 baseURL=http://127.0.0.1:3000/v1、api=openai-responses，apiKeyEnv 指向其凭据存储中的 TOKENHUB_API_KEY。这里使用 tokenHub 客户端令牌，不是上游 API Key。保留现有默认 tokenhub/deepseek-flash 与其它模型配置。

2026-10-21 排查的 `format v4 message requires a producer-owned source kind` 来自 DSH Hindsight 0.5.3 的记忆注入：它使用已废弃的 source.kind=plugin。已将用户本机插件 dist/dsh.js 的 injectionMessage 改为 plugin:hindsight，保留 plugin/form 元数据；原文件备份为同目录 dsh.js.tokenhub-backup-20261021。DSH 版本为 0.2.1-rc.2。需要重启 DSH 加载模块，用户已确认完成。没有放松 v4 校验，也没有修改历史会话或网关协议。插件更新可能覆盖此处本地补丁，复发时核对新版 producer 格式。

本次已用安装包内真实 Responses 适配器通过 tokenHub 获取 OK，并用真实 createDshHooks.preStep 和 DSH 原生 v4 校验器验证修复。相同类别的来源格式问题见 [DSH 上游讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/8500)。tokenHub 运行本身不依赖 DSH 或该补丁。

## VS Code Copilot 接入

VS Code 1.142 自带 Copilot Chat，通过 BYOK 自定义端点（`chatLanguageModels.json`，provider 名 `tokenHub`、vendor `customendpoint`、apiType `chat-completions`）接入：每个模型的 url 为 `http://127.0.0.1:3000/v1`，apiKey 填设置页的客户端令牌（不是上游 Key）。网关只认 `Authorization: Bearer <客户端令牌>`，请求路径为 `/v1/chat/completions`。

- 普通「聊天」与「内联聊天」面板直接使用文件里的 apiKey，改完文件等 VS Code 自动重载或重开窗口即可。
- 「Copilot 智能体/会话」窗口（vendor `agent-host-copilotcli`）不读明文 apiKey：首次在该窗口选择 tokenHub 模型时按提示粘贴同一客户端令牌（存入 VS Code 加密密钥存储 `copilot-byok-tokenHub-api-key`），否则请求会携带 Copilot 账号令牌而被网关以 401「客户端令牌无效或已停用」拒绝——这是 2026-10-21 排查时两次失败的根因。
- 模型列表与网关侧一致：deepseek-flash、deepseek-v4-flash、deepseek-v4-pro、glm-5.2、kimi-k3、sensenova-6.8-flash-lite。

## Docker 服务显示与切换

Docker 镜像不会自动成为运行中的 Compose 服务。桌面 Docker 快捷方式现在明确选择 Docker：先检查引擎，再等待本地模型调用完成（最多两分钟），正常停止本目录所属 Node 实例后执行 compose up -d --build。已有 Docker 实例才会直接复用。Docker 不可用时保留本地服务，部分启动失败时先停止 Compose 再尝试恢复本地，避免两个进程写同一 data 目录。

项目名、服务名和固定容器名均为 tokenhub；Docker Desktop 的 Containers 页显示 tokenhub 项目。通过 docker compose ps 查看状态。restart=unless-stopped，私有配置继续绑定当前 data 目录，客户端仍接入 http://127.0.0.1:3000/v1。

## 单 Key 重试

例如 max_attempts=10、3 个可用 Key：依次为 A 最多10次 → B 最多10次 → C 最多10次；任一次成功立即返回，不继续发请求。各 Key 仅进入一轮，不无限循环；耗尽后保留启用状态并进入暂时冷却，不永久停用。

retry_interval_ms 默认1000（界面以秒显示，可设0.1–60秒）；429 带有效 Retry-After 时用上游等待值，否则用配置间隔。等待期间占用当前请求并发名额，并在 Key 卡片显示等待重试。整体超时覆盖上游调用与重试等待，因此可能在用完所有次数之前返回504；客户端取消、正常停止同样立即中止等待。成功响应被接受后，正文或SSE中断不重放。
