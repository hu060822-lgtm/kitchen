/**
 * 背景音樂（程序生成的 16-bit 風格：方波、三角波、雜訊，全部即時合成，不需要音檔）。
 *
 *   title    起始頁面、大廳、打烊：A 小調，慢、有點憂傷
 *   kitchen  營業中：D 小調，低沉的低音與稀疏的琶音，聲音很小，不蓋過廚房的聲音提示
 *   tension  後門的東西在刮門／在場：急促的低音、不和諧的短音、心跳般的鼓
 *
 * 換曲時交叉淡入淡出。音樂用自己的 AudioContext（起始頁面還沒有啟動遊戲音效時也能播），
 * 第一次點擊或按鍵之後才會開始（瀏覽器的自動播放規則）。
 */

export type TrackId = 'title' | 'kitchen' | 'tension';

type Inst = 'lead' | 'arp' | 'bass' | 'bell' | 'noise' | 'kick' | 'stab';
interface Note {
  /** 第幾格（step） */
  s: number;
  /** MIDI 音高（雜訊、大鼓忽略） */
  n: number;
  /** 長度（格） */
  l: number;
  v?: number;
}
interface Track {
  bpm: number;
  /** 每拍幾格 */
  div: number;
  steps: number;
  gain: number;
  parts: Partial<Record<Inst, Note[]>>;
  /** 回音（秒、回授） */
  delay?: [number, number];
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/* ------------------------------ 曲目 ------------------------------ */

/** 和弦分解：每小節 n 格，依序輪流 */
function arp(chords: number[][], stepsPerBar: number, pattern: number[], len = 1, v = 1): Note[] {
  const out: Note[] = [];
  chords.forEach((ch, bar) => {
    pattern.forEach((p, i) => {
      if (p < 0) return;
      out.push({ s: bar * stepsPerBar + i * (stepsPerBar / pattern.length), n: ch[p % ch.length] + 12 * Math.floor(p / ch.length), l: len, v });
    });
  });
  return out;
}

function melody(bars: Array<Array<[number, number, number]>>, stepsPerBar: number, v = 1): Note[] {
  const out: Note[] = [];
  bars.forEach((bar, i) => bar.forEach(([s, n, l]) => out.push({ s: i * stepsPerBar + s, n, l, v })));
  return out;
}

// 起始頁面：Am F C G Am F E7 Am（每個和弦兩小節，八分音符格）
const T_CH = [
  [57, 60, 64],
  [57, 60, 64],
  [53, 57, 60],
  [53, 57, 60],
  [48, 52, 55],
  [48, 52, 55],
  [55, 59, 62],
  [55, 59, 62],
  [57, 60, 64],
  [57, 60, 64],
  [53, 57, 60],
  [53, 57, 60],
  [52, 56, 59, 62],
  [52, 56, 59, 62],
  [57, 60, 64],
  [57, 60, 64],
];
const TITLE: Track = {
  bpm: 76,
  div: 2,
  steps: 16 * 8,
  gain: 0.5,
  delay: [0.39, 0.32],
  parts: {
    bass: T_CH.flatMap((c, bar) => [
      { s: bar * 8, n: c[0] - 12, l: 3, v: 0.9 },
      { s: bar * 8 + 4, n: c[0] - 5, l: 3, v: 0.6 },
    ]),
    arp: arp(
      T_CH.map((c) => c.map((x) => x + 12)),
      8,
      [0, 1, 2, 1, 0, 1, 2, 1],
      1,
      0.35,
    ),
    lead: melody(
      [
        [[0, 76, 3], [3, 74, 1], [4, 72, 2], [6, 71, 2]],
        [[0, 69, 6]],
        [[0, 72, 2], [2, 74, 2], [4, 76, 3], [7, 77, 1]],
        [[0, 76, 4], [4, 72, 4]],
        [[0, 79, 3], [3, 76, 1], [4, 72, 2], [6, 76, 2]],
        [[0, 74, 6]],
        [[0, 71, 2], [2, 72, 2], [4, 74, 2], [6, 71, 2]],
        [[0, 67, 8]],
        [[0, 69, 2], [2, 72, 2], [4, 76, 2], [6, 81, 2]],
        [[0, 79, 3], [3, 76, 5]],
        [[0, 77, 3], [3, 76, 1], [4, 74, 2], [6, 72, 2]],
        [[0, 69, 8]],
        [[0, 71, 2], [2, 74, 2], [4, 68, 4]],
        [[0, 71, 4], [4, 76, 4]],
        [[0, 72, 2], [2, 71, 2], [4, 69, 4]],
        [[0, 69, 6]],
      ],
      8,
      0.8,
    ),
    noise: Array.from({ length: 16 }, (_, bar) => ({ s: bar * 8 + 4, n: 0, l: 1, v: 0.12 })),
  },
};

// 營業中：Dm Bb Gm A（每個和弦兩小節，十六分音符格），很安靜
const K_CH = [
  [50, 53, 57],
  [50, 53, 57],
  [46, 50, 53],
  [46, 50, 53],
  [43, 46, 50],
  [43, 46, 50],
  [45, 49, 52],
  [45, 49, 52],
];
const KITCHEN: Track = {
  bpm: 64,
  div: 4,
  steps: 8 * 16,
  gain: 0.42,
  delay: [0.47, 0.42],
  parts: {
    bass: K_CH.flatMap((c, bar) => [
      { s: bar * 16, n: c[0] - 12, l: 10, v: 0.9 },
      { s: bar * 16 + 12, n: c[0], l: 3, v: 0.35 },
    ]),
    arp: arp(
      K_CH.map((c) => c.map((x) => x + 12)),
      16,
      [0, -1, -1, 2, -1, -1, 4, -1, -1, -1, 3, -1, -1, -1, -1, -1],
      2,
      0.4,
    ),
    bell: K_CH.filter((_, i) => i % 2 === 0).map((c, i) => ({ s: i * 32 + 8, n: c[2] + 24, l: 8, v: 0.25 })),
    noise: Array.from({ length: 16 }, (_, i) => ({ s: i * 8 + 4, n: 0, l: 1, v: 0.05 })),
  },
};

// 牠來了：E 弗里吉亞（E–F 半音的壓迫感），138 BPM
const TENSION: Track = {
  bpm: 138,
  div: 4,
  steps: 4 * 16,
  gain: 0.55,
  parts: {
    bass: Array.from({ length: 32 }, (_, i) => ({ s: i * 2, n: i < 24 ? 40 : 41, l: 1, v: i % 4 === 0 ? 1 : 0.6 })),
    stab: [
      ...[6, 14, 22, 30, 38, 46].map((s) => ({ s, n: 64, l: 1, v: 0.5 })),
      ...[6, 14, 22, 30, 38, 46].map((s) => ({ s, n: 65, l: 1, v: 0.4 })),
      { s: 54, n: 70, l: 2, v: 0.6 },
      { s: 58, n: 71, l: 2, v: 0.6 },
      { s: 62, n: 76, l: 2, v: 0.7 },
    ],
    kick: Array.from({ length: 16 }, (_, i) => ({ s: i * 4, n: 0, l: 1, v: i % 2 === 0 ? 1 : 0.7 })),
    noise: Array.from({ length: 32 }, (_, i) => ({ s: i * 2 + 1, n: 0, l: 1, v: i % 4 === 1 ? 0.2 : 0.08 })),
    lead: [
      { s: 0, n: 76, l: 12, v: 0.3 },
      { s: 16, n: 77, l: 12, v: 0.3 },
      { s: 32, n: 76, l: 12, v: 0.3 },
      { s: 48, n: 82, l: 14, v: 0.35 },
    ],
  },
};

const TRACKS: Record<TrackId, Track> = { title: TITLE, kitchen: KITCHEN, tension: TENSION };

/* ------------------------------ 播放 ------------------------------ */

interface Playing {
  id: TrackId;
  out: GainNode;
  next: number;
  step: number;
  stopAt: number | null;
}

class Music {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pulse: Record<'12' | '25' | '50', PeriodicWave> | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private playing: Playing[] = [];
  private want: TrackId | null = null;
  private timer: number | null = null;
  private volume = 0.5;
  private unlocked = false;

