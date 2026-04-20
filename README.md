# my-telegram-bot

基于 `Telegraf + OpenAI + MongoDB` 的 Telegram 私聊陪伴机器人，支持：
- 私聊对话与情绪化回复
- 长期记忆与最近记录面板
- 回应方式与提醒频率偏好
- 定时问候与生日提醒
- 本地知识库 + 远程补检索（低置信时）

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量（参考下方 `.env`）

3. 启动

```bash
npm start
```

开发模式：

```bash
npm run dev
```

## 核心环境变量

必需：
- `BOT_TOKEN` Telegram Bot Token
- `MONGODB_URI` MongoDB 连接串
- `AI_API_KEY` 或 `OPENAI_API_KEY`

常用：
- `AI_BASE_URL` 模型网关地址（可选）
- `AI_MODEL_NAME` 主对话模型（默认 `gpt-4o-mini`）
- `AI_LIGHT_MODEL_NAME` 轻量模型（默认同上）
- `TELEGRAM_WEBAPP_URL` 记录面板 URL（用于 `/record`）
- `WEBHOOK_URL`（可选，不配则走 polling）
- `PORT` HTTP 端口（默认 `8080`）

检索相关：
- `SEARCH_API_URL` 远程搜索 API（支持 `{query}` 占位符）
- `SEARCH_TIMEOUT_MS` 单次搜索超时，默认 `12000`
- `REMOTE_SEARCH_TIME_BUDGET_MS` 远程补检索总预算，默认 `6000`
- `REMOTE_SEARCH_MAX_PAGES` 远程抓取最大页面数，默认 `2`
- `REMOTE_SEARCH_CONCURRENCY` 远程抓取并发数，默认 `2`

Qdrant（可选）：
- `QDRANT_URL`
- `QDRANT_COLLECTION`（默认 `telegram_bot_knowledge`）
- `QDRANT_API_KEY`（可选）

行为开关（本次体验修复新增）：
- `GROUP_REPLY_MENTION_ONLY=true`  
  群聊仅在 `@bot` 或回复 bot 消息时才给出“请私聊”提示
- `GROUP_PRIVATE_HINT_COOLDOWN_MS=300000`  
  群聊“请私聊”提示冷却时间（毫秒）
- `MESSAGE_COOLDOWN_MODE=merge_concat`  
  私聊冷却模式：`merge_concat`（默认，窗口内合并多条文本）、`merge_last` 或 `drop`
- `MESSAGE_COOLDOWN_MS=2000`  
  私聊冷却窗口（毫秒）
- `MESSAGE_COOLDOWN_NOTICE_MS=6000`  
  冷却提示最小间隔（毫秒）
- `STICKER_DEBUG_ENABLED=false`  
  是否启用贴纸 `file_id` 调试回包（生产建议保持 `false`）
- `STICKER_DEBUG_CHAT_IDS=`  
  调试白名单 chatId，逗号分隔；为空表示调试模式下全量允许
- `SAFETY_CRISIS_HEADER` / `SAFETY_CRISIS_EMERGENCY_LINE` / `SAFETY_CRISIS_SUPPORT_LINE` / `SAFETY_CRISIS_CLOSE_LINE`  
  危机安全回复文案（可选覆盖，默认内置中文安全提示）

## 用户命令

- `/start` 入口面板
- `/help` 命令帮助
- `/record` 打开记录面板（仅私聊）
- `/memory` 查看长期记忆
- `/recent` 查看最近记录
- `/forget 关键词` 删除记忆
- `/editmemory 关键词 => 新内容` 修改记忆
- `/mode 只陪我|帮我理一下|别追问了` 调回应方式
- `/push 安静一点|正常|多一点主动 [早上 下午 晚上]` 调提醒偏好
- `/timezone Asia/Shanghai` 设置用户时区（IANA）
- `/quiet 23:00-08:00` 设置免打扰时段，`/quiet off` 关闭
- `/nickname 名字` 设置称呼
- `/birthday 3-15` 设置生日
- `/status` 当前状态
- `/mood` 情绪与摘要状态
- `/diary` 生成今日日记
- `/reset` 重置会话和记忆

未知命令会自动提示使用 `/help`。

## 推送语义（重要）

`profile.pushWindows` 语义如下：
- `undefined/null`：未配置，按默认时段 `morning + afternoon + night`
- `[]`：显式关闭全部时段（`/push off`）
- `['morning'|'afternoon'|'night']`：显式开启集合

为兼容历史数据，系统使用 `pushWindowsConfigured` 区分“默认空值”与“用户明确关闭”。

## 时区与免打扰

- 用户可以通过 `/timezone` 设置个人时区，调度会按该时区判断生日日期与免打扰窗口
- 用户可以通过 `/quiet` 设置免打扰时段，命中窗口时不发送主动推送
- 免打扰支持跨天区间（例如 `23:00-08:00`）

## 群聊规则

- 默认不在群里处理普通消息
- 仅在以下情况提示“请私聊”：
  - 消息里 `@bot`
  - 回复 bot 的消息
- 提示有冷却，避免刷屏

## 安全分流

- 当消息命中高风险关键词（如“我不想活了”“想自杀”等）时，路由会进入 `safety_crisis`
- 该路由使用固定安全提示，不走花哨文风、不追加互动键盘、不发贴纸/语音

## 测试与类型检查

```bash
npm test
npm run typecheck
```

## 常见问题

1. `/record` 提示未配置  
原因：`TELEGRAM_WEBAPP_URL` 未设置。

2. 收不到 AI 回复  
原因：`AI_API_KEY/OPENAI_API_KEY` 缺失，系统会回退到兜底文案。

3. 群里为什么不回我  
默认群聊仅 `@bot` 或回复 bot 才触发提示，避免噪音。
