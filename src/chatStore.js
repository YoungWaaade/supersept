// Live state of agent chats, fed by the /ws/events socket (see App.jsx).
import { useEffect, useState } from 'react';
import { api } from './api.js';

const chats = new Map(); // agent → { messages, busy, loaded }
const unread = new Map(); // agent → count of agent messages not seen yet
const subs = new Set();
let viewing = null; // agent whose chat is on screen

const emit = () => subs.forEach((f) => f());
const get = (agent) => {
  if (!chats.has(agent)) chats.set(agent, { messages: [], busy: false, loaded: false });
  return chats.get(agent);
};

export async function loadChat(agent) {
  const r = await api.get(`/api/agents/${agent}/chat`);
  chats.set(agent, { messages: r.messages, busy: r.busy, loaded: true });
  emit();
}

export function onChatEvent(m) {
  const c = get(m.agent);
  if (m.type === 'chat') {
    const i = c.messages.findIndex((x) => x.id === m.message.id);
    c.messages = i >= 0 ? c.messages.map((x, j) => (j === i ? m.message : x)) : [...c.messages, m.message];
    if (i < 0 && m.message.role === 'assistant' && viewing !== m.agent) unread.set(m.agent, (unread.get(m.agent) || 0) + 1);
  } else if (m.type === 'chat-busy') c.busy = m.busy;
  else if (m.type === 'chat-reset') { c.messages = []; c.busy = false; }
  emit();
}

export function setViewing(agent) {
  viewing = agent;
  if (agent) unread.delete(agent);
  emit();
}

export function useChat(agent) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (agent && !get(agent).loaded) loadChat(agent).catch(() => {});
    return () => subs.delete(f);
  }, [agent]);
  return agent ? get(agent) : null;
}

// For the sidebar: busy + unread per agent.
export function useChatBadges() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return { busy: (a) => !!chats.get(a)?.busy, unread: (a) => unread.get(a) || 0 };
}
