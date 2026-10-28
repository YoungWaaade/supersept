// Live state of agent chats, fed by the /ws/events socket (see App.jsx).
// An agent has several conversations, open side by side; each one has its messages and busy state.
import { useEffect, useState } from 'react';
import { api } from './api.js';

const chats = new Map(); // "agent:conversation" → { messages, busy, loaded }
const convs = new Map(); // agent → { list, loaded }
const unread = new Map(); // "agent:conversation" → count of agent messages not seen yet
const subs = new Set();
let viewing = null; // "agent:conversation" on screen

const k = (agent, conv) => `${agent}:${conv}`;
const emit = () => subs.forEach((f) => f());
const get = (agent, conv) => {
  if (!chats.has(k(agent, conv))) chats.set(k(agent, conv), { messages: [], busy: false, loaded: false });
  return chats.get(k(agent, conv));
};

export async function loadChat(agent, conv) {
  const r = await api.get(`/api/agents/${agent}/chat?conversation=${conv}`);
  chats.set(k(agent, conv), { messages: r.messages, busy: r.busy, loaded: true });
  emit();
}
export async function loadConvs(agent) {
  const list = await api.get(`/api/agents/${agent}/conversations`);
  convs.set(agent, { list, loaded: true });
  for (const c of list) if (c.busy) get(agent, c.conversation).busy = true;
  emit();
}

export function onChatEvent(m) {
  if (m.type === 'chat-convs' || m.type === 'chat-reset') {
    if (convs.has(m.agent)) loadConvs(m.agent).catch(() => {});
    return;
  }
  const conv = m.conversation ?? m.message?.conversation ?? 0;
  const c = get(m.agent, conv);
  if (m.type === 'chat') {
    const i = c.messages.findIndex((x) => x.id === m.message.id);
    c.messages = i >= 0 ? c.messages.map((x, j) => (j === i ? m.message : x)) : [...c.messages, m.message];
    if (i < 0 && m.message.role === 'assistant' && viewing !== k(m.agent, conv)) unread.set(k(m.agent, conv), (unread.get(k(m.agent, conv)) || 0) + 1);
    // A message in a conversation we don't list yet (new mission, reopened): refresh the tabs.
    const list = convs.get(m.agent)?.list;
    if (list && !list.some((x) => x.conversation === conv && x.open)) loadConvs(m.agent).catch(() => {});
  } else if (m.type === 'chat-busy') c.busy = m.busy;
  emit();
}

export function setViewing(agent, conv = null) {
  viewing = agent && conv !== null ? k(agent, conv) : null;
  if (viewing) unread.delete(viewing);
  emit();
}

const useTick = () => {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
};

export function useChat(agent, conv) {
  useTick();
  useEffect(() => {
    if (agent && conv !== null && conv !== undefined && !get(agent, conv).loaded) loadChat(agent, conv).catch(() => {});
  }, [agent, conv]);
  return agent && conv !== null && conv !== undefined ? get(agent, conv) : null;
}

export function useConvs(agent) {
  useTick();
  useEffect(() => { if (agent) loadConvs(agent).catch(() => {}); }, [agent]);
  return convs.get(agent) || { list: [], loaded: false };
}

const sum = (agent, f) => [...chats.keys()].filter((x) => x.startsWith(`${agent}:`)).reduce((n, x) => n + f(x), 0);
// For the sidebar and the tabs: busy + unread per agent, and per conversation.
export function useChatBadges() {
  useTick();
  return {
    busy: (a) => sum(a, (x) => (chats.get(x).busy ? 1 : 0)) > 0,
    unread: (a) => [...unread].filter(([x]) => x.startsWith(`${a}:`)).reduce((n, [, v]) => n + v, 0),
    busyConv: (a, c) => !!chats.get(k(a, c))?.busy,
    unreadConv: (a, c) => unread.get(k(a, c)) || 0,
  };
}
