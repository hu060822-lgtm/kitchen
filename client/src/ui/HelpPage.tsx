import { KEY_ACTIONS, keyLabel } from '../game/keymap';
import { desktop } from '../platform';
import { FlawTable } from './flawUi';
import { BackToTitle, SheetHead } from './Menu';
import { CoopList, ThreatList } from './Overlays';

/** 說明（起始頁面）：怎麼玩、操作、缺陷卡、互助、威脅、和朋友一起玩 */
export default function HelpPage(): JSX.Element {
  const groups = ['移動', '動作', '畫面', '面板'] as const;
  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead right={<BackToTitle />} />

        <section className="sec">
          <div className="sec-label">
            <h3>一班怎麼進行</h3>
          </div>
          <div className="sec-body">
            <ol className="help-steps">
              <li>
                <b>開店</b>：一個人開房間，把房間代碼告訴朋友（1–8 人；一個人也能玩）。
              </li>
              <li>
                <b>選缺陷卡</b>：每個人一張。卡上寫著你做不好的事、比別人強的地方，以及隊友能怎麼幫你。
              </li>
              <li>
                <b>讀操作、按「準備好了」</b>：全員準備好，時鐘才開始走。
              </li>
              <li>
                <b>備料</b>（約 1 分鐘）：洗、切、先把常用的東西準備好。
              </li>
              <li>
                <b>營業</b>（約 7 分鐘）：單會從出餐口印出來——照標準做的招牌菜、今日特餐，以及只給條件、做法由你們決定的主廚委託。做好裝盤、送到出餐口。
              </li>
              <li>
                <b>打烊結算</b>：看每一道菜的評分、誰幫了誰，再開下一班。
              </li>
            </ol>
            <p className="note">
              餐廳最遠的那張桌子坐著一位從來不點餐的客人；後門外，有東西會被廚房的噪音吸引進來。它們只會打斷你們的工作，不會改變料理的規則——爐子上的東西，不管你躲到哪裡都會繼續煮。
            </p>
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>操作</h3>
            <p>目前的按鍵。可以在「設定」或遊戲中按 {keyLabel('help')} 修改。</p>
          </div>
          <div className="sec-body">
            <div className="help-keys">
              {groups.map((g) => (
                <div key={g}>
                  <div className="blk-heading">{g}</div>
                  <dl>
                    {KEY_ACTIONS.filter((a) => a.group === g).map((a) => (
                      <div key={a.id} className="help-key">
                        <dt>
                          <kbd>{keyLabel(a.id)}</kbd>
                        </dt>
                        <dd>{a.label}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
            <p className="note">
              滑鼠轉向（點一下畫面鎖定游標）。物品欄在畫面下方：左手、右手、菜籃 2 格。注視冷藏架／乾貨架時按 <kbd>1</kbd>–<kbd>7</kbd> 直接拿。
            </p>
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>缺陷卡</h3>
            <p>16 張卡都能選。缺陷 = 做不好的事 + 比別人強的地方 + 隊友能實際幫你的操作。</p>
          </div>
          <div className="sec-body">
            <FlawTable />
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>互助</h3>
            <p>所有人都能用，伺服器實際判定。</p>
          </div>
          <div className="sec-body">
            <CoopList />
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>廚房裡的威脅</h3>
          </div>
          <div className="sec-body">
            <ThreatList />
          </div>
        </section>

        <section className="sec">
          <div className="sec-label">
            <h3>和朋友一起玩</h3>
          </div>
          <div className="sec-body">
            <ul className="blk-list">
              <li>開房的人把 6 碼房間代碼告訴朋友；朋友在「開始遊戲」輸入代碼。也可以複製邀請連結，點開就會帶入代碼。</li>
              {desktop ? (
                <>
                  <li>Windows 版開的房間在你的電腦上：按「和朋友一起」或大廳的「邀請朋友」，朋友在任何地方（網頁版或應用程式）都能用代碼加入。</li>
                  <li>班次進行中每 30 秒自動存檔，關閉程式時也會存。下次從起始頁面的「繼續遊戲」讀檔，朋友用同樣的暱稱回到原本的位置。</li>
                </>
              ) : (
                <li>想要存檔、隨時接著玩，可以用 Windows 版自己開房。</li>
              )}
              <li>遊戲內語音所有人互通（沉默侍者不能發話）。互助操作都不需要語音。建議戴耳機，喇叭外放可能讓語音回授。</li>
              <li>斷線後重新整理或重開，會自動回到原本的房間。</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
