# 音频智能断句 + 逐词高亮需求

## 1. 产品目标

我们正在开发一个英语听力/口语模仿产品。

核心目标不是把英语音频切成大量短句方便初学者逐句学习，而是：

> **尽可能保留母语者自然、完整的一次性表达，让用户模仿真实英语的语流、节奏、语调和完整表达方式。**

因此需要同时解决两个独立问题：

1. **Utterance Segmentation**：把连续音频划分成自然、完整的表达单元。
2. **Word-level Alignment**：获得每个单词精确的时间戳，用于播放过程中的逐词高亮。

两者必须解耦：

```text
Utterance = 用户一次完整模仿的单位
Word      = UI 高亮和定位的最小单位
```

不能为了实现逐词高亮而把音频切成大量小 segment。

---

# 2. Utterance 切分原则

## 2.1 不采用“学习型碎片化切分”

例如：

```text
I think /
one of the biggest problems we have right now /
is that people don't really understand /
how these models work.
```

这种切法虽然降低了单次跟读难度，但破坏了母语者原本的：

- rhythm
- prosody
- information packaging
- intonation contour
- natural speech flow

因此不符合本产品目标。

---

## 2.2 我们需要的是 Native-like Utterance Segmentation

例如原始表达：

```text
I think one of the biggest problems we have right now
is that people don't really understand how these models work.
```

如果说话者实际上是一口气完成，且不存在明显 utterance boundary，则应该：

```text
[Segment 1]

I think one of the biggest problems we have right now
is that people don't really understand how these models work.
```

如果说话者在中间存在明显自然边界，可以：

```text
[Segment 1]

I think one of the biggest problems we have right now

[Segment 2]

is that people don't really understand how these models work.
```

核心原则：

> **宁可 segment 稍长，也不要为了长度而破坏完整表达。**

---

# 3. 不应该作为强制切分条件的信号

以下情况不能单独决定切分：

### 标点符号

逗号不代表一定需要切分。

### 从句

不能因为遇到：

```text
that
which
who
because
although
if
when
but
and
```

就自动切分。

### 短暂停顿

自然英语内部经常存在 hesitation / micro pause。

因此：

```text
pause > 300ms
```

不能简单等价于：

```text
new segment
```

### 固定长度

不要使用：

```text
每 3 秒切一次
每 5 秒切一次
每 N 个单词切一次
```

这样的机械规则。

Segment 长度应该是约束条件，而不是主要决定因素。

---

# 4. 推荐的边界判断

一个高置信度 utterance boundary 应综合考虑：

```text
Acoustic boundary
        +
Prosodic boundary
        +
Semantic/Syntactic completeness
```

可以考虑的信号包括：

### Acoustic

- pause duration
- breath
- silence
- speaker change

### Prosody

- pitch reset
- final lowering
- final rising
- F0 contour completion
- energy decay
- rhythm boundary

### Linguistic

- sentence completion
- clause completion
- semantic completeness
- discourse structure
- punctuation

其中：

> **ASR 负责“说了什么和什么时候说”，AI/LLM 负责理解表达结构，prosody/acoustic features 帮助判断说话者是否真的完成了一次表达。**

---

# 5. Segment 长度

不要强制限制为传统精听产品常见的 2–6 秒。

建议：

```text
Typical: 5–15 seconds
Acceptable: up to ~20 seconds
```

但不要把这个设计成硬规则。

如果一个自然表达持续 16 秒：

```text
16-second coherent utterance
```

应该优先保留完整表达，而不是机械切成：

```text
5s + 5s + 6s
```

---

# 6. ASR Pipeline

推荐整体流程：

```text
YouTube / uploaded audio
          ↓
     audio extraction
          ↓
     VAD / diarization
          ↓
          ASR
          ↓
 transcript + timestamps
          ↓
 word-level forced alignment
          ↓
 precise word timestamps
          ↓
 utterance boundary detection
     ↙        ↓         ↘
 acoustic   prosody   semantic
 signals    signals     / LLM
          ↓
 final utterance segments
```

ASR 可以考虑：

```text
Whisper
faster-whisper
```

Word-level alignment 可以考虑：

```text
WhisperX
```

或其他 forced-alignment solution。

---

# 7. LLM 的职责

不要让 LLM 直接生成毫秒时间戳，例如不要依赖：

```json
{
  "start": 12.432,
  "end": 18.756
}
```

LLM 更适合负责：

> 判断哪些 words 应该属于同一个完整表达。

