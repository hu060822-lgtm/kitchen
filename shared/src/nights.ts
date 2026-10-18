/**
 * 連續七晚（營業日誌）。
 *
 * 每晚多一點變化：新的主廚委託、後門的東西多一種行為、那位不點餐的客人越來越靠近；
 * 開班前讀一段，營業到一半出單機會印出一張「不是訂單的單」，打烊後再一段。第七晚，那位客人會點餐。
 *
 * 倍率都是「1＝原本的規則」。伺服器依這裡的設定調整威脅與出單；用戶端顯示文字、收進營業日誌。
 */

export interface NightMonsterTune {
  /** 想進來的門檻（＜1＝比較快進來） */
  hunger: number;
  /** 對聲音的敏感度 */
  noise: number;
  /** 在廚房待多久 */
  stay: number;
  speed: number;
  /** 追同一個人多久才換人（倍率；原本 20 秒） */
  loseSight: number;
  /** 自己離開後的飢餓值（＞0＝比較快回來） */
  returnHunger: number;
}

export interface NightGuestTune {
  /** 營業開始後多久出現（毫秒） */
  appearMs: number;
  /** 沒人看著幾毫秒移一格 */
  stepMs: number;
  /** 一開始坐在哪個位子（0＝最遠；4＝離旋轉門最近的座位） */
  startIdx: number;
  /** 請回座後安靜多久（倍率） */
  calm: number;
}

export interface NightDef {
  night: number;
  title: string;
  /** 開班前讀的一段 */
  intro: string;
  /** 今晚的變化（開班前的說明裡逐條列出） */
  changes: string[];
  /** 營業到一半，出單機印出的「不是訂單的單」 */
  fragment: { title: string; text: string };
  /** 打烊後的一段 */
  outro: string;
  /** 第七晚：那位客人點的菜沒出成時的結尾 */
  outroMissed?: string;
  /** 今晚的兩張進階委託（取代隨機挑的那兩張） */
  commissions: [string, string];
  guest: NightGuestTune;
  monster: NightMonsterTune;
  /** 第七晚：那位客人點餐（營業到第幾成） */
  storyOrder?: { atFrac: number; recipeId: string; text: string };
}

export const NIGHT_COUNT = 7;

