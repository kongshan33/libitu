# 真实教学链路测试：2026-10-18

## 修复后的验证

修复后的真实 `gemini-3.8-live` / `deepseek-v4-flash` 记录，确认了一次跨轮引导：第 3 轮策略绑定第 4 轮回复，Gemini 把取舍问题留给用户，没有说出目标表达或例句；目标泄露检查通过，DeepSeek 评估为 `reflected`。服务端也从第五轮的精确引用正确派生 `[0,16)`。这两项都有持久化原始日志；第五轮后续回复尚未出现首音即遇到持久化 503，不能把整场会话称为无故障通过。

| 记录 | 输入与结果 | 覆盖边界 |
|---|---|---|
| [run-02](run-02/README.md) | Web 开发服务未运行，浏览器预检失败 | 没有模型调用；隔离数据已清理 |
| [run-03](run-03/README.md) | 真实语音首轮后触发 `audio_rate` | 未覆盖策略；随后修复 PCM/展示确认等待状态锁引起的积压，保留原有限速 |
| [run-04](run-04/README.md) | 5 段合成语音，3 个完整用户轮和 4 条未确认片段；无 `audio_rate`；Usage/Example 共 9 条可见 ACK | 3 个完整轮首音均先于分析启动，领先分析完成 2.80–5.45 秒；VAD/ASR 拆轮导致策略和引用未覆盖 |
| [run-05](run-05/README.md) | 固定文本输入、真实 Gemini 音频和 DeepSeek；第 3→4 轮策略、自动方向卡、第五轮引用通过 | 第五轮后续回复未观察到首音；后端持久化 503 断连，未重试输入或换场景挑选成功结果 |

run-05 的输入在会话前固定；第五句预先写好，仅用于验证引用协议，不证明引导造成目标表达使用或真人学习效果。该轮第 1 次分析尚未完成时已收到 20 个 Gemini 音频包，首音比分析完成早 176.46 ms，并记录 WebAudio 播放重叠。另有阻塞分析的离线回归验证音频仍可发送；这些证据不等同于通用时延保证。

逐轮 DeepSeek 分析结果如下。完整 JSON、策略控制原文、Gemini 实际回复和展示 ACK 在 [run-05 完整报告](run-05/README.md)。

| 轮次 | DeepSeek 耗时 | 决策与执行 |
|---|---:|---|
| 1 | 1436.46 ms | 返回比较建议；`observation_phase`，只观察 |
| 2 | 1085.30 ms | 返回比较建议；`observation_phase`，只观察 |
| 3 | 1319.95 ms | `contextual_opportunity`，生成让用户表述取舍的策略 |
| 4 | 1289.12 ms | 返回新建议；本轮实际绑定的是第 3 轮不可变策略，`eligible`、`reflected` |
| 5 | 835.86 ms | `One trade-off is` 判为 `appropriate`；服务端派生 `[0,16)`，无拒绝，证据已落库 |

关键日志（UTC）：

```text
15:03:25.525 policy.sent source_turn=3 action=implicit_elicitation
15:03:27.196 policy.bound source_turn=3 response_turn=4 validity=eligible
15:03:34.942 policy.assessed outcome=reflected implicit_target_not_spoken=passed
15:03:35.838 browser hint.shown level=direction
15:03:58.925 analysis.completed turn=5 quote="One trade-off is"
             quote_anchor={source:server_derived,start:0,end:16,model_start:null,model_end:null}
15:03:59.515 analysis.reconciled turn=5 reason=committed
15:04:01.243 server.error code=runtime_503 message="Speaking persistence is unavailable. Please retry."
```

第 4 轮 Gemini 实际回复：

> It's a tough call. How would you frame the compromise between the cheaper option and the more reliable one?

第 5 轮模型没有返回数值偏移；本次真实验证覆盖 `server_derived`。旧错误范围的 `server_repaired`、重复引用歧义、UTF-16 代理对边界在离线回归覆盖，不冒充真实模型现场触发。方向卡只给沟通目的，因此原始证据为 `assistance=direction, prompted=false`；该布尔值仅表示未展示目标措辞/例句，不代表无教学帮助。

