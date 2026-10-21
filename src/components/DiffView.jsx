import { useEffect, useMemo, useState } from 'react';
import { HiChevronRight } from 'react-icons/hi2';
import { LuRefreshCw } from 'react-icons/lu';
import { api } from '../api.js';

function parse(patch) {
  const files = [];
  let f = null, oldN = 0, newN = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) {
      f = { path: line.split(' b/').slice(1).join(' b/'), lines: [], add: 0, del: 0, isNew: false, binary: false };
      files.push(f);
    } else if (!f) continue;
    else if (line.startsWith('new file')) f.isNew = true;
    else if (line.startsWith('deleted file')) f.deleted = true;
    else if (line.startsWith('Binary')) f.binary = true;
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename')) continue;
    else if (line.startsWith('@@')) {
      const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldN = Number(m?.[1] || 0);
      newN = Number(m?.[2] || 0);
      f.lines.push({ t: 'hunk', text: line });
    } else if (line.startsWith('+')) { f.lines.push({ t: 'add', n: newN++, text: line.slice(1) }); f.add++; }
    else if (line.startsWith('-')) { f.lines.push({ t: 'del', o: oldN++, text: line.slice(1) }); f.del++; }
    else if (line.startsWith(' ')) f.lines.push({ t: 'ctx', o: oldN++, n: newN++, text: line.slice(1) });
  }
  return files;
}

export default function DiffView({ ws }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState({});
  const load = () => api.get(`/api/workspaces/${ws.id}/diff`).then(setData, (e) => setError(e.message));
  useEffect(() => { load(); }, [ws.id, ws.status]);
  const files = useMemo(() => (data ? parse(data.patch) : []), [data]);

  if (error) return <p className="empty-note">{error}</p>;
  if (!data) return <p className="empty-note">Chargement…</p>;

  return (
    <div className="diff">
      <div className="diff-bar">
        <span>{files.length ? `${files.length} fichier${files.length > 1 ? 's' : ''}` : 'Aucun changement'}{data.base && <> · <span className="mono">{data.base}</span></>}</span>
        <button className="iconbtn size-6" title="Rafraîchir" onClick={load}><LuRefreshCw size={12} /></button>
      </div>
      {!files.length && !data.base && <p className="empty-note">Pas un repo git.</p>}
      {files.map((f) => (
        <section className="diff-file" key={f.path}>
          <header onClick={() => setClosed({ ...closed, [f.path]: !closed[f.path] })}>
            <HiChevronRight size={12} className={`chev ${closed[f.path] ? '' : 'open'}`} />
            <span className="diff-path fade-r" title={f.path}>
              <span className="muted">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}</span>{f.path.split('/').pop()}
            </span>
            {f.isNew && <span className="tag green">A</span>}
            {f.deleted && <span className="tag red">D</span>}
            <span className="diffstats active"><span className="add">+{f.add}</span><span className="del">−{f.del}</span></span>
          </header>
          {!closed[f.path] && (f.binary ? <p className="empty-note">Fichier binaire ou trop gros</p> : (
            <div className="code-scroll">
              <table className="code">
                <tbody>
                  {f.lines.map((l, i) => l.t === 'hunk' ? (
                    <tr key={i} className="hunk"><td colSpan={3}>{l.text}</td></tr>
                  ) : (
                    <tr key={i} className={l.t}>
                      <td className="ln">{l.o ?? ''}</td>
                      <td className="ln">{l.n ?? ''}</td>
                      <td className="src">{l.text || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
