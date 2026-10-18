import type { Seat } from './seats';
import type { SignalToken } from './signals';
import type { ZoneId } from './level';

/**
 * 缺陷卡系統 v1.0（共用定義）。
 *
 * 缺陷 = 能力缺口 + 補償優勢 + 互助接口 + 高光時刻。
 *
 * 這個檔案只有「資料」：卡片說明（給介面看）、型別化的效果設定（給伺服器判定用）、
 * 互助操作與狀態的型別。所有判定都在伺服器的 FlawSystem（server/src/flaws/）裡，
 * 介面元件不自己實作任何一套規則，只顯示伺服器給的狀態。
 *
 * 卡片用固定 ID（D01–D16）當主鍵；顯示名稱可以改，存檔、遙測與設定都只認 ID。
 */

export const FLAW_IDS = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16'] as const;
export type FlawId = (typeof FLAW_IDS)[number];
export const isFlawId = (v: unknown): v is FlawId => typeof v === 'string' && (FLAW_IDS as readonly string[]).includes(v);

export type FlawCategory = 'information' | 'communication' | 'operation' | 'mobility' | 'environment' | 'rhythm';
export type FlawPhase = 'A' | 'B' | 'C' | 'D';

export interface FlawCard {
  id: FlawId;
  name: string;
  /** 定位（企劃書的「定位」） */
  role: string;
  category: FlawCategory;
  phase: FlawPhase;
  /** 這一版已經實作、可以在大廳選 */
  available: boolean;
  tagline: string;
  limitation: string[];
  compensation: string[];
  cooperationHooks: string[];
  heroMoment: string;
  /** 受影響的操作（伺服器的接點名稱，見 docs/FLAW_CARDS.md） */
  affectedActions: string[];
  accessibilityNotes: string[];
}

const card = (c: FlawCard): FlawCard => c;

