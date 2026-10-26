import { Fragment, useEffect, useRef, useState } from 'react';
import { LuArrowUp, LuSquare, LuRotateCcw, LuSettings2, LuFolder, LuFolderPlus, LuPlay, LuLayers, LuEye, LuSend, LuArchive, LuBrain, LuSearch, LuGlobe, LuWrench, LuCheck, LuX, LuLoaderCircle, LuMegaphone, LuUsers, LuBot } from 'react-icons/lu';
import { api } from '../api.js';
import { useChat, setViewing } from '../chatStore.js';
import BotAvatar from './BotAvatar.jsx';

const ICONS = { folder: LuFolder, 'folder-plus': LuFolderPlus, play: LuPlay, layers: LuLayers, eye: LuEye, send: LuSend, archive: LuArchive, brain: LuBrain, search: LuSearch, globe: LuGlobe, tool: LuWrench, users: LuUsers, bot: LuBot };
const SUGGESTIONS = [
  'Qu\'est-ce que tu peux faire pour moi ?',
  'Fais le point sur mes sessions en cours',
];

// Tiny markdown: paragraphs, lists, **bold**, *italic*, `code`, links.
function inline(text) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|https?:\/\/[^\s)]+)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) parts.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) { const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(t); parts.push(<a key={k++} href={href} target="_blank" rel="noreferrer">{label}</a>); }
    else if (t.startsWith('http')) parts.push(<a key={k++} href={t} target="_blank" rel="noreferrer">{t}</a>);
    else parts.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
function Markdown({ text }) {
  const blocks = text.split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>)}</ul>;
    }
    return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l.replace(/^#+\s*/, ''))}</Fragment>)}</p>;
  });
}

// "[Supersept] La session « X » (id …) vient de terminer. …" → "Session « X » terminée"
function systemLabel(text) {
  const reply = /^\[Supersept\] (.+?) a répondu/.exec(text || '');
  if (reply) return `${reply[1]} a répondu`;
  const m = /La session « (.+?) » \(id [^)]+\) (vient de terminer|attend une réponse)/.exec(text || '');
  if (!m) return text;
  return m[2] === 'vient de terminer' ? `Session « ${m[1]} » terminée` : `Session « ${m[1]} » attend une réponse`;
}

export default function AgentChat({ agent, go }) {
  const chat = useChat(agent.slug);
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const list = useRef(null);
  const input = useRef(null);

  useEffect(() => { setViewing(agent.slug); input.current?.focus(); return () => setViewing(null); }, [agent.slug]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [chat?.messages.length, chat?.busy]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }, [text]);

  const send = async (t = text) => {
    const v = t.trim();
    if (!v) return;
    setText('');
    setError(null);
    try { await api.post(`/api/agents/${agent.slug}/chat`, { text: v }); } catch (e) { setError(e.message); setText(v); }
  };
  const reset = async () => {
    if (!confirm(`Commencer une nouvelle conversation avec ${agent.label} ?\nIl oubliera cette discussion (les sessions qu'il a lancées restent dans tes projets).`)) return;
    await api.post(`/api/agents/${agent.slug}/chat/reset`);
  };

  const messages = chat?.messages || [];
  return (
    <div className="chat">
      <header className="chat-head">
        <BotAvatar spec={agent.avatar} seed={agent.slug} size={22} />
        <div className="chat-head-text">
          <span className="chat-name">{agent.label}</span>
          <span className="chat-status">{chat?.busy ? 'travaille…' : 'disponible'}</span>
        </div>
        <span className="flex-1" />
        <button className="btn-ghost" onClick={reset} title="Nouvelle conversation"><LuRotateCcw size={13} /> Nouvelle conversation</button>
        <button className="iconbtn size-7" title="Modifier l'agent" onClick={() => go({ kind: 'agents', id: agent.slug })}><LuSettings2 size={15} /></button>
      </header>

      <div className="chat-list" ref={list}>
        <div className="chat-column">
          {!messages.length && (
            <div className="chat-empty">
              <BotAvatar spec={agent.avatar} seed={agent.slug} size={88} className="chat-empty-bot" />
              <h2>Salut, moi c'est {agent.label}</h2>
              <p>{agent.description}</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
              </div>
            </div>
          )}
          {messages.map((m) => <Message key={m.id} m={m} agent={agent} go={go} />)}
          {chat?.busy && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="msg agent"><BotAvatar spec={agent.avatar} seed={agent.slug} size={24} className="msg-bot" /><div className="msg-typing"><span /><span /><span /></div></div>
          )}
        </div>
      </div>

      <div className="chat-composer">
        <div className="chat-column">
          {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}
          <div className="chat-input">
            <textarea ref={input} rows={1} value={text} placeholder={`Écris à ${agent.label}…`} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            {chat?.busy && !text ? (
              <button className="chat-send stop" title="Arrêter" onClick={() => api.post(`/api/agents/${agent.slug}/chat/stop`)}><LuSquare size={12} /></button>
            ) : (
              <button className="chat-send" title="Envoyer (↵)" disabled={!text.trim()} onClick={() => send()}><LuArrowUp size={14} /></button>
            )}
          </div>
          <div className="chat-hint">Le travail avance en arrière-plan dans tes projets, et tu es prévenu quand c'est fait.</div>
        </div>
      </div>
    </div>
  );
}

function Message({ m, agent, go }) {
  if (m.role === 'user') {
    return (
      <div className={`msg user ${m.meta?.from ? 'delegated' : ''}`}>
        {m.meta?.from && <span className="msg-from">de {m.meta.fromLabel}</span>}
        <div className="msg-bubble">{m.text}</div>
      </div>
    );
  }
  if (m.role === 'system') return <div className="msg-system"><LuMegaphone size={12} /> {systemLabel(m.text)}</div>;
  if (m.role === 'error') return <div className="msg-system error"><LuX size={12} /> {m.text}</div>;
  if (m.role === 'activity') {
    const Icon = ICONS[m.meta?.icon] || LuWrench;
    const st = m.meta?.status;
    const link = m.meta?.workspace ? () => go({ kind: 'ws', id: m.meta.workspace }) : m.meta?.agent ? () => go({ kind: 'agent', id: m.meta.agent }) : null;
    return (
      <div className={`msg-activity ${st} ${link ? 'link' : ''}`} onClick={link || undefined} title={link ? 'Ouvrir la session' : undefined}>
        <Icon size={12} /> <span>{m.text}</span>
        {st === 'running' ? <LuLoaderCircle size={11} className="spin" /> : st === 'error' ? <LuX size={11} /> : <LuCheck size={11} />}
      </div>
    );
  }
  return (
    <div className="msg agent">
      <BotAvatar spec={agent.avatar} seed={agent.slug} size={24} className="msg-bot" />
      <div className="msg-text"><Markdown text={m.text || ''} /></div>
    </div>
  );
}
