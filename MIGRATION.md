# 使用与迁移说明

## 1. 这个压缩包能直接给我开箱即用吗？

能启动，但不能直接使用你原来的 New API 数据。

这个压缩包是干净的 Docker 分发包：

- 包含：`docker-compose.yml`、`token-earn-proxy` 代理源码、代理配置、`.env.example`、说明文件。
- 不包含：你的 `new-api-data/one-api.db`、New API 渠道、商汤 API Key、令牌、账号密码、日志。
- 不包含：你对 New API 商汤渠道的“重连/渠道/Key”配置。

所以放到新设备上，Docker 栈会正常启动，但 New API 是全新实例，需要在新设备上重新配置你自己的商汤渠道和令牌。

## 2. 如何在另一台设备上运行

### 2.1 准备

1. 安装 Docker Desktop 并启动。
2. 解压本压缩包到一个固定目录，例如 `D:\tokenHub`。

### 2.2 复制环境变量

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

### 2.3 启动

Windows 可直接双击 `start.bat`，或执行：

```powershell
docker compose up -d --build
```

macOS / Linux 执行：

```bash
docker compose up -d --build
```

### 2.4 配置自己的 New API

1. 打开 New API 后台：`http://127.0.0.1:3001`
2. 首次登录后，立刻修改默认管理员密码。
3. 添加你自己的商汤渠道：
   - 渠道类型选择 SenseNova / 商汤相关供应商。
   - 填入你自己的 SenseNova API Key。
   - 让渠道提供模型：`sensenova-6.8-flash-lite`
4. 创建一个令牌，供 AI 客户端使用。

### 2.5 配置 AI 客户端

在支持 OpenAI 兼容接口的客户端中配置：

- Base URL：`http://127.0.0.1:8788/v1`
- API Key：使用你在 New API 中创建的令牌
- 模型：`sensenova-6.8-flash-lite`

### 2.6 检查是否生效

- 代理控制台：`http://127.0.0.1:8788/`
- 状态接口：`http://127.0.0.1:8788/api/status`

正常运行时，状态里的 `plan_enabled` 应为 `true`，日志应出现：

```text
✓ 影子请求成功(200) via new-api ...
```

## 3. 如果我想把自己现有的 New API 配置迁移到新设备

这里有两类情况：

### 3.1 自己迁移（不想把 Key 给别人）

你原来的 New API 渠道、商汤 Key、令牌都存在这个文件里：

```text
旧设备目录/new-api-data/one-api.db
```

迁移步骤：

1. 在新设备先把这套 Docker 栈启动一次，让 `new-api-data` 目录生成。
2. 停止栈：

   ```powershell
   docker compose down
   ```

3. 用旧设备的 `new-api-data/one-api.db` 覆盖新设备的 `new-api-data/one-api.db`。
4. 重新启动：

   ```powershell
   docker compose up -d
   ```

注意：这个 `one-api.db` 里包含你的个人渠道 Key 和令牌，只能自己迁移用，不要放进给别人分享的压缩包。

### 3.2 给其他人使用（不给自己的 Key）

不要拷贝 `new-api-data/one-api.db`。

对方只需要使用当前压缩包，按第 2 节配置他们自己的 New API 渠道和 Key 即可。

### 3.3 一键导出 / 一键导入（推荐）

项目里提供了两个脚本，用于把当前 New API 配置导出成文本，再在新电脑上一键导入。

#### 旧设备导出

在 tokenHub 项目根目录运行：

```powershell
.\export-tokenhub.bat
```

或手动执行：

```bash
python scripts\export-tokenhub.py new-api-data\one-api.db tokenhub-export.sql
```

会在项目根目录生成 `tokenhub-export.sql`。这个文件包含你的 New API 渠道、Key、令牌和账号配置，只能自己迁移使用，不要上传到公开仓库。

#### 新设备导入

把 `tokenhub-export.sql` 放到 tokenHub 项目根目录，然后运行：

```powershell
.\import-tokenhub.bat
```

脚本会先执行 `docker compose down`，导入 SQL 文本到 `new-api-data\one-api.db`，再执行 `docker compose up -d`。

注意：导入前请确认 `tokenhub-export.sql` 与你当前设备不是同一套数据，避免覆盖新设备已有配置。脚本导入前会自动备份现有 `one-api.db`。

## 4. 这个压缩包里有没有我的商汤渠道/重连配置？

没有。

压缩包里只有：

- 代理如何监听 `8788`
- 代理如何把影子请求发到 New API 的 `sensenova-6.8-flash-lite`
- 代理如何复用当前请求的 New API Token

你的商汤 API Key、New API 渠道、模型映射、令牌都在你自己的 `new-api-data` 数据库里，不会被打进这个分享包。

## 5. 端口说明

- `8788`：代理入口，AI 客户端使用
- `3001`：New API 后台/管理界面
- New API 容器内部服务名：`new-api:3000`

## 6. 支持的协议

- `POST /v1/chat/completions`
- `POST /v1/responses`

两者都会正常转发到 New API，并同步触发商汤影子请求。
