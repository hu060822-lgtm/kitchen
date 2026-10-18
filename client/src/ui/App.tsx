import { useStore } from '../state/store';
import ContinuePage from './ContinuePage';
import GameScreen from './GameScreen';
import HelpPage from './HelpPage';
import JournalPage from './JournalPage';
import MusicDirector from './MusicDirector';
import Lobby from './Lobby';
import Menu from './Menu';
import SettingsPage from './SettingsPage';
import Title from './Title';

function ConnBanner(): JSX.Element | null {
  const session = useStore((s) => s.session);
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  if (!session) return null;
  if (connected && !reconnecting) return null;
  return <div className="conn plate" role="status">與伺服器的連線中斷，正在重新連線…（你的角色與進度會保留）</div>;
}

/** 沒有在房間裡：起始頁面與它的子頁面 */
function OutOfRoom(): JSX.Element {
  const page = useStore((s) => s.page);
  switch (page) {
    case 'play':
      return <Menu />;
    case 'continue':
      return <ContinuePage />;
    case 'settings':
      return <SettingsPage />;
    case 'help':
      return <HelpPage />;
    case 'journal':
      return <JournalPage />;
    default:
      return <Title />;
  }
}

export default function App(): JSX.Element {
  const session = useStore((s) => s.session);
  const room = useStore((s) => s.room);
  let screen: JSX.Element;
  if (!session || !room) screen = <OutOfRoom />;
  else if (room.phase === 'LOBBY') screen = <Lobby />;
  else screen = <GameScreen />;
  return (
    <>
      {screen}
      <ConnBanner />
      <MusicDirector />
    </>
  );
}
