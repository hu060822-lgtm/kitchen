# Windows 應用程式、起始頁面與房間代碼

## 起始頁面（網頁版與應用程式共用）

打開遊戲先看到起始頁面：出餐口剛印出來的一張單，掛在保溫燈下，單上的每一行就是選單。

| 選單 | 網頁版 | 應用程式 |
|---|---|---|
| 開始遊戲 | 開新房間（在線上伺服器）、輸入代碼加入 | 開新房間：**和朋友一起**／**自己一個人**／改用線上伺服器；輸入代碼加入 |
| 繼續遊戲 | — | 讀檔（顯示最近一次存檔） |
| 設定 | 聲音、畫面與操作、按鍵 | ＋連線（線上伺服器網址、區網模式）、個人資料匯出／匯入 |
| 說明 | 一班怎麼進行、操作、缺陷卡、互助、威脅、和朋友一起玩 | 同左 |
| 離開 | — | 關閉程式 |

鍵盤：`↑` `↓` 在單上移動，`Enter` 選。

## 給玩家：怎麼和朋友一起玩

**只要講 6 碼的房間代碼。**

1. 房主：開始遊戲 → 填暱稱 → **和朋友一起**。大廳會顯示「朋友輸入代碼 ABC123 就能加入」。
2. 朋友：打開《最後一桌》（**網頁版或應用程式都可以**）→ 開始遊戲 → 填暱稱 → 輸入代碼 → 加入。
3. 也可以按「複製邀請連結」貼給朋友，點開就會帶入代碼。

第一次按「和朋友一起」會自動下載 Cloudflare 的免費通道程式（約 50 MB，放在 `%APPDATA%\NullLastTable\bin`），之後就不用再下載。

> 第一次執行時 Windows 可能跳出「Windows 已保護您的電腦」（程式沒有付費的程式碼簽章）：按「其他資訊」→「仍要執行」。

### 存檔、讀檔

- 房間開在房主的電腦上，班次進行中**每 30 秒自動存檔**（班次有前進才存，同一個房間輪替三格）；打烊時、關掉程式時也會各存一份。
- 遊戲中按 `H`：房主可以「💾 立刻存檔」「⏸ 暫停班次」，也看得到邀請狀態。
- 下次打開 → 起始頁面的**繼續遊戲** → 讀檔。房間代碼不變，班次停在存檔的那一刻：
  - 勾著「讀檔後邀請朋友」（存檔裡有朋友時預設勾著），朋友輸入**同一個代碼**、用**原本的暱稱**加入，就回到原本的位置（手上的東西、缺陷卡都在）；
  - 暱稱不對時，錯誤訊息會列出還沒回來的人；
  - 大家按「準備好了」才繼續（房主可以按「不等了，繼續」）。
- 存檔可以匯出、匯入（換電腦帶著走）。存檔資料夾：`%APPDATA%\NullLastTable\saves`。

### 沒有網際網路時：區網模式

設定 → 連線 → 勾「區網模式」→ 重新開啟程式。之後同一個網路的朋友可以在「加入朋友的房間」直接輸入房主大廳顯示的網址（例如 `http://192.168.1.5:38401`）。

- 第一次開時 Windows 防火牆會詢問：勾「私人網路」並允許。
- 區網的 http 網址瀏覽器不給麥克風；應用程式第一次連到某個區網位址時會問要不要重新開啟一次，之後語音就能用。

### 個人資料

設定 → 個人資料 → 匯出／匯入。內容是設定、按鍵、料理圖鑑與委託紀錄（`prefs.json`、`records.json`，在 `%APPDATA%\NullLastTable`，每次寫入都留一份 `.bak`）。不管連到哪個伺服器（自己的、朋友的、線上的），用的都是同一份。

## 架構

```
  房主的電腦（應用程式）                         線上伺服器（Render）                朋友
  ┌────────────────────────────┐   登記代碼    ┌──────────────────────┐
  │ 遊戲伺服器（只聽本機）        │──────────────►│ 房間代碼查詢處          │◄── 1. 輸入代碼 ABC123
  │  ├ 房間、存檔、自動存檔        │  每 45 秒     │ ABC123 → https://xxxx │──► 2. 回答房主的網址
  │  └ 提供遊戲畫面               │               │       .trycloudflare.com│
  │ cloudflared（通道）           │◄────────────────────────────────────────── 3. 連到房主的電腦，自動加入
  └────────────────────────────┘   https（Cloudflare 免費快速通道）
```

- 遊戲本身是「房主當伺服器」（listen server）：所有判定都在房主的電腦上，其他人連到房主；不是每個人互連的 P2P。語音是玩家之間直接連（WebRTC）。
- 線上伺服器只記「代碼 → 網址」，150 秒沒更新就忘掉；遊戲資料、存檔都不經過它。
- 免費方案閒置後第一次要等約 30 秒才醒；應用程式一打開就先叫醒它，房主邀請期間每 45 秒的登記也讓它保持清醒。

### 應用程式（`desktop/`）

一打開就在本機跑遊戲伺服器（`server/src/host.ts`，預設通訊埠 38401，被占用時往後找），只有一個視窗，載入本機伺服器提供的遊戲畫面。加入朋友的房間時，視窗換到朋友的網址；離開房間後回到本機的起始頁面。