export const FLAW_CARDS: Record<FlawId, FlawCard> = {
  D01: card({
    id: 'D01',
    name: '幻聽外場',
    role: '資訊判讀型／訂單協作',
    category: 'information',
    phase: 'A',
    available: true,
    tagline: '聽得到還沒出現的訂單——也聽得到根本不存在的。',
    limitation: ['只有你會聽到「傳聞」：有些是假訂單（不存在的菜、錯的數量、錯的要求）', '傳聞不會自動變成訂單，要核對才知道真假'],
    compensation: ['真訂單出現前，你偶爾會先聽到一部分（菜名或關鍵食材，不含數量與特殊要求）', '核對為真的傳聞會變成全隊的「準備提示」，大家可以提早備料'],
    cooperationHooks: ['把傳聞貼到訂單板（Tab → 傳聞）', '隊友到出餐口「核對」只要 2 秒（你自己核對要 6 秒）', '任何人都可以「駁回」一則傳聞'],
    heroMoment: '你先聽到「有人要番茄」，隊友核對為真，番茄在訂單出現前就切好了。',
    affectedActions: ['order_preview', 'rumor_post', 'rumor_verify', 'rumor_dismiss'],
    accessibilityNotes: ['真傳聞與假傳聞的提示音有細微、固定的音高差異，可以學', '傳聞同時以文字卡顯示，不只靠聲音'],
  }),
  D02: card({
    id: 'D02',
    name: '耳背砧板',
    role: '感官資訊型／專注作業',
    category: 'information',
    phase: 'A',
    available: true,
    tagline: '聽不清楚廚房的聲音，但沒有任何東西能打斷你的刀。',
    limitation: ['一般的聲音提示（吐司跳起、送貨敲門、新訂單的鈴聲、隊友的敲擊）你聽不到，也不會有替代的文字', '隊友的語音聽起來悶悶的、很小聲'],
    compensation: ['在砧板和水槽連續作業時越做越快：每連續一次少 1 刀、清洗／削皮快 12%（上限 2 刀、36%）', '品質不受影響——刀工一致性仍然看你的節奏'],
    cooperationHooks: ['隊友走到你旁邊拍肩：畫面邊緣會亮起方向與符號', '隊友可以對工作站發協助訊號，你會看到方向標記'],
    heroMoment: '廚房一片混亂時，你在砧板前一口氣切完一整批料。',
    affectedActions: ['event_delivery', 'chop_strokes', 'task_duration:wash|peel|wipe', 'signal_tokens:audio'],
    accessibilityNotes: ['危險（怪物、燒焦）一定有畫面提示', '拍肩提示同時用形狀、位置與文字，不只靠顏色'],
  }),
  D03: card({
    id: 'D03',
    name: '味覺失調者',
    role: '品質判讀型／溫度專精',
    category: 'information',
    phase: 'A',
    available: true,
    tagline: '嚐不出鹹淡，卻比誰都早感覺到鍋子快要出事。',
    limitation: ['自己試吃只知道「有沒有調味」，嚐不出鹹淡酸甜', '調味要靠食譜刻度、隊友的試吃回報'],
    compensation: ['身邊 4.5 公尺內的鍋子快燒焦、快焦底、或火太小時，你會提早幾秒收到預警', '預警來自伺服器依真實狀態往前推算，不是猜的'],
    cooperationHooks: ['隊友試吃後按「回報給…」：你會收到他實際嚐到的味道（固定詞彙）', '回報綁定那一盤；之後再調味，回報會標成過期'],
    heroMoment: '你在湯快焦底前把火關小，隊友負責調味，一起端出高分的湯。',
    affectedActions: ['taste_result', 'thermal_warning', 'taste_report'],
    accessibilityNotes: ['預警同時有文字、圖示與方向'],
  }),
  D04: card({
    id: 'D04',
    name: '沉默侍者',
    role: '溝通限制型／高速外場',
    category: 'communication',
    phase: 'A',
    available: true,
    tagline: '不說話，只用手勢、標記與擺放傳話——跑得比誰都快。',
    limitation: ['不能使用遊戲內語音（遊戲不限制外部通話軟體，但遊戲機制不依賴語音）', '只能用固定訊號、標記與交接溝通'],
    compensation: ['在餐廳與出餐口一帶移動快 30%，端著盤子時到哪裡都快 15%', '帶位異常客人只要 1.2 秒（一般 2 秒）'],
    cooperationHooks: ['標記工作站或訂單（G），附上「需要什麼／確認嗎／交給你」等符號', '隊友可以直接回應你的標記', '和隊友手對手交接'],
    heroMoment: '廚房忙到沒人能停下來說話時，你用標記與快速出餐讓大家專心做菜。',
    affectedActions: ['voice_send', 'move_speed', 'task_duration:escort'],
    accessibilityNotes: ['標記會顯示來源與對象'],
  }),
  D05: card({
    id: 'D05',
    name: '大嗓門',
    role: '聲音干擾型／團隊召集',
    category: 'communication',
    phase: 'D',
    available: true,
    tagline: '一開口全廚房都聽得到——包括你不想讓它被蓋過的聲音。',
    limitation: [
      '遊戲內語音固定偏大聲、傳得比較遠，沒辦法小聲說話',
      '喊出「召集」後 4 秒，你身邊 6 公尺內的人（包括你自己）聽不到一般的聲音提示——在安靜區（冷藏室、乾貨室）裡的人不受影響',
    ],
    compensation: ['「召集」（V）：全隊不論距離都會收到，附方向、位置與符號；耳背砧板也看得到', '召集會在你站的地方留下 15 秒的標記，隊友可以直接回應「收到」'],
    cooperationHooks: ['隊友回應召集標記（是／等待…），你不必再喊第二次', '需要聽聲音的工作（吐司、送貨）可以交給在安靜區的隊友', '隊友拍肩提醒你改用手勢'],
    heroMoment: '大家散在冷藏室、爐台和出餐口時，你一聲召集，所有人同時轉向那張大單。',
    affectedActions: ['coop:rally', 'event_delivery:interference', 'voice_gain'],
    accessibilityNotes: ['召集同時有方向箭頭、文字與震動式的畫面提示', '干擾範圍與剩餘時間會顯示在畫面上'],
  }),
  D06: card({
    id: 'D06',
    name: '奶油手',
    role: '操作風險型／高速備料',
    category: 'operation',
    phase: 'B',
    available: true,
    tagline: '切得飛快，手上的東西卻不太穩。',
    limitation: [
      '拿著食材或盤子奔跑、急轉彎，或怪物撲過來時，手上的東西會「失衡」',
      '失衡不是馬上掉：有 1.6 秒的挽救時間——停下來（或放慢到幾乎靜止）、按 X 穩住，或讓隊友接住',
      '靜止操作、切菜、交接都不會掉；沒有拿東西就不會失衡',
    ],
    compensation: ['切菜、切片少三分之一的刀數（例如切丁 8 刀 → 6 刀）', '削皮快 50%'],
    cooperationHooks: ['隊友在 1.8 公尺內按 F「接住」失衡的東西', '切完直接交給隊友（交接永遠安全），或放在交接架上'],
    heroMoment: '你一口氣切完整批料，隊友站在砧板旁一份份接走送上爐。',
    affectedActions: ['held_wobble', 'coop:catch', 'coop:grip', 'chop_strokes', 'task_duration:peel'],
    accessibilityNotes: ['失衡時畫面會晃、手上的東西閃紅框，並顯示剩餘時間', '掉在地上的東西有聲音、位置標記，按 X 撿起來'],
  }),
  D07: card({
    id: 'D07',
    name: '巨人助手',
    role: '空間限制型／重物搬運',
    category: 'mobility',
    phase: 'C',
    available: true,
    tagline: '搬得動整箱貨、拿得到最高層，卻過不了低矮的門。',
    limitation: ['過不了低門楣的「乾貨室前門」（地上有黃黑斜線與標示），要從防火門繞後走廊進乾貨室', '身體比較寬：轉彎和走位需要多一點空間', '個子比所有人高（眼睛約 2 公尺）：看得到大家的頭頂，腳步又重又響'],
    compensation: ['冷藏架、乾貨架最上層的存貨伸手就拿（其他人要踩踏凳 1.5 秒，小矮人學徒拿不到）', '搬貨箱時走得比平常快 25%', '跑步撞到人會把人推得比較遠；小矮人撞到你會自己彈開'],
    cooperationHooks: ['隊友從低門或窄縫取得的東西，放到交接架讓你接手', '你從最上層拿下來的東西交給拿不到的隊友'],
    heroMoment: '你一個人把送來的貨箱扛進去、順手把最上層的存貨分給大家，小矮人從窄縫補上冷藏食材。',
    affectedActions: ['collider:low_door', 'player_radius', 'storage:take_high', 'move_speed:crate'],
    accessibilityNotes: ['過不了的門在你的畫面上有醒目的斜線柵欄，不會撞到看不見的牆'],
  }),
  D08: card({
    id: 'D08',
    name: '小矮人學徒',
    role: '空間限制型／狹窄區域專精',
    category: 'mobility',
    phase: 'C',
    available: true,
    tagline: '鑽得進冷藏室和乾貨室之間的窄縫，卻搆不到高處。',
    limitation: ['冷藏架、乾貨架最上層的存貨拿不到（請隊友拿，或等送貨補到下層）', '看不到湯鍋裡面：要在湯鍋前「墊腳看一下」（1 秒，之後 12 秒看得到），或請隊友試吃回報', '個子很矮（眼睛約 1 公尺，和檯面差不多高）：隊友在你眼前像巨人，跑步撞到巨人會被彈回來'],
    compensation: ['可以鑽過冷藏室與乾貨室之間的低矮窄縫（其他人和怪物都過不去）', '身體比較小，在擁擠的地方好走位、可以貼著隊友擠過去，腳步又輕又快'],
    cooperationHooks: ['隊友取下最上層的存貨交給你', '隊友試吃湯鍋後回報給你'],
    heroMoment: '你穿過窄縫，比繞路快一倍地把冷藏食材送到乾貨室那頭的隊友手上。',
    affectedActions: ['collider:crawl', 'player_radius', 'storage:take_high', 'station_view:stove', 'task:peek'],
    accessibilityNotes: ['窄縫的入口與出口都有地面標示與燈'],
  }),
  D09: card({
    id: 'D09',
    name: '單手廚師',
    role: '操作限制型／單工高速',
    category: 'operation',
    phase: 'B',
    available: true,
    tagline: '單手工序比誰都快；少數雙手工序需要有人扶一下。',
    limitation: [
      '兩個工序需要雙手：打蛋（一手扶碗、一手打）和用湯鍋盛湯（一手扶鍋、一手舀）',
      '自己做的話，先在工作站「用夾具固定」（4 秒，之後 20 秒內有效）',
      '物品欄只有一隻手（加上菜籃 2 格）：不能一手拿盤子、一手拿食材',
    ],
    compensation: ['清洗、擦砧板、量溫度、撬鐵籠快 30%', '其他所有操作照常——切菜、拿取、調味、出餐都不受影響'],
    cooperationHooks: ['隊友站在工作站旁按「幫忙扶穩」（8 秒內有效）：你就能立刻做雙手工序；扶的人隨時可以走開'],
    heroMoment: '你快速洗完、擦完所有東西，隊友在你要盛湯的那一刻伸手扶住鍋子。',
    affectedActions: ['two_handed:chop_beaten|ladle', 'coop:steady', 'task:clamp', 'task_duration:wash|wipe|probe|rescue'],
    accessibilityNotes: ['需要雙手的按鈕會標示「雙手」，並說明怎麼解開'],
  }),
  D10: card({
    id: 'D10',
    name: '怕火廚師',
    role: '工作站限制型／冷食專精',
    category: 'operation',
    phase: 'B',
    available: true,
    tagline: '不碰明火，冷盤與調味最快。',
    limitation: ['不能直接操作平底鍋、湯鍋、烤麵包機', '自救：在火源前「戴隔熱手套」（3 秒），之後 30 秒可以操作，但不能開大火'],
    compensation: ['調味區一次量兩種調味料（例如糖＋醋），一次倒完', '清洗、削皮快 20%，切菜少 1 刀', '訂單板上會標出「可以做成冷盤」的單（依配方：不要求熱的）'],
    cooperationHooks: ['把備好的料放到「爐台旁交接架」，由隊友接手下鍋', '隊友把煮好的東西交給你裝盤、調味、出餐'],
    heroMoment: '爐台一團亂的時候，你穩穩地把酸甜番茄冷盤和全部調味做完。',
    affectedActions: ['station_lock:pan|stove|toaster', 'task:glove', 'spice:double_measure', 'task_duration:wash|peel', 'chop_strokes', 'order_tag:cold'],
    accessibilityNotes: ['火源工作站的面板會說明為什麼不能用、以及手套剩幾秒'],
  }),
  D11: card({
    id: 'D11',
    name: '潔癖主廚',
    role: '清潔限制型／衛生專精',
    category: 'operation',
    phase: 'B',
    available: true,
    tagline: '不碰髒東西，但洗得比誰都快。',
    limitation: [
      '不肯徒手碰髒盤、垃圾和掉在地上的東西：回收窗口的髒盤要「用托盤收」（2.5 秒），丟垃圾要「用腳踩開蓋子」（1.2 秒）',
      '不在沒擦過的砧板上做事（碰過生肉的砧板要先擦）',
    ],
    compensation: ['洗碗、擦砧板快一倍；托盤一次可以收 6 個（徒手是 4 個）', '附近有被汙染的食材、沒擦的砧板，或有人把菜放上髒砧板時，會提早收到警告'],
    cooperationHooks: ['隊友把髒盤送到水槽的碗盤架，你直接洗（不必碰）', '隊友幫你撿地上的東西、倒垃圾'],
    heroMoment: '大家不停出餐時，你讓乾淨的盤子源源不絕，沒有人因為沒盤子而停下來。',
    affectedActions: ['dish_return:take', 'trash:discard', 'floor:pickup', 'prep:contaminated', 'task:tray|pedal', 'task_duration:dishes|wipe', 'contamination_warning'],
    accessibilityNotes: ['虛構的角色特性，不是醫療診斷，也不是在嘲笑任何人'],
  }),
  D12: card({
    id: 'D12',
    name: '幽閉外場',
    role: '環境限制型／開放空間移動',
    category: 'environment',
    phase: 'C',
    available: true,
    tagline: '進不了冷藏室，在開放空間裡卻飛快。',
    limitation: ['不能走進封閉的冷藏室（門口有標示）', '不能躲進置物櫃'],
    compensation: ['在餐廳與廚房移動快 15%', '在餐廳與廚房裡交接的距離比較遠（2.6 公尺）'],
    cooperationHooks: ['隊友把冷藏食材放到「冷藏室門口交接架」，你接手運送', '標記你需要的食材（G 標記冷藏架），隊友不用翻找'],
    heroMoment: '隊友在冷藏室裡一份份把食材遞到門口，你把它們飛快送到每個工作站。',
    affectedActions: ['zone_entry:COLD', 'locker:hide', 'move_speed:open', 'handoff_range:open'],
    accessibilityNotes: ['被冷藏室擋下時會有提示，不會像撞到看不見的牆', '被怪物抓進鐵籠後一定能自己走出冷藏室'],
  }),
  D13: card({
    id: 'D13',
    name: '暴衝快遞',
    role: '移動風險型／直線配送',
    category: 'mobility',
    phase: 'C',
    available: true,
    tagline: '直線最快，轉彎與急停很難。',
    limitation: ['一走就會加速，很難慢慢走；跑得越快越難轉彎、越難停下', '空白鍵是「煞停」（較快停下，但會滑一小段）'],
    compensation: ['直線移動時速度會一路衝到平常的 1.4 倍', '熟悉的直線路線（出餐口 ↔ 旋轉門 ↔ 餐桌）可以跑得飛快'],
    cooperationHooks: ['隊友按 Z 在地上畫箭頭，標出安全的直線路線（30 秒）', '隊友在轉角或交接架接應，讓你不用在窄處急轉彎'],
    heroMoment: '你沿著隊友畫好的直線，一趟接一趟把菜送到餐桌。',
    affectedActions: ['movement:momentum', 'move_speed:straight', 'coop:route'],
    accessibilityNotes: ['畫面下方的速度條顯示目前的衝勁；快撞牆時速度條會變色'],
  }),
  D14: card({
    id: 'D14',
    name: '嗜睡學徒',
    role: '節奏管理型／雙爐操作',
    category: 'rhythm',
    phase: 'D',
    available: true,
    tagline: '清醒時能同時顧兩個爐子；睡意看得到、也管得住。',
    limitation: [
      '時間與重複的工作會累積睡意（換不同的工作可以稍微提神）',
      '睡意 60 會打哈欠、85 眼皮很重，到 100 會睡著 5 秒（端著盤子或怪物在追時會撐一下，但最多 8 秒）',
      '睡著時不能動也不能操作；爐子照常運作',
    ],
    compensation: ['清醒時（睡意未滿 85）可以同時操作「最近碰過的兩個爐具」：只要在 4.2 公尺內，不必走到正前方（V 打開雙爐面板）'],
    cooperationHooks: ['隊友拍肩：直接叫醒你（睡意回到 35）', '隊友在你的爐子按「接管」：你的爐子交給他，畫面會標出是誰在顧', '自己到水槽「洗把臉」：睡意 −40（45 秒冷卻）'],
    heroMoment: '你一個人站在兩鍋之間同時顧著，快撐不住時隊友拍醒你、接手一鍋。',
    affectedActions: ['drowsiness', 'sleep', 'remote_station:pan|stove', 'coop:takeover', 'task:splash'],
    accessibilityNotes: ['睡意條一直顯示在畫面上；快睡著時畫面邊緣變暗並有文字提示'],
  }),
  D15: card({
    id: 'D15',
    name: '健忘助手',
    role: '工作記憶限制型／短期任務專精',
    category: 'information',
    phase: 'A',
    available: true,
    tagline: '一次只記得住兩張單——但專注在一張單上時，比誰都快。',
    limitation: ['同時只記得 2 張單的內容；其他單只看得到桌號與剩餘時間', '記憶 35 秒後會淡掉（只影響你看到的資訊，訂單本身完全不受影響）'],
    compensation: ['釘選一張「專注單」：它永遠記得，而且清洗、削皮、擦砧板、量溫度快 20%、切菜少 1 刀', '換專注單有 20 秒冷卻，不能一直換'],
    cooperationHooks: ['到出餐口看單就能想起那張單', '隊友在 3 公尺內「覆誦」一張單：你會額外記住它 45 秒（不佔名額）', '任何人都能在工作站貼便條（待處理／已備料／等待烹飪／完成）；內容一變便條就會標成過期'],
    heroMoment: '你專心做一份複雜的菜，隊友幫你盯其他單，兩人各自扛起擅長的資訊量。',
    affectedActions: ['order_visibility', 'order_refresh', 'focus_pin', 'task_duration:wash|peel|wipe|probe', 'chop_strokes'],
    accessibilityNotes: ['想不起來的單仍然看得到桌號與倒數，不會讓你看不到訂單板'],
  }),
  D16: card({
    id: 'D16',
    name: '定時噴嚏',
    role: '週期性風險型／嗅覺專精',
    category: 'rhythm',
    phase: 'D',
    available: true,
    tagline: '每 30 秒一個噴嚏（3 秒前一定有前兆），鼻子卻特別靈。',
    limitation: [
      '每 30 秒打一次噴嚏；前 3 秒會鼻子癢（畫面與聲音都有提示，隊友也看得到）',
      '噴嚏那一刻：手上的量匙會灑掉；拿著食材或盤子還在走動的話會失衡（1.2 秒內隊友可以接住）——站著不動就沒事',
    ],
    compensation: ['5 公尺內的鍋子開始過熟或焦底、食材不新鮮、砧板有生肉味時，你會「聞到」（只有提示，不會告訴你數值）', '按 V 把聞到的味道當成警告標記送給全隊'],
    cooperationHooks: ['前兆出現時把東西交給隊友，或讓隊友準備接住', '你送出的氣味警告，隊友到現場確認'],
    heroMoment: '噴嚏前你把鍋子交給隊友，同時聞到另一鍋快焦了。',
    affectedActions: ['sneeze_cycle', 'held_wobble', 'measure_spill', 'smell_hint', 'coop:smell'],
    accessibilityNotes: ['噴嚏倒數一直顯示；前兆同時有聲音、畫面邊框與文字'],
  }),
};

