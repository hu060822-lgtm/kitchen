import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { initNetwork, socket } from './net/socket';
import { useStore } from './state/store';
import { pose } from './game/controller';
import { blindDebug } from './game/loop';
import { audio } from './audio/engine';
import { music } from './audio/music';
import App from './ui/App';
import { getRecords, startRecords } from './state/records';
// 字型隨程式一起打包（不依賴外部字型服務；瀏覽器只會下載實際用到的字元子集）
import '@fontsource/noto-sans-tc/400.css';
import '@fontsource/noto-sans-tc/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';

if (!new URLSearchParams(location.search).get('preview')) {
  initNetwork();
  startRecords();
}

// ?debug：把 store 掛到 window 方便除錯／自動化測試。store 裡只有伺服器已依角色過濾後的資料，不會洩漏答案。
if (new URLSearchParams(location.search).has('debug')) {
  const events: Array<[number, string]> = [];
  socket.onAny((ev: string) => {
    if (ev === 'world:positions') return;
    events.push([Date.now(), ev]);
    if (events.length > 300) events.shift();
  });
  (window as unknown as { __NP__: unknown }).__NP__ = { useStore, pose, events, blind: blindDebug, audio, music, socket, records: getRecords };
}

// 角色預覽頁另外載入（不進主程式的套件）
const CrewPreview = lazy(() => import('./ui/CrewPreview'));
// 盲區員測試關卡（走廊、岔路、房門、目標）：同樣另外載入
const BlindLab = lazy(() => import('./ui/BlindLab'));
// 怪物預覽（四種狀態、第一人稱、察覺範圍俯視圖）
const MonsterPreview = lazy(() => import('./ui/MonsterPreview'));
// 客人預覽（四位一般客人、那位客人、坐在桌邊的樣子）
const GuestPreview = lazy(() => import('./ui/GuestPreview'));
// 食材模型預覽（整顆、架上、切法、熟度）
const FoodPreview = lazy(() => import('./ui/FoodPreview'));

const params = new URLSearchParams(location.search);
const preview = params.get('preview');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {preview === 'crew' ? (
      <Suspense fallback={null}>
        <CrewPreview />
      </Suspense>
    ) : preview === 'blind-lab' ? (
      <Suspense fallback={null}>
        <BlindLab />
      </Suspense>
    ) : preview === 'monster' ? (
      <Suspense fallback={null}>
        <MonsterPreview />
      </Suspense>
    ) : preview === 'food' ? (
      <Suspense fallback={null}>
        <FoodPreview />
      </Suspense>
    ) : preview === 'guests' ? (
      <Suspense fallback={null}>
        <GuestPreview />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
