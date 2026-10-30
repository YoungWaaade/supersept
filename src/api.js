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
  working: { label: 'En cours', color: 'var(--amber-500)' },
  waiting: { label: 'Attend ton input', color: 'var(--yellow-500)' },
  review: { label: 'À revoir', color: 'var(--green-500)' },
  error: { label: 'Erreur', color: 'var(--red-500)' },
  idle: { label: 'Inactif', color: 'var(--muted-foreground)' },
  done: { label: 'Terminé', color: 'var(--dim)' },
};

// Upload a file to ~/.claude-hub/attachments; returns { path, name, size }.
export async function uploadFile(f) {
  if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name || 'Le fichier'} dépasse 10 Mo`);
  const name = f.name || `image-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const res = await fetch(`/api/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "l'envoi du fichier a échoué");
  return data;
}
// …/attachments/<id>/<name> → the URL serving it.
export const attachmentUrl = (p) => {
  const [id, name] = String(p).split('/').slice(-2);
  return `/api/attachments/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
};
export const imageFiles = (list) => [...(list || [])].filter((f) => f.type?.startsWith('image/'));
