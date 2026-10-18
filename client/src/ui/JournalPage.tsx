import { NIGHTS, NIGHT_COUNT } from '@last-table/shared';
import { useCampaign } from '../state/campaign';
import { BackToTitle, SheetHead } from './Menu';

/**
 * 營業日誌：連續七晚讀過的故事。開班前的一段（玩到那一晚就讀得到）、出單機印出的碎片、打烊後的結尾。
 */
export default function JournalPage(): JSX.Element {
  const camp = useCampaign();
  const read = camp.fragments.length + camp.outros.length;
  return (
    <div className="screen">
      <div className="sheet">
        <SheetHead
          right={
            <div className="docmeta">
              <div>
                已讀 <b>{read}</b>／{NIGHT_COUNT * 2} 張
              </div>
              <div style={{ marginTop: 8 }}>
                <BackToTitle />
              </div>
            </div>
          }
        />
        {NIGHTS.map((n) => {
          const reached = n.night <= camp.unlocked;
          const frag = camp.fragments.includes(n.night);
          const outro = camp.outros.includes(n.night);
          return (
            <section key={n.night} className={`sec journal ${reached ? '' : 'locked'}`}>
              <div className="sec-label">
                <div className="no">{n.night}</div>
                <h3>{reached ? n.title : '？？？'}</h3>
                <p>{reached ? (outro ? '這一晚打烊了' : '還沒打烊') : '還沒到這一晚'}</p>
              </div>
              <div className="sec-body">
                {reached ? (
                  <>
                    <p className="journal-text">{n.intro}</p>
                    {frag ? (
                      <div className="journal-slip">
                        <div className="xs dim">出單機印出的單：{n.fragment.title}</div>
                        <p>{n.fragment.text}</p>
                      </div>
                    ) : (
                      <p className="dim sm">（營業到一半時，出單機會印出一張不是訂單的單。）</p>
                    )}
                    {outro && <p className="journal-text">{n.outro}</p>}
                    {n.night === NIGHT_COUNT && camp.ending === 'served' && <p className="journal-end">七個晚上結束了。</p>}
                  </>
                ) : (
                  <p className="dim sm">打烊過第 {n.night - 1} 晚之後才讀得到。</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
