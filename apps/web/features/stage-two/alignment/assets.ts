export const ALIGNMENT_ASSET_PATH = "/acoustic-assets/local-alignment-v1/";
export const ALIGNMENT_MODEL_FILE = "charsiu-en-fc-10ms-int8.onnx";
export const ALIGNMENT_MODEL_SHA256 = "53f5b163ea1f9f995ecf38bfc91994411505d8a970b912cf6b5544c8f28e916d";
export const ALIGNMENT_MODEL_BYTES = 123010803;

/** charsiu/tokenizer_en_cmu vocabulary; the model emits 42 classes, not IPA. */
export const PHONE_IDS: Readonly<Record<string, number>> = {
  "[SIL]": 0, NG: 1, F: 2, M: 3, AE: 4, R: 5, UW: 6, N: 7, IY: 8,
  AW: 9, V: 10, UH: 11, OW: 12, AA: 13, ER: 14, HH: 15, Z: 16, K: 17,
  CH: 18, W: 19, EY: 20, ZH: 21, T: 22, EH: 23, Y: 24, AH: 25, B: 26,
  P: 27, TH: 28, DH: 29, AO: 30, G: 31, L: 32, JH: 33, OY: 34, SH: 35,
  D: 36, AY: 37, S: 38, IH: 39, "[UNK]": 40, "[PAD]": 41,
};
