import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { OMsg } from './ollama';

/** The messages of the chat that is currently open. */
export const history: OMsg[] = [];

export interface SessionMeta { id: string; title: string; updated: number; archived?: boolean; pinned?: boolean; }
export interface ChatIndex { active: string; sessions: SessionMeta[]; }

export function chatKey(root: string) {
  return crypto.createHash('sha1').update(process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).digest('hex').slice(0, 16);
}
export function chatRoot(root: string) { return path.join(app.getPath('userData'), 'chat', chatKey(root)); }
export function chatIndexFile(root: string) { return path.join(chatRoot(root), 'index.json'); }
export function sessionFile(root: string, id: string) { return path.join(chatRoot(root), 'sessions', `${id}.json`); }
export function readChatIndex(root: string): ChatIndex {
  try {
    const p = JSON.parse(fs.readFileSync(chatIndexFile(root), 'utf8'));
    if (p && Array.isArray(p.sessions) && typeof p.active === 'string') return p as ChatIndex;
  } catch { /* fall through */ }
  return { active: '', sessions: [] };
}
export function writeChatIndex(root: string, index: ChatIndex) {
  try {
    const dir = path.dirname(chatIndexFile(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chatIndexFile(root), JSON.stringify(index, null, 2));
  } catch { /* ignore */ }
}
export function slugTitle(text: string) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : 'New chat';
}
export function loadSessionMessages(root: string, id: string): OMsg[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(root, id), 'utf8'));
    const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return msgs.filter((m: any) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m: any) => ({ role: m.role, content: m.content }));
  } catch {
    return [];
  }
}
export function saveSessionMessages(root: string, id: string, messages: OMsg[]) {
  try {
    const dir = path.dirname(sessionFile(root, id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionFile(root, id), JSON.stringify({ messages }, null, 2));
  } catch { /* ignore */ }
}
export function ensureChatSession(root: string): ChatIndex {
  const index = readChatIndex(root);
  if (index.sessions.length) return index;
  // Migrate the old single history.json if present.
  const oldPath = path.join(chatRoot(root), 'history.json');
  let msgs: OMsg[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch { msgs = []; }
  const id = crypto.randomUUID();
  const firstUser = msgs.find((m) => m.role === 'user');
  const meta: SessionMeta = { id, title: firstUser ? slugTitle((firstUser as any).content) : 'New chat', updated: Date.now() };
  writeChatIndex(root, { active: id, sessions: [meta] });
  saveSessionMessages(root, id, msgs);
  try { fs.rmSync(oldPath, { force: true }); } catch { /* ignore */ }
  return { active: id, sessions: [meta] };
}
export function loadActiveChat(root: string) {
  const index = ensureChatSession(root);
  history.length = 0;
  const active = index.sessions.find((s) => s.id === index.active) ? index.active : (index.sessions[0]?.id ?? '');
  if (active) {
    const msgs = loadSessionMessages(root, active);
    for (const m of msgs) history.push(m);
    if (index.active !== active) {
      index.active = active;
      writeChatIndex(root, index);
    }
  }
}
export function saveActiveChat(root: string) {
  const index = readChatIndex(root);
  if (!index.active) return;
  saveSessionMessages(root, index.active, history);
  const meta = index.sessions.find((s) => s.id === index.active);
  if (meta) { meta.updated = Date.now(); if (!meta.title || meta.title === 'New chat') { const u = history.find((m) => m.role === 'user'); if (u) meta.title = slugTitle(u.content); } }
  writeChatIndex(root, index);
}
export function createChatSession(root: string, title = 'New chat'): { id: string } {
  const index = readChatIndex(root);
  const id = crypto.randomUUID();
  index.sessions.push({ id, title, updated: Date.now() });
  index.active = id;
  writeChatIndex(root, index);
  saveSessionMessages(root, id, []);
  history.length = 0;
  return { id };
}
export function deleteChatSession(root: string, id: string) {
  const index = readChatIndex(root);
  index.sessions = index.sessions.filter((s) => s.id !== id);
  try { fs.rmSync(sessionFile(root, id), { force: true }); } catch { /* ignore */ }
  if (index.active === id) {
    index.active = index.sessions[0]?.id ?? '';
    history.length = 0;
    if (index.active) {
      const msgs = loadSessionMessages(root, index.active);
      for (const m of msgs) history.push(m);
    } else {
      const c = createChatSession(root, 'New chat');
      index.active = c.id;
    }
  }
  writeChatIndex(root, index);
}
export function renameChatSession(root: string, id: string, title: string) {
  const index = readChatIndex(root);
  const meta = index.sessions.find((s) => s.id === id);
  if (meta && title.trim()) meta.title = title.trim().slice(0, 80);
  writeChatIndex(root, index);
}
export function updateChatSession(root: string, id: string, patch: { pinned?: boolean; archived?: boolean; title?: string }) {
  const index = readChatIndex(root);
  const meta = index.sessions.find((s) => s.id === id);
  if (!meta) return;
  if (typeof patch?.pinned === 'boolean') meta.pinned = patch.pinned;
  if (typeof patch?.archived === 'boolean') meta.archived = patch.archived;
  if (typeof patch?.title === 'string' && patch.title.trim()) meta.title = patch.title.trim().slice(0, 80);
  writeChatIndex(root, index);
}
