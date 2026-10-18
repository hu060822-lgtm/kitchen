import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { on } from '../game/bus';
import { abductElapsed } from '../game/abduct';
import { audio } from '../audio/engine';
import { bindInput, requestLock, startGameLoop } from '../game/loop';
import { useStore } from '../state/store';
import { voice } from '../voice/voice';
import { CREW_MODELS, preloadCrew } from '../game/characters/assets';
import { preloadCreatures } from '../game/characters/creatures';
import DebugPanel from './DebugPanel';
import Briefing from './Briefing';
import TutorialCard from './TutorialCard';
import StorySlip from './StorySlip';
import Hud from './Hud';
import { Overlays } from './Overlays';
import ShiftResults from './ShiftResults';
import StationPanel from './StationPanel';
import MatePanel from './MatePanel';

// 3D 場景另外載入（大廳不需要）
const Scene = lazy(() => import('../game/Scene'));

/**
 * 畫面效果：被拖走／救出來的黑幕、怪物衝過來時的邊緣壓迫、燈光閃一下、被拍肩、溫度預警。
 * 都只是感知，不遮住料理需要的資訊太久（最長 0.7 秒）。
 */
function Fx(): JSX.Element | null {
  const [fx, setFx] = useState<{ k: number; v: string } | null>(null);
  useEffect(
    () =>
      on('fx', (f) => {
        if (['shift', 'charge', 'lunge', 'flicker', 'tap', 'thermal', 'handoff', 'grab', 'shake', 'rally', 'sleep'].includes(f.visual)) setFx((p) => ({ k: (p?.k ?? 0) + 1, v: f.visual }));
      }),
    [],
  );
  if (!fx) return null;
  return <div className={`fx ${fx.v}`} key={fx.k} aria-hidden />;
}

/**
 * 被抓走的過場（畫面層）：紅色暗角與心跳般的脈動 → 被拽倒的一瞬間紅光 → 黑幕裡的爪痕與文字 → 在鐵籠裡亮起來。
 * 鏡頭的部分在 Scene 的 Rig 裡（abduct.ts 是兩者共用的時間軸）。
 */
function AbductFx(): JSX.Element | null {
  const [k, setK] = useState(0);
  useEffect(
    () =>
      on('abduct', () => {
        setK((x) => Math.abs(x) + 1);
        // 過場結束（或截圖用的凍結解除）才拿掉畫面層
        const t = window.setInterval(() => {
          if (abductElapsed() === null) {
            setK((x) => -Math.abs(x));
            clearInterval(t);
          }
        }, 200);
      }),
    [],
  );
  useEffect(() => {
    // 過場期間把介面藏起來（只留過場本身）
    document.body.classList.toggle('abducting', k > 0);
    return () => document.body.classList.remove('abducting');
  }, [k]);
  if (k <= 0) return null;
  return (
    <div className="abduct" key={k} aria-hidden>
      <div className="abduct-vignette" />
      <div className="abduct-flash" />
      <div className="abduct-black">
        <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="abduct-claws">
          <path d="M18 4 C 26 20, 30 38, 34 58" />
          <path d="M27 2 C 35 18, 40 36, 45 59" />
          <path d="M37 3 C 44 18, 50 34, 56 57" />
          <path d="M60 6 C 63 22, 67 40, 72 56" />
        </svg>
        <p className="abduct-text">牠把你拖進了黑暗裡……</p>
        <p className="abduct-sub">冷藏室・鐵籠</p>
      </div>
    </div>
  );
}

export default function GameScreen(): JSX.Element | null {
  const role = useStore((s) => s.me?.role ?? null);
  const briefed = useStore((s) => s.briefed);
  const panel = useStore((s) => s.station);
  const volume = useStore((s) => s.prefs.volume);
  const prefs = useStore((s) => s.prefs);
  const debug = useStore((s) => s.debug && s.debugOpen);
  const tutorial = useStore((s) => !!s.room?.tutorial);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const unbind = bindInput(ref.current);
    const stop = startGameLoop();
    void voice.start();
    return () => {
      unbind();
      stop();
    };
  }, []);

  // 教學關：不用開班前的操作說明（教學卡會一步一步帶）
  useEffect(() => {
    if (tutorial && !briefed) useStore.getState().set({ briefed: true });
  }, [tutorial, briefed]);

  useEffect(() => {
    audio.setVolume(volume);
  }, [volume]);

  // 各類聲音的音量與單聲道模式（音訊還沒啟動時引擎會先記住，啟動後套用）
  useEffect(() => {
    audio.setBusVolume('env', prefs.envVolume);
    audio.setBusVolume('echo', prefs.echoVolume);
    audio.setBusVolume('nav', prefs.navVolume);
    audio.setBusVolume('voice', prefs.voiceVolume);
    audio.setMono(prefs.mono);
  }, [prefs.envVolume, prefs.echoVolume, prefs.navVolume, prefs.voiceVolume, prefs.mono]);

  useEffect(() => {
    if (panel && document.pointerLockElement) document.exitPointerLock();
  }, [panel]);

  // 預先下載隊友的角色模型
  useEffect(() => {
    if (role) {
      preloadCrew([...CREW_MODELS]);
      preloadCreatures();
    }
  }, [role]);

  if (!role) return null;

  return (
    <div className="game" ref={ref} style={{ ['--hud-scale' as string]: prefs.uiScale ?? 0.85 } as React.CSSProperties}>
      <Suspense fallback={<div className="blind-view"><div className="whisper">正在點亮廚房…</div></div>}>
        <div style={{ position: 'absolute', inset: 0 }} onClick={() => !panel && requestLock()}>
          <Scene />
        </div>
      </Suspense>
      <Fx />
      <AbductFx />
      <Hud />
      <StationPanel />
      <MatePanel />
      <Overlays />
      {!briefed && !tutorial && <Briefing />}
      {tutorial && <TutorialCard />}
      <StorySlip />
      <ShiftResults />
      {debug && <DebugPanel />}
    </div>
  );
}