  /** 使用者第一次點擊／按鍵時呼叫 */
  unlock(): void {
    if (this.unlocked && this.ctx?.state === 'running') return;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx({ latencyHint: 'playback' });
        this.master = this.ctx.createGain();
        this.master.gain.value = this.level();
        this.master.connect(this.ctx.destination);
        this.pulse = { '12': this.pulseWave(0.125), '25': this.pulseWave(0.25), '50': this.pulseWave(0.5) };
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        // 4-bit 風格的雜訊：每 8 個取樣才換一次值
        let v = 0;
        for (let i = 0; i < len; i++) {
          if (i % 8 === 0) v = Math.random() * 2 - 1;
          d[i] = v;
        }
      }
      void this.ctx.resume().catch(() => undefined);
      this.unlocked = true;
      this.timer ??= window.setInterval(() => this.schedule(), 40);
      if (this.want && !this.playing.some((p) => p.id === this.want && p.stopAt === null)) this.start(this.want);
    } catch {
      /* 沒有音訊也能玩 */
    }
  }

  /** 0–1（再乘上總音量） */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.1);
  }

  private level(): number {
    // 背景音樂本來就壓得很低：滑桿 100% 時大約是音效的三成
    return this.volume * 0.3;
  }

  /** 換曲（null＝停止） */
  play(id: TrackId | null): void {
    if (this.want === id) return;
    this.want = id;
    if (!this.ctx || !this.unlocked) return;
    const now = this.ctx.currentTime;
    for (const p of this.playing) {
      if (p.stopAt !== null) continue;
      p.stopAt = now + 1.6;
      p.out.gain.cancelScheduledValues(now);
      p.out.gain.setValueAtTime(p.out.gain.value, now);
      p.out.gain.linearRampToValueAtTime(0, now + 1.5);
    }
    if (id) this.start(id);
  }

  private start(id: TrackId): void {
    const ctx = this.ctx!;
    const tr = TRACKS[id];
    const out = ctx.createGain();
    const now = ctx.currentTime;
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(tr.gain, now + (id === 'tension' ? 0.4 : 2.0));
    out.connect(this.master!);
    if (tr.delay) {
      const d = ctx.createDelay(1);
      d.delayTime.value = tr.delay[0];
      const fb = ctx.createGain();
      fb.gain.value = tr.delay[1];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      out.connect(d);
      d.connect(lp).connect(fb).connect(d);
      lp.connect(this.master!);
    }
    this.playing.push({ id, out, next: now + 0.05, step: 0, stopAt: null });
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const ahead = ctx.currentTime + 0.25;
    for (const p of this.playing) {
      const tr = TRACKS[p.id];
      const stepDur = 60 / tr.bpm / tr.div;
      while (p.next < ahead && (p.stopAt === null || p.next < p.stopAt)) {
        for (const inst of Object.keys(tr.parts) as Inst[]) {
          for (const n of tr.parts[inst]!) if (n.s === p.step) this.note(inst, n, p.next, stepDur, p.out);
        }
        p.step = (p.step + 1) % tr.steps;
        p.next += stepDur;
      }
    }
    this.playing = this.playing.filter((p) => {
      if (p.stopAt !== null && ctx.currentTime > p.stopAt + 0.5) {
        try {
          p.out.disconnect();
        } catch {
          /* ignore */
        }
        return false;
      }
      return true;
    });
  }

  private note(inst: Inst, n: Note, at: number, stepDur: number, out: AudioNode): void {
    const ctx = this.ctx!;
    const dur = Math.max(0.05, n.l * stepDur * 0.92);
    const v = n.v ?? 1;
    if (inst === 'noise' || inst === 'kick') {
      if (inst === 'kick') {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(130, at);
        o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
        g.gain.setValueAtTime(0.5 * v, at);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 0.2);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 6000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25 * v, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
      src.connect(f).connect(g).connect(out);
      src.start(at, Math.random() * 0.5);
      src.stop(at + 0.08);
      return;
    }
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = hz(n.n);
    o.frequency.setValueAtTime(f, at);
    let peak = 0.2 * v;
    let release = 0.08;
    switch (inst) {
      case 'lead':
        o.setPeriodicWave(this.pulse!['25']);
        peak = 0.16 * v;
        // 小小的顫音
        {
          const lfo = ctx.createOscillator();
          const amt = ctx.createGain();
          lfo.frequency.value = 5.5;
          amt.gain.setValueAtTime(0, at);
          amt.gain.linearRampToValueAtTime(f * 0.006, at + Math.min(0.4, dur));
          lfo.connect(amt).connect(o.frequency);
          lfo.start(at);
          lfo.stop(at + dur + release);
        }
        break;
      case 'arp':
        o.setPeriodicWave(this.pulse!['12']);
        peak = 0.12 * v;
        break;
      case 'stab':
        o.setPeriodicWave(this.pulse!['50']);
        peak = 0.13 * v;
        release = 0.03;
        break;
      case 'bass':
        o.type = 'triangle';
        peak = 0.32 * v;
        break;
      case 'bell':
        o.type = 'sine';
        peak = 0.18 * v;
        release = 1.2;
        break;
    }
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.008);
    if (inst === 'bell') g.gain.exponentialRampToValueAtTime(0.001, at + dur + release);
    else {
      g.gain.setValueAtTime(peak * 0.8, at + dur);
      g.gain.linearRampToValueAtTime(0, at + dur + release);
    }
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + dur + release + 0.02);
  }

  /** 方波的佔空比（12.5%／25%／50%）：紅白機與超任的音色 */
  private pulseWave(duty: number): PeriodicWave {
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      imag[k] = 0;
    }
    return this.ctx!.createPeriodicWave(real, imag);
  }
}

export const music = new Music();
