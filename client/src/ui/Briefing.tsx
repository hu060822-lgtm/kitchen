import { useEffect, useRef, useState } from 'react';
import { FLAW_CARDS, NIGHT_COUNT, RECIPES, nightDef } from '@last-table/shared';
import { audio } from '../audio/engine';
import { requestLock } from '../game/loop';
import { keyLabel, useKeymap, type KeyAction } from '../game/keymap';
import { readyUp } from '../net/socket';
import { myFlaw, useStore } from '../state/store';
import { FlawBadge, FlawDetail } from './flawUi';
import { KeyBindings } from './KeyBindings';
import MicSetup from './MicSetup';
import { EndlessIntro, useEndlessToday } from './EndlessUi';
import { useCampaign } from '../state/campaign';

const NO_MENU: string[] = [];

/**
 * 開班前的操作說明：按鍵顯示的是自己設定的鍵。
 * 按「我看懂了，準備好」才算準備好；全員準備好（或房主決定不等）班次時鐘才開始走——
 * 讀說明的時間不會吃掉備料時間。準備好之後就能進廚房先走動熟悉，但要等時鐘開始才能操作工作站。
 */
type Row = [keys: Array<KeyAction | string>, text: string];
const CONTROLS: Row[] = [
  [['forward', 'left', 'back', 'right'], '移動（按住跑步鍵跑，很吵）'],
  [['run'], '跑步（按住）'],
  [['滑鼠'], '轉向（點一下畫面鎖定游標）'],
  [['左鍵'], '看著工作站：拿／放（手上有東西就放上去，空手就拿起來；裝盤區自動拿盤子；出餐口自動選單出餐）'],
  [['左鍵'], '拿著盤子看著平底鍋／烤箱／成品架／湯鍋：煮好的東西一次全部裝盤；拿著來福槍：開槍（準心變紅才打得中）'],
  [['右鍵'], '看著工作站：使用——備料台一鍵切、平底鍋翻面／湯鍋攪拌（空鍋時開關火）、開始烤、清洗、攪拌、拿新盤子、監視器鎖後門或緊急照明'],
  [['interact'], '面對工作站：打開面板（走開就關閉；面板裡可以按數字鍵）；面對隊友：拍肩、遞東西、覆誦訂單、回報試吃；被關進鐵籠：自己搖開'],
  [['1–9', '0'], '看著工作站直接做：冷藏架／乾貨架拿第幾種食材（Shift 拿滿、0 換分類）；爐子 1 關 2 小 3 中 4 大；烤麵包機 1–5 段；調味區量第幾種（Shift 量 1）；監視器 1 防火門 2 鎖後門 3 緊急照明'],
  [['swap', '滾輪'], '切換左手／右手／菜籃：物品欄在畫面下方，亮起來的是目前用的手，空手也能切'],
  [['handoff'], '接住隊友遞過來的東西，或隊友手上快掉的東西'],
  [['toss'], '把手上的食材丟給準心對著的隊友；對著後門的東西丟過去會讓牠愣住 3 秒'],
  [['pickup'], '撿起地上的東西（奶油手：穩住手上的東西）'],
  [['ability'], '缺陷卡的技能（召集、氣味警告、雙爐面板）'],
  [['mark'], '標記面前的工作站給隊友看（訂單在訂單板裡標記）'],
  [['crouch'], '蹲下：腳步安靜，怪物比較難看到你'],
  [['tickets'], '訂單板（出單、傳聞、準備提示）'],
  [['cookbook'], '食譜與口味表'],
  [['signals'], '信號器：敲擊、燈號、符號、手勢'],
  [['help'], '說明與設定（也可以在那裡改按鍵）'],
  [['mute'], '麥克風靜音'],
  [['Esc'], '關閉面板，或放開游標'],
];
const ACTIONS = new Set<string>(['forward', 'left', 'back', 'right', 'run', 'interact', 'swap', 'handoff', 'toss', 'pickup', 'ability', 'mark', 'crouch', 'tickets', 'cookbook', 'signals', 'help', 'mute']);

