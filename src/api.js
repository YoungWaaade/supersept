async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b || {}),
  put: (u, b) => req('PUT', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};

export const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}j`;
}

export const STATUS = {
  working: { label: 'En cours', color: 'var(--blue)' },
  waiting: { label: 'Attend ton input', color: 'var(--orange)' },
  review: { label: 'À revoir', color: 'var(--green)' },
  idle: { label: 'Inactif', color: 'var(--muted)' },
  done: { label: 'Terminé', color: 'var(--dim)' },
};
