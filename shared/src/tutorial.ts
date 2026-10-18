/**
 * 教學關「第一班」：一個人、沒有時間壓力，做一道煎蛋吐司，最後認識店裡的兩個威脅。
 *
 * 伺服器依廚房的實際狀態判定每一步完成了沒有（server/src/kitchen/tutorial.ts）；
 * 用戶端只負責顯示說明、在目標工作站上方放標記。
 * 判定都是「做到了沒有」，不是「照順序按了什麼」：玩家先做了後面的事，前面的步驟會一起過。
 *
 * 文字裡的 {interact}、{tickets} 之類會換成玩家目前設定的按鍵。
 */

export type TutorialAck =
  /** 按畫面上的按鈕（或 Enter） */
  | 'button'
  /** 打開訂單板 */
  | 'tickets'
  /** 打開食譜 */
  | 'cookbook';

export interface TutorialStepDef {
  id: TutorialStepId;
  title: string;
  text: string;
  /** 要去的工作站（畫面上放標記） */
  target?: string;
  /** 由玩家確認的步驟（伺服器看不到的事：讀完說明、打開某個畫面） */
  ack?: TutorialAck;
  /** 按鈕文字（ack === 'button'） */
  button?: string;
}

export type TutorialStepId =
  | 'welcome'
  | 'move'
  | 'tickets'
  | 'cookbook'
  | 'pantry'
  | 'toaster'
  | 'fridge'
  | 'pan'
  | 'cooked'
  | 'plate'
  | 'season'
  | 'serve'
  | 'guest_look'
  | 'guest_escort'
  | 'monster'
  | 'done';

export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    id: 'welcome',
    title: '第一班',
    text: '這一班只有你一個人，沒有時間壓力。跟著提示做一道煎蛋吐司，最後認識店裡的兩個「威脅」。大約 5 分鐘；隨時可以按「跳過教學」。',
    ack: 'button',
    button: '開始',
  },
  {
    id: 'move',
    title: '走動與轉頭',
    text: '{forward}{left}{back}{right} 走路，滑鼠轉頭（先點一下畫面鎖定游標，Esc 放開）。按住 {run} 跑步——跑步很吵，後門外的東西聽得到。走幾步試試。',
  },
  {
    id: 'tickets',
    title: '看單',
    text: '出餐口印出了一張單。按 {tickets} 打開訂單板，看是哪一桌、點了什麼；再按一次關掉。',
    target: 'pass',
    ack: 'tickets',
  },
  {
    id: 'cookbook',
    title: '查食譜',
    text: '按 {cookbook} 打開食譜。煎蛋吐司要：烤成金黃的吐司、奶油、一顆煎蛋，最後撒一點鹽和黑胡椒。',
    ack: 'cookbook',
  },
  {
    id: 'pantry',
    title: '拿吐司',
    text: '乾貨室在廚房後面（跟著標記走）。面對乾貨架按 {interact} 打開，拿一片吐司（注視架子時也可以直接按數字鍵拿）。手上的東西顯示在畫面下方：左手、右手和菜籃。',
    target: 'pantry',
  },
  {
    id: 'toaster',
    title: '烤吐司',
    text: '看著烤麵包機按滑鼠左鍵把吐司放進去，再按右鍵開始烤（3 段）。準星旁會提示左鍵、右鍵會做什麼。烤好會「叮」一聲跳起來。',
    target: 'toaster',
  },
  {
    id: 'fridge',
    title: '拿蛋',
    text: '冷藏室在廚房左後方，乾貨室的左邊。面對冷藏架按 {interact} 打開，拿一顆蛋（注視冷藏架時也可以直接按數字鍵拿）。',
    target: 'fridge',
  },
  {
    id: 'pan',
    title: '煎蛋',
    text: '看著平底鍋按右鍵開中火，再按左鍵把整顆蛋放下去。不用翻面。',
    target: 'pan_a',
  },
  {
    id: 'cooked',
    title: '等它熟',
    text: '爐子上的東西會一直煮下去，你走開也一樣。看鍋子裡的描述：蛋白凝固、蛋黃還軟就差不多了。吐司跳起來、蛋煎好，就看著它按左鍵拿起來。',
    target: 'pan_a',
  },
  {
    id: 'plate',
    title: '裝盤',
    text: '到裝盤區按左鍵：沒有盤子會自動拿一個，再把手上的東西裝上去。吐司、煎蛋都放上去；再去冷藏架拿一份奶油，也放上去。',
    target: 'plating',
  },
  {
    id: 'season',
    title: '調味',
    text: '盤子留在裝盤區。到調味區量鹽 0.5，回來倒在盤子上；黑胡椒 0.5 也一樣。份量不準也沒關係，評分會告訴你。',
    target: 'spice',
  },
  {
    id: 'serve',
    title: '出餐',
    text: '在裝盤區空手按左鍵端起盤子，送到出餐口再按左鍵出餐（會自動選最合適的單）。出餐口會幫這道菜打分數。',
    target: 'pass',
  },
  {
    id: 'guest_look',
    title: '那位客人',
    text: '餐廳最遠的桌子坐著一位從來不點餐的客人。穿過旋轉門到餐廳，看著他——有人看著他的時候，他不會動。',
  },
  {
    id: 'guest_escort',
    title: '請他回座位',
    text: '沒人看著他時，他會一步一步靠近廚房，跟在人旁邊擋路。現在他已經走進廚房了：站到他旁邊、面對他按 {interact}，請他回座位。',
  },
  {
    id: 'monster',
    title: '後門外的東西',
    text: '廚房越吵，牠越快來；平常進來前會在後門外刮門 6 秒，這時到監視器鎖後門就進不來。現在牠已經進來了，會追最近的人：躲進置物櫃（面對置物櫃按 {interact}），或跑進餐廳（牠不進餐廳）。被抓到也沒關係，在鐵籠裡按 {interact} 自己搖開。',
    target: 'locker_k',
  },
  {
    id: 'done',
    title: '教學完成',
    text: '你走完了一整輪：看單、拿食材、烤、煎、裝盤、調味、出餐，也見過了那位客人和後門的東西。真正的一班還有缺陷卡、隊友、更多的單和主廚委託。',
  },
];

export const TUTORIAL_STEP_BY_ID = Object.fromEntries(TUTORIAL_STEPS.map((s, i) => [s.id, { ...s, index: i }])) as Record<TutorialStepId, TutorialStepDef & { index: number }>;

/** 廚房快照裡的教學狀態 */
export interface TutorialPublic {
  step: TutorialStepId;
  index: number;
  total: number;
  /** 出餐的分數（出餐之後） */
  score?: number;
}
