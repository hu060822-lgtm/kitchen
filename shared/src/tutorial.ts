/**
 * 教學關「第一班」：一個人、沒有時間壓力。帶班的老廚師「老周」一步一步帶你：
 *   基本操作 → 看單與食譜 → 拿食材、兩隻手與菜籃 → 烤、煎、一次裝盤、調味、出餐
 *   → 地上的積水 → 隊友與缺陷卡 → 那位客人 → 後門外的東西（鎖門、來福槍、躲藏）。
 *
 * 伺服器依廚房的實際狀態判定每一步完成了沒有（server/src/kitchen/tutorial.ts）；
 * 用戶端只負責顯示老周說的話、要做的事、在目標上方放標記，並讓老周站到要去的地方。
 * 判定都是「做到了沒有」，不是「照順序按了什麼」：玩家先做了後面的事，前面的步驟會一起過。
 *
 * 文字裡的 {interact}、{tickets} 之類會換成玩家目前設定的按鍵；[左鍵]、[右鍵]、[滾輪] 是滑鼠。
 */

export type TutorialAck =
  /** 按畫面上的按鈕（或 Enter） */
  | 'button'
  /** 打開訂單板 */
  | 'tickets'
  /** 打開食譜 */
  | 'cookbook';

/** 教學分成幾個章節（卡片上方顯示） */
export type TutorialChapter = 'basics' | 'ingredients' | 'cooking' | 'floor' | 'crew' | 'threats' | 'end';

export const TUTORIAL_CHAPTER_LABEL: Record<TutorialChapter, string> = {
  basics: '一・基本',
  ingredients: '二・拿食材',
  cooking: '三・做菜到出餐',
  floor: '四・地上的水',
  crew: '五・隊友與缺陷卡',
  threats: '六・店裡的「威脅」',
  end: '下班',
};