```
desktop/
  src/main.ts      主程式：本機伺服器、視窗、存檔管理、設定、找房間（查詢處）、前往別人的房間
  src/invite.ts    邀請朋友：開通道＋登記代碼（心跳、房間不見就刪、關程式時全部刪）
  src/tunnel.ts    Cloudflare 快速通道：下載 cloudflared（進度、壞檔重下）、啟動、抓網址、中斷回報
  src/kvstore.ts   JSON 檔（原子寫入＋.bak）；遊戲 kv 分成 prefs.json 與 records.json
  src/preload.ts   window.lastTableApp（對應 client/src/platform.ts 的 DesktopBridge）
  pages/           連不上時的頁面
  build/           esbuild 打包、afterPack（resedit 寫入圖示與版本資訊）、圖示
  test/            煙霧測試、通道測試
```

### 房間代碼查詢處（`server/src/relay.ts`，只在線上伺服器開）

| 介面 | 說明 |
|---|---|
| `POST /api/relay` `{code, url, secret}` | 房主登記。`url` 只接受 `https://<子網域>.trycloudflare.com`；同一個代碼要用第一次的密語（只存雜湊）才能更新 |
| `DELETE /api/relay/:code` `{secret}` | 房主刪除 |
| `GET /api/locate/:code` | `{where:'here'}`（線上伺服器自己的房間）／`{where:'host', url}`／404 |

每個來源 IP 有頻率限制（Render 前面有代理，`TRUST_PROXY=1` 用 X-Forwarded-For）。房主模式的伺服器不開查詢處。

**「房間代碼登記不上（HTTP 404）」**：應用程式會再問一次線上伺服器的 `GET /api/version`（`{game:'last-table', version, relay, hostMode}`）與 `/healthz`，告訴你是哪一種情況：
- 線上伺服器還是舊版（`/healthz` 正常、但沒有查詢處）→ 把最新的原始碼推上 GitHub，等 Render 重新部署完成；
- 網址不是《最後一桌》的線上伺服器 → 到「設定 → 連線」填入 Render 上的網址。
「設定 → 連線 → 測試連線」可以隨時檢查（剛醒來的免費方案要等一下）。

### 找房間的流程（`client/src/net/findRoom.ts`）

1. 先在目前連著的伺服器加入；失敗原因是 `not_found` 才往下；
2. 問查詢處（應用程式由主程式去問；網頁版問同源的 `/api/locate`）；
3. 找到房主 → 換到 `房主網址/?join=代碼&name=暱稱`，到了自動加入（網址裡的暱稱、代碼用完就從網址列拿掉）。

也接受直接輸入網址（區網模式、或查詢處暫時不能用時）。

### 安全

- 視窗可能停在別人的網頁上（朋友的房間、線上伺服器），所以：`contextIsolation`、`sandbox` 開著；所有頁面只有 kv、回到起始頁面；存檔、邀請、找房間、設定、檔案對話框**只有本機伺服器的頁面**能用（preload 只給本機頁面、主程式每次再檢查呼叫的頁面）；視窗只停在本機、線上伺服器、或剛剛前往的房主網址，其他連結用預設瀏覽器打開；權限只允許麥克風、滑鼠鎖定、全螢幕、複製。
- 只會被帶到 Cloudflare 快速通道的網址（查詢處只收這種，網頁版收到時再檢查一次）。
- 本機伺服器只綁 `127.0.0.1`（區網模式才綁 `0.0.0.0`）；同源連線、開發者工具關閉。
- 存檔：sha256 校驗碼、格式版本檢查、只接受存檔資料夾裡的檔名。

### 存檔格式（第 1 版）

```jsonc
{
  "meta": { "format": "last-table-save", "version": 1, "game": "0.2.0", "savedAt": 0, "kind": "auto|manual|exit|closed",
            "code": "ABC123", "players": [{ "name": "Luz", "role": "P1", "flaw": "D03", "host": true }],
            "phase": "SERVICE", "shiftSec": 312, "served": 7, "missed": 1 },
  "checksum": "sha256(JSON {meta,state})",
  "state": { "room": { /* 房間、玩家（憑證、席位、缺陷卡、位置） */ }, "sim": { /* 整個廚房模擬的快照 */ } }
}
```

`sim` 是 `server/src/save/snapshot.ts` 的通用快照：物件圖整個存下來，`Map`／`Set`／非有限數字／亂數產生器的狀態用標記保存，函式與 `hooks`、`opts`、`sim`、`cfg`、`def` 這些參照不存（讀檔時用新建的物件、只覆寫資料）。模擬是固定步長、沒有 `Math.random`，讀回來之後繼續跑和沒存檔時一模一樣（`server/test/save.test.ts`）。

## 建置

```bash
npm ci --include=dev            # 根目錄（shared / server / client）
cd desktop && npm ci            # Electron、electron-builder（desktop/ 不是 workspace，Render 的建置不會裝到 Electron）
npm start                       # 開發：打包主程式後直接開 Electron（先 npm run build -w client）
npm run dist:win                # Windows 版：release/NullLastTable-x.y.z-win-x64.zip
```

- 在 Linux 上打包 Windows 版沒有 wine，所以關掉 rcedit（`signAndEditExecutable: false`），改在 `build/after-pack.cjs` 用純 JavaScript 的 `resedit` 寫入 exe 的圖示與版本資訊。
- GitHub Actions：`.github/workflows/desktop-windows.yml`（手動執行，或推送 `desktop-v*` 標籤）在 Windows 機器上建置並上傳 zip。
