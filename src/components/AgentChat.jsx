import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LuArrowUp, LuSquare, LuSettings2, LuFolder, LuFolderPlus, LuPlay, LuLayers, LuEye, LuSend, LuArchive, LuBrain, LuSearch, LuGlobe, LuWrench, LuCheck, LuX, LuLoaderCircle, LuMegaphone, LuUsers, LuBot, LuHistory, LuChevronDown, LuPlus, LuMessageSquare, LuImagePlus, LuImage } from 'react-icons/lu';
import { api, ago, uploadFile, attachmentUrl, imageFiles } from '../api.js';
import { useChat, useConvs, loadConvs, setViewing, useChatBadges } from '../chatStore.js';
import BotAvatar from './BotAvatar.jsx';

const ICONS = { folder: LuFolder, 'folder-plus': LuFolderPlus, play: LuPlay, layers: LuLayers, eye: LuEye, send: LuSend, archive: LuArchive, brain: LuBrain, search: LuSearch, globe: LuGlobe, tool: LuWrench, users: LuUsers, bot: LuBot, image: LuImage };
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

const convTitle = (c) => c.title || (c.first ? c.first.replace(/\s+/g, ' ').slice(0, 60) : 'Nouvelle conversation');
const lastKey = (slug) => `supersept.conv.${slug}`;
// Where the user left a conversation they had scrolled up in (absent = stuck to the bottom).
const scrollPos = new Map();