export const AVAILABLE_FLAWS: readonly FlawId[] = FLAW_IDS.filter((id) => FLAW_CARDS[id].available);

/* ============================== 效果設定 ============================== */

/**
 * 集中管理的效果數值（倍率、距離、冷卻、持續時間、門檻）。
 * 伺服器可以用環境變數 FLAW_CONFIG（JSON，只需寫要覆寫的欄位）調整，不必改程式。
 * 客戶端從同步資料拿到伺服器實際使用的版本（移動速度要和伺服器一致）。
 */
export interface FlawEffectConfig {
  common: {
    /** 拍肩距離（公尺）與每個人的冷卻 */
    tapRange: number;
    tapCooldownMs: number;
    /** 手對手交接：兩人距離、接住的時間窗 */
    handoffRange: number;
    handoffWindowMs: number;
    /** 覆誦距離與冷卻 */
    reciteRange: number;
    reciteCooldownMs: number;
    /** 試吃回報：試吃後多久內可以回報、回報顯示多久 */
    tasteReportWindowMs: number;
    tasteReportTtlMs: number;
    /** 便條：每人最多幾張、過期後顯示多久才移除、最長存在時間 */
    notesPerPlayer: number;
    noteStaleShowMs: number;
    noteTtlMs: number;
    /** 標記回應的有效時間 */
    markTtlMs: number;
    /** 撿起地上東西的距離 */
    pickupRange: number;
    /** 在地上畫路線箭頭：有效時間、每人最多幾個 */
    routeTtlMs: number;
    routePerPlayer: number;
    /** 一般人踩踏凳拿最上層存貨要多久 */
    stoolMs: number;
  };
  D01: {
    /** 假傳聞的間隔（毫秒，在範圍內依種子決定） */
    fakeGapMinMs: number;
    fakeGapMaxMs: number;
    /** 營業開始多久後才會出現第一則假傳聞 */
    firstFakeMs: number;
    /** 每隔幾張真訂單洩漏一次（2＝每兩張一次） */
    leakEvery: number;
    /** 真訂單提前多久洩漏 */
    leakLeadMs: number;
    /** 傳聞的有效時間 */
    rumorTtlMs: number;
    /** 私人傳聞同時最多幾則（超過就不再產生新的假傳聞） */
    maxActive: number;
    /** 核對時間：隊友／本人 */
    verifyMs: number;
    verifySelfMs: number;
  };
  D02: {
    /** 兩次備料之間超過這段時間，連續就中斷 */
    streakWindowMs: number;
    /** 每一層連續少幾刀、上限 */
    strokesPerStreak: number;
    maxStrokeCut: number;
    /** 每一層連續的清洗／削皮／擦砧板加速比例、上限 */
    taskSpeedPerStreak: number;
    maxTaskSpeed: number;
    /** 隊友語音的音量（客戶端呈現） */
    voiceGain: number;
  };
  D03: {
    /** 預警的感知距離 */
    range: number;
    /** 往前推算幾秒 */
    leadSec: number;
    /** 同一台工作站兩次預警的最短間隔 */
    repeatMs: number;
  };
  D04: {
    /** 在餐廳與出餐口一帶的移動倍率 */
    diningSpeed: number;
    /** 端著盤子時的移動倍率（與上一項取較大者，不相乘） */
    plateSpeed: number;
    /** 帶位客人的時間 */
    escortMs: number;
  };
  D05: {
    /** 召集的冷卻、標記保留多久 */
    rallyCooldownMs: number;
    rallyMarkMs: number;
    /** 召集後的聲音干擾：持續時間、半徑 */
    interfereMs: number;
    interfereRange: number;
    /** 遊戲內語音：音量倍率、距離衰減（客戶端呈現） */
    voiceGain: number;
    voiceRolloff: number;
  };
  D06: {
    /** 失衡的觸發：奔跑速度（m/s）、急轉彎（rad/s，且速度超過 turnMinSpeed）、怪物撲抓的距離 */
    runSpeed: number;
    turnRate: number;
    turnMinSpeed: number;
    lungeRange: number;
    /** 挽救時間；速度低於 settleSpeed 持續 settleMs 就穩住 */
    windowMs: number;
    settleSpeed: number;
    settleMs: number;
    /** 按 X 穩住：速度要低於多少、冷卻 */
    gripMaxSpeed: number;
    gripCooldownMs: number;
    /** 一次失衡處理完後，多久內不會再失衡 */
    cooldownMs: number;
    /** 切菜刀數倍率（1.5＝快 50%）、削皮加速比例 */
    chopSpeed: number;
    peelSpeed: number;
  };
  D07: {
    radius: number;
    /** 搬貨箱時的移動倍率 */
    crateSpeed: number;
    /** 體型（1＝一般人）：眼睛高度、模型大小、步伐 */
    bodyScale: number;
  };
  D08: {
    radius: number;
    /** 體型（1＝一般人）：眼睛高度、模型大小、步伐 */
    bodyScale: number;
    /** 墊腳看湯鍋：動作時間、之後看得到多久 */
    peekMs: number;
    peekHoldMs: number;
  };
  D09: {
    /** 隊友扶穩的有效時間、距離 */
    steadyMs: number;
    steadyRange: number;
    /** 自己用夾具固定：動作時間、有效時間 */
    clampMs: number;
    clampHoldMs: number;
    /** 單手工序加速比例 */
    taskSpeed: number;
  };
  D10: {
    /** 隔熱手套：動作時間、有效時間 */
    gloveMs: number;
    gloveHoldMs: number;
    /** 清洗、削皮加速比例；切菜少幾刀 */
    prepSpeed: number;
    strokeCut: number;
  };
  D11: {
    /** 用托盤收髒盤、用腳踩開垃圾桶 */
    trayMs: number;
    pedalMs: number;
    /** 托盤一次能收幾個 */
    trayCapacity: number;
    /** 洗碗、擦砧板的加速比例 */
    cleanSpeed: number;
    /** 汙染警告的範圍、同一個目標的重複間隔 */
    warnRange: number;
    warnRepeatMs: number;
  };
  D12: {
    /** 在餐廳與廚房的移動倍率、交接距離 */
    openSpeed: number;
    openHandoffRange: number;
  };
  D13: {
    /** 直線最高速度倍率（相對步行）；加速度、自然減速、煞停減速（m/s²） */
    maxMult: number;
    accel: number;
    decel: number;
    brakeDecel: number;
    /** 有在按方向鍵時的最低速度比例（很難慢慢走） */
    minFrac: number;
    /** 轉向速度：低速、全速時（rad/s） */
    turnSlow: number;
    turnFast: number;
  };
  D14: {
    /** 睡意：每秒累積、同一種工作再做一次、換工作時減少（每 30 秒最多減幾次） */
    perSecond: number;
    sameWork: number;
    switchRelief: number;
    switchReliefPer30s: number;
    /** 門檻 */
    warnAt: number;
    heavyAt: number;
    sleepAt: number;
    /** 睡多久、醒來後的睡意、最多能撐多久 */
    sleepMs: number;
    wakeTo: number;
    /** 隊友拍一下降多少睡意 */
    tapRelief: number;
    postponeMaxMs: number;
    /** 洗把臉：動作時間、減少多少、冷卻 */
    splashMs: number;
    splashRelief: number;
    splashCooldownMs: number;
    /** 雙爐：在幾公尺內可以操作 */
    dualRange: number;
  };
  D15: {
    /** 同時記得幾張單 */
    capacity: number;
    /** 記憶保留多久 */
    memoryMs: number;
    /** 被覆誦後額外記得多久 */
    recitedMs: number;
    /** 專注單：動作加速比例、少幾刀、換單冷卻 */
    focusTaskSpeed: number;
    focusStrokeCut: number;
    focusCooldownMs: number;
  };
  D16: {
    /** 噴嚏週期、前兆提前多久、失衡挽救時間、算「還在走動」的速度 */
    periodMs: number;
    warnMs: number;
    windowMs: number;
    moveSpeed: number;
    /** 嗅覺：範圍、同一個目標的重複間隔、氣味警告冷卻 */
    smellRange: number;
    smellRepeatMs: number;
    alertCooldownMs: number;
  };
}