例如 ASR/alignment 已经获得：

```text
word[0]  I
word[1]  think
word[2]  one
word[3]  of
...
word[20] work
```

LLM 可以输出：

```json
[
  {
    "start_word": 0,
    "end_word": 20
  }
]
```

程序再通过：

```text
words[start_word].start
words[end_word].end
```

得到真正的 audio timestamp。

这样可以避免 LLM hallucinate timestamps。

---

# 8. 逐词高亮

逐词高亮和 segment 切分是两个完全独立的问题。

例如一个完整 segment：

```text
I think one of the biggest problems we have right now
is that people don't really understand how these models work.
```

底层保存：

```json
{
  "start": 12.4,
  "end": 20.86,
  "text": "I think one of the biggest problems we have right now is that people don't really understand how these models work.",
  "words": [
    {
      "word": "I",
      "start": 12.4,
      "end": 12.55
    },
    {
      "word": "think",
      "start": 12.55,
      "end": 12.93
    },
    {
      "word": "one",
      "start": 13.02,
      "end": 13.2
    }
  ]
}
```

播放器根据：

```text
word.start <= currentTime < word.end
```

决定当前 active word。

因此可以：

```text
完整播放 10 秒 utterance
             +
播放过程中逐词高亮
```

不需要把 10 秒音频切成十几个小文件。

---

# 9. 推荐数据层级

建议使用：

```text
Video
 │
 ├── Utterance / Segment
 │      ├── id
 │      ├── start_time
 │      ├── end_time
 │      ├── text
 │      │
 │      └── Words[]
 │             ├── text
 │             ├── start_time
 │             ├── end_time
 │             └── confidence
 │
 └── ...
```

如果后续需要做 pronunciation analysis：

```text
Video
 └── Utterance
       └── Word
             └── Phoneme
                   ├── phoneme
                   ├── start
                   ├── end
                   └── score
```

也就是：

```text
Utterance
    ↓
Word
    ↓
Phoneme
```

三个层级分别服务：

```text
Utterance → 完整表达 / shadowing / loop playback

Word      → 逐词高亮 / 点击播放 / word-level feedback

Phoneme   → 发音分析 / pronunciation scoring
```

---

# 10. 实现时的重要约束

Codex 在实现 segmentation pipeline 时，请遵守以下原则：

1. 不要把 VAD segment 直接当作最终 utterance。
2. 不要把 ASR segment 直接当作最终 utterance。
3. 不要根据标点机械断句。
4. 不要根据固定秒数机械断句。
5. 不要因为 clause 存在就自动切分。
6. 不要为了逐词高亮把 utterance 拆碎。
7. Word timestamp 和 utterance boundary 必须分开建模。
8. 优先保持 native speaker 原始 speech flow。
9. 边界应该综合 acoustic + prosody + linguistic information。
10. LLM 负责语言结构判断，不负责凭空预测精确 audio timestamp。

---

# 11. MVP 建议

第一阶段不需要一开始就实现复杂的 prosody model。

可以先实现：

```text
faster-whisper
      ↓
ASR transcript
      ↓
word timestamps / WhisperX alignment
      ↓
punctuation + pause information
      ↓
LLM semantic utterance segmentation
      ↓
boundary snapping to word timestamps
      ↓
final segments
```

即：

```text
Audio
 → ASR
 → Word Alignment
 → Semantic Segmentation
 → Timestamp Mapping
 → Utterances
```

后续第二阶段再加入：

```text
F0 / pitch
energy
pause
breathing
prosodic boundary detection
```

优化 native-like segmentation。

---

# 12. 最终验收标准

最终效果不是：

> “能不能把音频切成句子？”

而应该判断：

> **“这个切分位置是不是母语者自然结束一次表达、学习者也适合在这里结束一次完整模仿？”**

一个好的 segment 应：

- 语义基本完整
- 不破坏明显的句法依赖
- 保持自然语流
- 保持完整 intonation contour
- 不因固定时长被机械切断
- 可以自然地一次 shadowing
- 内部拥有准确 word-level timestamps
- 播放时能够流畅逐词高亮

最终目标：

```text
Native speech
      ↓
Natural utterances
      ↓
Word-level synchronization
      ↓
Whole-utterance imitation
      ↓
Pronunciation / rhythm / intonation analysis
```

核心产品原则：

> **Preserve the speaker's natural utterance first; optimize learning interaction around it, rather than destroying the utterance to make learning easier.**