export default function AgentChat({ agent, go }) {
  const { list, loaded } = useConvs(agent.slug);
  const badges = useChatBadges();
  // Open conversations are tabs, in the order they were started; the others stay in the history.
  const open = list.filter((c) => c.open).sort((a, b) => a.conversation - b.conversation);
  const [active, setActive] = useState(() => {
    const v = localStorage.getItem(lastKey(agent.slug));
    return v === null ? null : Number(v);
  });
  const chat = useChat(agent.slug, active);
  const drafts = useRef(new Map()); // conversation → unsent text
  const [text, setText] = useState('');
  const [images, setImages] = useState([]); // [{ path, name }]
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [histOpen, setHistOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const list_ = useRef(null);
  const input = useRef(null);
  const fileInput = useRef(null);

  // Keep the selected tab valid: fall back to the last active open conversation.
  useEffect(() => {
    if (!loaded) return;
    if (active !== null && open.some((c) => c.conversation === active)) return;
    const next = list.find((c) => c.open);
    setActive(next ? next.conversation : null);
  }, [loaded, list, active]);
  useEffect(() => {
    if (active !== null) localStorage.setItem(lastKey(agent.slug), String(active));
    setViewing(agent.slug, active);
    setText(drafts.current.get(active) || '');
    input.current?.focus();
  }, [agent.slug, active]);
  useEffect(() => () => setViewing(null), []);
  // A conversation opens on its last message, before the first paint: no visible scrolling. While the view
  // is stuck to the bottom, late content (messages loading, images) keeps it there; a scroll up unsticks it.
  const stick = useRef(true);
  const lastTop = useRef(0);
  const opened = useRef(0); // when the conversation was shown: content arriving soon after jumps, later it glides
  const convKey = `${agent.slug}:${active}`;
  const toBottom = (smooth) => {
    const el = list_.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    const el = list_.current;
    if (!el) return;
    const saved = scrollPos.get(convKey);
    stick.current = saved === undefined;
    opened.current = performance.now();
    if (stick.current) toBottom(false);
    else el.scrollTop = saved;
    lastTop.current = el.scrollTop;
    return () => { if (!stick.current) scrollPos.set(convKey, lastTop.current); else scrollPos.delete(convKey); };
  }, [convKey, chat?.loaded]);
  useLayoutEffect(() => {
    if (stick.current) toBottom(performance.now() - opened.current > 1500);
  }, [chat?.messages.length, chat?.busy]);
  useEffect(() => {
    const el = list_.current;
    const col = el?.firstElementChild;
    if (!col) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom) stick.current = true;
      else if (el.scrollTop < lastTop.current - 2) stick.current = false; // only the user scrolls up
      lastTop.current = el.scrollTop;
    };
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(performance.now() - opened.current > 1500); });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(col);
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, []);
  useEffect(() => {
    drafts.current.set(active, text);
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }, [text]);

  const select = async (c) => {
    setHistOpen(false);
    if (!c.open) { await api.patch(`/api/agents/${agent.slug}/conversations/${c.conversation}`, { open: true }); await loadConvs(agent.slug); }
    setActive(c.conversation);
  };
  const newConv = async () => {
    const r = await api.post(`/api/agents/${agent.slug}/conversations`);
    await loadConvs(agent.slug);
    setActive(r.conversation);
  };
  const closeConv = async (c) => {
    if (c.conversation === active) {
      const i = open.findIndex((x) => x.conversation === c.conversation);
      const next = open[i + 1] || open[i - 1];
      setActive(next ? next.conversation : null);
    }
    await api.patch(`/api/agents/${agent.slug}/conversations/${c.conversation}`, { open: false });
    loadConvs(agent.slug);
  };
  const rename = async (c, title) => {
    setRenaming(null);
    if (title.trim() !== convTitle(c)) await api.patch(`/api/agents/${agent.slug}/conversations/${c.conversation}`, { title });
  };

  const upload = async (files) => {
    const imgs = imageFiles(files).slice(0, 8 - images.length);
    if (!imgs.length) return false;
    setUploading(true);
    setError(null);
    try {
      for (const f of imgs) { const a = await uploadFile(f); setImages((l) => [...l, a]); }
    } catch (e) { setError(e.message); }
    setUploading(false);
    input.current?.focus();
    return true;
  };

  const send = async (t = text) => {
    const v = t.trim();
    if (!v && !images.length) return;
    const imgs = images;
    setText('');
    setImages([]);
    setError(null);
    try {
      const r = await api.post(`/api/agents/${agent.slug}/chat`, { text: v, conversation: active, images: imgs });
      if (r.conversation !== active) { await loadConvs(agent.slug); setActive(r.conversation); }
    } catch (e) { setError(e.message); setText(v); setImages(imgs); }
  };

  const messages = chat?.messages || [];
  return (
    <div className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDragging(false)}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}>
      <header className="chat-head">
        <BotAvatar spec={agent.avatar} seed={agent.slug} size={22} />
        <div className="chat-head-text">
          <span className="chat-name">{agent.label}</span>
          <span className="chat-status">{chat?.busy ? 'travaille…' : badges.busy(agent.slug) ? 'travaille dans une autre conversation…' : 'disponible'}</span>
        </div>
        <span className="flex-1" />
        <span className="menu-anchor">
          <button className="btn-ghost" onClick={() => setHistOpen((v) => !v)}><LuHistory size={13} /> Historique <LuChevronDown size={12} /></button>
          {histOpen && (
            <div className="popover chat-history-menu" onMouseLeave={() => setHistOpen(false)}>
              {list.map((c) => (
                <button key={c.conversation} className={`popover-item conv-item ${c.conversation === active ? 'checked' : ''}`} onClick={() => select(c)}>
                  <span className="conv-main">
                    <span className="fade-r">{convTitle(c)}</span>
                    <small>{new Date(c.started).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · {c.count} messages · {ago(c.last)}{c.open ? ' · ouverte' : ''}</small>
                  </span>
                </button>
              ))}
              {loaded && !list.length && <div className="empty-note">Aucune conversation pour l'instant.</div>}
            </div>
          )}
        </span>
        <button className="iconbtn size-7" title="Modifier l'agent" onClick={() => go({ kind: 'agents', id: agent.slug })}><LuSettings2 size={15} /></button>
      </header>

      <div className="tabbar chat-tabs">
        <div className="tabbar-scroll">
          <div className="tabbar-inner">
            {open.map((c) => {
              const busy = badges.busyConv(agent.slug, c.conversation);
              const unreadN = badges.unreadConv(agent.slug, c.conversation);
              return (
                <div className="tab-cell" key={c.conversation}>
                  <div className={`tab ${c.conversation === active ? 'active' : ''}`} onClick={() => setActive(c.conversation)} onDoubleClick={() => setRenaming(c.conversation)} title={`${convTitle(c)}\nDouble-clic pour renommer`}>
                    <div className="tab-title">
                      {busy ? <LuLoaderCircle size={12} className="spin chat-tab-busy" /> : <LuMessageSquare size={12} />}
                      {renaming === c.conversation ? (
                        <input className="chat-tab-rename" autoFocus defaultValue={convTitle(c)} onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => rename(c, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                      ) : <span className="tab-label fade-r">{convTitle(c)}</span>}
                      {unreadN > 0 && <span className="chat-tab-unread">{unreadN}</span>}
                    </div>
                    <div className="tab-close-slot">
                      <button className="tab-close" title="Fermer (elle reste dans l'historique)" onClick={(e) => { e.stopPropagation(); closeConv(c); }}><LuX size={14} /></button>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="tab-add-cell"><button className="tab-add" title="Nouvelle conversation" onClick={newConv}><LuPlus size={14} /></button></div>
            <div className="tab-filler" />
          </div>
        </div>
      </div>

      <div className="chat-list" ref={list_}>
        <div className="chat-column">
          {!messages.length && chat?.loaded !== false && (
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
            {(images.length > 0 || uploading) && (
              <div className="chat-thumbs">
                {images.map((a) => (
                  <span key={a.path} className="chat-thumb">
                    <img src={attachmentUrl(a.path)} alt={a.name} />
                    <button type="button" title="Retirer" onClick={() => setImages((l) => l.filter((x) => x !== a))}><LuX size={10} /></button>
                  </span>
                ))}
                {uploading && <span className="chat-thumb loading"><LuLoaderCircle size={14} className="spin" /></span>}
              </div>
            )}
            <div className="chat-input-row">
              <button className="chat-attach" title="Ajouter une image (ou colle-la, ou glisse-la ici)" onClick={() => fileInput.current.click()}><LuImagePlus size={16} /></button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
              <textarea ref={input} rows={1} value={text} placeholder={`Écris à ${agent.label}…`} onChange={(e) => setText(e.target.value)}
                onPaste={(e) => { if (imageFiles(e.clipboardData.files).length) { e.preventDefault(); upload(e.clipboardData.files); } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              {chat?.busy && !text && !images.length ? (
                <button className="chat-send stop" title="Arrêter" onClick={() => api.post(`/api/agents/${agent.slug}/chat/stop`, { conversation: active })}><LuSquare size={12} /></button>
              ) : (
                <button className="chat-send" title="Envoyer (↵)" disabled={(!text.trim() && !images.length) || uploading} onClick={() => send()}><LuArrowUp size={14} /></button>
              )}
            </div>
          </div>
          <div className="chat-hint">Le travail avance en arrière-plan dans tes projets, et tu es prévenu quand c'est fait.</div>
        </div>
      </div>
      {dragging && <div className="chat-drop">Dépose ton image pour l'envoyer à {agent.label}</div>}
    </div>
  );
}

function Message({ m, agent, go }) {
  if (m.role === 'user') {
    return (
      <div className={`msg user ${m.meta?.from ? 'delegated' : ''}`}>
        {m.meta?.from && <span className="msg-from">de {m.meta.fromLabel}</span>}
        {m.meta?.images?.length > 0 && (
          <div className="msg-images">
            {m.meta.images.map((i) => <a key={i.path} href={attachmentUrl(i.path)} target="_blank" rel="noreferrer"><img src={attachmentUrl(i.path)} alt={i.name} /></a>)}
          </div>
        )}
        {m.text && <div className="msg-bubble">{m.text}</div>}
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
