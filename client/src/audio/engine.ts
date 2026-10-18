import { MATERIALS, forwardOf, type EchoVoice, type Seat, type SignalToken } from '@last-table/shared';

/**
 * 程序化音訊引擎（Web Audio，不使用任何外部音檔或生成式 AI）。
 *
 * 角色限制在這裡「真的」執行：
 *   - 靜默員（聽不見）：hearing=false → 不會建立 AudioContext、不會播放任何東西、
 *     也不會接上任何遠端語音串流。master gain 另外強制為 0 作為第二道防線。
 *   - 盲區員／失語員：可聽見，並使用 HRTF 空間音訊。
 *
 * 音量分成幾條匯流排，各自調整（回聲與隊友語音分開管理）：
 *   sfx＝一般音效與廚房事件、env＝環境音與聲學地標、echo＝盲區員的回聲、
 *   nav＝方向提示與設備指引、voice＝隊友語音。全部再經過 master（總音量）。
 * 單聲道模式：在輸出端把左右聲道混成一個（給只有單一喇叭、或聽不出左右的玩家）。
 */

type Pos = readonly [number, number] | null;
export type Bus = 'sfx' | 'env' | 'echo' | 'nav' | 'voice';
export const BUSES: readonly Bus[] = ['sfx', 'env', 'echo', 'nav', 'voice'];

export interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  at?: number;
  attack?: number;
  slideTo?: number;
  pos?: Pos;
  pan?: number;
  filter?: number;
  /** 輸出到哪條匯流排（預設 sfx） */
  bus?: Bus;
  /** 直接輸出到指定節點（例如聲學地標自己的遮蔽鏈）；指定後忽略 pos／pan／bus */
  dest?: AudioNode;
  /** 空間音源的高度（預設 1.4 m） */
  y?: number;
  /** 空間音源的距離衰減係數（預設 0.9；回聲自己計算距離衰減時設為 0） */
  rolloff?: number;
}

export type LoopKind = 'sizzle' | 'boil' | 'dry' | 'breath';
export interface LoopSpec {
  id: string;
  kind: LoopKind;
  pos: readonly [number, number];
  /** 0–1 */
  level: number;
}
const LOOP_GAIN: Record<LoopKind, number> = { sizzle: 0.16, boil: 0.22, dry: 0.12, breath: 0.3 };
interface LoopNode {
  kind: LoopKind;
  src: AudioBufferSourceNode;
  lfo: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: PannerNode;
  nodes: AudioNode[];
}

export interface NoiseOpts {
  freq: number;
  q?: number;
  gain?: number;
  at?: number;
  pos?: Pos;
  pan?: number;
  type?: BiquadFilterType;
  bus?: Bus;
  dest?: AudioNode;
  y?: number;
  rolloff?: number;
  attack?: number;
}

/** 設定聽者位置與朝向：forward＝forwardOf(yaw)、up＝+y（與移動、鏡頭同一個座標系） */
export function applyListener(l: AudioListener, x: number, z: number, yaw: number, t: number): void {
  const [fx, fz] = forwardOf(yaw);
  if (l.positionX) {
    l.positionX.setValueAtTime(x, t);
    l.positionY.setValueAtTime(1.6, t);
    l.positionZ.setValueAtTime(z, t);
    l.forwardX.setValueAtTime(fx, t);
    l.forwardY.setValueAtTime(0, t);
    l.forwardZ.setValueAtTime(fz, t);
    l.upX.setValueAtTime(0, t);
    l.upY.setValueAtTime(1, t);
    l.upZ.setValueAtTime(0, t);
  } else {
    // 舊版 Safari
    (l as unknown as { setPosition(a: number, b: number, c: number): void }).setPosition(x, 1.6, z);
    (l as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, 0, fz, 0, 1, 0);
  }
}