export const DEFAULT_FLAW_CONFIG: FlawEffectConfig = {
  common: {
    tapRange: 1.8,
    tapCooldownMs: 4000,
    handoffRange: 1.8,
    handoffWindowMs: 4000,
    reciteRange: 3.0,
    reciteCooldownMs: 3000,
    tasteReportWindowMs: 25_000,
    tasteReportTtlMs: 45_000,
    notesPerPlayer: 4,
    noteStaleShowMs: 5000,
    noteTtlMs: 120_000,
    markTtlMs: 15_000,
    pickupRange: 1.5,
    routeTtlMs: 30_000,
    routePerPlayer: 4,
    stoolMs: 1500,
  },
  D01: {
    fakeGapMinMs: 35_000,
    fakeGapMaxMs: 55_000,
    firstFakeMs: 20_000,
    leakEvery: 2,
    leakLeadMs: 20_000,
    rumorTtlMs: 45_000,
    maxActive: 3,
    verifyMs: 2000,
    verifySelfMs: 6000,
  },
  D02: {
    streakWindowMs: 9000,
    strokesPerStreak: 1,
    maxStrokeCut: 2,
    taskSpeedPerStreak: 0.12,
    maxTaskSpeed: 0.36,
    voiceGain: 0.3,
  },
  D03: { range: 4.5, leadSec: 6, repeatMs: 8000 },
  D04: { diningSpeed: 1.3, plateSpeed: 1.15, escortMs: 1200 },
  D05: { rallyCooldownMs: 20_000, rallyMarkMs: 15_000, interfereMs: 4000, interfereRange: 6, voiceGain: 1.6, voiceRolloff: 0.35 },
  D06: {
    runSpeed: 3.2,
    turnRate: 4.5,
    turnMinSpeed: 1.6,
    lungeRange: 3.5,
    windowMs: 1600,
    settleSpeed: 0.6,
    settleMs: 350,
    gripMaxSpeed: 2.6,
    gripCooldownMs: 6000,
    cooldownMs: 2500,
    chopSpeed: 1.5,
    peelSpeed: 0.5,
  },
  D07: { radius: 0.42, crateSpeed: 1.25, bodyScale: 1.25 },
  D08: { radius: 0.25, bodyScale: 0.62, peekMs: 1000, peekHoldMs: 12_000 },
  D09: { steadyMs: 8000, steadyRange: 1.8, clampMs: 4000, clampHoldMs: 20_000, taskSpeed: 0.3 },
  D10: { gloveMs: 3000, gloveHoldMs: 30_000, prepSpeed: 0.2, strokeCut: 1 },
  D11: { trayMs: 2500, pedalMs: 1200, trayCapacity: 6, cleanSpeed: 0.5, warnRange: 4, warnRepeatMs: 15_000 },
  D12: { openSpeed: 1.15, openHandoffRange: 2.6 },
  D13: { maxMult: 1.4, accel: 3.2, decel: 1.6, brakeDecel: 7.5, minFrac: 0.6, turnSlow: 7, turnFast: 1.6 },
  D14: {
    perSecond: 0.9,
    sameWork: 3,
    switchRelief: 3,
    switchReliefPer30s: 3,
    warnAt: 60,
    heavyAt: 85,
    sleepAt: 100,
    sleepMs: 5000,
    wakeTo: 20,
    tapRelief: 25,
    postponeMaxMs: 8000,
    splashMs: 2000,
    splashRelief: 40,
    splashCooldownMs: 45_000,
    dualRange: 4.2,
  },
  D15: { capacity: 2, memoryMs: 35_000, recitedMs: 45_000, focusTaskSpeed: 0.2, focusStrokeCut: 1, focusCooldownMs: 20_000 },
  D16: { periodMs: 30_000, warnMs: 3000, windowMs: 1200, moveSpeed: 0.6, smellRange: 5, smellRepeatMs: 12_000, alertCooldownMs: 8000 },
};