run-04/run-05 分别导出 109/95 条诊断，均 `drained`、已报告缺口为 0；各自临时会话和语料删除确认均为 `true`。原始失败、未确认转写、预登记输入、源码哈希和清理结果全部保留。物理麦克风、真实登录、一般策略遵循率及学习效果仍未验证。

最终在真实会话结束后串行运行根目录 `pnpm lint`、`pnpm build`、`pnpm test`，全部通过：1,179 个 API 测试、390 个 Web 测试；114 个 extension 测试复用缓存。保留一项现有 Starlette 弃用警告。此前并发检查曾触发 3 个无关声学子进程时序测试失败，单独重跑和最终全量均通过，没有修改声学行为。新增回归覆盖分析阻塞时音频继续、引用修复/歧义、目标泄露、播放 ACK/存储交错与关闭清理；静态检查和测试通过不代表上述实测故障已被解决。

## 历史：run-01 修复前结果

本次使用真实 `gemini-3.8-live`、`deepseek-v4-flash` 和托管 Supabase，完成一场浏览器会话。结论：语音先于分析、策略跨轮传递和提示展示记录得到验证；隐式教学内容落实未通过。

## 逐轮结果

会话 ID：`9e095d07-dc0f-4a77-aa90-6cc96f9f1b31`。目标表达：`One trade-off is`。下表按服务端规范用户轮计数，不把 AI 开场和静默追问算作用户轮。

| 轮次 | 输入 | DeepSeek 分析耗时 | 本轮分析与策略结果 |
|---|---|---:|---|
| 1 | 语音：数据库选型 | 1025.30 ms | 返回比较建议，服务端按 `observation_phase` 只观察 |
| 2 | 语音：性能和维护限制 | 966.96 ms | `recommendation=null`，仍处观察期 |
| 3 | 语音：托管与自建的比较片段 | 957.44 ms | `recommendation=null`，无策略；语音被拆轮、回复被打断 |
| 4 | 语音：仍在考虑 | 745.79 ms | `recommendation=null`，无策略 |
| 5 | 文本：成本与维护的权衡 | 952.79 ms | `contextual_opportunity`，生成并发送 `implicit_elicitation` |
| 6 | 语音：更关心可靠性 | 751.05 ms | 本轮没有新建议；第 5 轮策略绑定本轮回复且仍 `eligible`，事后评估 `not_reflected` |
| 7 | 语音：复用刚展示的例句 | 699.56 ms | 模型证据偏移校验失败；词面回退保留 `uncertain`，`prompted=true / assistance=example` |

6 个语音首次回复的首音均早于本轮分析启动，早于完成 2.03–3.36 秒。5 个分析窗口与有效的浏览器 WebAudio 播放区间重叠；分析窗口内没有新音频包到达。当前路径在语音回复已经开始后才完成用户转写并启动分析。这些结果不能等同于“分析进行期间首包到达”，也不提供任意网络条件下的时延保证。第 5 轮文本输入的分析恰好比首音早完成 42.38 ms，单凭这个顺序不能判定存在等待。

## 策略执行与展示日志摘录

以下时间为 UTC，保留源日志中的事件时间；完整载荷在链接报告中。

```text
11:42:28.941  turn=5 analysis.completed reason=contextual_opportunity
11:42:37.824  policy.sent policy=a4c17f52-8b0d-556b-91bb-7a99bc986b54
11:43:03.401  policy.bound source_turn=5 response_turn=6 validity_at_bind=eligible
11:43:13.058  policy.assessed outcome=not_reflected exact_quote=null
11:43:42.654  browser client.hint.shown level=usage version=2
11:43:46.337  browser client.hint.shown level=example version=2
11:44:36.629  turn=7 analysis.completed evidence_rejection=quote_or_utf16_offsets_mismatch
```

第 6 轮 Gemini 实际说：

