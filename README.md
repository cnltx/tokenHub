# tokenHub

一套可直接分发给其他用户的 Docker 网关：`8788` 同时转发到自己的 `new-api`，并通过 New API 的商汤 `sensenova-6.8-flash-lite` 模型产生影子调用。

本包不包含任何个人 API Key，也没有 New API 数据库、令牌或账号数据。

## 结构

- `docker-compose.yml`: 启动 `new-api` 和 `token-earn-proxy`
- `token-earn-proxy/`: 影子代理源码
- `token-earn-proxy-data/config.json`: 代理运行时配置
- `new-api-data/`: 每个使用者自己的 New API 数据目录
- `MIGRATION.md`: 详细的运行、迁移和渠道配置说明
- `scripts/`: 一键导出/导入 New API 配置文本

换电脑迁移时，先在旧设备运行 `export-tokenhub.bat` 生成 `tokenhub-export.sql`，再把该 SQL 文本放到新设备，运行 `import-tokenhub.bat` 一键导入。

## 快速开始

1. 安装 Docker Desktop，并启动 Docker。
2. 复制环境变量模板：

   ```bash
   cp .env.example .env
   ```

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

3. 启动：

   ```bash
   docker compose up -d --build
   ```

4. 打开 New API 后台：`http://127.0.0.1:3001`

   - 首次登录后请先修改 New API 默认管理员密码。
   - 在“渠道”里添加商汤渠道，配置自己的 SenseNova API Key。
   - 让渠道提供模型名：`sensenova-6.8-flash-lite`。
   - 创建一个自己的令牌，供 AI 客户端使用。

5. 在 AI 客户端中配置：

   - Base URL: `http://127.0.0.1:8788/v1`
   - API Key: 使用你在 New API 中生成的令牌
   - 模型: `sensenova-6.8-flash-lite` 或你在 New API 渠道中映射的模型名

6. 查看影子请求状态：

   - 控制台: `http://127.0.0.1:8788/`
   - 状态接口: `http://127.0.0.1:8788/api/status`

## 支持的协议

- `POST /v1/chat/completions`
- `POST /v1/responses`

两者都会正常转发到 New API，并同步触发一次商汤影子请求。

## 说明

- 影子请求复用当前客户端请求携带的 New API Token，代理层不保存任何商汤 Key。
- 以后增减或轮换商汤 Key，只需要在 New API 后台渠道中操作，不需要改 Docker 配置。
- 影子请求会真实消耗商汤调用配额，请确认自己的套餐支持。
