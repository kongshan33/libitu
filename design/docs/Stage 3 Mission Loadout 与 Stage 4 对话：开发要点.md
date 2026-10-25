# Stage 3 Mission Loadout 与 Stage 4 对话：开发要点

ToneFlow（libitu）· 2026-10-25 · 依据：Stage 3 交互原型（含评论中的决定）与相关讨论。文中「已确认」表示你明确定下的，「建议」表示我提出、待你确认的。

## 1. 目标与范围

- 目标：让用户少做选择就能开始一次对话练习，同时保证 logic（对话结构）、场景、目标表达三者配套，对话里真的用得上。
- 范围：Stage 3 Mission Loadout 页面；规划（plan）生成与匹配；Stage 4 对话的行为要求。
- 不在范围：Stage 5 统计页；语料入库流程（只列出需要新增的字段）。

## 2. 已确认的产品决定

- 目标表达（chunk、idiom、structure）最多选 5 个，不区分 primary / opportunity。
- 默认路径是 Quick start：零选择即可开始；手动选择是覆盖，不是必经步骤。
- Quick start 展示 3 个推荐表达，每个标注它对应的 logic 阶段。
- logic、场景、表达是配套的一组，但用户仍可自由选任意 chunk。
- 对话方的默认行为（不是选项）：① 用到目标表达时先说一遍，用户模仿；② 用户在语法、用词或发音上出错时，对话方纠正一遍。
- 去掉「目标没用上时提醒」的开关。
- 需要「全部语料」抽屉：搜索、按功能分类筛选，与主页面共用选择。
- Free conversation：无目标、无 logic。

## 3. 核心概念与数据模型

### 3.1 功能分类（建议，替代现有 8 类）

| 大类 | 子功能 |
| --- | --- |
| Open & structure | framing、signposting、summarising、concluding |
| Inform & explain | describing、giving examples、data/trends、cause & effect |
| Stance | emphasising、hedging、evaluating、agreeing/disagreeing |
| Align & respond | acknowledging、conceding、reframing、pushing back |
| Ask & propose | requesting、proposing、offering、declining |
| Clarify & repair | clarifying、checking understanding、rephrasing、correcting |
| Social | small talk、reacting、thanking、apologizing |
| Narrate（日常） | setting the scene、sequencing、complication、reflecting |

规则：每条语料有一个大类（必填）和若干子功能（可选）。没有可复用功能的条目（纯词汇、绑定原视频语境的句子）标为 vocabulary 或 context-bound，不进 loadout。

### 3.2 数据结构（建议）

```ts
LogicTemplate {
  id, family: 'workplace' | 'daily', name, goal,
  stages: [{ name, function }],      // 每个阶段对应一个功能大类
  version
}
SceneSeed {
  id, logicId, family, text,         // 预置场景描述，每个 (logic x family) 3-5 条
  roleUser, rolePartner
}
CorpusItem (在现有字段上新增) {
  function,                          // 功能大类，必填
  subFunctions[],                    // 可选
  loadoutEligible                    // 是否可进 loadout
}
UsageStat (user x item) {
  missionCount, utcDates[], sceneFamilies[],
  lastUsedAt, independentUseCount
}
MissionPlan {
  logicId | null,                    // null = Free conversation
  scene: { seedId } | { text },
  targets: [{ itemId, stageIndex | null, pinned }],   // 最多 5 个
  prefs: { family, difficulty, feedback },
  origin: 'quick' | 'manual'
}
```

### 3.3 推荐标签

Never used、Due for review、From recent videos 由 UsageStat 与语料来源计算。Due 的规则待定，建议先用固定间隔。

## 4. Stage 3 页面行为

### 4.1 页面结构（已确认，见原型）

1. 顶部 Quick start 卡片：logic、3 个表达（阶段标签 + 推荐理由）、场景、偏好摘要；按钮 Start mission / Shuffle picks / Adjust。
2. 「自己选目标」区：筛选 chip（Recommended / Due for review / Never used / From recent videos），按 logic 阶段分组展示，选中显示对勾。
3. 「Browse the full corpus by function」打开右侧抽屉。
4. Advanced（折叠）：Mission preferences、Choose a scene myself、Logic template、Practice history。
5. 右侧栏：Loadout preview（标签、logic、已选表达及阶段）、Start 按钮、Free conversation 按钮、固定说明句。

### 4.2 Start 按钮文案

| 状态 | 文案 |
| --- | --- |
| 未选择 | Quick start |
| 选了 n 个 | Start with n target(s) |
| Free conversation | Start free conversation |

### 4.3 Quick start 推荐算法（规则，不用 LLM）