> One trade-off is that higher reliability often comes with higher costs. Given your focus on reliability, are you willing to increase the budget?

这直接点名了目标表达，违反已发送策略的“不要点名目标表达、不要替用户作答”约束。DeepSeek 事后评估原文如下；这是模型的建议性评估，不是因果证明：

```json
{"outcome":"not_reflected","exact_quote":null,"reason":"The response asks about budget willingness but does not introduce or frame a compromise between the two database options as suggested."}
```

用户随后主动请求用法与例句，实际展示的例句为：

> One trade-off is that a managed database reduces maintenance effort but raises the monthly cost.

2 次帮助请求共有 9 条按层级和版本记录的可见 ACK，都能与浏览器发送记录对应；不是 9 张卡。第 7 轮复用例句正确记为有提示使用。模型把目标表达的范围写成 `[0,15)`，实际长度为 16 个 UTF-16 单元，因此其 `appropriate` 判断被拒绝，只保留 `uncertain` 的词面命中。

## 证据与边界

- [完整逐轮日志及原始模型回复](run-01/README.md)：7 次观察分析、2 次帮助、1 次效果评估，以及策略发送、绑定、评估和提示展示。
- [原始服务端诊断](run-01/diagnostics.json)：221 条，闭合状态 `drained`，已报告丢失数为 0。
- [浏览器事件](run-01/browser-events.jsonl)、[结构化报告](run-01/summary.json)、[例句截图](run-01/example-example.png)、[清理结果](run-01/cleanup.json)。
- 仅身份使用隔离的测试替身；语音输入使用本地合成 WAV，经实际 MediaStream / AudioWorklet / PCM / Gemini VAD 和转写链路发送。6 个规范语音轮来自 5 段 WAV，其中一段被 VAD 拆成两轮并丢失部分转写；另外一次 `writes` 被识别为 `rides`。不把合成语音测试称为真人麦克风或真实 Clerk 登录验收。
- WebAudio 的 `onended` 包含主动停止，不代表整段完整播放。本次 33 个迟到的启动探针已在报告中保守排除；未来测试脚本已修复，原始记录没有改写。
- 测试 API 仅绑定回环地址。浏览器关闭、诊断导出后，临时会话和语料已删除；既有用户数据未改动。run-01 当次没有改动生产教学策略或重跑；后续修复与验证独立记录在上方各 run 中。

## 工具复用

本次新增三个显式运行的测试工具，不加入默认付费测试流程：

1. `apps/api/scripts/live_teaching_server.py`：从 `apps/api` 使用 `.venv/bin/python -m scripts.live_teaching_server --live --output /absolute/new/run-directory` 启动隔离 API。读取既有忽略配置，创建临时会话；正常 SIGINT 退出时导出并清理。异常强制终止需要依据配置内的合成 owner/session 检查清理。
2. `apps/web/tests/speaking-live.browser.mjs`：已有本地 Web 开发服务运行时启动。读取 `LIBITU_LIVE_CONFIG`（默认 `/tmp/libitu-live-teaching-config.json`），通过命令 JSONL 接收 `connect`、`speak`、`submit`、`hint`、`example`、`wait_audio`、`snapshot`、`stop`。语音命令需提供 `wavPath`；文本命令需提供 `text`。等待每条命令的结果后继续，最后先停止浏览器，再停止 API。可用 `LIBITU_PLAYWRIGHT_MODULE` 指向已有 Playwright 安装。
3. `apps/api/scripts/report_live_teaching.py`：从 `apps/api` 使用 `.venv/bin/python -m scripts.report_live_teaching /absolute/run-directory` 离线生成完整报告，不调用模型。

run-01 当次新增 Python 脚本编译、浏览器脚本 ESLint、播放探针停止/正常播放离线检查及报告关联断言通过。报告中的模型原文逐条核对，20 个原始文件的哈希在生成报告前后保持不变。run-01 当次未重新运行全仓构建和测试；本次修复后的最终检查见上文。
