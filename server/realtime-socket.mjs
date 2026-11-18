import { WebSocketServer, WebSocket } from 'ws';
import { createPcmResampler, realtimeSession, REALTIME_SAMPLE_RATE } from './realtime.mjs';

export function attachRealtime(server, { sessions, realtime, speech, provider, publicSession = ({ id, level, status, revision, turns, report }) => ({ id, level, status, revision, turns, report }), maxDurationMs = 600000, finalWaitMs = 12000, handshakeMs = 18000 }) {
  const fastSpeech = realtime?.speechMode === 'speechkit' && speech?.enabled;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6400, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/speech/realtime') return;
    const reject = code => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (![ `http://${req.headers.host}`, 'http://127.0.0.1:5173' ].includes(req.headers.origin)) return reject('403 Forbidden');
    if (!realtime?.enabled || !provider) return reject('503 Service Unavailable');
    const session = sessions.get(url.searchParams.get('sessionId'));
    if (!session || Date.now() - session.updated > 2 * 60 * 60 * 1000) return reject('404 Not Found');
    if (session.status !== 'active' || session.busy || session.speechBusy || session.sttBusy || session.realtimeBusy || String(session.revision) !== url.searchParams.get('revision')) return reject('409 Conflict');
    session.realtimeBusy = true;
    socket.once('close', () => { if (session.realtimeBusy === true) session.realtimeBusy = false; });
    try { wss.handleUpgrade(req, socket, head, ws => connect(ws, session)); }
    catch { session.realtimeBusy = false; socket.destroy(); }
  });
  server.once('close', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });

  function connect(ws, session) {
    session.realtimeBusy = ws;
    let upstream;
    let ended = false;
    let ready = false;
    let finishing = false;
    let accepting = false;
    let processing = false;
    let operation = Promise.resolve();
    let bytes = 0;
    let currentInputBytes = 0;
    let speechActive = false;
    let activeItem;
    let partial = '';
    let text = '';
    let carriedDraft = '';
    let fallbackIndex = 0;
    const finalized = new Map();
    const pendingItems = new Set();
    const itemOrder = new Map();
    const handledItems = new Set();
    const activeResponses = new Set();
    let allowedResponse;
    let expectingResponse = false;
    let muted = false;
    let pendingQuestion;
    let questionConfigured = false;
    let configuration;
    let closeTimer;
    let waitTimer;
    let speechController;
    const resample = createPcmResampler();
    const started = Date.now();
    let timer = setTimeout(() => fail('Realtime не ответил вовремя. Попробуйте ещё раз или завершите интервью.'), handshakeMs);
    const current = () => session.turns.at(-1);
    const draft = () => [text, partial].filter(Boolean).join(' ').trim();
    const snapshot = () => publicSession(session);
    const send = event => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 2 * 1024 * 1024) return fail('Воспроизведение не успевает за аудиопотоком. Попробуйте снова.');
      ws.send(JSON.stringify(event));
    };
    const cloud = event => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event)); };
    const status = phase => send({ type: 'status', phase });
    function cleanup() {
      clearTimeout(timer); clearTimeout(waitTimer);
      speechController?.abort();
      if (session.realtimeBusy === ws) session.realtimeBusy = false;
      if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
      else if (upstream?.readyState === WebSocket.OPEN) upstream.close();
    }
    function close() {
      ws.close();
      closeTimer = setTimeout(() => ws.terminate(), 1000);
      closeTimer.unref();
    }
    function fail(message) {
      if (ended) return;
      session.realtimeDraft = draft();
      ended = true;
      cleanup();
      send({ type: 'error', message, session: snapshot(), text, partial });
      close();
    }
    function interrupt() {
      muted = true;
      speechController?.abort();
      for (const id of activeResponses) cloud({ type: 'response.cancel', response_id: id });
    }
    function resetDraft() {
      text = ''; partial = ''; carriedDraft = ''; currentInputBytes = 0;
      speechActive = false; activeItem = undefined;
      pendingItems.clear(); finalized.clear(); itemOrder.clear();
      session.realtimeDraft = '';
      send({ type: 'transcript', text: '', partial: '' });
    }
    function maybeSpeak() {
      if (ended || finishing || !pendingQuestion || !questionConfigured || (!fastSpeech && (activeResponses.size || expectingResponse))) return;
      if (fastSpeech) {
        const question = pendingQuestion;
        pendingQuestion = undefined;
        const controller = new AbortController();
        speechController?.abort();
        speechController = controller;
        status('speaking');
        speech.synthesize(question, { signal: controller.signal }).then(audio => {
          if (controller.signal.aborted || ended) return;
          send({ type: 'audio_file', audio: audio.toString('base64'), mimeType: 'audio/mpeg' });
          send({ type: 'audio_done' });
          if (accepting) status('listening');
        }).catch(() => {
          if (!controller.signal.aborted && !ended) fail('Не удалось озвучить вопрос через SpeechKit. Проверьте доступ к синтезу и повторите подключение.');
        });
        return;
      }
      expectingResponse = true;
      muted = false;
      pendingQuestion = undefined;
      cloud({ type: 'response.create' });
    }
    function ask(question) {
      if (ended || finishing) return;
      resetDraft();
      accepting = true;
      configuration = realtimeSession(question, realtime.voice);
      pendingQuestion = question;
      // SpeechKit does not need another cloud configuration update per question.
      questionConfigured = fastSpeech && ready;
      if (fastSpeech) configuration.output_modalities = ['text'];
      if (!fastSpeech || !ready) cloud({ type: 'session.update', session: configuration });
      send({ type: 'session', session: snapshot() });
      send({ type: 'assistant_transcript', text: question, partial: '' });
      status('thinking');
      maybeSpeak();
    }
    function recordAnswer(answer) {
      const turn = current();
      if (!turn || !answer.trim()) return;
      if (turn.followUps?.length && turn.followUps.at(-1).answer === null) {
        turn.followUps.at(-1).answer = answer;
        turn.answer = `${turn.answer || ''}\nУточнение: ${answer}`.trim();
      } else turn.answer = answer;
      session.revision++;
      session.updated = Date.now();
      session.realtimeDraft = '';
    }
    async function report() {
      if (ended) return;
      accepting = false;
      send({ type: 'finishing' });
      status('finishing');
      // Partial interviews are legitimate. Do not invent an answer to the last question.
      const answered = session.turns.filter(turn => turn.answer?.trim());
      session.turns = answered;
      session.status = 'ready';
      session.revision++;
      session.updated = Date.now();
      send({ type: 'session', session: snapshot() });
      let result = null;
      if (answered.length) result = await provider.report({ ...session, turns: answered.map(turn => ({ ...turn })) });
      if (ended) return;
      session.report = result;
      session.status = 'completed';
      session.revision++;
      session.updated = Date.now();
      session.realtimeDraft = '';
      ended = true;
      cleanup();
      send({ type: 'done', session: snapshot(), text: '' });
      close();
    }
    async function advance(answer, saved = false) {
      if (ended || processing || !accepting || (!saved && !answer.trim())) return;
      processing = true;
      accepting = false;
      interrupt();
      status('thinking');
      if (!saved) recordAnswer(answer);
      send({ type: 'session', session: snapshot() });
      resetDraft();
      try {
        if (finishing) return await report();
        const turn = current();
        let decision;
        if (provider.nextTurn) decision = await provider.nextTurn(session);
        else {
          // Support lightweight providers used by local protocol checks.
          const followup = !turn.followUps?.length && provider.followup ? await provider.followup(session) : null;
          if (ended) return;
          if (finishing) return await report();
          decision = followup ? { action: 'followup', question: followup } : session.turns.length >= 5 ? { action: 'finish' } : { action: 'question', question: await provider.question(session) };
        }
        if (ended) return;
        if (finishing) return await report();
        if (decision.action === 'finish') { finishing = true; return await report(); }
        if (decision.action === 'followup') {
          turn.followUps = [{ question: decision.question, answer: null }];
          turn.question += `\nУточнение: ${decision.question}`;
        } else session.turns.push({ question: decision.question, answer: null });
        session.revision++;
        ask(decision.question);
      } finally { processing = false; }
    }
    function queueAdvance(answer) {
      if (processing || !accepting || ended) return;
      operation = advance(answer).catch(() => fail('Не удалось продолжить интервью. Ответы сохранены; завершите интервью или попробуйте снова.'));
    }
    function settleFinish() {
      if (ended || processing) return;
      clearTimeout(waitTimer);
      const answer = draft();
      if (answer && accepting) operation = advance(answer).catch(() => fail('Не удалось сформировать отчёт. Ответы сохранены.'));
      else operation = report().catch(() => fail('Не удалось сформировать отчёт. Ответы сохранены.'));
    }
    function finish() {
      if (ended || finishing) return;
      finishing = true;
      interrupt();
      status('finishing');
      clearTimeout(timer);
      send({ type: 'finishing' });
      if (processing) return; // advance() checks finishing after every awaited provider call.
      if (accepting && (speechActive || pendingItems.size || (currentInputBytes && !text))) {
        if (speechActive || !pendingItems.size) {
          pendingItems.add(activeItem || 'pending');
          cloud({ type: 'input_audio_buffer.commit' });
        }
        waitTimer = setTimeout(settleFinish, finalWaitMs);
      } else settleFinish();
    }
    ws.on('error', () => fail('Соединение с микрофоном прервалось.'));
    ws.on('close', () => { if (!ended) session.realtimeDraft = draft(); ended = true; cleanup(); clearTimeout(closeTimer); });
    try {
      upstream = realtime.open();
      upstream.on('open', () => {
        const turn = current();
        const pendingFollowup = turn?.followUps?.at(-1)?.answer === null;
        if (turn?.answer && !pendingFollowup) {
          accepting = true;
          operation = advance('', true).catch(() => fail('Не удалось продолжить интервью. Ответы сохранены; повторите подключение или завершите интервью.'));
          return;
        }
        const savedDraft = session.realtimeDraft || '';
        const question = pendingFollowup ? turn.followUps.at(-1).question : turn?.question;
        ask(question || 'Расскажите о вашем опыте разработки.');
        if (savedDraft) { carriedDraft = savedDraft; text = savedDraft; session.realtimeDraft = savedDraft; send({ type: 'transcript', text, partial: '' }); }
      });
      upstream.on('unexpected-response', (_, response) => { response.resume(); upstream.terminate(); fail(response.statusCode === 401 || response.statusCode === 403 ? 'Realtime: проверьте роль ai.models.user и область ключа yc.ai.foundationModels.execute. Можно повторить подключение или завершить интервью.' : 'Realtime временно недоступен. Попробуйте снова или завершите интервью.'); });
      upstream.on('error', () => fail('Не удалось подключиться к Realtime. Попробуйте снова или завершите интервью.'));
      upstream.on('close', () => { if (!ended) fail('Realtime прервал соединение. Ответы сохранены; можно завершить интервью.'); });
      upstream.on('message', data => {
        if (ended) return;
        let event;
        try { event = JSON.parse(data.toString()); } catch { return fail('Realtime вернул некорректный ответ.'); }
        if (event.type === 'session.updated' && event.session?.instructions === configuration?.instructions) {
          if (!ready) {
            ready = true; clearTimeout(timer);
            timer = setTimeout(finish, maxDurationMs);
            send({ type: 'ready', sampleRate: 16000, outputSampleRate: fastSpeech ? null : REALTIME_SAMPLE_RATE, outputFormat: fastSpeech ? 'mp3' : 'pcm16', maxDurationSeconds: maxDurationMs / 1000 });
          }
          questionConfigured = true;
          maybeSpeak();
        } else if (event.type === 'response.created') {
          const id = event.response?.id;
          if (id) activeResponses.add(id);
          if (expectingResponse && !finishing) { expectingResponse = false; allowedResponse = id; status('speaking'); }
          else cloud({ type: 'response.cancel', response_id: id });
        } else if (event.type === 'response.done') {
          activeResponses.delete(event.response?.id);
          if (event.response?.id === allowedResponse && accepting) status('listening');
          maybeSpeak();
        } else if (event.type === 'response.output_audio.delta' && !muted && (!event.response_id || event.response_id === allowedResponse)) {
          if (typeof event.delta === 'string') send({ type: 'audio', audio: event.delta, sampleRate: REALTIME_SAMPLE_RATE });
        } else if (event.type === 'response.output_audio.done' && (!event.response_id || event.response_id === allowedResponse)) {
          send({ type: 'audio_done' }); if (accepting) status('listening');
        } else if (event.type === 'input_audio_buffer.speech_started' && accepting) {
          speechActive = true; activeItem = event.item_id;
          if (activeItem && !itemOrder.has(activeItem)) itemOrder.set(activeItem, itemOrder.size);
          interrupt(); send({ type: 'speech_start' }); status('listening');
        } else if (event.type === 'input_audio_buffer.speech_stopped' && accepting) {
          speechActive = false; pendingItems.add(event.item_id || activeItem || 'pending'); send({ type: 'speech_stop' });
        } else if (event.type === 'input_audio_buffer.committed' && accepting) {
          pendingItems.add(event.item_id || 'pending');
          if (event.item_id && !itemOrder.has(event.item_id)) itemOrder.set(event.item_id, itemOrder.size);
        } else if (event.type === 'conversation.item.input_audio_transcription.delta' && accepting) {
          partial += event.delta || '';
          session.realtimeDraft = draft();
          if ((current()?.answer?.length || 0) + text.length + partial.length > 4000) return fail('Ответ достиг лимита 4000 символов. Завершите интервью.');
          send({ type: 'transcript', text, partial });
        } else if (event.type === 'conversation.item.input_audio_transcription.completed' && accepting) {
          const id = event.item_id || `fallback-${fallbackIndex++}`;
          if (handledItems.has(id)) return;
          handledItems.add(id);
          finalized.set(id, event.transcript || partial);
          text = [carriedDraft, ...[...finalized.entries()].sort(([a], [b]) => (itemOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (itemOrder.get(b) ?? Number.MAX_SAFE_INTEGER)).map(([, value]) => value)].filter(Boolean).join(' ').trim();
          partial = ''; pendingItems.delete(event.item_id || 'pending'); pendingItems.delete('pending');
          if (!event.item_id || event.item_id === activeItem) speechActive = false;
          session.realtimeDraft = text;
          if ((current()?.answer?.length || 0) + text.length > 4000) return fail('Ответ достиг лимита 4000 символов. Завершите интервью.');
          send({ type: 'transcript', text, partial });
          if (!pendingItems.size && !speechActive) {
            if (finishing) settleFinish();
            else if (text) queueAdvance(text);
          }
        } else if (event.type === 'error') {
          if (['response_cancel_not_active', 'response_not_active', 'conversation_already_has_active_response'].includes(event.error?.code)) return;
          if (finishing && event.error?.code === 'input_audio_buffer_commit_empty') return settleFinish();
          fail('Ошибка Realtime. Ответы сохранены; попробуйте снова или завершите интервью.');
        }
      });
    } catch { return fail('Не удалось запустить Realtime. Можно повторить подключение или завершить интервью.'); }
    ws.on('message', (data, binary) => {
      if (ended) return;
      if (!binary) {
        let event;
        try { event = JSON.parse(data.toString()); } catch { return fail('Неизвестная команда Realtime.'); }
        if (event.type === 'cancel') { session.realtimeDraft = draft(); ended = true; cleanup(); close(); return; }
        if (event.type === 'cancel_audio') return interrupt();
        if (event.type === 'finish') return finish();
        return fail('Неизвестная команда Realtime.');
      }
      if (!ready || finishing) return;
      if (!data.length || data.length % 2) return fail('Некорректный формат аудио.');
      bytes += data.length;
      if (bytes > 16000 * 2 * maxDurationMs / 1000 || bytes > (Date.now() - started + 2000) * 32) return fail('Превышен лимит аудиопотока.');
      if (upstream.bufferedAmount > 256000) return fail('Соединение с Realtime перегружено. Попробуйте снова.');
      if (!accepting) return;
      currentInputBytes += data.length;
      cloud({ type: 'input_audio_buffer.append', audio: resample(data).toString('base64') });
    });
  }
  return wss;
}
