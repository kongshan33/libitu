export type PlaybackRange = { start: number; end: number; loop: boolean };

export type YouTubeTransport = {
  getCurrentTime(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
};

export type YouTubePlayerHandle = {
  seekTo(seconds: number, options?: { autoplay?: boolean }): void;
  play(): void;
  pause(): void;
  setRange(range: PlaybackRange | null): void;
  playRange(start: number, end: number, options?: { loop?: boolean }): void;
  setPlaybackRate(rate: number): void;
};

/** One range owner for both sentence and segment playback, including commands before ready. */
export class YouTubePlaybackController implements YouTubePlayerHandle {
  private player: YouTubeTransport | null = null;
  private range: PlaybackRange | null = null;
  private position: number | null = null;
  private wantsPlay = false;
  private playing = false;
  private rate = 1;
  private seeking: { target: number; deadline: number } | null = null;

  constructor(private readonly events: {
    time(seconds: number): void;
    playback(playing: boolean): void;
    error(message: string): void;
  }) {}

  attach(player: YouTubeTransport): void {
    this.player = player;
    player.setPlaybackRate(this.rate);
    if (this.position !== null) this.seekTo(this.position, { autoplay: this.wantsPlay });
    else if (this.wantsPlay) player.playVideo();
  }

  detach(): void {
    this.player = null;
    this.playing = false;
    this.seeking = null;
  }

  setRange(range: PlaybackRange | null): void {
    if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end)
      || range.start < 0 || range.end <= range.start)) return;
    this.range = range ? { ...range } : null;
  }

  isPausedSeekPending(): boolean {
    return Boolean(this.seeking && !this.wantsPlay);
  }

  isSeekPending(): boolean { return this.seeking !== null; }

  seekTo(seconds: number, { autoplay = false }: { autoplay?: boolean } = {}): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.position = seconds;
    this.wantsPlay = autoplay;
    this.seeking = this.player ? { target: seconds, deadline: Date.now() + 3000 } : null;
    this.events.time(seconds);
    if (!autoplay) this.pause();
    if (!this.player) return;
    this.player.seekTo(seconds, true);
    // YouTube seek from a cued/ended state can start playback; explicitly pause after it.
    if (autoplay) this.player.playVideo();
    else this.player.pauseVideo();
  }

  play(): void {
    this.wantsPlay = true;
    const current = this.player?.getCurrentTime() ?? this.position;
    if (this.range && (current === null || current < this.range.start || current >= this.range.end)) {
      this.seekTo(this.range.start, { autoplay: true });
    } else this.player?.playVideo();
  }

  pause(): void {
    this.wantsPlay = false;
    this.playing = false;
    this.player?.pauseVideo();
    this.events.playback(false);
  }

  playRange(start: number, end: number, { loop = false }: { loop?: boolean } = {}): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;
    this.setRange({ start, end, loop });
    this.seekTo(start, { autoplay: true });
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.rate = rate;
    this.player?.setPlaybackRate(rate);
  }

  onStateChange(state: number): void {
    if (!this.player) return;
    if (state === 1) {
      if (this.seeking && !this.wantsPlay) {
        this.player.pauseVideo();
        return;
      }
      this.playing = true;
      this.wantsPlay = true;
      this.events.playback(true);
    } else if (state === 0 && this.wantsPlay && this.range?.loop && !this.seeking) {
      this.seekTo(this.range.start, { autoplay: true });
    } else if (state === 0 || state === 2 || state === -1 || state === 5) {
      this.playing = false;
      // A pause emitted by an in-flight seek does not cancel its requested play.
      if (!this.seeking) this.wantsPlay = false;
      this.events.playback(false);
    } else if (state === 3) {
      this.playing = false;
    }
  }

  sample(seconds: number): void {
    if (!this.player || !Number.isFinite(seconds)) return;
    if (this.seeking) {
      // A short sentence's old endpoint must not acknowledge a seek back to its start.
      const tolerance = this.range ? Math.min(0.4, (this.range.end - this.range.start) / 2) : 0.4;
      const reached = Math.abs(seconds - this.seeking.target) <= tolerance;
      if (!reached) {
        if (Date.now() >= this.seeking.deadline) {
          this.seeking = null;
          this.pause();
          this.events.error("The video could not reach this position. Please try playing again.");
        }
        return; // Ignore old timestamps while YouTube completes a seek.
      }
      this.seeking = null;
    }
    this.position = seconds;
    if (this.playing && this.range) {
      if (seconds >= this.range.end) {
        if (this.range.loop) this.seekTo(this.range.start, { autoplay: true });
        else {
          this.pause();
          this.events.time(seconds);
        }
        return;
      }
      if (seconds < this.range.start - 0.4) {
        this.seekTo(this.range.start, { autoplay: true });
        return;
      }
    }
    this.events.time(seconds);
  }
}
