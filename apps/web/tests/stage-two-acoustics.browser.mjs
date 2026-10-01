// Compatibility entrypoint for the original acoustic browser regression command.
// The buffered v3 flow supersedes the per-sentence v2 UI. The current suite keeps
// actual Silero/Pitchy inference, microphone replay, dual-speaker Rhythm/Melody,
// Sound abstention, shared workers/cache, and no-upload assertions. It also runs
// the extension's actual AudioWorklet → PCM → WAV path with a synthetic source.
import "./stage-two-buffered-reference.browser.mjs";
