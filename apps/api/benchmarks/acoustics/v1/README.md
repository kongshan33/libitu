# Libitu 离线声学基准 v1

这一目录提供可执行的数据/结果契约与评测工具。当前种子集是 **16 条真实录音、4 位成人说话人、49.107 秒，全部 dev**：8 条 CMU ARCTIC 参考录音、8 条 SpeechOcean762 中国英语学习者录音。两边句子未配对，`reference_sample_id=null`；不能拿不同内容直接比较。

64 个目标都是**待人工选取位置的标注任务**（每段各一个 pause、F0、vowel length、linking gap），不是已发现的 64 次现象。当前已仲裁金标为 **0**，模型运行次数为 **0**。尚未达到前期建议的 200–300 条带标注基准规模。`collection_plan.json` 另列 256 条未来控制采集计划；计划录音不计入真实样本数量。

## 快速使用

在仓库根目录执行。使用已有 API `.venv`；首次环境安装遵循 `apps/api/README.md`。无需新增声学模型、云服务或 API key。

```bash
# 恢复已锁定的16个小WAV；已有文件只校验，不重复下载或覆盖
pnpm --filter @libitu/api benchmark:seed

# 严格离线核对缓存
pnpm --filter @libitu/api benchmark:seed --verify-only

# 验证提交的清单、真实WAV参数/完整性与分组；音频根相对 apps/api
pnpm --filter @libitu/api benchmark:acoustics validate benchmarks/acoustics/v1/public_seed/manifest.json --audio-root ../../.cache/acoustic-benchmark/public-seed

# 生成独立的结果填写模板；所有目标均 not_evaluated，绝不调用模型
pnpm --filter @libitu/api benchmark:acoustics new-run benchmarks/acoustics/v1/public_seed/manifest.json --run-id trial-001 --output ../../.cache/acoustic-benchmark/trial-001.json

# 先验证真实文件，再评估；当前将报告 no_eligible_annotations
pnpm --filter @libitu/api benchmark:acoustics evaluate benchmarks/acoustics/v1/public_seed/manifest.json --audio-root ../../.cache/acoustic-benchmark/public-seed --results ../../.cache/acoustic-benchmark/trial-001.json --split dev
```

`--output` 可将 validate/evaluate 报告保存为 JSON。输出文件默认拒绝覆盖；换一个名字保留旧记录。命令不访问在线练习 API。`validate` 不传 `--audio-root` 只校验元数据，明确标为 `metadata_only`；`evaluate` 必须传音频根并检查文件。错误退出码为 2，不把无金标误当解析失败。

音频仅在 `.cache/acoustic-benchmark/public-seed/`，不提交 Git。来源记录、逐文件哈希、许可/完整署名见 [SOURCES.md](SOURCES.md)、[public_seed/LICENSES.json](public_seed/LICENSES.json)。下载器限定确切的 16 个文件和 URL，单文件上限 2 MiB，不解压档案，不追随重定向。CMU 原始站点是 HTTP，校验和锁定本次取得的字节，但不提供传输认证。用户未授权的 Glossika 资料不在此种子集。

需要复现 manifest 时，先恢复音频，再写到一个新路径：

```bash
pnpm --filter @libitu/api benchmark:prepare-seed --output ../../.cache/acoustic-benchmark/seed-rebuilt.json
```

转换器保留原始文本和音频，质量保持未审、转写为 `provided`，不导入原数据集的发音分数，不运行词典或规则预测。

## 统一格式

`app/schemas/acoustic_benchmark.py` 中的 Pydantic 模型是唯一真源；[schemas/manifest.schema.json](schemas/manifest.schema.json) 与 [schemas/results.schema.json](schemas/results.schema.json) 是导出的交换格式。本轮没有前端消费者，不创建重复 TypeScript 定义，也不修改在线 Sound API。

| 对象 | 含义 |
|---|---|
| Manifest / Sample | 数据集/样本版本、说话人、来源分组、split、参考/学习者角色、独立音频与转写哈希、来源许可 |
| Target.rule_candidate | 可选的条件规则与版本；与人工标签、声学观测分开 |
| Target.annotation | pending / single_review / adjudicated / synthetic；分类标签、物理测量、独立标注者与理由 |
| SampleResult | 精确绑定 sample/audio/transcript/role；quality、content、alignment 分别有 gate |
| Observation | measured / detected / not_detected / uncertain / not_evaluated / not_supported / rejected；没有发音总分 |
| ResultFile | run_id、pipeline/模型版本及可选 calibration_id；参考与学习者各自有结果记录 |

