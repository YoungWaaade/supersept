import { useEffect, useMemo, useRef, useState } from 'react';
import { HiChevronRight } from 'react-icons/hi2';
import { LuRefreshCw, LuFileCode } from 'react-icons/lu';
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

// One continuous scroll of every changed file (Superset's "Changes" pane), scrolled to `focus`.
export default function DiffView({ ws, focus, sha, nonce }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState({});
  const box = useRef(null);
  const load = () => {
    setError(null);
    (sha ? api.get(`/api/workspaces/${ws.id}/commit/${sha}`).then((r) => ({ ...r, base: sha.slice(0, 7) })) : api.get(`/api/workspaces/${ws.id}/diff`))
      .then(setData, (e) => setError(e.message));
  };
  useEffect(() => { load(); }, [ws.id, ws.status, sha, ws.stats?.add, ws.stats?.del]);
  const files = useMemo(() => (data ? parse(data.patch) : []), [data]);
  useEffect(() => {
    if (!focus || !files.length) return;
    setClosed((c) => ({ ...c, [focus]: false }));
    requestAnimationFrame(() => box.current?.querySelector(`[data-path="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'start' }));
  }, [focus, nonce, files.length]);

  if (error) return <div className="dv-empty">Impossible de charger le diff — {error}</div>;
  if (!data) return <div className="dv-empty">Chargement…</div>;

  return (
    <div className="dv" ref={box}>
      <div className="dv-bar">
        <span className="dv-bar-label">{sha ? 'Commit' : 'Contre la base'}</span>
        <span className="dv-bar-count">{files.length}</span>
        {data.base && <span className="dv-bar-base mono">{data.base}</span>}
        <span className="flex-1" />
        <button className="iconbtn size-6" title="Rafraîchir" onClick={load}><LuRefreshCw size={12} /></button>
      </div>
      {!files.length && <div className="dv-empty">Aucune modification</div>}
      {files.map((f) => (
        <section className="dv-file" key={f.path} data-path={f.path}>
          <header onClick={() => setClosed({ ...closed, [f.path]: !closed[f.path] })}>
            <HiChevronRight size={12} className={`chev ${closed[f.path] ? '' : 'open'}`} />
            <span className="dv-path fade-r">
              <span className="muted">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}</span>{f.path.split('/').pop()}
            </span>
            {f.isNew && <span className="tag green">nouveau</span>}
            {f.deleted && <span className="tag red">supprimé</span>}
            <span className="diffstats active"><span className="add">+{f.add}</span><span className="del">−{f.del}</span></span>
          </header>
          {!closed[f.path] && (f.binary ? <div className="dv-binary"><LuFileCode size={32} /> Fichier binaire masqué</div> : (
            <div className="code-scroll">
              <table className="code">
                <tbody>
                  {f.lines.map((l, i) => l.t === 'hunk' ? (
                    <tr key={i} className="hunk"><td colSpan={3}>{l.text}</td></tr>
                  ) : (
                    <tr key={i} className={l.t}>
                      <td className="ln">{l.o ?? ''}</td>
                      <td className="ln">{l.n ?? ''}</td>
                      <td className="src"><span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' '}</span>{l.text || ' '}</td>
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

export function FileViewer({ ws, path }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/api/workspaces/${ws.id}/file?path=${encodeURIComponent(path)}`).then(setFile, (e) => setError(e.message)); }, [ws.id, path]);
  if (error) return <div className="dv-empty">{error}</div>;
  if (!file) return <div className="dv-empty">Chargement…</div>;
  if (file.binary) return <div className="dv-binary"><LuFileCode size={32} /> Fichier binaire ({Math.round(file.size / 1024)} Ko)</div>;
  const lines = file.content.split('\n');
  return (
    <div className="dv">
      <div className="code-scroll">
        <table className="code viewer">
          <tbody>
            {lines.map((l, i) => <tr key={i}><td className="ln">{i + 1}</td><td className="src">{l || ' '}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
