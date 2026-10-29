import { useEffect, useMemo, useRef, useState } from 'react';
import { LuRefreshCw, LuLoaderCircle } from 'react-icons/lu';
import { api, ago } from '../api.js';

const RANGES = [['7', '7 j'], ['30', '30 j'], ['90', '90 j'], ['all', 'Depuis le début']];
const GROUPS = [['session', 'Session'], ['agent', 'Agent'], ['project', 'Projet']];
const TOP = 8;

const num = (n, d = 2) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtTokens = (n) => (n >= 1e9 ? `${num(n / 1e9)} Md` : n >= 1e6 ? `${num(n / 1e6)} M` : n >= 1e3 ? `${num(n / 1e3)} k` : String(Math.round(n)));
export const fmtCost = (n) => `${num(n, n >= 1000 ? 0 : 2)} $`;
const fmtDay = (day, withYear) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
const pct = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)} %` : '–');

// Token usage of Supersept's sessions, from the local transcripts, priced at the public API rates.
export function UsageSection() {
  const [range, setRange] = useState('30');
  const [mode, setMode] = useState('cost');
  const [group, setGroup] = useState('session');
  const [all, setAll] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async (refresh = false) => {
    setBusy(true);
    try {
      setData(await api.get(`/api/usage?range=${range}${refresh ? '&refresh=1' : ''}`));
      setError(null);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  useEffect(() => { load(); }, [range]);

  const value = (x) => (mode === 'cost' ? x.cost : x.tokens);
  const fmt = mode === 'cost' ? fmtCost : fmtTokens;

  if (!data) return <p className="empty-note">{error ? `Lecture impossible : ${error}` : 'Lecture des journaux de session…'}</p>;
  const t = data.totals;
  const inputAll = t.input + t.cacheWrite + t.cacheRead;
  const rows = data.groups[group];
  const shown = all ? rows : rows.slice(0, TOP);
  const max = Math.max(...rows.map(value), 0);
  const unknown = data.models.filter((m) => !m.priced);

  return (
    <div className="usage">
      <div className="usage-head">
        <div>
          <h2>Utilisation de tokens</h2>
          <p className="usage-sub">
            {fmtDay(data.daily[0].day, true)} – {fmtDay(data.daily[data.daily.length - 1].day, true)} · estimation au tarif API à partir des journaux de session locaux
          </p>
        </div>
        <div className="usage-controls">
          <div className="wsp-segmented">
            <button className={mode === 'cost' ? 'on' : ''} onClick={() => setMode('cost')}>Coût</button>
            <button className={mode === 'tokens' ? 'on' : ''} onClick={() => setMode('tokens')}>Tokens</button>
          </div>
          <div className="wsp-segmented">
            {RANGES.map(([k, label]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{label}</button>)}
          </div>
          <button className="iconbtn size-7" title={`Relire les journaux (lus il y a ${ago(data.scannedAt)})`} disabled={busy} onClick={() => load(true)}>
            {busy ? <LuLoaderCircle size={14} className="spin" /> : <LuRefreshCw size={14} />}
          </button>
        </div>
      </div>

      <div className="usage-hero">
        <div className="usage-total">
          {mode === 'cost' ? (
            <>
              <strong>{fmtCost(t.cost)}*</strong>
              <span className="usage-note">* si facturé au tarif API plein</span>
            </>
          ) : (
            <>
              <strong>{fmtTokens(t.tokens)}</strong>
              <span className="usage-note">tokens traités</span>
            </>
          )}
          <span className="usage-note">{data.sessions} session{data.sessions > 1 ? 's' : ''} Supersept, sous-agents compris</span>
          {t.unpriced > 0 && <span className="usage-note warn">{fmtTokens(t.unpriced)} tokens au tarif inconnu, non comptés dans le coût</span>}
        </div>
        <UsageChart daily={data.daily} value={value} fmt={fmt} axis={mode === 'cost' ? (v) => `${num(v, v && v < 10 ? 2 : 0)} $` : (v) => fmtTokens(v).replace(/,00(?= )/, '')} />
      </div>

      <div className="usage-stats">
        <Stat label="Tokens traités" value={fmtTokens(t.tokens)} />
        <Stat label="Entrée mise en cache" value={`${fmtTokens(t.cacheRead)} · ${pct(t.cacheRead, inputAll)}`} title="Lue depuis le cache (cache read)" />
        <Stat label="Entrée non mise en cache" value={fmtTokens(t.input + t.cacheWrite)} title={`${fmtTokens(t.input)} d'entrée simple + ${fmtTokens(t.cacheWrite)} écrits en cache`} />
        <Stat label="Sortie" value={fmtTokens(t.output)} />
        <Stat label="Économies de cache" value={`${fmtCost(Math.max(0, t.savings))} · ${t.cost > 0 ? `${num(t.uncached / t.cost, 1)}x` : '–'}`} title={`Sans cache, la même entrée aurait coûté ${fmtCost(t.uncached)} : ${t.cost > 0 ? num(t.uncached / t.cost, 1) : '–'} fois plus`} />
      </div>

      <div className="usage-tables">
        <table className="usage-table">
          <thead><tr><th>Modèle</th><th>Coût</th><th>Part</th><th>Tokens</th></tr></thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.key}>
                <td><span className="usage-dot" />{m.name}</td>
                <td>{m.priced ? fmtCost(m.cost) : <span className="tag">tarif inconnu</span>}</td>
                <td>{pct(value(m), value(t))}</td>
                <td>{fmtTokens(m.tokens)}</td>
              </tr>
            ))}
            {!data.models.length && <tr><td colSpan={4} className="muted">Aucune utilisation sur cette période.</td></tr>}
          </tbody>
          <tfoot><tr><td>Total</td><td>{fmtCost(t.cost)}</td><td>{data.models.length ? '100 %' : '–'}</td><td>{fmtTokens(t.tokens)}</td></tr></tfoot>
        </table>

        <div className="usage-table usage-groups">
          <div className="usage-groups-head">
            <div className="wsp-segmented">
              {GROUPS.map(([k, label]) => <button key={k} className={group === k ? 'on' : ''} onClick={() => { setGroup(k); setAll(false); }}>{label}</button>)}
            </div>
            <span className="usage-cols"><span>Tokens</span><span>Coût</span></span>
          </div>
          {shown.map((g) => (
            <div key={g.key} className="usage-row" title={g.name}>
              <span className="usage-name fade-r">{g.name}</span>
              <span>{fmtTokens(g.tokens)}</span>
              <span>{fmtCost(g.cost)}{g.unpriced > 0 ? '*' : ''}</span>
              <i style={{ width: `${max > 0 ? (value(g) / max) * 100 : 0}%` }} />
            </div>
          ))}
          {!rows.length && <p className="muted usage-empty">Aucune utilisation sur cette période.</p>}
          {rows.length > TOP && (
            <button className="btn-ghost usage-more" onClick={() => setAll(!all)}>{all ? 'Réduire' : `Tout afficher (${rows.length})`}</button>
          )}
        </div>
      </div>
      {unknown.length > 0 && <p className="usage-foot">Tarif inconnu pour {unknown.map((m) => m.key).join(', ')} : ajoute-le dans ~/.claude-hub/pricing.json.</p>}
    </div>
  );
}