1. 场景族：默认取用户上次的。Workplace 用工作类 logic，Daily life / Travel 用日常类。
2. 选 logic：对每个候选 logic 计算覆盖分（有多少阶段能找到 Never used 或 Due 的表达），取最高；并列时避开上次用过的 logic。
3. 逐阶段选表达：按阶段顺序，每个阶段最多一条；排序为 Never used > Due > From recent videos；已选的不重复；最多 3 个。
4. 没有对应功能表达的阶段跳过；不足 3 个时用剩余表达补齐，标为 Any stage。
5. 场景：从该 (logic x 场景族) 的 SceneSeed 里选一条，换一组时轮换。
6. Shuffle：logic、场景、表达一起换；转完一圈后同一阶段轮换另一条候选。

### 4.4 手动选择规则

- 上限 5 个，超出提示；再次点击取消。
- 手动选的标为 pinned，replan 不会替换。
- 手动选择后，Quick start 卡片仍保留作为 AI 方案；点卡片里的 Start 会清空手动选择并改用 AI 方案。
- 每个已选表达在侧栏显示它在当前 logic 里的阶段；对不上显示 Any stage。
- 如果换一个 logic 能覆盖更多已选表达，给一句建议由用户决定，不静默切换。

### 4.5 全部语料抽屉

搜索（表达、释义、功能）、功能筛选 chip、按功能分组、选中对勾、底部「n / 5 selected」与 Done。选择与主页面共用同一份状态。

### 4.6 Advanced

- Mission preferences：场景族（Workplace / Daily life / Travel）、难度（Guided / Natural / Stretch）、反馈（Detailed / Light / Summary only）。
- Choose a scene myself：Let AI choose / I will choose；自填场景不超过 500 字；自填时覆盖 SceneSeed，由 LLM 解析后匹配 logic。
- Logic template：Workplace / Daily life 切换，点选即指定，再点一次回到 AI 推荐。
- Practice history：规则为 3 次 Mission、2 个 UTC 日期、跨 2 个场景族才算可靠独立使用（这是练习规则，不是掌握度评分）；展示当前目标各自的进度。原型里的数字是示例数据。

## 5. replan 规则（让三者配套）

函数：replan(plan, change) 返回新的 plan，是纯函数，在前端本地执行。依赖顺序：场景族 → logic → 场景种子 → 表达。

| 变化 | 处理 |
| --- | --- |
| 换场景族 | 提示换 logic，不静默替换 |
| 换 logic | 保留仍适配的已选表达，其余重新分配阶段；非 pinned 的重新补齐；场景种子跟着换 |
| 自填场景 | 交 LLM 解析并匹配 logic；logic 可手动覆盖 |
| 增删表达 | logic 不变；无对应阶段的标 Any stage；检查是否有更优 logic 并提示 |
| Shuffle | 非 pinned 部分全部重算 |

约束：pinned 永不被覆盖；表达总数不超过 5；Free conversation 时 logic 为 null、targets 为空。

## 6. 前后端分工与接口

### 6.1 原则

- 匹配与推荐是确定性计算，数据量小（几百条语料）：前端拉一次摘要，本地计算，切换才会即时。
- 服务端负责持久化、使用统计、LLM 生成。
- 不要把 loadout 规划放进 Python worker 队列轮询（Stage 2 那种模式延迟大），走普通 API 或 RPC。

### 6.2 接口（建议）

| 接口 | 作用 |
| --- | --- |
| GET /loadout/bootstrap | 返回 logic 模板、SceneSeed、用户语料摘要（含功能、标签、UsageStat 摘要） |
| POST /missions | 保存 MissionPlan，创建 Mission，返回 missionId |
| POST /missions/:id/brief | 触发 LLM 生成 SessionBrief（流式返回） |
| GET /practice-history?itemIds= | 返回目标的独立使用进度 |
| POST /missions/:id/events | 写入对话事件（见 7.7） |

### 6.3 LLM 调用时机

- 只在 Start 之后生成 SessionBrief（场景说明、对话方开场、逐阶段开口机会），流式输出，页面显示 Preparing a scene。
- 可选预取：loadout 打开时对默认方案后台生成一份，用户修改就丢弃。
- 缓存键：hash(logicId, seedId, itemIds, difficulty)。
- 自填场景文本需要 LLM 解析，同样异步处理，不阻塞页面切换。

## 7. Stage 4 对话要求

### 7.1 总原则

- 对话方是自然的交谈对象，不是考官：先顺着场景交流，再在合适位置带出目标表达。
- 每个目标表达都要有被用到的自然位置（开口机会），由 logic 阶段决定。
- 对话方的两条默认行为（已确认）：示范一遍让用户模仿；用户出错后纠正一遍。

### 7.2 SessionBrief（LLM 生成，结构化，建议）

```ts
SessionBrief {
  scene: { setting, roleUser, rolePartner, opening },
  logic: { id, stages: [{ name, goal }] },
  stagePlan: [{
    stageIndex,
    targetItemId | null,         // 该阶段要带出的表达，可为空
    slot: string,                // 对话方制造的开口机会，例如一个问题或一个质疑
    modelLine: string | null     // 对话方示范该表达的自然说法
  }],
  difficulty, feedback
}
```

