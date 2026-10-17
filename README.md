# Libitu

**中文** | [English](README.en.md)

Libitu 是一个 AI 英语学习应用，将 YouTube 视频中的真实表达转化为个人语料、跟读练习和情景对话，帮助你把听懂的英语用起来。

> 当前处于本地开发阶段，尚未上线。支持英语视频，字幕可用性取决于视频来源。

## 功能

- **视频学习**：粘贴 YouTube 链接或通过 Chrome 扩展进入，查看字幕、内容概要和表达解析。
- **个人语料库**：收藏、筛选和编辑视频中的语块、习语与句式，保留来源上下文。
- **逐句跟读**：录音、回放并检查跟读内容，查看 Sound、Rhythm、Melody 三层反馈，了解发音相关时长、停顿、节奏与音高变化；可选准备参考音频进行对比。
- **AI 情景对话**：选择想练习的表达，设置场景与目标，通过实时语音或文字与 AI 练习。
- **练习反馈**：查看带有对话原文依据的会话报告，以及个人练习记录和学习活动。

你可以从视频中收藏表达后直接开始情景对话，也可以先进行跟读练习。声学反馈和会话评分仍在验证中，不代表经过校准的发音诊断或英语能力测评。

## 技术栈

Next.js 15 · React 19 · TypeScript · FastAPI · Supabase · Clerk · Upstash Redis · DeepSeek · Gemini Live

项目使用 pnpm + Turborepo 管理；服务端跟读分析使用 faster-whisper、MFA、Silero VAD 和 Praat。

## 本地运行

### 1. 准备环境

- Node.js 22.18+（22.x）与 pnpm 10.19.0
- Python 3.11–3.14 与 [uv](https://docs.astral.sh/uv/)
- Clerk 开发应用，用于当前 Web 的登录集成
- Chrome，用于安装扩展和体验参考音频采集

```bash
git clone https://github.com/kongshan33/libitu.git
cd libitu
pnpm install

cd apps/api
uv sync --extra dev --extra acoustics
cd ../..
```

### 2. 配置环境变量

首次运行时复制配置模板；已有配置请直接编辑，避免覆盖：

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env
```

基础开发模式需要配置：

| 文件 | 配置 |
| --- | --- |
| `apps/web/.env.local` | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`、`CLERK_SECRET_KEY`；保留 `NEXT_PUBLIC_LIBITU_API_BASE_URL=http://localhost:8000` |
| `apps/api/.env` | 同一 Clerk 应用的 `CLERK_SECRET_KEY`；保留 `CLERK_AUTHORIZED_PARTIES=http://localhost:3000` 和 `PROCESSING_MODE=inline` |

`inline` 使用确定性的开发数据和内存存储，适合查看界面和调试接口；它不执行真实的视频 AI 分析，也不提供完整的持久化、语音分析和实时对话体验。

### 3. 启动 Web 和 API

在仓库根目录分别打开两个终端：

```bash
# 终端 1：API
pnpm --filter @libitu/api dev:server
```

```bash
# 终端 2：Web
pnpm --filter @libitu/web dev
```

访问 [Web 应用](http://localhost:3000) 或 [API 文档](http://localhost:8000/docs)。

### 4. 按需启用完整功能

在 `apps/api/.env` 中补齐对应配置，具体变量见 [API 配置模板](apps/api/.env.example)：

| 功能 | 额外配置 |
| --- | --- |
| 持久化数据与练习记录 | 配置自己的 Supabase 项目，按顺序应用 `supabase/migrations` 中的迁移，填写 `SUPABASE_URL` 和 `SUPABASE_SECRET_KEY` |
| 真实视频分析 | 在持久化配置基础上设置 `PROCESSING_MODE=queue`，填写 Upstash REST URL / Token 和 `DEEPSEEK_API_KEY`；运行 `pnpm --filter @libitu/api setup:punctuation` 准备字幕标点模型 |
| AI 语音对话与会话报告 | 在持久化配置基础上填写 `GEMINI_API_KEY` 和 `DEEPSEEK_API_KEY`，保留 `SPEAKING_REALTIME_PROVIDER=gemini`；确认所配置模型在自己的服务账号中可用 |
| 服务端跟读分析 | 在持久化配置基础上安装 FFmpeg、MFA 并准备 ASR、声学模型与词典；配置模型路径和校验值，见 [声学运行说明](apps/api/deploy/README.md) |

只启用视频分析或对话时，可在 Web/API 之外按需启动 worker：

```bash
pnpm --filter @libitu/api worker
pnpm --filter @libitu/api worker:feedback
```

每个 worker 在独立终端运行。完成全部服务和声学模型配置后，可改用根目录的 `pnpm dev` 统一启动 Web、API、视频分析、会话报告和两条声学 worker。**未配置数据库或声学模型时，请使用前面的分开启动方式。**

AI 功能需要使用你自己的服务账号和凭据，可能产生调用费用。密钥仅放在本地环境文件中，不要提交到仓库。

### 5. 安装 Chrome 扩展（可选）

1. 打开 Chrome 的 `chrome://extensions`，启用开发者模式。
2. 点击「加载已解压的扩展程序」，选择仓库中的 `apps/extension`。
3. 打开英语 YouTube 视频，点击播放器中的 Libitu 按钮或扩展工具栏图标。

扩展默认连接 `http://localhost:3000`。参考音频采集需要按页面提示显式授权；Web 或扩展更新后，请重载扩展并刷新相关页面。详见 [扩展说明](apps/extension/README.md)。

## 开发

```text
apps/web        Web 应用
apps/api        API 与后台 worker
apps/extension  Chrome 扩展
packages        共享类型、业务工具和 UI 配置
supabase        数据库迁移
design/docs     产品与实现文档
```

```bash
# 从仓库根目录开始
cd apps/api
uv sync --extra dev --extra acoustics

# 回到仓库根目录执行
cd ../..
pnpm lint
pnpm test
pnpm build
```

欢迎提交 Issue 和 Pull Request。开发前请阅读 [贡献工作约定](CLAUDE.MD)；当前进度和后续计划见 [PROJECT.MD](PROJECT.MD) 与 [TASK.MD](TASK.MD)。