export const NIGHTS: readonly NightDef[] = [
  {
    night: 1,
    title: '交接',
    intro:
      '新老闆把鑰匙交給你們的時候，只交代了三件事：後門入夜以後別開；最遠那張桌子的客人不用招呼，他不會點餐；打烊前，把出餐口的單子撕乾淨。他沒說為什麼。',
    changes: ['第一晚：那位客人比較晚才出現，後門外的東西也還在觀望。', '今晚的主廚委託：「奶香料理」「三種食材的限制」。'],
    fragment: {
      title: '最後一桌，兩位',
      text: '出單機自己印了一張。日期是二十年前的今天。桌號那一欄寫著：最後一桌。人數：兩位。備註：不用急，等主廚忙完。',
    },
    outro: '打烊後你把那張單撕下來，想丟進垃圾桶，最後還是夾進了值班日誌。最遠那張桌子，椅子被拉開了一點點。',
    commissions: ['creamy', 'three_items'],
    guest: { appearMs: 90_000, stepMs: 8000, startIdx: 0, calm: 1.2 },
    monster: { hunger: 1.35, noise: 0.85, stay: 0.85, speed: 1, loseSight: 1, returnHunger: 0 },
  },
  {
    night: 2,
    title: '訂位簿',
    intro: '你在櫃台抽屜的最底下找到一本舊訂位簿。最後一頁只有一筆：「二十三點，最後一桌，兩位。林。」字寫得很用力，像是怕被誰塗掉。',
    changes: ['那位客人比昨天早出現。', '今晚的主廚委託：「指定食材挑戰」「一鍋完成」。'],
    fragment: {
      title: '訂位簿的背面',
      text: '背面是另一個人的筆跡，像是寫給自己看的：「今天收完就收了。最後一道我自己做，做給他吃。」',
    },
    outro: '那位客人今天看了你一眼。不是看你，是看你身後的廚房，像在找一個人。',
    commissions: ['corn_cheese', 'one_pot'],
    guest: { appearMs: 60_000, stepMs: 7000, startIdx: 0, calm: 1 },
    monster: { hunger: 1.15, noise: 1, stay: 1, speed: 1, loseSight: 1, returnHunger: 0 },
  },
  {
    night: 3,
    title: '後門的鎖',
    intro: '後門的鎖是電子的，在監視器那裡可以鎖、可以開。老闆說它以前會自己鎖上——「門一關就鎖，從外面打不開。」他說完就不再提了。',
    changes: ['後門的東西聽得更清楚了：切菜、鍋鏟、跑步，都會讓牠更快想進來。', '那位客人一開始就換到比較近的位子。', '今晚的主廚委託：「不能使用油」「麵食專家」。'],
    fragment: {
      title: '維修單',
      text: '後門電子鎖。故障：關門即自動上鎖，外側無法開啟。處理：已報修，待料。日期：二十年前，十月。',
    },
    outro: '打烊時你特別確認了後門，鎖得好好的。門的另一邊，有人很輕、很輕地敲了兩下。',
    commissions: ['no_oil', 'noodle_pro'],
    guest: { appearMs: 55_000, stepMs: 6500, startIdx: 1, calm: 1 },
    monster: { hunger: 1, noise: 1.35, stay: 1, speed: 1, loseSight: 1, returnHunger: 0 },
  },
  {
    night: 4,
    title: '監視器',
    intro: '監視器的硬碟裡還留著一段很舊的畫面，時間停在二十三點五十八分。你們沒有人去點開它。',
    changes: ['後門的東西進來之後，會待得比較久。', '那位客人又坐近了一些，回座後安靜的時間也變短。', '今晚的主廚委託：「限時出餐」「鮮味大師」。'],
    fragment: {
      title: '23:58',
      text: '畫面裡，主廚拎著兩袋垃圾推開後門，門在他身後闔上。外面在下雨。畫面裡的廚房很忙，所有人都低著頭。',
    },
    outro: '你想起那段畫面沒有聲音。可是你好像聽得見——抽風機、油鍋、出單機，一層蓋過一層。',
    commissions: ['rush', 'umami'],
    guest: { appearMs: 50_000, stepMs: 6000, startIdx: 2, calm: 0.9 },
    monster: { hunger: 1, noise: 1.35, stay: 1.1, speed: 1, loseSight: 1, returnHunger: 0 },
  },
  {
    night: 5,
    title: '太吵了',
    intro: '老闆今天喝了點酒，說那天晚上的廚房是他待過最吵的一次。「滿座。單一直印出來。誰都沒空抬頭。」',
    changes: ['後門的東西離開之後，會比較快回來。', '那位客人沒人看著時移動得更快。', '今晚的主廚委託：「食材替代」「外酥內軟」。'],
    fragment: {
      title: '值班日誌，二十年前',
      text: '23:58 主廚出去倒垃圾。00:20 還沒回來，大概在後巷抽菸。00:45 最後一桌的客人說他再等一下。01:30 打烊。後門打不開，從裡面也打不開。',
    },
    outro: '打烊後很安靜。安靜到你聽得見後門那邊，有指節一下一下地敲著，很有耐心，像在等人開門。',
    commissions: ['substitute', 'crispy_outside'],
    guest: { appearMs: 45_000, stepMs: 5500, startIdx: 2, calm: 0.85 },
    monster: { hunger: 0.95, noise: 1.35, stay: 1.1, speed: 1, loseSight: 1, returnHunger: 25 },
  },
  {
    night: 6,
    title: '只要一下下',
    intro: '那位客人今天第一次開口。不是對你們，是對著他對面空著的座位：「你說只要一下下。」',
    changes: ['後門的東西走得更快，追同一個人也追得更久才換人。', '那位客人一開始就坐在靠門的位子，移動也更快。', '今晚的主廚委託：「濃湯挑戰」「異常廚房」。'],
    fragment: {
      title: '最後一桌的帳單',
      text: '品項：（空白）。金額：（空白）。簽名欄寫著：「等他出來，一起結。」',
    },
    outro: '你們終於懂了。他不是不點餐。他在等一個人從廚房出來，幫他點。',
    commissions: ['thick_soup', 'timer_broken'],
    guest: { appearMs: 35_000, stepMs: 5000, startIdx: 3, calm: 0.8 },
    monster: { hunger: 0.9, noise: 1.4, stay: 1.15, speed: 1.08, loseSight: 1.2, returnHunger: 25 },
  },
  {
    night: 7,
    title: '最後一桌',
    intro: '最後一晚。訂位簿上那一筆，今天的日期被人用鉛筆圈了起來。後門外的敲門聲，從開店就沒有停過。',
    changes: ['今晚，那位客人會點餐。他的單很有耐心，但只有一張。', '後門的東西比任何一晚都想進來。', '今晚的主廚委託：「雙重限制」「主廚的自由命題」。'],
    fragment: {
      title: '最後一道',
      text: '出單機印出一張手寫字的單：「煎蛋吐司。蛋黃要軟的。他以前都這樣做給我吃。」',
    },
    outro:
      '你們把那盤煎蛋吐司放在最後一桌。他低頭看了很久，把蛋黃戳破，像是在確認什麼。「對，就是這樣。」他站起來，把椅子推回去，對著後門的方向點了點頭。敲門聲停了。出單機印出最後一張：「最後一桌，已結帳。」',
    outroMissed: '那張單在出單軌上燒成了灰。他還坐在那裡，看著對面的空位。後門的敲門聲沒有停。——明天晚上，再試一次吧。',
    commissions: ['no_meat_no_egg', 'chef_choice'],
    guest: { appearMs: 25_000, stepMs: 4500, startIdx: 4, calm: 0.75 },
    monster: { hunger: 0.85, noise: 1.45, stay: 1.2, speed: 1.1, loseSight: 1.5, returnHunger: 30 },
    storyOrder: { atFrac: 0.5, recipeId: 'egg_toast', text: '最後一桌（那位客人）點餐了：煎蛋吐司。蛋黃要軟的。' },
  },
];

export const nightDef = (n: number): NightDef | null => NIGHTS[n - 1] ?? null;

/** 營業到第幾成時印出故事碎片 */
export const FRAGMENT_AT = 0.45;

/** 那位客人的桌號（出單軌上顯示「最後一桌」） */
export const STORY_TABLE = 0;

/** 廚房快照裡的這一晚 */
export interface NightPublic {
  night: number;
  /** 故事碎片印出來了沒有 */
  fragment: boolean;
  /** 第七晚：那位客人的單（open／served／missed；還沒點＝null） */
  story: 'open' | 'served' | 'missed' | null;
}