function Stat({ label, value, title }) {
  return (
    <div className="usage-stat" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// Daily area chart; the hovered day shows its value.
function UsageChart({ daily, value, fmt, axis }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const H = 170, L = 64, B = 22, T = 8;
  const values = daily.map(value);
  const top = useMemo(() => niceMax(Math.max(...values, 0)), [values.join(',')]);
  const x = (i) => L + (daily.length === 1 ? (W - L) / 2 : (i * (W - L - 4)) / (daily.length - 1));
  const y = (v) => T + (H - T - B) * (1 - (top ? v / top : 0));
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1)},${H - B} L${x(0)},${H - B} Z`;
  const ticks = [0, top / 2, top];
  const labels = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - L) / (W - L - 4)) * (daily.length - 1));
    setHover(i >= 0 && i < daily.length ? i : null);
  };
  return (
    <div className="usage-chart" ref={ref}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W} y1={y(v)} y2={y(v)} className="usage-grid" />
          <text x={L - 8} y={y(v) + 3.5} textAnchor="end">{axis(v)}</text>
        </g>
      ))}
      {labels.map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}>{fmtDay(daily[i].day)}</text>)}
      <path d={area} className="usage-area" />
      <path d={line} className="usage-line" />
      {hover != null && (
        <g>
          <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="usage-grid" />
          <circle cx={x(hover)} cy={y(values[hover])} r="3" className="usage-point" />
          <text x={Math.min(Math.max(x(hover), L + 50), W - 50)} y={T + 10} textAnchor="middle" className="usage-tip">{fmtDay(daily[hover].day)} · {fmt(values[hover])}</text>
        </g>
      )}
    </svg>
    </div>
  );
}

// 1, 2, 2.5 or 5 × a power of ten, just above the highest value.
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