export interface TutorialStepDef {
  id: TutorialStepId;
  chapter: TutorialChapter;
  title: string;
  /** 老周說的話（一句一句出現） */
  say: readonly string[];
  /** 要做的事（簡短、帶按鍵） */
  text: string;
  /** 要去的工作站（畫面上放標記、老周站到旁邊） */
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
  | 'hands'
  | 'pan'
  | 'cooked'
  | 'butter'
  | 'plate_all'
  | 'season'
  | 'serve'
  | 'puddle'
  | 'crew'
  | 'guest_look'
  | 'guest_escort'
  | 'backdoor'
  | 'rifle'
  | 'monster'
  | 'done';

/** 帶班的老廚師 */
export const MENTOR = {
  name: '老周',
  title: '夜班主廚',
} as const;

export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    id: 'welcome',
    chapter: 'basics',
    title: '新來的？',
    say: ['你就是新來的夜班？我是老周，這間店的夜班主廚，做了快三十年。', '今晚店裡只有我們兩個，客人也只有一桌——我帶你從頭走一遍。不趕時間，照著做就好。', '要是覺得自己都會了，右下角可以跳過。'],
    text: '大約 8 分鐘。按「開始」或 Enter；之後點一下畫面鎖定滑鼠（Esc 放開）。',
    ack: 'button',
    button: '開始',
  },
  {
    id: 'move',
    chapter: 'basics',
    title: '走動與轉頭',
    say: ['先活動一下。廚房不大，但東西很多。', '用跑的比較快——可是跑步很吵。後門外有東西喜歡聽人跑步，等等你就知道了。'],
    text: '{forward}{left}{back}{right} 走路、滑鼠轉頭，按住 {run} 跑步。走幾步試試。',
  },
  {
    id: 'tickets',
    chapter: 'basics',
    title: '看單',
    say: ['出餐口的機器在印單了。每一張單都有桌號、菜名，底下那條會慢慢燒短——那是客人的耐心。'],
    text: '按 {tickets} 打開訂單板看單，再按一次關掉。',
    target: 'pass',
    ack: 'tickets',
  },
  {
    id: 'cookbook',
    chapter: 'basics',
    title: '查食譜',
    say: ['煎蛋吐司。別笑，越簡單的越容易做砸。', '不知道怎麼做就翻食譜：要什麼料、熟到什麼程度、調什麼味，都寫在上面。'],
    text: '按 {cookbook} 打開食譜看「煎蛋吐司」：烤到金黃的吐司、奶油、煎蛋、一點鹽和黑胡椒。',
    ack: 'cookbook',
  },
  {
    id: 'pantry',
    chapter: 'ingredients',
    title: '拿吐司',
    say: ['乾貨室在廚房後面。吐司、洋蔥、馬鈴薯、高湯都在那裡。', '看著架子按數字鍵就直接拿，不用開面板；按住 Shift 再按是拿滿。'],
    text: '走到乾貨架（跟著標記），看著它按數字鍵拿一片吐司（或按 {interact} 打開面板選）。',
    target: 'pantry',
  },
  {
    id: 'toaster',
    chapter: 'ingredients',
    title: '烤吐司',
    say: ['滑鼠左鍵是「拿／放」，右鍵是「使用」——準星旁邊會告訴你按了會做什麼。', '烤麵包機烤好會「叮」一聲跳起來，你可以先去做別的。'],
    text: '看著烤麵包機：[左鍵] 放進去，[右鍵] 開始烤（3 段）。',
    target: 'toaster',
  },
  {
    id: 'fridge',
    chapter: 'ingredients',
    title: '兩隻手和菜籃',
    say: ['冷藏室在廚房左後方。蛋、奶油、肉、青菜都在冷藏架上。', '你有兩隻手，腰上還掛著一個菜籃——生的原料可以多放兩份在菜籃裡。', '今天先拿兩顆蛋、再拿一份奶油：手上放不下的，會自己進菜籃。'],
    text: '在冷藏架先拿兩顆蛋、再拿一份奶油（數字鍵或面板都行）。看畫面下方：左手、右手、菜籃。',
    target: 'fridge',
  },
  {
    id: 'hands',
    chapter: 'ingredients',
    title: '換手、翻菜籃',
    say: ['亮起來的那一格是你現在用的手，放東西、拿東西都用它。', '按 B 或轉滑鼠滾輪就能換：這隻手、另一隻手、菜籃裡的每一格，空手也能換。'],
    text: '按兩次 {swap}（或轉 [滾輪]），看亮起來的格子怎麼移動。',
  },
  {
    id: 'pan',
    chapter: 'cooking',
    title: '煎蛋',
    say: ['平底鍋：右鍵開火，左鍵把手上的東西放下去。', '手上的放下去之後，會自動換成另一隻拿著東西的手——連按兩下，兩顆蛋都下鍋。'],
    text: '看著平底鍋 A：[右鍵] 開中火，[左鍵] 把蛋放下去（兩顆）。數字鍵 1–4 也能直接調火。',
    target: 'pan_a',
  },
  {
    id: 'cooked',
    chapter: 'cooking',
    title: '等它熟',
    say: ['爐子上的東西會一直煮下去，你走開也一樣——所以別忘了它。', '看鍋裡的描述：蛋白凝固、蛋黃還軟就差不多了。焦了的蛋，客人吃得出來。'],
    text: '等吐司跳起來、蛋煎熟。這段時間可以去裝盤區旁邊等著。',
    target: 'pan_a',
  },
  {
    id: 'butter',
    chapter: 'cooking',
    title: '先放奶油',
    say: ['等的時候先把盤子準備好。奶油還在你手上吧？', '看著裝盤區按左鍵：沒有盤子會自己拿一個，再把手上的料裝上去。'],
    text: '看著裝盤區 [左鍵]：自動拿盤子並把奶油裝上去。',
    target: 'plating',
  },
  {
    id: 'plate_all',
    chapter: 'cooking',
    title: '一次裝盤',
    say: ['以前的學徒一份一份拿去裝盤，跑到腿斷。', '拿著盤子走到鍋子前面按左鍵，裡面煮好的東西一次全部倒進盤子。烤麵包機、烤箱、成品架都一樣。'],
    text: '空手看著裝盤區 [左鍵] 端起盤子；拿著盤子看平底鍋 [左鍵] 全部裝盤，再看烤麵包機 [左鍵]。',
    target: 'pan_a',
  },
  {
    id: 'season',
    chapter: 'cooking',
    title: '調味',
    say: ['調味區用量匙。量多少就是多少，倒上去就收不回來了。', '份量不準也沒關係，出餐的時候評分會告訴你差在哪裡。'],
    text: '盤子放回裝盤區（[左鍵]）。到調味區量鹽 0.5（看著它按數字鍵），回裝盤區 [左鍵] 倒在盤子上；黑胡椒也一樣。',
    target: 'spice',
  },
  {
    id: 'serve',
    chapter: 'cooking',
    title: '出餐',
    say: ['最後一步。空手端起盤子，拿到出餐口——會自動對上最合適的那張單。', '單燒完之前沒送到，就是跑單。跑太多單，這間店就撐不下去。'],
    text: '在裝盤區空手 [左鍵] 端起盤子，到出餐口 [左鍵] 出餐。',
    target: 'pass',
  },
  {
    id: 'puddle',
    chapter: 'floor',
    title: '地上的水',
    say: ['……誰把水灑在地上了。', '用跑的踩到積水會滑倒，手上的東西會飛出去，跌倒的聲音也會引來東西。湯鍋滾太久也會溢出來。', '看到就擦掉。'],
    text: '走到積水旁邊按 {pickup} 擦乾（別用跑的）。地上的食材也是按 {pickup} 撿。',
  },
  {
    id: 'crew',
    chapter: 'crew',
    title: '隊友與缺陷卡',
    say: [
      '真正的夜班不會只有你一個。每個人開班前抽一張「缺陷卡」——怕火的、嚐不出味道的、只有一隻手的、個子太高或太矮的……',
      '所以要互相補：放上交接架讓別人接手、按 {toss} 把食材丟給準心對著的隊友、按 {handoff} 接住遞來的東西，嗜睡的人就拍他一下。',
      '用跑的撞到隊友，他手上的東西會晃。廚房很擠，走路看路。',
    ],
    text: '看完按「知道了」（Enter）。真正開班前，大廳裡會讓每個人選缺陷卡。',
    ack: 'button',
    button: '知道了',
  },
  {
    id: 'guest_look',
    chapter: 'threats',
    title: '那位客人',
    say: ['接下來的事，白天的人不會跟你說。', '餐廳裡坐著一位客人，他從來不點餐。去看看他——有人看著他的時候，他不會動。'],
    text: '穿過旋轉門到餐廳，看著那位穿黑西裝的客人一下。',
  },
  {
    id: 'guest_escort',
    chapter: 'threats',
    title: '請他回座位',
    say: ['沒人看著他的時候，他會一步一步走進廚房，站在你旁邊擋路。', '不要跟他吵。客客氣氣請他回去就好。'],
    text: '他已經走進廚房了：站到他旁邊、面對他按 {interact}，請他回座位。',
  },
  {
    id: 'backdoor',
    chapter: 'threats',
    title: '後門的刮門聲',
    say: ['聽到了嗎？後門外面。', '廚房越吵，牠越快來。牠進來之前會先在門外刮門——這時候去監視器把後門鎖上，牠就進不來。', '真正的時候你只有 6 秒。今天我先幫你擋著，你過去鎖。'],
    text: '到監視器按 [右鍵]（或數字鍵 2）鎖後門。',
    target: 'cctv',
  },
  {
    id: 'rifle',
    chapter: 'threats',
    title: '槍架',
    say: ['門不會一直鎖著，牠總有一天會進來。', '監視器旁邊那把來福槍，整班只有 4 發子彈。打中一次，牠就會逃回後門。', '要空出兩隻手才拿得動。'],
    text: '空出雙手，看著來福槍架 [左鍵] 拿起來。',
    target: 'gunrack',
  },
  {
    id: 'monster',
    chapter: 'threats',
    title: '後門外的東西',
    say: ['來了。牠會追最近的人。', '把十字準心對準牠——變紅了才打得中——按左鍵。沒把握就躲進置物櫃，或跑進餐廳，牠不進餐廳。', '被抓到也別慌，在冷藏室的鐵籠裡按 {interact} 可以自己搖開。今天我讓牠走慢一點。'],
    text: '十字準心對準牠變紅時 [左鍵] 開槍；或躲進置物櫃（{interact}）、跑進餐廳。其他反制：監視器的緊急照明、看著牠按 {toss} 丟東西砸牠。',
    target: 'locker_k',
  },
  {
    id: 'done',
    chapter: 'end',
    title: '下班',
    say: [
      '不錯，第一晚就撐過來了。',
      '真正的一班還有更多的單、主廚委託、隊友和他們的缺陷卡，還有連續七個晚上——每晚都會多一點奇怪的事。',
      '明天開始就是你的了。對了……別讓最後一桌等太久。',
    ],
    text: '教學完成。可以直接開始真正的一班，或回到起始頁面。',
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
  /** 這一步要擦的積水（畫面標記用） */
  puddle?: [number, number];
}