/** 只覆寫數字欄位（未知欄位、非數字、負數一律忽略），回傳新的設定 */
export function mergeFlawConfig(base: FlawEffectConfig, override: unknown): FlawEffectConfig {
  const out = JSON.parse(JSON.stringify(base)) as FlawEffectConfig;
  if (!override || typeof override !== 'object') return out;
  const o = override as Record<string, unknown>;
  for (const group of Object.keys(out) as Array<keyof FlawEffectConfig>) {
    const src = o[group];
    if (!src || typeof src !== 'object') continue;
    const dst = out[group] as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (k in dst && typeof v === 'number' && Number.isFinite(v) && v >= 0) dst[k] = v;
    }
  }
  return out;
}

/* ============================== 共用規則（前後端一致） ============================== */

/**
 * 移動速度倍率。伺服器用它放寬移動預算，客戶端用同一個函式決定實際的步行速度，
 * 所以兩邊永遠一致（客戶端用的設定來自伺服器）。
 */
export type HeldKind = 'item' | 'plate' | 'measure' | 'crate' | 'dirty' | null;

export function flawSpeedMultiplier(flaw: FlawId | null, zone: ZoneId | null, held: HeldKind | boolean, cfg: FlawEffectConfig): number {
  const heldKind: HeldKind = held === true ? 'plate' : held === false ? null : held;
  if (flaw === 'D04') {
    let m = 1;
    if (zone === 'DINING') m = Math.max(m, cfg.D04.diningSpeed);
    if (heldKind === 'plate') m = Math.max(m, cfg.D04.plateSpeed);
    return m;
  }
  if (flaw === 'D07' && heldKind === 'crate') return cfg.D07.crateSpeed;
  if (flaw === 'D12' && (zone === 'DINING' || zone === 'KITCHEN')) return cfg.D12.openSpeed;
  // 暴衝快遞：實際速度由客戶端的慣性模型決定；這裡是伺服器允許的上限
  if (flaw === 'D13') return cfg.D13.maxMult;
  return 1;
}

