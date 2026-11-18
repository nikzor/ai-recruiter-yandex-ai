import { WebSocketServer, WebSocket } from 'ws';
import { recognitionOptions, recognitionError } from './stt.mjs';

export function attachRecognition(server, { sessions, recognition, maxDurationMs = 120000, idleMs = 15000, finalWaitMs = 12000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6400, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/speech/realtime') return;
    if (url.pathname !== '/api/speech/recognize') return reject('404 Not Found');
    // Browser WebSockets always send Origin. Never allow an arbitrary site to spend this key.
    if (![ `http://${req.headers.host}`, 'http://127.0.0.1:5173' ].includes(req.headers.origin)) return reject('403 Forbidden');
    if (!recognition?.enabled) return reject('503 Service Unavailable');
    const s = sessions.get(url.searchParams.get('sessionId'));
    if (!s || Date.now() - s.updated > 2 * 60 * 60 * 1000) return reject('404 Not Found');
    if (s.status !== 'active' || s.busy || s.sttBusy || s.speechBusy || s.realtimeBusy || url.searchParams.get('revision') !== String(s.revision)) return reject('409 Conflict');
    s.sttBusy = true;
    socket.once('close', () => { if (s.sttBusy === true) s.sttBusy = false; });
    try { wss.handleUpgrade(req, socket, head, ws => connect(ws, s)); }
    catch { s.sttBusy = false; socket.destroy(); }
  });
  server.once('close', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });

  function connect(ws, session) {
    session.sttBusy = ws;
    let call;
    let ended = false;
    let finishing = false;
    let bytes = 0;
    let timer;
    let idle;
    let closeTimer;
    let fallbackIndex = 0;
    let blocked = false;
    let inputEnded = false;
    let queuedBytes = 0;
    const queue = [];
    let partial = '';
    const finals = new Map();
    const started = Date.now();
    const text = () => [...finals.values()].join(' ').trim();
    const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    function cleanup() {
      clearTimeout(timer); clearTimeout(idle);
      if (session.sttBusy === ws) session.sttBusy = false;
    }
    function close() {
      ws.close();
      closeTimer = setTimeout(() => ws.terminate(), 1000);
      closeTimer.unref();
    }
    function fail(message) {
      if (ended) return;
      ended = true;
      send({ type: 'error', message, text: text(), partial });
      cleanup();
      call?.cancel();
      close();
    }
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail('Аудио перестало поступать. Проверьте микрофон и попробуйте снова.'), idleMs);
    };
    ws.on('error', () => fail('Соединение с микрофоном прервалось.'));
    ws.on('close', () => { ended = true; cleanup(); clearTimeout(closeTimer); call?.cancel(); });
    try {
      call = recognition.open();
      call.on('error', error => fail(recognitionError(error)));
      call.on('data', response => {
        if (ended) return;
        if (response.partial) partial = response.partial.alternatives?.[0]?.text || '';
        else if (response.final) {
          const index = String(response.audioCursors?.finalIndex ?? fallbackIndex++);
          finals.set(index, response.final.alternatives?.[0]?.text || '');
          partial = '';
        } else if (response.finalRefinement?.normalizedText) {
          finals.set(String(response.finalRefinement.finalIndex), response.finalRefinement.normalizedText.alternatives?.[0]?.text || '');
        } else return;
        if (text().length + partial.length > 4000) return fail('Ответ достиг лимита 4000 символов. Завершите его текстом.');
        send({ type: 'transcript', text: text(), partial });
      });
      call.on('end', () => {
        if (ended) return;
        ended = true;
        send({ type: 'done', text: text(), partial });
        cleanup(); close();
      });
      call.write({ sessionOptions: recognitionOptions });
      send({ type: 'ready', sampleRate: 16000, maxDurationSeconds: maxDurationMs / 1000 });
      timer = setTimeout(() => finish(), maxDurationMs);
      resetIdle();
    } catch { return fail('Не удалось подключиться к SpeechKit. Попробуйте снова или продолжайте текстом.'); }

    function finish() {
      if (finishing || ended) return;
      finishing = true;
      clearTimeout(timer); clearTimeout(idle);
      send({ type: 'finishing' });
      timer = setTimeout(() => fail('SpeechKit не завершил расшифровку вовремя. Полученный текст сохранён в черновике.'), finalWaitMs);
      flush();
    }
    function flush() {
      while (!ended && !blocked && queue.length) {
        const data = queue.shift();
        queuedBytes -= data.length;
        if (!call.write({ chunk: { data } })) {
          blocked = true;
          ws.pause();
          call.once('drain', () => { blocked = false; if (!ended) { flush(); if (!blocked) ws.resume(); } });
        }
      }
      if (finishing && !ended && !blocked && !queue.length && !inputEnded) { inputEnded = true; call.end(); }
    }
    ws.on('message', (data, isBinary) => {
      if (ended || finishing) return;
      if (!isBinary) {
        try { if (JSON.parse(data.toString()).type === 'finish') return finish(); } catch { /* Invalid controls close the stream. */ }
        return fail('Неизвестная команда распознавания.');
      }
      if (!data.length || data.length % 2) return fail('Некорректный формат аудио. Используйте текстовый режим.');
      bytes += data.length;
      if (bytes > 16000 * 2 * 120 || bytes > (Date.now() - started + 2000) * 32) return fail('Превышен лимит аудиопотока. Попробуйте снова.');
      resetIdle();
      // pause() cannot retract frames already decoded from the same TCP packet.
      // Keep that remainder bounded and only write it after gRPC's drain event.
      queuedBytes += data.length;
      if (queuedBytes > 64000) return fail('Соединение с распознаванием перегружено. Полученный текст сохранён.');
      queue.push(data);
      flush();
    });
  }
  return wss;
}
