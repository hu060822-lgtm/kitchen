import { flawCanSpeak, type FlawId } from '@last-table/shared';
import { useStore } from '../state/store';
import { voice } from '../voice/voice';
import { Icon } from './icons';

const STATE_TEXT: Record<string, string> = {
  off: '麥克風尚未啟用',
  requesting: '正在要求麥克風權限…',
  on: '麥克風已啟用',
  denied: '麥克風權限被拒絕。請在網址列旁的權限設定允許麥克風，再按一次啟用。',
  unavailable: '這個瀏覽器不支援麥克風或 WebRTC。',
  forbidden: '沉默侍者不能使用遊戲內語音。',
};

export default function MicSetup({ flaw }: { flaw: FlawId | null }): JSX.Element | null {
  const micState = useStore((s) => s.micState);
  const level = useStore((s) => s.micLevel);
  const muted = useStore((s) => s.micMuted);

  if (!flawCanSpeak(flaw)) {
    return (
      <div className="stack">
        <div className="row">
          <Icon name="micOff" />
          <b>沉默侍者不使用遊戲內語音。</b>
        </div>
        <p className="note">
          這是缺陷卡的限制：瀏覽器不會要求麥克風權限，伺服器也會拒絕由你發出的語音連線。
          你聽得到隊友；要回話，用標記（<kbd>G</kbd>）、信號器（<kbd>Q</kbd>）、拍肩與交接。遊戲不會、也無法限制外部通話軟體——但遊戲裡的一切都不需要語音就能完成。
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        {micState !== 'on' ? (
          <button className="btn" onClick={() => void voice.enableMic()} disabled={micState === 'requesting'}>
            <Icon name="mic" size={18} /> 啟用麥克風
          </button>
        ) : (
          <button className="btn" onClick={() => voice.setMuted(!muted)}>
            <Icon name={muted ? 'mic' : 'micOff'} size={18} /> {muted ? '取消靜音' : '靜音'}
          </button>
        )}
        <span className="meter" aria-hidden>
          <i style={{ width: `${Math.min(100, level * 260)}%` }} />
        </span>
        <span className="sm dim">{STATE_TEXT[micState] ?? ''}</span>
      </div>
      <p className="note">
        {flaw === 'D02' ? '你的聲音會傳給所有隊友；隊友的聲音傳到你這裡會又悶又小聲（耳背砧板）。' : '你的聲音會傳給所有隊友（耳背砧板聽起來會比較悶）。'}
      </p>
    </div>
  );
}