/** 體型：巨人比一般人高大、小矮人矮小（眼睛高度、模型大小、腳步聲、步伐都跟著變；伺服器與客戶端共用） */
export function flawBodyScale(flaw: FlawId | null | undefined, cfg: FlawEffectConfig): number {
  if (flaw === 'D07') return cfg.D07.bodyScale ?? 1.25;
  if (flaw === 'D08') return cfg.D08.bodyScale ?? 0.62;
  return 1;
}

/** 碰撞半徑：巨人比較寬、小矮人比較窄（伺服器與客戶端共用） */
export function flawRadius(flaw: FlawId | null, cfg: FlawEffectConfig, base: number): number {
  if (flaw === 'D07') return cfg.D07.radius;
  if (flaw === 'D08') return cfg.D08.radius;
  return base;
}

/**
 * 區域進入限制（伺服器與客戶端共用）：幽閉外場不能「走進」冷藏室。
 * 只擋進去，不擋出來——被抓進鐵籠後一定能自己走出冷藏室。
 */
export function flawZoneBlocked(flaw: FlawId | null, fromZone: ZoneId | null, toZone: ZoneId | null): boolean {
  return flaw === 'D12' && toZone === 'COLD' && fromZone !== 'COLD';
}

/** 安靜區：在這裡判讀聲音不受大嗓門的召集干擾 */
export const QUIET_ZONES: readonly ZoneId[] = ['COLD', 'DRY'];