生成后做校验：每个有目标的阶段都有 slot 和 modelLine；modelLine 必须包含目标表达；不满足则重试。

### 7.3 阶段状态机（建议）

- 状态：当前阶段、已示范的表达、已尝试的表达、已纠正的错误。
- 推进：用户在当前阶段完成一次有效发言就进入下一阶段；用户卡住（沉默或明显不会）时，对话方给提示或示范。
- 用户中途跑题：对话方先接住，再用 slot 把话题拉回当前阶段。
- 阶段名不对用户展示成清单，只可选地在侧边提示当前所处的结构位置。

### 7.4 规则 A：示范一次，用户模仿（已确认）

- 触发：进入有目标表达的阶段，且用户还没有自发用出该表达。
- 做法：对话方在一句自然的话里说出该表达（modelLine），不加「请跟我说」之类的指令，然后用 slot 的问题让用户有机会接话。
- 每个表达每次 Mission 只示范一次；用户模仿之后不重复示范。
- 模仿判定（建议）：用户后续话语里出现该表达（允许时态、人称变化），记为 attempted；可复用 Stage 2 的内容校验思路（词匹配率分档）做容错。
- 用户没有接话：本阶段不追问，继续推进；该表达在事后反馈里列为「未尝试」。
- 用户自发先用了该表达：不示范，记为独立使用。

### 7.5 规则 B：出错纠正一遍（已确认）

- 范围：语法、用词/表达、发音。
- 方式：对话方用自然复述（recast）说出正确版本，然后继续对话，不停下来讲解。
- 每个错误只纠正一次；同一错误重复出现不再重复纠正，计入事后反馈。
- 纠正强度跟随 Feedback 设置（建议）：Detailed 每个明显错误都纠正；Light 只纠正影响理解或与目标表达有关的错误；Summary only 对话中不纠正，全部放到结束后。
- 同一轮有多个错误（建议）：只纠正最重要的一个（影响理解或涉及目标表达），其余留到事后。
- 发音：对话回合内只能做轻量判断（ASR 词级不匹配）。完整的音素分析依赖 MFA，你本地实测单次约 17–34 秒，不能放进对话回合，应在对话结束后异步生成。

### 7.6 难度与对话方行为（建议）

| 难度 | 行为 |
| --- | --- |
| Guided | 开口机会明确，对话方示范表达并留出空间，等待用户 |
| Natural | 开口机会隐含，只示范一次，不额外等待 |
| Stretch | 不示范表达（用户需自发使用），只在事后反馈里给出示范 |

### 7.7 数据与事件

对话中记录事件：stage\_entered、target\_modeled、target\_attempted、target\_used\_independently、correction\_given（类型：语法 / 用词 / 发音）、turn\_text 与音频引用。

「独立使用」的定义（建议）：用户在对话方示范该表达之前，或示范之后又经过至少一个无关话轮，自发使用该表达。写入 UsageStat，供 Practice history 判断「3 次 Mission、2 个 UTC 日期、跨 2 个场景族」。

### 7.8 对话结束后

- 事后反馈：目标表达的使用情况（独立使用 / 模仿 / 未尝试）、被纠正的错误汇总、发音分析（异步）、「你本来可以用的表达」。
- 回流：从对话里提取用户想说但没说出来的表达，一键存入语料库。
- 更新 UsageStat 与 Practice history。

### 7.9 Free conversation

无 logic、无目标；对话方只顺着话题聊，规则 B（出错纠正一遍）仍然生效；结束后提取可学表达回流语料库。

### 7.10 性能预算（建议）

- 对话回合的响应延迟以流式首字为准；需要 LLM 的纠正与复述在同一次回复内完成。
- 任何需要 MFA、forced alignment 的分析一律异步，放到对话结束后。

## 8. 待确认与风险

- 功能分类是否改成上面的 7+1 类：现有语料需要重新标注，旧 8 类到新类的映射要做迁移。
- Due for review 的规则（固定间隔，还是按使用情况）。
- 场景种子的数量与来源：人工预置，还是 LLM 批量生成后审核。
- 自填场景如何解析并匹配 logic，失败时的兜底。
- 独立使用的判定边界（示范后间隔几个话轮算独立）。
- Feedback 三档的具体纠正阈值，需要在真实对话里调。
- 示例数据：原型里的语料、进度数字、推荐理由都是示意，不代表真实规则。

## 9. 建议开发顺序

1. 数据层：功能分类字段、LogicTemplate、SceneSeed、UsageStat。
2. bootstrap 接口与前端本地 replan（含 Quick start 推荐）。
3. Loadout 页面（按原型实现，含抽屉）。
4. MissionPlan 保存与 SessionBrief 生成（流式 + 校验 + 缓存）。
5. Stage 4 状态机与规则 A / B。
6. 事件记录、事后反馈、Practice history 联动。
7. 预取与性能优化。