时间相对各自 WAV，单位秒；词范围使用 `transcript.text.split()` 的半开索引。本轮只存每个目标每个名称一个标量；更多 F0 窗口用独立 target，逐帧轨迹/DTW 后续扩展。不同编码、裁切、转写或标注修订必须保留新文件/数据版本。报告还包含完整 manifest 的规范化 SHA-256，以识别具体标注修订。

新格式记录 `training_allowed=false` 表达本轮只做基准的用途选择；它不否定上游公开许可允许的其他使用。每个目标的实际许可条件仍来自 source 和来源登记。

置信度不是物理测量值。只有 detected/not_detected 可填 confidence，且需要 calibration_id；无校准时用 null。它表示“所输出结论成立的概率”，因此 not_detected 的 `P(present)=1-confidence`。仅填写一个 calibration_id 不能证明模型已校准，评测报告不会据此放行产品。

定位判断必须通过三项 gate；只有限定名称的 pause/F0 描述性测量可不依赖内容/音素对齐。校验器还拒绝非有限数值、单位错配、时间越界、重复目标、合成金标混入真人集，以及同一说话人/来源分组/音频哈希/原始 source record 跨 split。

## 开始人工标注

按 [ANNOTATION.md](ANNOTATION.md) 操作，复制原 manifest 到新的私有工作路径，两位标注者分别保留初标。源文本尚未人工核对；核对后更新原样 UTF-8 文本哈希和全部词索引，保留读错、漏词与重复。`reference_sample_id` 表达同一练习目标关系，实际用户转写可以与参考不同，不能为“配对成功”删掉读错的样本。

先人工选择真实目标词/区间；必要时拆分多个 occurrence，未找到适用位置用 not_applicable，听不清用 uncertain。可靠时长/F0用 label=null 的连续测量，不贴“对/错”。未审状态不能预填标签、数值或标注者。两次独立初标和仲裁记录保存在 notes 引用的位置；列出两个标注者 ID 本身不是已复核的证明。

## 评测口径与边界

- 默认只评 test；当前种子全部 dev，须显式 `--split dev`，报告为 exploratory。不会自动把 dev 当 test。
- 真人集只使用 adjudicated；pending、single_review、uncertain、not_applicable 不充当负例。若不确定类别下仍有可靠物理量，另建已仲裁、label=null 的测量目标。
- 每现象分别报告决定覆盖率、混淆计数、precision/recall/F1、包含弃权阳性的端到端 recall；缺预测留在分母。连续量报告 MAE、bias、覆盖率。零分母用 null。
- 按角色、说话人和条件分别报告。confidence 存在时计算带明确样本量的 Brier；没有校准数据时不生成概率或准确率承诺。
- 这只是**已指定目标上的评测**。事件发现、额外误报匹配、音素边界误差、逐帧 F0/八度错误、DTW、标注者一致性、置信区间和产品评分仍待后续实现。
- 12 项各自统计，不生成跨现象总分；drop_d 是 elision 子类，不能把两者条数相加当独立事件。小种子缺少独立 test、足够说话人和金标；`release_ready` 始终为 false。
- 合成测试只检验工具和指标计算，显式 `--allow-synthetic` 才能评 synthetic_smoke；不能据此报告人类语音效果。

重新导出 Schema（语义/跨文件校验仍需 Python 校验器）：

```bash
pnpm --filter @libitu/api benchmark:acoustics schemas --output-dir benchmarks/acoustics/v1/schemas --replace
```

最小下一交付是冻结第一批独立人工标注，再接入真实离线引擎。音素对齐、声学检测、线上媒体 F1–F5 均未由这一基准工具实现。

验证记录（2026-09-13）：16/16 真实 WAV 的完整性通过；未运行模板的报告为 64 个 not_evaluated、0 个可评金标。新增 115 个离线契约/指标回归通过，根目录 lint/build/test 通过（671 tests）。这些结果验证软件和数据链路，不验证语音检测准确率。
