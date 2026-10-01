# Stage 1 边听边准备原音：修正版与本地实现

日期：2026-09-13。范围：本地开发版 Web + Chrome 扩展。

本次按 `toneflow_audio_acquisition_flow.html` 的核心交互实现本地流程：Stage 1 正常播放时积累原音、选择片段检查覆盖、缺失内容显式补录、逐句准备结果。首次扩展授权、音频时间映射和 JSON3 证据边界经过修正。**没有实现该图中的云端上传、Supabase Realtime、MFA、Parselmouth、CREPE 或跨用户共享缓存。** 原文件保留为输入材料，不是这些功能的实施证明。

## 1. 流程图需要修正的地方

| 原方案假设 | 核对结论与实现方式 |
|---|---|
| JSON3 是准确的词 start/end | 现有 `sentence-v3` 保留 provider 提供的词起点；词尾可能为下词起点/事件末尾估算，也可能缺失。沿用同一套共享句子，不重新跑 ASR 来做基本导航 |
| 页面进入即完全无感录制 | 必须先在当前 Libitu 标签页开启并显式调用扩展；授权后可跨句、片段与 Stage 1/2 复用，页面持续显示状态与关闭入口 |
| service worker 直接持有 MediaRecorder | background 获取 stream ID、校验归属，offscreen document 持有媒体流和 AudioContext |
| 累计每秒 WebM chunks 后用视频毫秒裁剪 | 改用 AudioWorklet 的单声道 PCM 与连续播放区间映射；不假设独立 MediaRecorder chunk 可解码，也不把视频绝对时间当成 Blob 偏移 |
| 缺失片段静默 1.3× 补录 | 用户点击后，显示播放器，按实际 1× 播放补齐；可暂停、取消，不静音、不自动跳走 |
| MFA 支持 `--use_word_timestamps`，逐词运行保证提速 | 官方 align 工作流没有该参数。JSON3 可辅助定位句子/短语，不能替代内容核对与音素对齐。逐词切割会丢失跨词上下文；本次不实现未经验证的对齐器 |
| 同一视频/片段时间就能共享声学结果 | 本次只复用同一来源会话的本地数据；不同捕获有不同 capture ID。没有跨用户缓存，也没有精度/延迟百分比承诺 |

