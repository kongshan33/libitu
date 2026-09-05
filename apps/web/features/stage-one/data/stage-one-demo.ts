import type { CorpusItem, LogicNode, TranscriptLine } from "@libitu/types/stage-one";

export const logicNodes: LogicNode[] = [
  {
    id: "l1",
    title: "Context and stakes",
    subtitle: "Why AI safety matters now",
    time: "0:49",
  },
  {
    id: "l2",
    title: "Conflict and tension",
    subtitle: "Capability versus safety trade-off",
    time: "1:45",
  },
  {
    id: "l3",
    title: "Technical approach",
    subtitle: "Responsible scaling policy",
    time: "1:31",
  },
  {
    id: "l4",
    title: "Outcome and vision",
    subtitle: "Racing to the top",
    time: "2:19",
  },
];

export const chapters = [
  "Why work on AI?",
  "Scaling breakthroughs",
  "Early days of AI",
  "Sentiment shifting",
  "The Responsible Scaling Policy",
  "Founding story",
  "Building a culture of trust",
  "Racing to the top",
  "Looking to the future",
];

export const transcript: TranscriptLine[] = [
  {
    time: "0:42",
    parts: ["And did you meet everyone through Google when you were doing the interpretability stuff, Chris?"],
  },
  { time: "0:48", parts: ["No."] },
  {
    id: "l1",
    time: "0:49",
    parts: [
      "So I guess I actually met a bunch of you when I was 19 and I was visiting - ",
      { text: "I guess", tag: "hedging", kind: "chunk" },
      " I met Dario and Jared then, and I remember thinking ",
      { text: "at the time", tag: "evaluating", kind: "chunk" },
      " it was so exciting.",
    ],
  },
  {
    time: "1:04",
    parts: [
      {
        text: "The problem is not that we lack the technology, but rather that we lack the frameworks",
        tag: "contrast-structure",
        kind: "structure",
      },
      " to deploy it safely.",
    ],
  },
  {
    time: "1:18",
    parts: [
      "And ",
      { text: "to be fair", tag: "acknowledging", kind: "chunk" },
      ", I think the question of whether scaling continues to work is genuinely uncertain.",
    ],
  },
  {
    id: "l3",
    time: "1:31",
    parts: [
      "What we decided was - ",
      {
        text: "given everything we knew, the responsible path forward was",
        tag: "decision-framing",
        kind: "structure",
      },
      " to build safety into the core, not as an afterthought.",
    ],
  },
  {
    id: "l2",
    time: "1:45",
    parts: [
      "So there is ",
      { text: "a real tension here", tag: "framing", kind: "chunk" },
      " between moving fast enough to stay relevant and moving carefully enough to avoid catastrophic mistakes.",
    ],
  },
  {
    time: "2:02",
    parts: [
      "I think ",
      { text: "what I would say is", tag: "hedging", kind: "chunk" },
      " that we have tried to resolve that tension by being extremely transparent about what we are doing and why.",
    ],
  },
  {
    id: "l4",
    time: "2:19",
    parts: [
      {
        text: "The upshot of all this is",
        tag: "summarizing",
        kind: "structure",
      },
      " that safety and capability are not actually opposed - you can race to the top instead of the bottom.",
    ],
  },
];

export const corpusItems: CorpusItem[] = [
  {
    id: "guess",
    kind: "chunk",
    text: "\"I guess\" - softening certainty before a claim",
    tags: ["hedging", "softening"],
    meta: "0:49 - saved to corpus",
    saved: true,
  },
  {
    id: "fair",
    kind: "chunk",
    text: "\"to be fair\" - conceding before a counterpoint",
    tags: ["acknowledging", "softening"],
    meta: "1:18 - click + to save",
  },
  {
    id: "tension",
    kind: "chunk",
    text: "\"a real tension here\" - naming the conflict explicitly",
    tags: ["framing", "acknowledging"],
    meta: "1:45 - click + to save",
  },
  {
    id: "would-say",
    kind: "chunk",
    text: "\"what I would say is\" - buying thinking time naturally",
    tags: ["hedging", "discourse"],
    meta: "2:02 - click + to save",
  },
  {
    id: "problem",
    kind: "structure",
    text: "The problem is not [A], but rather [B]",
    tags: ["contrast", "reframing"],
    meta: "1:04 - syntactic structure",
  },
  {
    id: "given",
    kind: "structure",
    text: "given [premise], the [decision] was to [action]",
    tags: ["justifying", "framing"],
    meta: "1:31 - saved to corpus",
    saved: true,
  },
  {
    id: "upshot",
    kind: "structure",
    text: "The upshot of all this is [conclusion]",
    tags: ["summarizing", "discourse"],
    meta: "2:19 - syntactic structure",
  },
];
