# 網路架構

## 1. 整體

```
瀏覽器（React + R3F）  ──Socket.IO──►  Node 伺服器（Express + Socket.IO）
   │                                     │  房間、席位與缺陷卡、位置驗證、廚房模擬（固定步長）、威脅、FlawSystem（事件過濾、每位玩家的快照、互助）、語音 signaling 驗證
   └──────── WebRTC（純音訊，單向）────────┘（伺服器不經手音訊，只轉發並驗證 offer/answer/ICE）
```

- **伺服器權威**：房間、席位、缺陷卡效果、位置、門、所有食材與鍋子的狀態、訂單、評分、怪物與客人全部在伺服器。客戶端只送「意圖」（移動、工作站操作、送出信號）。
- **單一服務部署**：正式環境由同一個 Node 程序提供 `client/dist`、Socket.IO 與 `/api/*`，前端永遠使用同源網址（不需要 CORS）。開發時 Vite 以 proxy 轉發 `/socket.io` 與 `/api`。
- 房間資料存在記憶體（重新部署或伺服器重啟會清空所有房間）。

## 2. 事件

型別定義在 `shared/src/events.ts`（前後端共用）。

客戶端 → 伺服器（全部有頻率限制，payload 一律視為不可信）：

| 事件 | 說明 |
| --- | --- |
| `room:create` `{name}` / `room:join` `{name, code}` | 建立／加入，回傳 `roomCode`、`token`（重連憑證，只回給本人）、`playerId` 與完整同步資料（含廚房快照） |
| `room:rejoin` `{code, token}` | 斷線重連，恢復席位、缺陷狀態與計時器、位置、手上的東西、互助標記 |
| `room:selectFlaw` `{flaw}` | 選缺陷卡（可重複；只能選已開放的卡；`null`＝取消） |
| `room:leave` / `room:selectRole` / `room:start` / `room:restart` | 大廳操作（開始、重新開始只限房主） |
| `player:move` `{x,y,z,yaw,seq}` | 位置（約 15Hz，volatile） |
| `player:stance` `{crouch, panel}` | 蹲下（影響怪物的視線與腳步噪音） |
| `kitchen:action` `{stationId, action, args, requestId}` | 工作站操作（拿、洗、切、開火、翻面、量、裝盤、出餐、躲、撬、帶位……）。`requestId` 必填；客戶端逾時會用**同一個** `requestId` 重送一次 |
| `signal:emit` `{tokens}` | 信號器 |
| `signal:mark` `{targetId, token?}` | 標記工具（所有人）：工作站或 `order:<id>`；存進互助狀態（重連後還在），隊友可用 `coop/mark_reply` 回應 |
| `kitchen:action` `{stationId:'coop', action, args, requestId}` | 互助操作：tap、handoff、handoff_accept／decline／cancel、note、note_clear、recite、taste_report、mark_reply、rumor_post、rumor_dismiss、focus（同樣以 requestId 去重） |
| `debug:state` / `debug:command` `{cmd}` | 開發者工具（見第 7 節） |
| `voice:ready` / `voice:signal` | 語音 |

伺服器 → 客戶端：

| 事件 | 說明 |
| --- | --- |
| `room:state` | 大廳／房間狀態 |
| `kitchen:state` | 廚房的公開快照（約 5Hz）：階段與時間、工作站、食材、盤子、每個人手上的東西與狀態、訂單（含評分結果）、門、威脅的位置 |
| `kitchen:event` | 事件（新單、跑單、出餐、吐司跳起、送貨、被抓、獲救、客人說話／移動、怪物的聲音、防火門）。**依接收者感官過濾**（PerceptionSystem）：`sense: 'sound'` 的事件不送給聽不見的人、`sense: 'sight'` 不送給看不見的人；其他事件的 `sound` 欄位只給聽得見的人、`visual` 只給看得見的人；客人說的話只給 2.2 m 內的人 |
| `signal:received` / `signal:marker` | 信號、標記（附帶的符號依接收者感官過濾） |
| `world:positions` / `player:correct` | 位置（10Hz；含蹲下、正在操作、被抓次數）、位置修正；`teleport: true` 表示被拖走、被救出來、躲進／離開置物櫃 |
| `notice`、`room:closed`、`game:restarted`、`voice:signal`、`voice:peer` | 其他 |

**任何廣播都不含重連憑證**（整合測試會掃描所有事件確認）。

## 3. 移動驗證

- 前後端共用 `shared/src/level.ts` 的碰撞盒（牆、家具、置物櫃、關上的防火門，以及站在門口或廚房裡的客人、在場的怪物）。
- 伺服器對每次移動：檢查數值合法、在地圖範圍內、以「累積移動額度」限制速度（`MAX_SPEED` 7 m/s，額度上限 2.5 m）、沿路徑做**掃掠碰撞檢查**。違規時回 `player:correct` 把玩家拉回伺服器位置。
- 被關在鐵籠或躲在置物櫃裡的人只能轉頭。
- 工作站操作需在工作站正面 `SERVER_INTERACT_RANGE`（2.8 m）內；監視器所有人都能用。計時的動作（清洗、削皮、擦砧板、溫度計、撬鐵籠、帶位）在離開範圍時中斷。
- 傳送後 250 ms 內收到的移動會被忽略（那是客戶端在收到傳送前送出的舊位置）。

## 3.1 工作站操作的處理順序（`server/src/kitchen/sim.ts`）

