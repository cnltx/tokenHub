# tokenHub

独立的轻量 AI 网关：多渠道、Key 轮询、客户端令牌、模型路由与可选后台转发。零第三方 Node 运行依赖，默认端口 3000。

## Windows 桌面启动

双击桌面的 **tokenHub** 快捷方式，或项目里的 **start.vbs**。启动器直接调用 Node 并隐藏控制台，打开浏览器即可进入免登录后台；已经运行时直接打开现有面板。

需要 Node.js 22+。移动项目目录后，运行 `scripts/install-shortcuts.ps1` 更新快捷方式。故障信息保存在被 Git 忽略的 data/desktop-error.log。

开发调试和停止：

```powershell
node src/cli.js start --open
node src/cli.js status
node src/cli.js stop
```

## Docker 启动

```powershell
docker compose up -d --build
docker compose logs -f
docker compose stop
```

打开 http://127.0.0.1:3000/ 。也可以双击桌面的 **tokenHub Docker** 快捷方式（Windows 启动器使用本机 Node 调用 Docker）。纯 Docker CLI 部署不需要安装宿主机 Node。

配置、API Key 和统计绑定到 `./data:/app/data`，重建容器保留数据。镜像仅复制 package.json、src、public，私有文件由 .dockerignore 排除。容器以 node 用户运行；Linux 上的 data 目录需允许该用户写入。

本地与 Docker 默认使用同一 3000 端口和 data 目录。Docker 快捷方式先确认 Docker 可用，等待本地请求结束，再正常停止本地实例并启动 Compose；启动失败会先停止部分启动的容器，再恢复本地服务。Docker 已运行时直接打开它。切回本地方式先运行 `docker compose stop`，再使用普通快捷方式；不要同时用两个实例写同一数据目录。容器实例由 Compose 停止。

Compose 默认仅发布到宿主本机；远程部署需明确修改 ports，并设置 TOKENHUB_PUBLIC_URL 为浏览器实际访问的 origin。参考 [Docker Compose](https://docs.docker.com/compose/intro/compose-application-model/) 与 [端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。

渠道与 Key 页显示正在使用的 Key、主调用/后台转发数量、最近使用及成功率。成功率只统计已结束的上游调用（含连通测试和重试），没有样本时显示 —。

## 模型转发

在“模型与转发”页选择源模型、目标模型，勾选启用并保存。未配置或未启用时只调用客户端请求的模型。

例如：源模型选择 ds，目标选择 sensenova。客户端调用 ds 后，**返回 ds 的原始结果**；同一份完整请求在后台额外发给 sensenova。目标结果不返回、不替换原回复，也没有候选采纳。源模型可选全部或指定模型，目标随时可换。

- 支持 Chat Completions 与 Responses，流式和非流式主请求均保持原协议。
- 转发复制完整上下文、工具等字段，只改目标模型、流式读取及输出上限；跨模型的服务端历史 ID 是否有效由上游决定，失败不替换主响应。
- 转发有独立并发和健康/冷却状态，不占用主请求并发额度；后台满载时跳过并记录原因。
- 不递归转发，目标自身的请求不会再次转发。
- 目标也须在原客户端令牌的分组和模型权限内；无权限则跳过，不能借转发越权。
- 客户端中途取消会中止主调用和其后台转发；主调用正常完成后，后台可继续到完成或超时。
- 两个模型的实际调用分别计量；后台结果正文不保存，只记录元数据与上游 usage。

重试上限按每个 Key 计算：例如设为10，则先在当前 Key 上最多尝试10次，耗尽后冷却并换下一枚。所有上游非 2xx 状态码（包括400、401、403、404、429及5xx）和连接错误均适用。429 遵守 Retry-After，没有则按设置的间隔等待；整体超时和取消仍可提前中止。

## 客户端接入

Base URL：`http://127.0.0.1:3000/v1`。API Key 使用设置页的客户端令牌；上游 Key 与客户端令牌分别配置，后台不需要账号或密码。

支持 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`。接口测试页返回所选原模型的文本结果，可直接验证转发规则。

原生协议透传上游支持的工具、reasoning 和多模态字段；显式 Responses→Chat 转换仅支持纯文本子集，工具/图片/previous_response_id 等需选择原生 Responses 渠道。无上游 usage 时标为未知，缓存命中是输入 Token 子集。

## 配置导入、导出与 Git

设置页支持导入 tokenHub 自身 schema_version=2 JSON，并提供模型配置（不含 API Key）、模型配置与 API Key 两种导出。

点击“导入配置”选择文件（最大 3 MB），预览渠道、模型、Key、客户端令牌及增删数量后确认。默认合并：按 ID 或名称更新，保留文件未包含的项目；替换模式会移除文件未包含的渠道和令牌。含 Key 文件可完整恢复；不含 Key 时保留本机同地址渠道已有的 Key，新渠道需补 Key，无凭据且本机不存在的令牌会跳过并提示。渠道地址变化时不会自动带走原有 Key。

转发规则随文件导入；运行设置默认保留，勾选后才恢复，端口变更需重启。用量记录保留，当前调用与批量测试结束后才能应用。文件无效或预览后配置发生变化时拒绝导入，保存沿用原子写入和上一版备份。示例见 config.example.json。

真实配置、密钥、日志和统计集中在 data/，不与项目外目录关联。以下内容已被 .gitignore 排除：

- data/ 私有数据、.tmp/、日志、桌面快捷方式。
- config.json、secrets.json、环境文件及旧版遗留的管理密钥文件。
- exports/、backups/ 和默认 tokenhub-*.json 导出文件。
- 本地界面截图目录。

config.example.json 和 .env.example 只包含占位值，可纳入源码。仓库初始化后可用 `git status --ignored` 核对，不要用 `git add -f` 强制加入私有数据。

开发约定：每完成并验证一项修改后提交、推送 origin/main；上传前检查差异及私有文件排除规则。

## 验证与文档

```powershell
node scripts/check.js
node test/run.js
# 仅使用本机模拟模型的界面演示
node scripts/demo.js
```

[架构](docs/architecture.md) · [运维与 API](docs/operations.md) · [验证记录](docs/verification.md) · [内部 skill](.agents/skills/tokenhub/SKILL.md)
