import { useEffect } from 'react';
import { music, type TrackId } from '../audio/music';
import { useStore } from '../state/store';
import { desktop } from '../platform';

/**
 * 依畫面決定背景音樂：起始頁面／大廳／打烊＝title，營業中＝kitchen，
 * 後門的東西在刮門或在場＝tension。第一次點擊或按鍵之後才開始播放。
 */
export default function MusicDirector(): null {
  const inGame = useStore((s) => !!s.session && s.room?.phase === 'PLAYING' && !!s.kitchen && s.kitchen.phase !== 'CLOSED');
  const danger = useStore((s) => {
    const m = s.kitchen?.threats.monster;
    return !!m && (m.mode === 'lurk' || (m.present && m.mode !== 'leave'));
  });
  const vol = useStore((s) => s.prefs.musicVolume ?? 0.5);
  const master = useStore((s) => s.prefs.volume);

  useEffect(() => {
    // 應用程式允許自動播放：一打開就有音樂
    if (desktop) music.unlock();
    const unlock = () => music.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    music.setVolume(vol * master);
  }, [vol, master]);

  useEffect(() => {
    const id: TrackId = inGame ? (danger ? 'tension' : 'kitchen') : 'title';
    music.play(id);
  }, [inGame, danger]);

  return null;
}
