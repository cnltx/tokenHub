# tokenHub v0.2 交付验证

日期：2026-10-21。环境：Windows、Node.js v24.14.1、Docker Desktop 29.7.2。

## 自动检查

- `node scripts/check.js`：全部 JavaScript 语法检查通过。
- `node test/run.js`：21 个集成场景通过；node:test 输出 22 项通过（含父测试），0 失败、0 跳过。
- 内部 skill 的 quick_validate.py 校验通过。

覆盖免登录管理、自动 CSRF/同源限制、管理密钥遗留文件删除、API 客户端鉴权、模型白名单、Key 轮询、优先级故障切换、有限重试、Chat/Responses 原生字段、增量 SSE、取消、超时、统计持久化及凭据原子保存。

转发专项覆盖完整上下文和工具保留、原模型结果不变且不等待目标、未启用/未匹配/目标自身跳过、目标错误及权限隔离、流式取消、Responses、独立并发及停止落盘。已移除的导入、对比和采纳接口返回 404。

## 界面与真实配置

- 浏览器直接打开 3000 端口即进入后台，无登录表单、退出按钮或管理密钥参数。
- 页面不再显示每页的大标题和宣传提示语；保留操作说明。
- 本机模拟上游验证：保存转发规则，接口测试只显示 demo-fast 原结果；后台 demo-think 单独完成，两个调用分别记录 usage。
- 原有个人模型、上游 API Key、客户端令牌与历史统计保留；本次验证没有调用真实上游模型。
- 已保存免登录总览截图到 docs/screenshots/overview-v02.png，该目录由 Git 忽略。

## Windows 与 Docker

- 桌面 tokenHub / tokenHub Docker 两个快捷方式已创建，指向 wscript.exe 和各自 VBS 启动器。
- `cscript.exe //nologo start.vbs --no-open` 已实际启动本地免登录服务，启动器隐藏 Node 控制台，不依赖 cmd。
- 最终 tokenhub:local 镜像构建成功；检查以非 root 用户运行，镜像中无个人 config.json、secrets.json 或管理密钥文件，无登录表单。
- 使用独立 .tmp/docker-verify 绑定卷和宿主 13000 端口启动验证容器。重建容器后原测试渠道及测试 API Key 保留，免登录访问返回 200；遗留管理密钥自动清理。
- 测试容器已正常停止并移除。本地 3000 服务继续运行，未将个人数据交给测试容器。
- Compose 与本地默认共用个人 data 目录，切换模式前须先停止当前实例。

## Git 与配置独立性

已建立独立 main 分支仓库，尚无提交和远程。Git 待加入文件清单只包含源码、文档、示例及 data/.gitkeep；真实配置、API Key、日志、临时数据、截图和默认导出文件被忽略。已逐值核对当前本地凭据，没有出现在待纳入仓库的源码或文档中。

项目运行不读取其它项目目录；设置只提供自身模型配置的脱敏导出或含 API Key 导出。不生成或使用管理账号、密码及管理密钥。

## DSH 与 Key 状态增量验证

- DSH 当前令牌与 tokenHub 的有效客户端令牌一致；模型发现 HTTP 200。按 DSH 当前 openai-responses 配置直接请求 HTTP 200，流式完成。使用安装包真实 pi-ai 适配器得到文本 OK；这些最小连接验证产生正常模型用量。
- DSH 记忆插件旧注入函数复现用户报告的 producer-owned source kind 异常。局部修复后，真实 createDshHooks.preStep 返回的记忆消息通过原生 v4 校验；负例仍被拒绝，证明未绕过校验。原文件已备份，用户已确认完全退出并重启 DSH。未自动操作 DSH 的原生聊天窗口，因此不将实际窗口里的完整新回合报告为已验证。
- Key 指标更新后运行 node scripts/check.js 和 node test/run.js：24 个集成场景、含父测试 25 项全部通过。新增同 Key 并发主调用/转发计数、取消释放与重启不残留、重试切换 Key、完成率及响应头前取消统计场景。修正原测试逐块 UTF-8 解码的偶发断字，改为收集字节后统一验证。
- 浏览器模拟请求实测两张 Key 卡片的正在使用状态，主调用结束后后台 Key 保持高亮；成功率未提前计入进行中请求。正式 3000 渠道页也已显示真实历史 Key 成功率。截图 key-activity-v02.png 仅含本机模拟凭据，受 Git 忽略。
- 本地服务已正常重启加载本次更新，Docker 镜像重新构建。原有模型、API Key、令牌和转发选择保持。

最终 Docker 临时容器已实际启动 API，免登录 HTTP 200，Key active=0、无样本 success_rate=null、completed=0 均通过断言，结束自动移除。正式个人配置与凭据再次扫描，37 个候选源码/文档文件未发现实际凭据；个人数据、截图和 DSH 诊断脚本仍被 Git 忽略。确认 DSH 进程已在用户重启后更新。

