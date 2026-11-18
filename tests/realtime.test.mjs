import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { attachRealtime } from '../server/realtime-socket.mjs';
import { createPcmResampler, createRealtimeProvider } from '../server/realtime.mjs';

class FakeCloud extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  messages = [];
  count = 0;
  acknowledgeUpdates = true;
  send(raw) {
    const event = JSON.parse(raw); this.messages.push(event);
    if (event.type === 'session.update' && this.acknowledgeUpdates) queueMicrotask(() => this.event({ type: 'session.updated', session: event.session }));
    if (event.type === 'response.create') queueMicrotask(() => this.event({ type: 'response.created', response: { id: `response-${++this.count}` } }));
    if (event.type === 'response.cancel') queueMicrotask(() => this.event({ type: 'response.done', response: { id: event.response_id } }));
  }
  event(event) { this.emit('message', JSON.stringify(event)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  start() { this.readyState = 1; this.emit('open'); }
}
async function fixture(t, options = {}) {
  const cloud = new FakeCloud();
  const session = { id: 'interview', updated: Date.now(), status: 'active', revision: 2, turns: [{ question: 'Ваш опыт?', answer: null }] };
  const reports = [];
  const provider = { question: async s => `Вопрос ${s.turns.length + 1}?`, followup: async () => null, report: async s => { reports.push(structuredClone(s.turns)); return { summary: 'Отчёт', overallScore: 75 }; } };
  const server = createServer();
  attachRealtime(server, { sessions: new Map([['interview', session]]), realtime: { enabled: true, voice: 'filipp', speechMode: options.speechMode || 'native', open: () => { setImmediate(() => cloud.start()); return cloud; } }, provider, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const connect = (query = 'sessionId=interview&revision=2', browserOrigin = origin) => new WebSocket(`${origin.replace('http:', 'ws:')}/api/speech/realtime?${query}`, { origin: browserOrigin });
  return { cloud, session, reports, connect };
}
function next(ws, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${type}`)); }, 2000);
    const handler = data => { const event = JSON.parse(data); if (event.type === type && predicate(event)) { cleanup(); resolve(event); } };
    const cleanup = () => { clearTimeout(timer); ws.off('message', handler); };
    ws.on('message', handler);
  });
}
function answer(cloud, text, id) {
  cloud.event({ type: 'input_audio_buffer.speech_started', item_id: id });
  cloud.event({ type: 'input_audio_buffer.speech_stopped', item_id: id });
  cloud.event({ type: 'input_audio_buffer.committed', item_id: id });
  cloud.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('provider keeps credentials server-side and targets supported model', () => {
  let call;
  const provider = createRealtimeProvider({ AI_MODE: 'yandex', API_KEY: 'secret', YANDEX_FOLDER_ID: 'folder' }, { socketFactory: (...args) => { call = args; return {}; } });
  assert.equal(provider.enabled, true); provider.open();
  assert.equal(new URL(call[0]).searchParams.get('model'), 'gpt://folder/speech-realtime-deepseek-v4-flash');
  assert.equal(call[1].headers.Authorization, 'Api-Key secret'); assert(!call[0].includes('secret'));
  assert.equal(createRealtimeProvider({ AI_MODE: 'mock', API_KEY: 'secret', YANDEX_FOLDER_ID: 'folder' }).enabled, false);
});

test('PCM resampling preserves chunk continuity and sample count', () => {
  const input = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) input.writeInt16LE(Math.round(Math.sin(i / 20) * 25000), i * 2);
  const one = createPcmResampler()(input); const split = createPcmResampler();
  assert.deepEqual(Buffer.concat([split(input.subarray(0, 1600)), split(input.subarray(1600))]), one);
  assert(Math.abs(one.length / 2 - 4410) <= 3);
});

test('one socket autonomously advances all five questions and produces the report', async t => {
  const { cloud, session, reports, connect } = await fixture(t);
  const ws = connect(); const ready = await next(ws, 'ready');
  assert.equal(ready.outputSampleRate, 44100);
  ws.send(Buffer.alloc(3200)); await tick();
  assert(Buffer.from(cloud.messages.find(event => event.type === 'input_audio_buffer.append').audio, 'base64').length > 8700);
  for (let i = 1; i <= 5; i++) {
    const progress = i < 5 ? next(ws, 'session', e => e.session.turns.length === i + 1) : next(ws, 'done');
    answer(cloud, `Ответ ${i}.`, `item-${i}`);
    await progress; await tick();
  }
  assert.equal(session.status, 'completed'); assert.equal(session.realtimeBusy, false);
  assert.equal(session.turns.length, 5); assert(session.turns.every(turn => turn.answer));
  assert.equal(reports.length, 1); assert.equal(reports[0].length, 5);
  assert.equal(cloud.messages.filter(event => event.type === 'session.update').length, 5);
  assert.equal(cloud.messages.filter(event => event.type === 'response.create').length, 5);
});

test('followup is automatic, stays in the same main turn, and is limited to one', async t => {
  let followups = 0;
  const provider = { question: async () => 'Следующий основной?', followup: async () => { followups++; return 'Как вы это проверяли?'; }, report: async () => ({ summary: 'Итог' }) };
  const { cloud, session, connect } = await fixture(t, { provider });
  const ws = connect(); await next(ws, 'ready');
  const clarification = next(ws, 'assistant_transcript', e => e.text === 'Как вы это проверяли?');
  answer(cloud, 'Использую Flutter.', 'first'); await clarification; await tick();
  assert.equal(session.turns.length, 1);
  const mainQuestion = next(ws, 'session', e => e.session.turns.length === 2);
  answer(cloud, 'Пишу тесты.', 'clarification'); await mainQuestion;
  assert.equal(followups, 1);
  assert.match(session.turns[0].question, /Уточнение: Как вы это проверяли/);
  assert.match(session.turns[0].answer, /Использую Flutter.*\nУточнение: Пишу тесты/);
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' })); await done;
});

test('finish ends the whole interview and reports only answered questions', async t => {
  const { cloud, session, reports, connect } = await fixture(t);
  const ws = connect(); await next(ws, 'ready');
  const nextQuestion = next(ws, 'session', e => e.session.turns.length === 2);
  answer(cloud, 'Первый ответ.', 'first'); await nextQuestion; await tick();
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' }));
  const event = await done;
  assert.equal(event.session.status, 'completed'); assert.equal(reports[0].length, 1);
  assert.equal(session.turns.length, 1); assert.equal(session.realtimeBusy, false);
});

test('finish waits for active transcription and includes its last answer', async t => {
  const { cloud, reports, connect } = await fixture(t);
  const ws = connect(); await next(ws, 'ready'); ws.send(Buffer.alloc(3200)); await tick();
  cloud.event({ type: 'input_audio_buffer.speech_started', item_id: 'last' });
  ws.send(JSON.stringify({ type: 'finish' })); await next(ws, 'finishing');
  assert(cloud.messages.some(event => event.type === 'input_audio_buffer.commit'));
  const done = next(ws, 'done');
  cloud.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last', transcript: 'Последний ответ.' });
  await done; assert.equal(reports[0][0].answer, 'Последний ответ.');
});

test('finish without answers completes without inventing a report', async t => {
  const { session, reports, connect } = await fixture(t);
  const ws = connect(); await next(ws, 'ready');
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' }));
  assert.equal((await done).session.report, null); assert.equal(reports.length, 0);
  assert.equal(session.status, 'completed'); assert.equal(session.realtimeBusy, false);
});

test('rejects cross-origin, stale revisions and overlapping voice sessions', async t => {
  const { connect, session } = await fixture(t);
  async function rejected(ws, expected) { ws.on('error', () => {}); const [, response] = await once(ws, 'unexpected-response'); assert.equal(response.statusCode, expected); response.resume(); ws.terminate(); }
  await rejected(connect(undefined, 'https://untrusted.example'), 403);
  await rejected(connect('sessionId=interview&revision=1'), 409);
  session.sttBusy = true; await rejected(connect(), 409);
});

test('disconnect preserves the draft and releases the session', async t => {
  const { cloud, session, connect } = await fixture(t);
  const ws = connect(); await next(ws, 'ready');
  cloud.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'draft', delta: 'Текущий ответ' });
  await next(ws, 'transcript', e => e.partial === 'Текущий ответ');
  const closed = once(ws, 'close'); ws.close(); await closed; await tick();
  assert.equal(session.realtimeDraft, 'Текущий ответ'); assert.equal(session.realtimeBusy, false);
});

test('reconnection advances an already answered turn without overwriting it', async t => {
  const { session, connect } = await fixture(t);
  session.turns[0].answer = 'Сохранённый ответ.';
  const ws = connect(); await next(ws, 'ready');
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].answer, 'Сохранённый ответ.');
  assert.equal(session.turns[1].answer, null);
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' })); await done;
});

test('reconnection combines a preserved draft with the next final transcription', async t => {
  const { cloud, session, connect } = await fixture(t);
  session.realtimeDraft = 'Сохранённое начало.';
  const ws = connect();
  const restored = next(ws, 'transcript', e => e.text === 'Сохранённое начало.');
  await next(ws, 'ready'); await restored;
  const progress = next(ws, 'session', e => e.session.turns.length === 2);
  answer(cloud, 'Продолжение ответа.', 'continued'); await progress;
  assert.equal(session.turns[0].answer, 'Сохранённое начало. Продолжение ответа.');
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' })); await done;
});

test('combined decision uses one provider call instead of separate clarification and question requests', async t => {
  let calls = 0;
  const provider = {
    nextTurn: async () => { calls++; return { action: 'question', question: 'Следующий вопрос?' }; },
    question: async () => assert.fail('Extra question request'),
    followup: async () => assert.fail('Extra clarification request'),
    report: async () => ({ summary: 'Итог' }),
  };
  const { cloud, session, connect } = await fixture(t, { provider });
  const ws = connect(); await next(ws, 'ready'); await tick();
  const progress = next(ws, 'session', e => e.session.turns.length === 2);
  answer(cloud, 'Ответ.', 'first'); await progress; await tick();
  assert.equal(calls, 1);
  assert.equal(session.turns[1].question, 'Следующий вопрос?');
  assert.equal(cloud.messages.filter(e => e.type === 'response.create').length, 2);
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' })); await done;
});

test('fast speech sends one MP3 per question, cancels on barge-in and needs only one cloud configuration', async t => {
  const syntheses = [];
  const speech = { enabled: true, synthesize: (question, options) => new Promise(resolve => {
    syntheses.push({ question, ...options, resolve });
  }) };
  const { cloud, connect } = await fixture(t, { speech, speechMode: 'speechkit' });
  const ws = connect(); await next(ws, 'ready'); await tick();
  assert.equal(cloud.messages[0].session.output_modalities[0], 'text');
  assert.equal(cloud.messages.filter(e => e.type === 'response.create').length, 0);
  assert.equal(syntheses[0].pcm, undefined);
  let audioCount = 0;
  ws.on('message', raw => { if (JSON.parse(raw).type === 'audio_file') audioCount++; });
  const firstAudio = next(ws, 'audio_file');
  syntheses[0].resolve(Buffer.from('ID3mp3-audio'));
  const audio = await firstAudio;
  assert.equal(audio.mimeType, 'audio/mpeg');
  assert.equal(Buffer.from(audio.audio, 'base64').toString(), 'ID3mp3-audio');
  const started = next(ws, 'speech_start');
  cloud.event({ type: 'input_audio_buffer.speech_started', item_id: 'first' }); await started;
  assert.equal(syntheses[0].signal.aborted, true);
  await tick();
  assert.equal(audioCount, 1);
  cloud.acknowledgeUpdates = false;
  const progress = next(ws, 'session', e => e.session.turns.length === 2);
  answer(cloud, 'Ответ.', 'first'); await progress; await tick();
  assert.equal(syntheses.length, 2);
  assert.equal(cloud.messages.filter(e => e.type === 'session.update').length, 1);
  const done = next(ws, 'done'); ws.send(JSON.stringify({ type: 'finish' })); await done;
  assert.equal(syntheses[1].signal.aborted, true);
  syntheses[1].resolve(Buffer.from('ID3late-audio'));
  await tick();
  assert.equal(audioCount, 1);
});