/** 這張卡會不會打瞌睡、打噴嚏…（介面用：哪些個人狀態需要顯示） */
export const flawUsesFire = (flaw: FlawId | null): boolean => flaw !== 'D10';

/** 這張卡能不能用遊戲內語音發話 */
export const flawCanSpeak = (flaw: FlawId | null): boolean => flaw !== 'D04';

/** 這張卡能不能聽到聲音類的信號（敲擊） */
export const flawHearsTaps = (flaw: FlawId | null): boolean => flaw !== 'D02';

/* ============================== 互助操作 ============================== */

/** 便條的狀態（固定詞彙，不是自由文字） */
export const NOTE_LABELS = ['todo', 'prepped', 'waiting', 'done'] as const;
export type NoteLabel = (typeof NOTE_LABELS)[number];
export const NOTE_TEXT: Record<NoteLabel, string> = { todo: '待處理', prepped: '已備料', waiting: '等待烹飪', done: '完成' };

/**
 * 互助操作（全部走 kitchen:action，stationId＝'coop'，同樣有 requestId 去重）。
 * 這是規格書的 cooperationAction。另外兩個要站在出餐口才能做的操作走出餐口本身：
 *   { stationId: 'pass', action: 'verify', args: { rumorId } }   核對傳聞（計時動作）
 *   { stationId: 'pass', action: 'read', args: { orderId } }     看單（健忘助手想起那張單）
 */
export type CoopAction =
  | { action: 'tap'; args: { to: Seat; token?: SignalToken } }
  | { action: 'handoff'; args: { to: Seat } }
  | { action: 'handoff_accept'; args: { offerId: string } }
  | { action: 'handoff_decline'; args: { offerId: string } }
  | { action: 'handoff_cancel'; args: { offerId: string } }
  | { action: 'note'; args: { stationId: string; label: NoteLabel; orderId?: string } }
  | { action: 'note_clear'; args: { noteId: string } }
  | { action: 'recite'; args: { to: Seat; orderId: string } }
  | { action: 'taste_report'; args: { to: Seat } }
  | { action: 'mark_reply'; args: { markId: string; token: SignalToken } }
  | { action: 'rumor_post'; args: { rumorId: string } }
  | { action: 'rumor_dismiss'; args: { rumorId: string } }
  | { action: 'focus'; args: { orderId: string | null } }
  /** 接住隊友手上失衡的東西（奶油手、定時噴嚏） */
  | { action: 'catch'; args: { to: Seat } }
  /** 奶油手：穩住手上失衡的東西 */
  | { action: 'grip'; args: Record<string, never> }
  /** 撿起地上的東西 */
  | { action: 'pickup'; args: { floorId: string } }
  /** 幫單手廚師扶穩工作站上的碗或鍋 */
  | { action: 'steady'; args: { stationId: string } }
  /** 大嗓門：召集 */
  | { action: 'rally'; args: { token?: SignalToken } }
  | { action: 'rally_reply'; args: { rallyId: string; token: SignalToken } }
  /** 接管嗜睡學徒的爐具 */
  | { action: 'takeover'; args: { stationId: string } }
  /** 定時噴嚏：把聞到的味道送給全隊 */
  | { action: 'smell'; args: { hintId: string } }
  /** 在地上畫路線箭頭（給暴衝快遞看） */
  | { action: 'route'; args: { x: number; z: number; yaw: number } }
  | { action: 'route_clear'; args: Record<string, never> };

export type CoopActionName = CoopAction['action'];
export const COOP_ACTIONS: readonly CoopActionName[] = [
  'tap',
  'handoff',
  'handoff_accept',
  'handoff_decline',
  'handoff_cancel',
  'note',
  'note_clear',
  'recite',
  'taste_report',
  'mark_reply',
  'rumor_post',
  'rumor_dismiss',
  'focus',
  'catch',
  'grip',
  'pickup',
  'steady',
  'rally',
  'rally_reply',
  'takeover',
  'smell',
  'route',
  'route_clear',
];

/* ============================== 公開狀態（所有人一樣） ============================== */

export interface HandoffPublic {
  id: string;
  from: Seat;
  to: Seat;
  /** 遞出的東西的簡短描述（「番茄（切丁）」「盤子」） */
  what: string;
  expiresAt: number;
}

export interface NotePublic {
  id: string;
  by: Seat;
  stationId: string;
  label: NoteLabel;
  orderId?: string;
  /** 工作站的內容已經和貼便條時不同（或連結的訂單已結束）：顯示「已過期」，稍後移除 */
  stale: boolean;
  at: number;
}

export interface MarkPublic {
  id: string;
  from: Seat;
  /** 工作站 id，或 `order:<訂單 id>` */
  targetId: string;
  token?: SignalToken;
  /** 誰回應了什麼 */
  replies: Array<{ by: Seat; token: SignalToken }>;
  at: number;
  expiresAt: number;
}

/** D01 貼上訂單板、等待核對的傳聞（內容公開；真假只有核對後才知道） */
export interface RumorPublic {
  id: string;
  by: Seat;
  text: string;
  status: 'posted' | 'verifying' | 'confirmed' | 'rejected';
  /** 正在核對的人 */
  verifier?: Seat;
  at: number;
}

/** 核對為真的傳聞：全隊的準備提示（訂單正式出現或過期後消失） */
export interface PrepHintPublic {
  id: string;
  text: string;
  /** 連結的訂單出現後填上，客戶端用來把提示和訂單連在一起 */
  orderId?: string;
  at: number;
  expiresAt: number;
}

/** 掉在地上的東西（奶油手、定時噴嚏）：任何人都看得到，靠近按 X 撿起來 */
export interface FloorItemPublic {
  id: string;
  kind: 'item' | 'plate';
  /** 食材的種類（畫面用） */
  type?: string;
  /** 簡短描述（「番茄（切丁）」「一盤菜」） */
  what: string;
  x: number;
  z: number;
  by: Seat;
  at: number;
}

/** 手上的東西正在失衡：挽救窗口內隊友可以接住 */
export interface WobblePublic {
  seat: Seat;
  what: string;
  cause: 'run' | 'turn' | 'lunge' | 'sneeze' | 'bump';
  until: number;
}

/** 隊友正在幫單手廚師扶穩某個工作站 */
export interface SteadyPublic {
  by: Seat;
  stationId: string;
  until: number;
}

