import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

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
    else if (line.startsWith('Binary') ) f.binary = true;
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

  if (error) return <p className="dim pad">{error}</p>;
  if (!data) return <p className="dim pad">Chargement…</p>;
  if (!files.length) return <p className="dim pad">Aucun changement {data.base ? `par rapport à ${data.base}` : '(pas un repo git)'}.</p>;

  return (
    <div className="diff">
      <div className="diff-bar">
        <span>{files.length} fichier{files.length > 1 ? 's' : ''} · comparé à <b className="mono">{data.base}</b></span>
        <button className="ghost" onClick={load}><Icon name="restart" /> Rafraîchir</button>
      </div>
      <div className="diff-layout">
        <ul className="diff-files">
          {files.map((f) => (
            <li key={f.path}><a href={`#diff-${f.path}`} onClick={(e) => { e.preventDefault(); document.getElementById(`diff-${f.path}`)?.scrollIntoView({ behavior: 'smooth' }); }}>
              <span className="mono fname">{f.path}</span>
              <span className="stats mono"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
            </a></li>
          ))}
        </ul>
        <div className="diff-body">
          {files.map((f) => (
            <section className="file" key={f.path} id={`diff-${f.path}`}>
              <header onClick={() => setClosed({ ...closed, [f.path]: !closed[f.path] })}>
                <Icon name={closed[f.path] ? 'right' : 'down'} />
                <span className="mono">{f.path}</span>
                {f.isNew && <span className="tag green">nouveau</span>}
                {f.deleted && <span className="tag red">supprimé</span>}
                <span className="stats mono"><span className="add">+{f.add}</span> <span className="del">−{f.del}</span></span>
              </header>
              {!closed[f.path] && (f.binary ? <p className="dim pad">Fichier binaire ou trop gros</p> : (
                <table className="code mono">
                  <tbody>
                    {f.lines.map((l, i) => l.t === 'hunk' ? (
                      <tr key={i} className="hunk"><td colSpan={3}>{l.text}</td></tr>
                    ) : (
                      <tr key={i} className={l.t}>
                        <td className="ln">{l.o ?? ''}</td>
                        <td className="ln">{l.n ?? ''}</td>
                        <td className="src"><span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span>{l.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
