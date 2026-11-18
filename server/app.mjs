import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { AppError } from './provider.mjs';
import { levels } from './questions.mjs';
import { attachRecognition } from './stt-socket.mjs';
import { attachRealtime } from './realtime-socket.mjs';
const MAX_BODY = 24000;
const TTL = 2 * 60 * 60 * 1000;
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'Ожидается JSON.');
  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError(413, 'Запрос слишком большой.');
    raw += chunk;
  }
  try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new AppError(400, 'Некорректный JSON.'); }
}
export function createApp(provider, { dist = resolve('dist'), speech, recognition, recognitionLimits, realtime, realtimeLimits } = {}) {
  const sessions = new Map();
  const publicSession = s => ({ id: s.id, level: s.level, mode: provider.mode, interactionMode: s.interactionMode, total: 5, revision: s.revision, status: s.status, turns: s.turns, report: s.report });
  const server = createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        // No cross-origin access to this local, unauthenticated teaching server.
        const allowedOrigins = [`http://${req.headers.host}`, 'http://127.0.0.1:5173'];
        if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) throw new AppError(403, 'Запрос с другого сайта запрещён.');
        for (const [id, s] of sessions) if (!s.busy && !s.speechBusy && !s.sttBusy && !s.realtimeBusy && Date.now() - s.updated > TTL) sessions.delete(id);
        if (req.method === 'GET' && path === '/api/health') return json(200, { mode: provider.mode, ready: true, speech: { enabled: Boolean(speech?.enabled), recognitionEnabled: Boolean(recognition?.enabled), realtimeEnabled: Boolean(realtime?.enabled) } });
        if (req.method === 'POST' && path === '/api/speech/synthesize') {
          const input = await body(req);
          const s = sessions.get(input.sessionId);
          if (!s) throw new AppError(404, 'Сессия истекла. Начните новое интервью.');
          if (!Number.isInteger(input.questionNumber) || input.questionNumber < 1 || input.questionNumber > s.turns.length) throw new AppError(400, 'Выберите существующий вопрос.');
          if (!speech?.enabled) throw new AppError(503, 'Озвучивание SpeechKit выключено. Продолжайте текстом.');
          if (s.speechBusy || s.sttBusy || s.realtimeBusy) throw new AppError(409, 'Завершите текущий голосовой запрос.');
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          s.speechBusy = true;
          res.once('close', cancel);
          try {
            const audio = await speech.synthesize(s.turns[input.questionNumber - 1].question, { signal: controller.signal });
            if (res.destroyed) return;
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(audio);
          } finally {
            s.speechBusy = false;
            res.off('close', cancel);
          }
        }
        if (req.method === 'POST' && path === '/api/sessions') {
          const input = await body(req);
          if (!levels.includes(input.level)) throw new AppError(400, 'Выберите Intern, Junior, Middle или Senior.');
          if (input.interactionMode !== undefined && !['voice', 'text', 'realtime'].includes(input.interactionMode)) throw new AppError(400, 'Выберите голосовой, текстовый режим или Realtime.');
          if (sessions.size >= 100) throw new AppError(429, 'Слишком много сессий. Перезапустите локальный сервер.');
          const s = { id: randomUUID(), level: input.level, interactionMode: input.interactionMode || 'text', turns: [], status: 'active', revision: 0, report: null, updated: Date.now(), busy: true };
          sessions.set(s.id, s);
          try { s.turns.push({ question: await provider.question(s), answer: null }); }
          catch (error) { sessions.delete(s.id); throw error; }
          finally { s.busy = false; }
          return json(201, publicSession(s));
        }
        const match = path.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(answers|report|finish))?$/);
        if (!match) throw new AppError(404, 'Маршрут не найден.');
        const s = sessions.get(match[1]);
        if (!s) throw new AppError(404, 'Сессия истекла или сервер перезапущен. Начните новое интервью.');
        if (req.method === 'GET' && !match[2]) return json(200, publicSession(s));
        if (req.method === 'DELETE' && !match[2]) {
          if (s.busy || s.sttBusy || s.realtimeBusy) throw new AppError(409, 'Завершите текущий запрос или голосовой ответ.');
          sessions.delete(s.id); return json(200, { deleted: true });
        }
        if (req.method !== 'POST' || !match[2]) throw new AppError(405, 'Метод не поддерживается.');
        const input = await body(req);
        if (s.busy || s.sttBusy || s.realtimeBusy) throw new AppError(409, 'Завершите текущий запрос или голосовой ответ.');
        if (match[2] === 'finish' && s.status === 'completed') return json(200, publicSession(s));
        if (match[2] === 'report' && s.report) return json(200, publicSession(s));
        if (input.revision !== s.revision) throw new AppError(409, 'Состояние изменилось. Обновите сессию перед повтором.');
        s.busy = true;
        try {
          if (match[2] === 'finish') {
            if (s.interactionMode !== 'realtime') throw new AppError(400, 'Этот маршрут завершает Realtime-интервью.');
            if (s.realtimeDraft?.trim() && s.turns.at(-1)) {
              const turn = s.turns.at(-1);
              const draft = s.realtimeDraft.trim();
              const followup = turn.followUps?.at(-1);
              if (followup?.answer === null) followup.answer = draft;
              turn.answer = [turn.answer, followup ? `Уточнение: ${draft}` : draft].filter(Boolean).join('\n').slice(0, 4000);
              s.realtimeDraft = '';
            }
            s.turns = s.turns.filter(turn => turn.answer?.trim());
            s.status = s.turns.length ? 'ready' : 'completed';
            // Preserve the completed portion even if report generation fails.
            s.revision++;
            s.updated = Date.now();
            if (s.turns.length) { s.report = await provider.report(s); s.status = 'completed'; }
            return json(200, publicSession(s));
          } else if (match[2] === 'answers') {
            if (s.status !== 'active') throw new AppError(409, 'Все ответы уже получены.');
            if (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 4000) throw new AppError(400, 'Ответ должен содержать от 1 до 4000 символов.');
            // Commit only after generation succeeds: failures leave the current answer editable.
            const draft = { ...s, turns: s.turns.map(t => ({ ...t })) };
            draft.turns.at(-1).answer = input.answer.trim();
            if (draft.turns.length < 5) draft.turns.push({ question: await provider.question(draft), answer: null });
            else draft.status = 'ready';
            s.turns = draft.turns;
            s.status = draft.status;
          } else {
            if (s.status !== 'ready') throw new AppError(409, 'Сначала ответьте на все пять вопросов.');
            s.report = await provider.report(s);
            s.status = 'completed';
          }
          s.revision++;
          s.updated = Date.now();
          return json(200, publicSession(s));
        } finally { s.busy = false; }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'Метод не поддерживается.');
      const filename = resolve(dist, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!filename.startsWith(dist + sep)) throw new AppError(403, 'Доступ запрещён.');
      let file;
      try { file = await readFile(filename); } catch { throw new AppError(404, 'Файл не найден. Выполните npm run build или используйте npm run dev.'); }
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[extname(filename)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) { if (res.destroyed) return; if (!res.headersSent) json(error.status || 500, { error: error instanceof AppError ? error.message : 'Внутренняя ошибка сервера.' }); else res.end(); }
  });
  attachRecognition(server, { sessions, recognition, ...recognitionLimits });
  attachRealtime(server, { sessions, realtime, speech, provider, publicSession, ...realtimeLimits });
  return server;
}