export default function Briefing(): JSX.Element | null {
  useKeymap();
  const role = useStore((s) => s.me?.role ?? null);
  const restoredWait = useStore((s) => s.room?.waiting?.why === 'restored');
  const nightN = useStore((s) => s.room?.night ?? 0);
  const flaw = useStore(() => myFlaw());
  const today = useEndlessToday();
  const camp = useCampaign();
  const enter = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // 聚焦按鈕但不要把說明捲走
  useEffect(() => enter.current?.focus({ preventScroll: true }), []);
  if (!role || !flaw) return null;
  const card = FLAW_CARDS[flaw];

  const go = async (): Promise<void> => {
    setBusy(true);
    await audio.init();
    audio.startAmbient();
    const err = await readyUp();
    setBusy(false);
    if (err) useStore.getState().pushNotice({ tone: 'warn', text: err });
    useStore.getState().set({ briefed: true });
    requestLock();
  };

  return (
    <div className="modal-bg" style={{ background: 'rgba(36,39,41,.82)' }}>
      <div className="modal" style={{ width: 'min(780px, 100%)' }}>
        <header>
          <FlawBadge flaw={flaw} short />
          <div>
            <div className="sub">缺陷卡・{card.role}</div>
            <h2 style={{ fontSize: 'var(--t-xl)' }}>你是{card.name}</h2>
          </div>
          <span />
        </header>
        <div className="body">
          <p className="blk-text brief-clock">
            {restoredWait
              ? '這是從存檔讀回來的班次：時鐘停在存檔的那一刻。複習一下操作，按下面的「準備好」；全員準備好才繼續。'
              : '班次時鐘還沒開始：慢慢讀完操作，按下面的「準備好」。全員準備好才開始計時。'}
          </p>
          {nightN > 0 && <NightIntro night={nightN} />}
          {today && <EndlessIntro today={today} best={camp.endlessBest} />}
          <p className="blk-text">
            午夜之後的最後一班。單會從出餐口印出來：有照標準做的招牌菜，也有只說「我想吃什麼」、做法由你們決定的主廚委託（只有條件，沒有標準答案）。
            餐廳最遠的那張桌子坐著一位從來不點餐的客人；後門外，有東西會被噪音吸引進來。它們不會改變料理的規則——爐子上的東西，不管你躲到哪裡都會繼續煮。
          </p>
          <p className="blk-text">
            <b>{card.tagline}</b>
          </p>
          <FlawDetail flaw={flaw} />
          <MenuToday />
          <div className="blk-heading">操作（你目前的按鍵）</div>
          <dl className="kv">
            {CONTROLS.filter(([k]) => flaw !== 'D04' || !k.includes('mute')).map(([keys, v]) => (
              <Line key={v} keys={keys} v={v} />
            ))}
          </dl>
          <details className="kb-details">
            <summary>改按鍵</summary>
            <KeyBindings />
          </details>
          <div className="blk-heading">語音</div>
          <MicSetup flaw={flaw} />
          <div className="actions">
            <button ref={enter} className="btn primary" disabled={busy} onClick={() => void go()}>
              我看懂了，準備好
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ keys, v }: { keys: Array<KeyAction | string>; v: string }): JSX.Element {
  return (
    <>
      <dt>
        {keys.map((k) => (
          <kbd key={k}>{ACTIONS.has(k) ? keyLabel(k as KeyAction) : k}</kbd>
        ))}
      </dt>
      <dd>{v}</dd>
    </>
  );
}

/** 這一班的菜單：招牌菜＋今日特餐（食譜在 R 裡） */
function MenuToday(): JSX.Element | null {
  const menu = useStore((s) => s.kitchen?.menu) ?? NO_MENU;
  useKeymap();
  if (!menu.length) return null;
  const sig = menu.filter((id) => RECIPES[id]?.group === 'signature');
  const sp = menu.filter((id) => RECIPES[id] && RECIPES[id].group !== 'signature');
  return (
    <>
      <div className="blk-heading">今晚的菜單</div>
      <div className="briefing-menu">
        {sig.map((id) => (
          <span key={id} className="chip">{RECIPES[id].name}</span>
        ))}
        {sp.map((id) => (
          <span key={id} className="chip special">今日特餐：{RECIPES[id].name}</span>
        ))}
      </div>
      <p className="xs dim">
        食譜在 <kbd>{keyLabel('cookbook')}</kbd> 的「本班菜單」。主廚委託沒有標準做法——任何合理的做法都會被認出來、取名字、評分。
      </p>
    </>
  );
}

/** 連續七晚：開班前讀的一段，與今晚的變化 */
function NightIntro({ night }: { night: number }): JSX.Element | null {
  const def = nightDef(night);
  if (!def) return null;
  return (
    <div className="night-intro">
      <div className="night-no">
        第 {night} 晚／共 {NIGHT_COUNT} 晚
      </div>
      <h3>{def.title}</h3>
      <p className="night-text">{def.intro}</p>
      <div className="blk-heading">今晚的變化</div>
      <ul className="blk-list">
        {def.changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}