/** 單聲道：讓節點只處理一個聲道（瀏覽器依 speakers 規則把立體聲混成單聲道） */
function setMonoNode(n: AudioNode, mono: boolean): void {
  try {
    n.channelCountMode = mono ? 'explicit' : 'clamped-max';
    n.channelCount = mono ? 1 : 2;
    n.channelInterpretation = 'speakers';
  } catch {
    /* 舊瀏覽器：維持原狀 */
  }
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private buses: Partial<Record<Bus, GainNode>> = {};
  private meters: Partial<Record<Bus, AnalyserNode>> = {};
  private busLevel: Record<Bus, number> = { sfx: 1, env: 1, echo: 1, nav: 1, voice: 1 };
  private envDuck = 1;
  private mono = false;
  /** 耳背砧板：環境聲與語音又悶又小聲 */
  private muffled = false;
  private muffleVoice = 0.3;
  private filters: Partial<Record<Bus, BiquadFilterNode>> = {};
  private noiseBuf: AudioBuffer | null = null;
  private hearing = false;
  private volume = 0.8;
  private ambientNodes: AudioNode[] = [];
  private voices = new Map<Seat, { src: MediaStreamAudioSourceNode; panner: PannerNode; gain: GainNode; analyser: AnalyserNode; el: HTMLAudioElement; buf: Uint8Array<ArrayBuffer> }>();
  /** 每位隊友的語音呈現（大嗓門：比較大聲、傳得比較遠） */
  private voiceProfiles = new Map<Seat, { gain: number; rolloff: number }>();
  /** 持續的空間聲音（爐上的滋滋聲、湯滾、怪物的呼吸） */
  private loops = new Map<string, LoopNode>();
  /** 音訊尚未啟動（還沒有使用者手勢）時先收到的語音串流 */
  private pendingVoices = new Map<Seat, MediaStream>();

  setHearing(hearing: boolean): void {
    this.hearing = hearing;
    if (!hearing) this.shutdown();
  }
  canHear(): boolean {
    return this.hearing;
  }

  /** 必須由使用者操作（點擊／按鍵）觸發 */
  async init(): Promise<void> {
    if (!this.hearing) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.comp = comp;
      this.master.connect(comp).connect(this.ctx.destination);
      for (const b of BUSES) {
        const g = this.ctx.createGain();
        g.gain.value = this.busGain(b);
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = this.muffled && (b === 'env' || b === 'voice') ? 650 : 20000;
        g.connect(f).connect(this.master);
        this.filters[b] = f;
        this.buses[b] = g;
        const m = this.ctx.createAnalyser();
        m.fftSize = 1024;
        g.connect(m);
        this.meters[b] = m;
      }
      this.applyMono();
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    for (const [role, stream] of this.pendingVoices) this.attachVoice(role, stream);
    this.pendingVoices.clear();
  }

  private shutdown(): void {
    this.stopLoops();
    for (const role of [...this.voices.keys()]) this.detachVoice(role);
    this.stopAmbient();
    if (this.master) this.master.gain.value = 0;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.buses = {};
    this.meters = {};
    this.filters = {};
    this.noiseBuf = null;
  }

  /** 耳背砧板：環境聲與隊友語音加上低通、壓低音量（只是呈現；聲音提示本來就不會從伺服器送來） */
  setMuffled(on: boolean, voiceGain = 0.3): void {
    this.muffled = on;
    this.muffleVoice = voiceGain;
    for (const b of ['env', 'voice'] as Bus[]) {
      const f = this.filters[b];
      if (f && this.ctx) f.frequency.setTargetAtTime(on ? 650 : 20000, this.ctx.currentTime, 0.05);
      this.setBusVolume(b, this.busLevel[b]);
    }
  }

  /** 幻聽外場的傳聞提示音：兩聲短音，音高由伺服器給（真假有細微、固定的差異） */
  rumor(pitch: number): void {
    this.tone(740 * pitch, 0.09, { type: 'sine', gain: 0.16 });
    this.tone(988 * pitch, 0.12, { type: 'sine', gain: 0.14, at: 0.1 });
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.hearing) this.master.gain.value = this.volume;
  }

  private busGain(b: Bus): number {
    const muffle = this.muffled ? (b === 'env' ? 0.4 : b === 'voice' ? this.muffleVoice : 1) : 1;
    return this.busLevel[b] * (b === 'env' ? this.envDuck : 1) * muffle;
  }

  /** 各匯流排的音量（0–1.5）；音訊還沒啟動時先記下來 */
  setBusVolume(b: Bus, v: number): void {
    this.busLevel[b] = Math.max(0, Math.min(1.5, v));
    const g = this.buses[b];
    if (g && this.ctx) g.gain.setTargetAtTime(this.busGain(b), this.ctx.currentTime, 0.05);
  }

  /** 隊友說話時稍微壓低環境音，讓語音、回聲與環境音同時存在時仍然聽得清楚 */
  setEnvDuck(on: boolean): void {
    const v = on ? 0.55 : 1;
    if (v === this.envDuck) return;
    this.envDuck = v;
    this.setBusVolume('env', this.busLevel.env);
  }

  /** 單聲道模式：壓縮器只處理一個聲道（瀏覽器自動把立體聲混成單聲道），輸出端再送到兩邊喇叭 */
  setMono(on: boolean): void {
    this.mono = on;
    this.applyMono();
  }
  isMono(): boolean {
    return this.mono;
  }
  private applyMono(): void {
    if (this.comp) setMonoNode(this.comp, this.mono);
  }

  /**
   * 測試用：以離線音訊（OfflineAudioContext）實際算繪一個 HRTF 聲源，回傳左右聲道的能量。
   * 聽者設定與單聲道處理使用和遊戲完全相同的函式，用來驗證「聲源在右邊時右耳比較大聲」。
   */
  async probe(o: { x: number; z: number; yaw: number; sx: number; sz: number; mono?: boolean }): Promise<{ left: number; right: number }> {
    const rate = 44100;
    const ctx = new OfflineAudioContext(2, Math.round(rate * 0.4), rate);
    applyListener(ctx.listener, o.x, o.z, o.yaw, 0);
    const buf = ctx.createBuffer(1, rate, rate);
    const d = buf.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < d.length; i++) d[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.positionX.value = o.sx;
    p.positionY.value = 1.6;
    p.positionZ.value = o.sz;
    const comp = ctx.createDynamicsCompressor();
    setMonoNode(comp, !!o.mono);
    src.connect(p).connect(comp).connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    const rms = (ch: Float32Array) => Math.sqrt(ch.reduce((s, v) => s + v * v, 0) / ch.length);
    return { left: rms(out.getChannelData(0)), right: rms(out.getChannelData(1)) };
  }

  /** 匯流排目前設定的增益（含說話時的環境音壓低） */
  busValue(b: Bus): number {
    return this.buses[b]?.gain.value ?? this.busGain(b);
  }

  /** 各匯流排目前的音量（RMS，測試與開發者工具用） */
  meter(b: Bus): number {
    const a = this.meters[b];
    if (!a || !this.live) return 0;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
  }

  private get live(): boolean {
    return this.hearing && !!this.ctx && !!this.master && this.ctx.state === 'running';
  }

  /** 給空間音訊模組使用：音訊正在運作時回傳 AudioContext，否則 null */
  get context(): AudioContext | null {
    return this.live ? this.ctx : null;
  }
  bus(b: Bus): AudioNode | null {
    return this.live ? (this.buses[b] ?? null) : null;
  }
  get noise1s(): AudioBuffer | null {
    return this.noiseBuf;
  }

  setListener(x: number, z: number, yaw: number): void {
    if (!this.live || !this.ctx) return;
    applyListener(this.ctx.listener, x, z, yaw, this.ctx.currentTime);
  }

  /* ----------------------------- 基本音源 ----------------------------- */

  private route(o: { pos?: Pos; pan?: number; bus?: Bus; dest?: AudioNode; y?: number; rolloff?: number }): AudioNode {
    const ctx = this.ctx!;
    if (o.dest) return o.dest;
    const out = this.buses[o.bus ?? 'sfx'] ?? this.master!;
    if (o.pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.rolloffFactor = o.rolloff ?? 0.9;
      p.maxDistance = 40;
      p.positionX.value = o.pos[0];
      p.positionY.value = o.y ?? 1.4;
      p.positionZ.value = o.pos[1];
      p.connect(out);
      return p;
    }
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, o.pan));
      sp.connect(out);
      return sp;
    }
    return out;
  }

  tone(freq: number, dur: number, o: ToneOpts = {}): void {
    if (!this.live || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + dur);
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    const attack = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    let tail: AudioNode = g;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.filter;
      g.connect(f);
      tail = f;
    }
    tail.connect(this.route(o));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise(dur: number, o: NoiseOpts): void {
    if (!this.live || !this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.route(o));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  /* ----------------------------- 遊戲音效 ----------------------------- */

  /** size：體型（巨人的腳步又重又低沉，小矮人的又輕又高） */
  footstep(pos: Pos = null, running = false, at = 0, size = 1): void {
    const j = (0.85 + Math.random() * 0.3) / size;
    const g = Math.sqrt(size);
    this.noise(0.07 * size, { freq: 900 * j, q: 0.8, gain: (pos ? 0.22 : 0.1) * g, pos, at });
    this.tone(95 * j, 0.09 * size, { type: 'sine', gain: (pos ? 0.18 : 0.1) * g * g, pos, at });
    if (running) this.noise(0.05, { freq: 2200, q: 1.2, gain: 0.05, pos, at: at + 0.02 });
  }

  bump(): void {
    this.tone(110, 0.16, { type: 'sine', gain: 0.35, slideTo: 45 });
    this.noise(0.1, { freq: 300, q: 0.7, gain: 0.2 });
  }

  door(pos: Pos, opening: boolean): void {
    this.noise(0.7, { freq: opening ? 500 : 800, q: 0.6, gain: 0.25, pos, type: 'bandpass' });
    this.tone(opening ? 140 : 180, 0.6, { type: 'sawtooth', gain: 0.1, slideTo: opening ? 260 : 90, pos, filter: 800 });
    this.tone(opening ? 520 : 300, 0.12, { type: 'square', gain: 0.07, at: 0.62, pos });
  }

  uiOk(): void {
    this.tone(660, 0.12, { type: 'triangle', gain: 0.18 });
    this.tone(990, 0.18, { type: 'triangle', gain: 0.16, at: 0.09 });
  }
  uiError(): void {
    this.tone(180, 0.22, { type: 'sawtooth', gain: 0.16, filter: 900 });
    this.tone(150, 0.26, { type: 'sawtooth', gain: 0.14, at: 0.16, filter: 900 });
  }
  uiWarn(): void {
    this.tone(420, 0.14, { type: 'triangle', gain: 0.16 });
    this.tone(420, 0.14, { type: 'triangle', gain: 0.16, at: 0.2 });
  }
  uiOpen(): void {
    this.tone(480, 0.07, { type: 'triangle', gain: 0.12 });
    this.tone(720, 0.09, { type: 'triangle', gain: 0.12, at: 0.06 });
  }
  uiClose(): void {
    this.tone(720, 0.07, { type: 'triangle', gain: 0.1 });
    this.tone(440, 0.09, { type: 'triangle', gain: 0.1, at: 0.06 });
  }
  uiKey(): void {
    this.tone(900, 0.03, { type: 'square', gain: 0.05 });
  }
  notice(): void {
    this.tone(540, 0.1, { type: 'sine', gain: 0.14 });
  }
  solved(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.45, { type: 'triangle', gain: 0.17, at: i * 0.11 }));
  }
  /** 終章：低音上升的和弦 */
  ending(): void {
    [110, 165, 220, 277, 330, 440].forEach((f, i) => this.tone(f, 3.2, { type: 'sine', gain: 0.1, at: i * 0.55, attack: 0.4 }));
  }
  /** 盲區員的指引：設備方位的短促「滴」聲；音高隨設備種類不同 */
  beacon(dx: number, dz: number, yaw: number, dist: number, kindPitch: number): void {
    const [fx, fz] = forwardOf(yaw);
    const rx = -fz;
    const rz = fx;
    const len = Math.hypot(dx, dz) || 1;
    const front = (dx * fx + dz * fz) / len;
    const side = (dx * rx + dz * rz) / len;
    const near = dist < 2.6;
    const gain = Math.max(0.05, 0.28 - dist * 0.02) * (front < -0.2 ? 0.7 : 1);
    this.tone(kindPitch * (front < -0.2 ? 0.7 : 1), near ? 0.14 : 0.08, { type: near ? 'triangle' : 'sine', gain, pan: side, bus: 'nav' });
    if (near && front > 0.5) this.tone(kindPitch * 1.5, 0.1, { type: 'triangle', gain: gain * 0.7, pan: side, at: 0.07, bus: 'nav' });
  }

  /* ----------------------------- 盲區員：主動回聲 ----------------------------- */

  /** 自己發出的脈衝（短促的「嗒」，不定位） */
  echoPing(): void {
    this.noise(0.025, { freq: 3400, q: 0.9, gain: 0.16, bus: 'echo' });
    this.tone(1900, 0.03, { type: 'square', gain: 0.05, filter: 5000, bus: 'echo' });
  }

  /**
   * 一個反射：在反射點用 HRTF 定位播放；音色由材質決定，延遲、音量、明暗由 planEcho 依距離計算。
   * 距離衰減已經算在 gain 裡，所以 panner 的衰減設為 0。
   */
  echoVoice(v: EchoVoice): void {
    const pos: Pos = [v.x, v.z];
    const common = { pos, at: v.at, bus: 'echo' as const, rolloff: 0, y: 1.3 };
    if (v.kind === 'open') {
      this.noise(0.22, { freq: 420, q: 0.6, gain: v.gain, type: 'lowpass', attack: 0.06, ...common });
      return;
    }
    const m = MATERIALS[v.material ?? 'concrete'];
    const cut = Math.max(500, v.cutoff);
    switch (m.voice) {
      case 'noise':
        this.noise(m.ring, { freq: Math.min(m.freq, cut), q: 1.4, gain: v.gain * 1.2, ...common });
        return;
      case 'ring':
        this.tone(m.freq, m.ring, { type: 'triangle', gain: v.gain * 0.7, filter: cut * 1.4, ...common });
        this.tone(m.freq * 1.47, m.ring * 0.8, { type: 'sine', gain: v.gain * 0.45, filter: cut * 1.4, ...common });
        this.noise(0.03, { freq: Math.min(3000, cut), q: 2, gain: v.gain * 0.5, ...common });
        return;
      case 'buzz':
        this.tone(m.freq, m.ring, { type: 'square', gain: v.gain * 0.45, filter: Math.min(cut, 2200), ...common });
        this.tone(m.freq * 2.01, m.ring * 0.7, { type: 'sawtooth', gain: v.gain * 0.2, filter: Math.min(cut, 2200), ...common });
        return;
      case 'knock':
        this.tone(m.freq, m.ring, { type: 'sine', gain: v.gain * 1.1, slideTo: m.freq * 0.8, ...common });
        this.noise(0.02, { freq: Math.min(1400, cut), q: 2, gain: v.gain * 0.4, ...common });
        return;
    }
  }

  /** 殘響尾巴：左右兩個不相關的噪音，長度代表空間大小（開放空間較長） */
  echoTail(len: number, gain: number, at = 0.08): void {
    for (const pan of [-0.7, 0.7]) this.noise(len, { freq: 1100, q: 0.5, gain, type: 'lowpass', at, pan, attack: 0.03, bus: 'echo' });
  }

  /** 冷卻結束：很輕的上升兩音，告訴玩家可以再發 */
  echoReady(): void {
    this.tone(1200, 0.05, { type: 'sine', gain: 0.05, bus: 'echo' });
    this.tone(1800, 0.06, { type: 'sine', gain: 0.045, at: 0.06, bus: 'echo' });
  }

  /** 冷卻中再按：一聲很輕的「喀」，告訴玩家還不能發 */
  echoNotReady(): void {
    this.tone(260, 0.04, { type: 'triangle', gain: 0.05, bus: 'echo' });
  }

  /** 回聲被感測器干擾：短暫的雜訊，沒有任何反射 */
  echoJammed(): void {
    this.noise(0.5, { freq: 2600, q: 0.4, gain: 0.12, bus: 'echo' });
    this.tone(180, 0.4, { type: 'sawtooth', gain: 0.04, filter: 900, bus: 'echo' });
  }

  /* ----------------------------- 盲區員：方向提示 ----------------------------- */

  /**
   * 轉向提示（不定位，單聲道也聽得出來）：
   *   minor＝每 45° 的輕響、axis＝轉到右翼／左翼、deep＝轉到深處（上升雙音）、entry＝轉到入口（低音）。
   */
  headingTick(kind: 'minor' | 'axis' | 'deep' | 'entry'): void {
    const o = { bus: 'nav' as const };
    if (kind === 'minor') this.tone(1500, 0.025, { type: 'sine', gain: 0.045, ...o });
    else if (kind === 'axis') this.tone(990, 0.06, { type: 'triangle', gain: 0.07, ...o });
    else if (kind === 'deep') {
      this.tone(880, 0.06, { type: 'triangle', gain: 0.08, ...o });
      this.tone(1320, 0.08, { type: 'triangle', gain: 0.08, at: 0.07, ...o });
    } else this.tone(440, 0.1, { type: 'triangle', gain: 0.08, ...o });
  }

  /** 音訊校準：左／右聲道各自播放；both＝兩邊同時（確認音量） */
  testChannel(side: 'left' | 'right' | 'both'): void {
    const pan = side === 'left' ? -1 : side === 'right' ? 1 : 0;
    for (let i = 0; i < 3; i++) this.tone(side === 'both' ? 660 : 880, 0.12, { type: 'triangle', gain: 0.2, pan, at: i * 0.2 });
  }

  /** 聲學感測器偵測到回聲：兩音交替的警報（在感測器位置播放） */
  alarm(pos: Pos): void {
    for (let i = 0; i < 4; i++) {
      this.tone(i % 2 ? 620 : 830, 0.28, { type: 'sawtooth', gain: 0.12, at: i * 0.3, filter: 2000, pos, y: 3 });
    }
  }

  /** 標記提示音（失語員指向某台設備；聽得見的人聽到位置） */
  marker(pos: Pos): void {
    this.tone(1320, 0.06, { type: 'triangle', gain: 0.14, pos });
    this.tone(1760, 0.08, { type: 'triangle', gain: 0.12, at: 0.08, pos });
  }

  /** 信號器的聽覺 token */
  signalTokens(tokens: readonly SignalToken[]): void {
    let at = 0;
    for (const t of tokens) {
      if (t === 'TAP_S') {
        this.tone(520, 0.1, { type: 'triangle', gain: 0.3, at, filter: 2200 });
        at += 0.3;
      } else if (t === 'TAP_L') {
        this.tone(520, 0.38, { type: 'triangle', gain: 0.3, at, attack: 0.01, filter: 2200 });
        at += 0.6;
      }
    }
  }

  /** 被抓走的過場（只有被抓的人聽到，3.6 秒，和畫面同步） */
  abduct(): void {
    // 撲上來的尖嘯＋貼在耳邊的低吼
    this.tone(980, 0.7, { type: 'sawtooth', gain: 0.16, slideTo: 2300, filter: 5000, attack: 0.02 });
    this.noise(0.6, { freq: 3000, q: 2, gain: 0.28 });
    this.tone(52, 1.4, { type: 'sawtooth', gain: 0.32, slideTo: 38, filter: 420, attack: 0.05 });
    // 越來越快的心跳
    [0.05, 0.42, 0.72, 0.95, 1.13].forEach((at, i) => {
      this.tone(62, 0.16, { type: 'sine', gain: 0.5 + i * 0.05, at });
      this.tone(52, 0.14, { type: 'sine', gain: 0.35, at: at + 0.16 });
    });
    // 被拽倒在地的重擊
    this.tone(40, 0.6, { type: 'sine', gain: 0.6, slideTo: 24, at: 0.9 });
    this.noise(0.25, { freq: 220, q: 0.7, gain: 0.45, at: 0.9 });
    // 拖行：身體在地上摩擦、指甲刮過磁磚
    this.noise(1.3, { freq: 280, q: 1.1, gain: 0.32, attack: 0.15, at: 1.5 });
    for (let i = 0; i < 3; i++) this.noise(0.22, { freq: 4200, q: 6, gain: 0.1, at: 1.7 + i * 0.36, type: 'bandpass' });
    this.tone(45, 1.3, { type: 'sine', gain: 0.22, at: 1.5 });
    // 鐵籠關上
    this.noise(0.35, { freq: 2200, q: 9, gain: 0.2, at: 2.8 });
    this.tone(180, 0.5, { type: 'square', gain: 0.07, slideTo: 120, filter: 1200, at: 2.8 });
  }

  /* ----------------------------- 廚房 ----------------------------- */

  /** 伺服器事件的聲音（只有聽得見的人會收到 sound 欄位）；at 為發生位置 */
  kitchenSound(name: string, at: Pos): void {
    const pos = at;
    switch (name) {
      case 'ticket':
        // 出單機：快速的針式列印聲
        for (let i = 0; i < 7; i++) this.noise(0.03, { freq: 3200, q: 2, gain: 0.12, at: i * 0.05, pos });
        this.tone(1480, 0.08, { type: 'square', gain: 0.05, at: 0.4, filter: 3000, pos });
        return;
      case 'bell':
        this.tone(1760, 1.1, { type: 'sine', gain: 0.22, pos });
        this.tone(2637, 0.7, { type: 'sine', gain: 0.07, pos });
        return;
      case 'toast_pop':
        this.noise(0.06, { freq: 1800, q: 2, gain: 0.3, pos });
        this.tone(320, 0.1, { type: 'triangle', gain: 0.18, slideTo: 520, pos });
        return;
      case 'knock':
        for (let i = 0; i < 3; i++) {
          this.tone(85, 0.14, { type: 'sine', gain: 0.4, at: i * 0.32, pos });
          this.noise(0.08, { freq: 400, q: 1, gain: 0.25, at: i * 0.32, pos });
        }
        return;
      case 'chair':
        // 椅腳在地板上拖動
        this.noise(0.7, { freq: 520, q: 6, gain: 0.18, attack: 0.08, pos });
        this.tone(170, 0.7, { type: 'sawtooth', gain: 0.04, slideTo: 210, filter: 800, pos });
        return;
      case 'steps':
        for (let i = 0; i < 3; i++) this.footstep(pos, false, i * 0.55);
        return;
      case 'murmur':
        for (let i = 0; i < 5; i++) this.tone(140 + ((i * 37) % 60), 0.22, { type: 'sawtooth', gain: 0.05, at: i * 0.2, filter: 600, pos, attack: 0.04 });
        return;
      case 'door_open':
        this.door(pos, true);
        return;
      case 'door_slam':
        this.tone(60, 0.45, { type: 'sine', gain: 0.5, slideTo: 35, pos });
        this.noise(0.3, { freq: 300, q: 0.7, gain: 0.35, pos });
        return;
      case 'cage_rattle':
        // 有人在搖鐵籠：金屬撞擊的連響
        for (let i = 0; i < 4; i++) {
          this.noise(0.09, { freq: 2600 + i * 180, q: 7, gain: 0.16, at: i * 0.13, pos });
          this.tone(340 + i * 25, 0.12, { type: 'square', gain: 0.035, filter: 1800, at: i * 0.13, pos });
        }
        return;
      case 'cage_open':
        this.noise(0.4, { freq: 2400, q: 8, gain: 0.12, pos });
        this.tone(720, 0.5, { type: 'square', gain: 0.04, slideTo: 540, filter: 2000, pos });
        return;
      case 'backdoor':
        // 生鏽的鉸鏈
        this.tone(410, 1.2, { type: 'sawtooth', gain: 0.06, slideTo: 290, filter: 1400, attack: 0.1, pos });
        this.noise(1.0, { freq: 1300, q: 10, gain: 0.08, attack: 0.1, pos });
        return;
      case 'scratch':
        // 指甲刮過後門的鐵皮：幾道高頻的刮擦，越來越急
        for (let i = 0; i < 5; i++) {
          this.noise(0.35, { freq: 2200 + i * 140, q: 9, gain: 0.16, attack: 0.05, at: i * 0.42 - i * i * 0.02, pos });
          this.tone(900 + i * 60, 0.3, { type: 'sawtooth', gain: 0.03, slideTo: 700, filter: 2500, at: i * 0.42 - i * i * 0.02, pos });
        }
        return;
      case 'growl':
        this.tone(58, 1.3, { type: 'sawtooth', gain: 0.26, slideTo: 44, filter: 380, attack: 0.15, pos });
        this.noise(1.2, { freq: 240, q: 1.4, gain: 0.25, attack: 0.15, pos });
        return;
      case 'screech':
        this.tone(1250, 0.6, { type: 'sawtooth', gain: 0.12, slideTo: 1900, filter: 4000, attack: 0.03, pos });
        this.noise(0.5, { freq: 2600, q: 3, gain: 0.2, pos });
        return;
      case 'drag':
        this.noise(1.6, { freq: 300, q: 1.2, gain: 0.3, attack: 0.1, pos });
        this.tone(48, 1.6, { type: 'sine', gain: 0.25, pos });
        return;
      case 'boil_over':
        this.noise(0.9, { freq: 4800, q: 0.6, gain: 0.3, type: 'highpass', pos });
        return;
      case 'slip':
        // 踩到水滑倒：鞋底在濕地上吱一聲，接著整個人跌在地上
        this.tone(1900, 0.18, { type: 'sawtooth', gain: 0.05, slideTo: 2600, filter: 3200, pos });
        this.noise(0.08, { freq: 1600, q: 3, gain: 0.12, at: 0.02, pos });
        this.noise(0.35, { freq: 180, q: 0.8, gain: 0.55, at: 0.2, pos });
        this.tone(70, 0.3, { type: 'sine', gain: 0.35, slideTo: 45, at: 0.2, pos });
        return;
      case 'bump':
        // 兩個人撞在一起：悶悶的一下
        this.noise(0.12, { freq: 260, q: 1, gain: 0.4, pos });
        this.tone(110, 0.14, { type: 'sine', gain: 0.25, slideTo: 80, pos });
        return;
      case 'toss':
        // 東西被丟出去：咻的一聲
        this.noise(0.28, { freq: 1200, q: 2, gain: 0.12, attack: 0.05, pos });
        return;
      case 'catch':
        this.noise(0.05, { freq: 700, q: 1.5, gain: 0.3, pos });
        return;
      case 'drop':
        // 東西掉到地上：短促的碰撞＋盤子的碎響
        this.noise(0.12, { freq: 900, q: 1, gain: 0.35, pos });
        this.tone(2200, 0.25, { type: 'triangle', gain: 0.08, slideTo: 1400, at: 0.03, pos });
        return;
      case 'sniff':
        for (let i = 0; i < 2; i++) this.noise(0.12, { freq: 5200, q: 1.5, gain: 0.08, at: i * 0.25, type: 'highpass', pos });
        return;
      case 'sneeze':
        this.noise(0.08, { freq: 1200, q: 0.8, gain: 0.15, pos });
        this.noise(0.35, { freq: 2600, q: 0.6, gain: 0.32, at: 0.12, type: 'highpass', pos });
        return;
      case 'rally':
        this.tone(310, 0.5, { type: 'sawtooth', gain: 0.18, filter: 1400, attack: 0.03, pos });
        this.tone(420, 0.45, { type: 'sawtooth', gain: 0.12, filter: 1600, at: 0.12, pos });
        return;
      default:
        this.notice();
    }
  }

  /** 沉重的腳步（怪物）；pos 必須是空間位置 */
  heavyStep(pos: Pos, fast = false): void {
    const j = 0.9 + Math.random() * 0.2;
    this.tone(52 * j, 0.22, { type: 'sine', gain: fast ? 0.5 : 0.38, pos, rolloff: 0.7 });
    this.noise(0.14, { freq: 280 * j, q: 0.8, gain: fast ? 0.32 : 0.22, pos, rolloff: 0.7 });
  }

  /**
   * 持續的空間聲音。每個快照呼叫一次，傳入目前所有應該存在的聲音；不在清單裡的會淡出。
   *   sizzle：平底鍋的油爆聲（level＝鍋溫）、boil：湯滾、dry：乾鍋的焦味聲、breath：怪物的呼吸
   */
  setLoops(specs: readonly LoopSpec[]): void {
    if (!this.live || !this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const keep = new Set<string>();
    for (const sp of specs) {
      keep.add(sp.id);
      let n = this.loops.get(sp.id);
      if (!n || n.kind !== sp.kind) {
        if (n) this.killLoop(sp.id);
        n = this.makeLoop(sp);
        this.loops.set(sp.id, n);
      }
      n.panner.positionX.setTargetAtTime(sp.pos[0], now, 0.08);
      n.panner.positionZ.setTargetAtTime(sp.pos[1], now, 0.08);
      n.gain.gain.setTargetAtTime(LOOP_GAIN[sp.kind] * Math.max(0, Math.min(1, sp.level)), now, 0.25);
      if (sp.kind === 'sizzle') n.filter.frequency.setTargetAtTime(2600 + sp.level * 3200, now, 0.3);
    }
    for (const id of [...this.loops.keys()]) if (!keep.has(id)) this.killLoop(id);
  }

  private makeLoop(sp: LoopSpec): LoopNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = sp.pos[0];
    panner.positionY.value = sp.kind === 'breath' ? 2.1 : 1.0;
    panner.positionZ.value = sp.pos[1];
    // 振幅調變：油爆的不規則、湯的氣泡、呼吸的起伏
    const mod = ctx.createGain();
    mod.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    if (sp.kind === 'sizzle') {
      filter.type = 'highpass';
      filter.frequency.value = 3600;
      lfo.type = 'square';
      lfo.frequency.value = 13;
      lfoAmt.gain.value = 0.25;
    } else if (sp.kind === 'boil') {
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 6;
      lfo.type = 'square';
      lfo.frequency.value = 5.3;
      lfoAmt.gain.value = 0.45;
    } else if (sp.kind === 'dry') {
      filter.type = 'bandpass';
      filter.frequency.value = 1700;
      filter.Q.value = 3;
      lfo.type = 'sawtooth';
      lfo.frequency.value = 2.1;
      lfoAmt.gain.value = 0.4;
    } else {
      filter.type = 'bandpass';
      filter.frequency.value = 420;
      filter.Q.value = 1.6;
      lfo.type = 'sine';
      lfo.frequency.value = 0.32;
      lfoAmt.gain.value = 0.5;
    }
    lfo.connect(lfoAmt).connect(mod.gain);
    src.connect(filter).connect(mod).connect(gain).connect(panner).connect(this.buses.env ?? this.master!);
    src.start(0, Math.random() * 0.8);
    lfo.start();
    return { kind: sp.kind, src, lfo, filter, gain, panner, nodes: [src, filter, mod, gain, panner, lfo, lfoAmt] };
  }

  private killLoop(id: string): void {
    const n = this.loops.get(id);
    if (!n) return;
    this.loops.delete(id);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    n.gain.gain.setTargetAtTime(0, t, 0.15);
    try {
      n.src.stop(t + 0.8);
      n.lfo.stop(t + 0.8);
    } catch {
      /* 已停止 */
    }
    setTimeout(() => n.nodes.forEach((x) => x.disconnect()), 1000);
  }

  stopLoops(): void {
    for (const id of [...this.loops.keys()]) this.killLoop(id);
  }

  /* ----------------------------- 環境音 ----------------------------- */

  startAmbient(): void {
    if (!this.live || !this.ctx || this.ambientNodes.length) return;
    const ctx = this.ctx;
    const mk = (f: number, g: number, type: OscillatorType): void => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const gn = ctx.createGain();
      gn.gain.value = g;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      o.connect(lp).connect(gn).connect(this.buses.env ?? this.master!);
      o.start();
      this.ambientNodes.push(o, gn, lp);
    };
    mk(54, 0.05, 'sawtooth');
    mk(54.7, 0.04, 'sawtooth');
    mk(108.3, 0.015, 'sine');
    if (this.noiseBuf) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 400;
      const g = ctx.createGain();
      g.gain.value = 0.02;
      src.connect(f).connect(g).connect(this.buses.env ?? this.master!);
      src.start();
      this.ambientNodes.push(src, f, g);
    }
  }
  stopAmbient(): void {
    for (const n of this.ambientNodes) {
      try {
        (n as OscillatorNode).stop?.();
      } catch {
        /* 已停止 */
      }
      n.disconnect();
    }
    this.ambientNodes = [];
  }

  /* ----------------------------- 隊友語音 ----------------------------- */

  /**
   * 接上隊友的語音。靜默員（聽不見）會直接拒絕——即使伺服器因為 bug 路由了語音，
   * 客戶端也不會把它放出來。
   */
  attachVoice(role: Seat, stream: MediaStream): boolean {
    if (!this.hearing) return false;
    if (!this.ctx || !this.master) {
      this.pendingVoices.set(role, stream);
      return true;
    }
    this.detachVoice(role);
    // Chrome 需要把遠端串流先接到一個（靜音的）媒體元素，Web Audio 才會真的有資料
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    void el.play().catch(() => undefined);
    const src = this.ctx.createMediaStreamSource(stream);
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;
    panner.rolloffFactor = 0.3;
    panner.maxDistance = 60;
    panner.positionY.value = 1.6;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = this.ctx.createGain();
    const prof = this.voiceProfiles.get(role);
    if (prof) {
      gain.gain.value = prof.gain;
      panner.rolloffFactor = prof.rolloff;
    }
    src.connect(panner).connect(gain).connect(this.buses.voice ?? this.master);
    src.connect(analyser);
    this.voices.set(role, { src, panner, gain, analyser, el, buf: new Uint8Array(analyser.fftSize) });
    return true;
  }

  /** 設定某位隊友的語音呈現（大嗓門：音量倍率、距離衰減） */
  setVoiceProfile(role: Seat, gain: number, rolloff: number): void {
    const prev = this.voiceProfiles.get(role);
    if (prev && prev.gain === gain && prev.rolloff === rolloff) return;
    this.voiceProfiles.set(role, { gain, rolloff });
    const v = this.voices.get(role);
    if (v && this.ctx) {
      v.gain.gain.setValueAtTime(gain, this.ctx.currentTime);
      v.panner.rolloffFactor = rolloff;
    }
  }
  detachVoice(role: Seat): void {
    this.pendingVoices.delete(role);
    const v = this.voices.get(role);
    if (!v) return;
    try {
      v.src.disconnect();
      v.panner.disconnect();
      v.gain.disconnect();
      v.analyser.disconnect();
    } catch {
      /* ignore */
    }
    v.el.srcObject = null;
    this.voices.delete(role);
  }
  updateVoicePos(role: Seat, x: number, z: number): void {
    const v = this.voices.get(role);
    if (!v || !this.ctx) return;
    v.panner.positionX.setValueAtTime(x, this.ctx.currentTime);
    v.panner.positionZ.setValueAtTime(z, this.ctx.currentTime);
  }
  voiceLevel(role: Seat): number {
    const v = this.voices.get(role);
    if (!v) return 0;
    v.analyser.getByteTimeDomainData(v.buf);
    let peak = 0;
    for (let i = 0; i < v.buf.length; i++) peak = Math.max(peak, Math.abs(v.buf[i] - 128));
    return peak / 128;
  }
  hasVoice(role: Seat): boolean {
    return this.voices.has(role);
  }
}

export const audio = new AudioEngine();