/** 大嗓門的召集（全隊都看得到方向與位置；隊友可以回應） */
export interface RallyPublic {
  id: string;
  by: Seat;
  x: number;
  z: number;
  token?: SignalToken;
  replies: Array<{ by: Seat; token: SignalToken }>;
  at: number;
  expiresAt: number;
}

/** 聲音干擾的範圍（召集之後幾秒） */
export interface InterferencePublic {
  by: Seat;
  x: number;
  z: number;
  r: number;
  until: number;
}

/** 地上的路線箭頭 */
export interface RoutePublic {
  id: string;
  by: Seat;
  x: number;
  z: number;
  yaw: number;
  expiresAt: number;
}

/** 嗜睡學徒的狀態（隊友需要知道要不要叫醒他、哪個爐子沒人顧） */
export interface DrowsyPublic {
  seat: Seat;
  state: 'heavy' | 'asleep';
  /** 睡著時：預計醒來的時間 */
  until?: number;
}

/** 嗜睡學徒正在遠端照看的爐具，以及被誰接管 */
export interface DualLinkPublic {
  seat: Seat;
  stationId: string;
  takenBy?: Seat;
}

/** 定時噴嚏的前兆（隊友看得到，可以準備接住） */
export interface SneezePublic {
  seat: Seat;
  at: number;
}

export interface CoopPublic {
  /** 每個席位選的卡（缺陷卡是公開的：隊友需要知道怎麼幫你） */
  flaws: Partial<Record<Seat, FlawId>>;
  handoffs: HandoffPublic[];
  notes: NotePublic[];
  marks: MarkPublic[];
  rumors: RumorPublic[];
  prepHints: PrepHintPublic[];
  floor: FloorItemPublic[];
  wobbles: WobblePublic[];
  steadies: SteadyPublic[];
  rallies: RallyPublic[];
  interference: InterferencePublic[];
  routes: RoutePublic[];
  drowsy: DrowsyPublic[];
  links: DualLinkPublic[];
  sneezes: SneezePublic[];
}

/* ============================== 個人狀態（只給本人） ============================== */

/** D01 私人傳聞（只有本人看得到；hint 是提示音的音高，真假有細微、固定的差異） */
export interface PrivateRumor {
  id: string;
  text: string;
  pitch: number;
  at: number;
  expiresAt: number;
  posted: boolean;
}

export interface TasteReport {
  id: string;
  by: Seat;
  /** 回報的對象（「裝盤區的盤子」「湯鍋 A」） */
  target: string;
  words: string[];
  stale: boolean;
  at: number;
  expiresAt: number;
}

export interface ThermalWarning {
  id: string;
  stationId: string;
  text: string;
  /** 預計幾秒後發生（四捨五入） */
  inSec: number;
  at: number;
}

/**
 * playerFlawState：玩家目前的缺陷、效果狀態與剩餘時間（只送給本人）。
 * 所有時間都是伺服器的班次時間（KitchenPublic.t 同一個時鐘），重連後照樣有效。
 */
/** 個人的提示（潔癖主廚的汙染警告、定時噴嚏聞到的味道） */
export interface FlawHint {
  id: string;
  kind: 'contamination' | 'smell';
  text: string;
  stationId?: string;
  at: [number, number] | null;
  t: number;
}

export interface PlayerFlawState {
  flaw: FlawId;
  /** 冷卻結束的時間 */
  cooldowns: { tap: number; recite: number; focus: number; grip?: number; rally?: number; splash?: number; smell?: number };
  /** D06／D16：手上的東西正在失衡 */
  wobble?: { until: number; cause: WobblePublic['cause'] } | null;
  /** D09：自己固定過的工作站（工作站 id → 有效到什麼時候） */
  clamps?: Record<string, number>;
  /** D10：隔熱手套有效到什麼時候 */
  gloveUntil?: number;
  /** D08：墊腳看過的湯鍋（工作站 id → 看得到到什麼時候） */
  peeks?: Record<string, number>;
  /** D14：睡意（0–100）與狀態 */
  drowsy?: { level: number; state: 'awake' | 'warn' | 'heavy' | 'asleep'; sleepUntil?: number; holding?: boolean };
  /** D14：可以遠端照看的爐具 */
  links?: string[];
  /** D16：下一次噴嚏的時間 */
  sneezeAt?: number;
  /** D11／D16 的提示 */
  hints?: FlawHint[];
  /** 你目前聽不到一般聲音提示（被召集干擾）到什麼時候 */
  muffledUntil?: number;
  /** D01 */
  rumors?: PrivateRumor[];
  /** D02：目前的連續層數與到期時間 */
  streak?: { level: number; until: number };
  /** D03 */
  thermal?: ThermalWarning[];
  /** D15：記得的訂單（訂單 id → 記到什麼時候）、專注單 */
  memory?: Record<string, number>;
  focus?: string | null;
  /** 收到的試吃回報（任何卡都能收到；對 D03 最有用） */
  reports: TasteReport[];
  /** 最近一次拍肩（給畫面提示用） */
  tapped?: { from: Seat; token?: SignalToken; at: number; x: number; z: number } | null;
}

/* ============================== 事件與遙測 ============================== */

/** flawEvent：觸發、解除、互助成功與失敗 */
export interface FlawEvent {
  at: number;
  seat: Seat;
  flaw: FlawId | null;
  kind: 'trigger' | 'resolve' | 'coop_ok' | 'coop_fail';
  what: string;
}

/** flawTelemetry：每張卡的觸發次數、互助成功率、失誤率與閒置時間 */
export interface FlawTelemetryCard {
  players: number;
  triggers: number;
  coopOk: number;
  coopFail: number;
  /** 被擋下的操作（例如記不得的單、嚐不出的味道） */
  blocked: number;
  /** 能力被實際用上的次數（少切的刀、提早的預警、加速的動作…） */
  advantage: number;
  /** 連線、沒被關、但超過 10 秒沒有任何操作的累計秒數 */
  idleSec: number;
}
export type FlawTelemetry = Partial<Record<FlawId, FlawTelemetryCard>>;

/**
 * 語音邊（from → to）是否允許：不同人、發話者的卡可以說話（沉默侍者不行）。
 * 耳背砧板仍然收得到語音，只是客戶端把它處理得又悶又小聲。
 */
export function voiceEdgeAllowed(from: Seat, to: Seat, flawOf: (s: Seat) => FlawId | null): boolean {
  return from !== to && flawCanSpeak(flawOf(from));
}