## 正式切换到 Docker

2026-10-21：复现 Compose 无容器、实际为 mode=local 的情况。修复 Docker 快捷方式复用本地实例的问题，并备份个人数据。等待当前调用结束后，已通过更新的 desktop.js --docker --no-open 正常停止本地实例并创建正式 Compose 服务。

当前项目/服务 tokenhub，容器 tokenhub-tokenhub-1，为 running/healthy，端口 127.0.0.1:3000→3000，restart=unless-stopped；绑定原 data 目录到 /app/data。service.json mode=docker，后台 HTTP 200，1 个渠道、3 个上游 Key、3 个客户端令牌保留，config.json/secrets.json 的 SHA-256 与切换前完全相同，累计统计保留且包含等待期间的新调用。再次运行 Docker 启动器成功复用容器。此处 supersedes 前文关于正式服务仍以本地 Node 运行的阶段性记录。

新增 Docker 模式切换、已有容器复用、引擎失败时保留本地和部分启动失败的恢复测试。语法检查通过；26 个集成场景、含父测试共 27 项全部通过。

2026-10-21：依用户要求在线将正式容器由 tokenhub-tokenhub-1 改名 tokenhub，并在 compose.yaml 固定 container_name: tokenhub。Compose 配置校验、运行状态 healthy 及 3000 健康接口通过；容器 ID 和服务 instance 与改名前相同，未重启服务。Docker 与本地桌面方式均可用，共用 data/3000；本地方式是隐藏 Node 的 VBS 快捷方式，并非独立 exe。

## 2026-10-22 单 Key 重试规则

本节为当日历史记录；状态码范围已由下节 2026-10-23 的规则取代。

用户将 max_attempts 的含义改为每 Key 尝试上限。配置10时同 Key 最多10次（包含首次），可恢复错误等待后继续同 Key，耗尽再暂时冷却并换下一 Key。默认 retry_interval_ms=1000；429 优先 Retry-After；保留401直接隔离、400/403/404不重试、成功响应后不重放、整体超时和取消。

先用新增测试复现旧逻辑 A 一次就转 B；修改后 node scripts/check.js 和 node test/run.js 通过：31 个集成场景、含父测试32项，0失败。专项验证 A 连续10次再 B、各 Key 独立预算、Retry-After等待与活动状态、成功恢复、取消/截止中止等待、网络/5xx重试以及401/400不重复。统计每个上游尝试分别记账，等待不增加次数。

当前实际运行模式是 local，等待空闲并备份个人数据后正常重启加载新代码，浏览器设置页保存并验证单Key次数10、间隔1秒、原整体超时200秒，截图 docs/screenshots/per-key-retry-20261022.png。模型、客户端令牌、转发规则及所有当前凭据与备份逐项一致，源码候选文件扫描无凭据泄露。

Docker 镜像同步重建，并在隔离临时容器用模拟上游实际确认 A 连续10次后切换B成功。正式名为 tokenhub 的容器已更新到新镜像，保留用户当前的停止状态（Created），未同时启动两个实例写个人数据。下次 Docker 启动使用新策略；本地策略已生效。所有验证请求使用模拟上游，不新增真实模型调用。

## 2026-10-23 所有上游 HTTP 错误使用同一预算

所有上游非 2xx 响应均先在同一个 Key 上按 max_attempts 尝试（包含首次），耗尽后临时冷却并切换。401 不再永久排除 Key，冷却结束可自动重新选择；旧鉴权标记也不会永久阻止选择。本地令牌、权限、参数和协议桥接校验保持直接返回；已接受的成功响应正文/SSE 出错保持不重放。429 继续遵守 Retry-After，整体期限与取消覆盖重试等待。

node scripts/check.js、技能 quick_validate 和 git diff --check 通过；node test/run.js 的 32 个集成场景、含父测试共 33 项全部通过。状态码矩阵验证 300/302/304/400/401/402/403/404/408/409/422/429/500/502/503/504/529/599 均为 A 两次后 B 成功；另验证 400 全 Key 耗尽、401 冷却结束自动恢复、连接错误、十次预算、取消、超时、记账及转发隔离。

Docker 镜像重建后，隔离容器实际验证 400/401/403/404/429/503 为 A 三次后 B 成功，结束统计落盘。正式 tokenhub 容器更新到新镜像，保留 Created 状态。等待本地实例空闲后，通过隐藏 VBS 正常重启；端口仍为3000，本次读取的个人设置为 max_attempts=20、retry_interval_ms=1000、request_timeout_ms=200000，均原样保留，默认示例仍为10次。模型、令牌、转发规则和凭据与重启前备份一致，页面已提供全部上游非 2xx 重试说明。测试仅使用模拟服务，无新增真实模型验证调用。

上传前检查 Git 工作文件和全部现有历史 blob：未包含当前真实凭据，data/.tmp/导出/环境文件/截图继续排除，示例仅含占位值。