参考：[Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[MV3 offscreen 录制方案](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)、[MediaStream Recording 规范](https://www.w3.org/TR/mediastream-recording/)、[MFA 对齐工作流](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/workflows/alignment.html)。

## 2. 现在如何使用

1. 重新加载本地 `apps/extension` 扩展并刷新 Libitu 页面，让双方使用最新协议。
2. Stage 1 蓝图已有内容身份后，在视频下方点击 **Enable reference audio**，再点击当前标签页上的 Libitu 扩展工具栏。此操作本身不播放视频、不打开麦克风。
3. 正常按 1× 听视频。界面显示准备状态；只有经过连续性校验且确有 PCM 的区间进入可用覆盖。
4. 选择练习片段。准备页分别显示文本句数、本地原音覆盖句数和已分析句数；已有原音自动准备前几句。
5. 未覆盖时点击 **Listen to prepare missing audio**，播放器从缺失句附近按 1× 播放。可暂停，或直接 **Start shadowing** 继续基础练习。
6. Stage 2 复用会话、缓冲与已完成结果，按当前句和后两句的需求准备分析。可点击 **Prepare this sentence at 1×** 补录；录音/回放用户声音会暂停原片并挂起原音准备。
7. 返回 Stage 1、切句或切层不会要求重新授权。Stage 1 → Stage 2 的同文档 history URL 更新会继续使用同一页面级会话；扩展也会忽略同来源更新附带的短暂 `loading` 状态，不会误清理 REC 租约。刷新、换来源、显式关闭、连接失效或会话到期会释放原音会话；刷新/换来源也清理对应缓存。

尚未解析出稳定内容身份时不显示开启入口，避免 content/job URL 变化使授权绑错来源。首次准备不会补回授权前听过的内容。当前授权周期仍受 Chrome 和应用会话生命周期约束，不承诺永久只授权一次。

## 3. 时间与覆盖保证

扩展记录两个不同的时钟：YouTube 视频时间和 AudioContext/PCM 帧位置。浏览器遥测提供单调时间、epoch 时间、实际播放状态、速率，以及播放器 generation。

连续区间要求实际 1×、连续遥测和存在的 PCM。暂停、seek、buffer、速率变化、播放器替换、时钟跳动或丢样都会打断区间。客户端与扩展均要求目标句子被**单个连续区间**覆盖，不用多个区间的最小/最大时间冒充完整覆盖。

抽取的是实际 PCM，编码为带正确采样率和时长的 WAV。再次完整听过相同位置时优先选择最新的完整捕获，避免重录后仍分析旧样本。数据淘汰后撤销对应覆盖；抽取失败也撤销失效的客户端覆盖，不继续声称原音存在。

映射仍是浏览器时钟估计，不是经过验证的声学对齐。连续性检查约 120 ms 的容差不是“音素精度 ±120 ms”。JSON3 的词尾仍保留原有估算/缺失状态。

显式补录从目标起点前最多 0.5 秒开始，到末尾后约 0.3 秒结束，为启动与边界留上下文。如果句子从视频 0 秒开始、首次有效采样晚于句首，仍可能无法完整覆盖；不伪造缺失帧。目标视频、广告、配音音轨与真实说话人一致性仍需另外验证。

## 4. 资源与版本边界

- PCM 缓冲同时受 10 分钟时间窗口和 64 MiB 字节限制，以先达到者为准；较高采样率能保留的时长更短。
- 空闲、缺少有效播放遥测、用户录音/回放或隐藏页面时不持续积累新的合格原音。
- 单句抽取最长 60 秒，WAV 还受独立字节上限限制。过长句子保留普通播放，不谎报完整声学准备。
- 提取记录使用 capture ID；应用特征缓存绑定来源、共享句子 ID、精确请求边界与分析版本。当前只存在于本页面来源会话，不向其他用户共享。
- 特征缓存沿用最多 20 项、一份同时推理、至多两份待分析原音及 12 MiB 总原音预算。准备页只预取前三句，Shadow 只预取当前句及后两句，避免长片段反复挤出缓存。
- 新协议 `LIBITU_BUFFER_REQUEST/EVENT` v3 与旧 v2 共存，但共享单一媒体归属锁，禁止两个会话同时占用标签页音频。
- 保留 45 秒页面心跳租约、30 分钟会话上限及异常清理。扩展重启不恢复原始音频。

## 5. 分析能力没有越界

继续调用现有本地 Silero V5 / Pitchy 测量。模型按需加载；基本听读和录音不等待原音高级分析。

Sound 仍是词典/文字规则候选，实际音素与现象仍显示未评估。Rhythm 是语音跨度与停顿；Melody 是相对音高与音域。对齐、词/句重音、整体发音分数和 CEFR 评估均未因本次采集改造自动获得。

## 6. 与文件目标架构、云端部分的关系

本次是用户提供的新流程所对应的**本地采集改进**。它不能消除首次 Chrome 授权和未听内容的实时补录等待。[文件式原音目标架构](STAGE_TWO_FILE_REFERENCE_ARCHITECTURE.md)仍是避免这些成本的另一条来源依赖路径，尚未实现。

产品决策已确认：同一来源、同一页面会话内只做一次显式 Chrome 工具栏授权，切句、切片和 Stage 1/2 切换复用该会话；服务器可以保存经过身份验证的用户录音、分析证据和进度记录。第三方 YouTube 原音只有在来源权利允许时才进入文件化服务器流程，普通链接不上传。本次仍只完成本地、可逆、显式开启的实现，没有上传第三方媒体或创建公共音频缓存。

云端处理还需实际媒体接入/存储、任务恢复、身份与目的控制、版本化评估，以及经过验证的对齐/检测模型。不能把这些写成已完成的“受控接口”，本次没有新增媒体 API。

## 7. 实现位置与验证

- `apps/extension/src/buffer-capture.js`、`buffer-bridge.js`：授权、来源归属、协议与请求限额。
- `apps/extension/src/buffer-offscreen.js`、`buffer-worklet.js`、`buffer-pcm.js`：实际媒体生命周期、PCM 缓冲、时间映射、覆盖和 WAV。
- `apps/web/features/stage-two/reference/buffered-reference.ts`、`use-buffered-reference.ts`：来源级会话、遥测、抽取及迟到消息隔离。
- `apps/web/features/stage-two/analysis/use-buffered-analysis.ts`：按句需求提取并进入有界本地分析队列。
- `StageOneReader`、`StageTwoShadowing`、`BufferedReferencePanel`：跨阶段拥有者、覆盖/就绪显示与显式补录。

单元验证覆盖数据空洞、暂停/变速/seek、来源/generation 变化、缓冲淘汰、最新捕获选择、WAV 结构、请求取消、会话回收和失效覆盖。浏览器验证使用模拟 API/播放器/扩展授权边界，另外运行实际 AudioWorklet、Silero/Pitchy 和 MediaRecorder；它不替代真实 Chrome 工具栏授权与目标 YouTube 视频的人工验收。最终运行结果记录在 `TASK.MD`。