1. `requestId` 必填；同一位玩家重送同一個 `requestId` 直接回傳上一次的結果（每人保留最近 64 個）——重連後重送也不會重複扣庫存、重複出餐
2. 已經打烊 → 拒絕；被關、躲著（除了離開置物櫃）、正在做計時的動作 → 拒絕
3. 工作站存在、距離在範圍內
4. 交給該種工作站的處理函式；所有狀態改變都在這裡發生，客戶端送來的任何「結果」欄位一律無效
5. 出餐時由 `scoring.ts` 評分，結果附在回覆裡，並廣播 `kitchen:event`（出餐）

## 4. 房間與重連

- 房間代碼 6 碼，字母表排除易混淆的 I/O/0/1，用 `crypto.randomInt` 產生；重連憑證為 192-bit 隨機值（`crypto.randomBytes`），以 `timingSafeEqual` 比對。
- 加入／重連失敗次數過多會被暫時封鎖（每個連線）。
- 憑證存在瀏覽器 `sessionStorage`（只在該分頁有效）；重新整理頁面會自動重連。同一個憑證在另一個分頁重連時，舊連線會被取代。
- 遊戲中斷線不會移除玩家：席位、缺陷狀態、位置、手上的東西保留，隊友看到「離線」；廚房照常運作（爐子上的東西繼續煮）。大廳中斷線有寬限時間，逾時才釋放位置。房主離線超過寬限時間會自動移交給在線的玩家。
- 閒置房間（預設 15 分鐘）會被清除。

## 5. 頻率限制

每個 socket 有獨立的 token bucket：一般操作（30，每秒回補 15）、移動（60／40）、語音 signaling（200／100）、建立房間（每分鐘 5 次）。信號器另有 1.2 秒冷卻與 6 個 token 上限。

## 6. 語音（WebRTC）

### 6.1 路由規則

`voiceEdgeAllowed(from, to, flawOf) = from ≠ to ∧ flawOf(from) ≠ D04`：所有人互通，只有**沉默侍者（D04）不能發話**。
耳背砧板（D02）照樣接收，客戶端把隊友語音處理得又悶又小聲（呈現；伺服器的限制是不送聲音提示）。

### 6.2 連線方式

- **每條邊一條獨立、單向的 RTCPeerConnection**：發話者建立 `sendonly` 的純音訊 offer，接收者回 `recvonly` answer。
- 由發話者發起：伺服器以 `voice:peer` 通知「某位隊友的語音上線／離線」，發話者據此（重新）建立連線；連線失敗會自動重試。
- 伺服器在轉發之前驗證：
  1. 寄件者在房間內、有席位，且 socket 是該玩家目前的連線；
  2. 這條邊被允許（發話者不是沉默侍者）；
  3. offer 只能由該邊的發話者送、answer 只能由接收者送（不能冒充）；
  4. SDP 只能有 `m=audio` 區段（拒絕 video 與 DataChannel，避免被當成隱蔽通道），方向必須是 offer=`sendonly`、answer=`recvonly`／`inactive`，長度有上限；
  5. ICE candidate 大小有上限。
  不符合的訊息直接丟棄。
- 客戶端的第二道防線：收到的 signaling 再檢查一次邊是否允許；沉默侍者從不要求麥克風權限。

### 6.3 STUN／TURN

- ICE 伺服器由 `/api/ice-servers` 提供（TURN 憑證只放在伺服器環境變數）。預設只有公用 STUN。
- **正式上線強烈建議設定 TURN**（`TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`）：在對稱型 NAT、公司或學校網路下，只有 STUN 時 P2P 可能連不上，語音會沒有聲音。
- 本專案在無頭 Chromium 中驗證過五個瀏覽器之間（同一台機器）的語音連線：沉默侍者沒有任何發話連線。尚未在真實的跨網路環境測試；8 人時是最多 56 條單向連線的網狀結構。

### 6.4 空間音訊

接收到的語音接到 Web Audio 的 HRTF `PannerNode`，位置跟著說話者在場景中的位置（衰減很緩和，在後場也聽得清楚），可以靠聲音判斷隊友方向。

## 7. 開發者工具（規格 8）

- 啟用條件：`DEBUG_TOOLS=1`，或 `NODE_ENV` 不是 `production` 且沒有設定 `DEBUG_TOOLS=0`。**正式環境預設關閉**：伺服器拒絕 `debug:*` 事件，同步資料的 `debug` 為 `false`，前端不會顯示面板。Render 的 `render.yaml` 明確設定 `DEBUG_TOOLS=0`。
- 功能（遊戲中按 `` ` ``）：階段與時間、怪物的內部狀態（模式、飢餓值、目標、上一次轉換的原因）、客人的狀態、最近的操作；跳過備料、補滿庫存、叫出客人、叫出怪物、讓怪物離開、直接打烊、重新初始化房間。
- 開發者指令只改變「時間」與「威脅是否在場」，不改變任何料理規則或食材狀態。
- 出單排程使用固定種子，每局都一樣，方便重現問題。

## 7. 每位玩家的快照

`kitchen:state` 不再是房間廣播。伺服器每次只算一份共同的 `publicState()`，再為每位玩家加上：

- `self`：只給本人的 `playerFlawState`，包括私人傳聞、預警、記憶、冷卻與試吃回報；
- 個人版本的 `orders`：健忘助手想不起來的單不含菜名。

`coop`（缺陷卡、交接、便條、標記、傳聞看板、準備提示）是公開的，所有人一樣。
傳聞的真假、提示音的音高、別人的私人狀態都不會出現在其他人的封包裡（`flaws-net.test.ts` 逐一檢查）。
