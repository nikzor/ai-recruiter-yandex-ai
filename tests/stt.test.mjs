import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as grpc from '@grpc/grpc-js';
import { WebSocket } from 'ws';
import { Recognizer, createRecognitionProvider } from '../server/stt.mjs';
import { createApp } from '../server/app.mjs';
import { createProvider } from '../server/provider.mjs';

const env = { AI_MODE: 'yandex', API_KEY: 'test-secret' };
function fakeCall() {
  const call = new EventEmitter();
  call.writes = [];
  call.write = data => { call.writes.push(data); return true; };
  call.end = () => call.emit('end');
  call.cancel = () => { call.cancelled = true; };
  return call;
}
async function fixture(t, recognition, recognitionLimits) {
  const server = createApp(createProvider({}), { recognition, recognitionLimits });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, data, method = data ? 'POST' : 'GET') => fetch(base + '/api' + path, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const session = await (await request('/sessions', { level: 'Intern', interactionMode: 'voice' })).json();
  const sockets = [];
  function connect({ origin = base, revision = session.revision, id = session.id } = {}) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/speech/recognize?sessionId=${id}&revision=${revision}`, { origin });
    sockets.push(ws);
    ws.on('error', () => {});
    const messages = [];
    const emitter = new EventEmitter();
    ws.on('message', raw => { const event = JSON.parse(raw); messages.push(event); emitter.emit('event'); });
    const wait = type => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { emitter.off('event', check); reject(new Error(`Missing ${type}`)); }, 2000);
      function check() {
        const found = messages.find(e => e.type === type);
        if (found) { clearTimeout(timeout); emitter.off('event', check); resolve(found); }
      }
      emitter.on('event', check); check();
    });
    const rejection = new Promise(resolve => ws.once('unexpected-response', (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }));
    return { ws, wait, messages, rejection };
  }
  t.after(() => new Promise(resolve => { sockets.forEach(ws => ws.terminate()); server.closeAllConnections(); server.close(resolve); }));
  return { base, request, session, connect };
}
test('STT: явное отключение в mock и STT_ENABLED=false', () => {
  for (const config of [{}, { ...env, AI_MODE: 'mock' }, { ...env, STT_ENABLED: 'false' }]) {
    const p = createRecognitionProvider(config);
    assert.equal(p.enabled, false);
    assert.throws(() => p.open(), { status: 503 });
  }
});
test('STT: реальный локальный gRPC проверяет protobuf, авторизацию и half-close', async t => {
  let metadata;
  const requests = [];
  const grpcServer = new grpc.Server();
  grpcServer.addService(Recognizer.service, { recognizeStreaming(call) {
    metadata = call.metadata;
    call.on('data', request => {
      requests.push(request);
      if (request.chunk) call.write({ partial: { alternatives: [{ text: 'частичный' }] } });
    });
    call.on('end', () => {
      call.write({ audioCursors: { finalIndex: '0' }, final: { alternatives: [{ text: 'готовый ответ' }] } });
      call.write({ finalRefinement: { finalIndex: '0', normalizedText: { alternatives: [{ text: 'Готовый ответ.' }] } } });
      call.end();
    });
  } });
  const port = await new Promise((resolve, reject) => grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => e ? reject(e) : resolve(p)));
  t.after(() => grpcServer.forceShutdown());
  const recognition = createRecognitionProvider(env, { clientFactory: () => new Recognizer(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) });
  const { connect, request, session } = await fixture(t, recognition);
  const socket = connect(); await socket.wait('ready');
  socket.ws.send(Buffer.alloc(3200));
  assert.equal((await socket.wait('transcript')).partial, 'частичный');
  socket.ws.send(JSON.stringify({ type: 'finish' }));
  const done = await socket.wait('done');
  assert.equal(done.text, 'Готовый ответ.');
  assert.equal(done.partial, '');
  assert.equal(metadata.get('authorization')[0], 'Api-Key test-secret');
  assert.equal(requests[0].sessionOptions.recognitionModel.audioFormat.rawAudio.sampleRateHertz, '16000');
  assert.equal(requests[0].sessionOptions.recognitionModel.audioFormat.rawAudio.audioEncoding, 'LINEAR16_PCM');
  assert.equal(requests[1].chunk.data.length, 3200);
  const saved = await (await request(`/sessions/${session.id}`)).json();
  assert.equal(saved.revision, 0);
  assert.equal(saved.turns[0].answer, null);
  assert.equal(saved.interactionMode, 'voice');
});
test('STT: Origin, сессия, revision, параллельность и блокировка записи интервью', async t => {
  const call = fakeCall();
  const { connect, request, session } = await fixture(t, { enabled: true, open: () => call });
  assert.equal(await connect({ origin: 'https://example.com' }).rejection, 403);
  assert.equal(await connect({ id: 'missing' }).rejection, 404);
  assert.equal(await connect({ revision: 7 }).rejection, 409);
  const first = connect(); await first.wait('ready');
  assert.equal(await connect().rejection, 409);
  assert.equal((await request(`/sessions/${session.id}/answers`, { revision: 0, answer: 'Ответ' })).status, 409);
  assert.equal((await request(`/sessions/${session.id}`, undefined, 'DELETE')).status, 409);
  first.ws.send(JSON.stringify({ type: 'finish' })); await first.wait('done');
  assert.equal((await request(`/sessions/${session.id}/answers`, { revision: 0, answer: 'Ответ' })).status, 200);
});
test('STT: ошибки облака сохраняют текст и не раскрывают upstream, обрыв отменяет gRPC', async t => {
  const call = fakeCall();
  const { connect } = await fixture(t, { enabled: true, open: () => call });
  const socket = connect(); await socket.wait('ready');
  call.emit('data', { audioCursors: { finalIndex: 0 }, final: { alternatives: [{ text: 'Первая фраза' }] } });
  call.emit('data', { partial: { alternatives: [{ text: 'продолжение' }] } });
  call.emit('error', { code: 7, details: 'test-secret' });
  const error = await socket.wait('error');
  assert.equal(error.text, 'Первая фраза');
  assert.equal(error.partial, 'продолжение');
  assert.match(error.message, /ai.speechkit-stt.user/);
  assert.ok(!JSON.stringify(error).includes('test-secret'));
  assert.equal(call.cancelled, true);
});
test('STT: некорректное аудио, тишина и ограничение длительности закрывают поток', async t => {
  for (const kind of ['odd', 'idle', 'duration']) await t.test(kind, async t => {
    const call = fakeCall();
    const { connect } = await fixture(t, { enabled: true, open: () => call }, { idleMs: kind === 'idle' ? 15 : 1000, maxDurationMs: kind === 'duration' ? 15 : 1000 });
    const socket = connect(); await socket.wait('ready');
    if (kind === 'odd') socket.ws.send(Buffer.alloc(3));
    await socket.wait(kind === 'duration' ? 'done' : 'error');
    if (kind !== 'duration') assert.equal(call.cancelled, true);
  });
});
test('STT: disconnect отменяет gRPC; backpressure приостанавливает вход и возобновляет по drain', async t => {
  const call = fakeCall();
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  call.cancel = () => { call.cancelled = true; cancelled(); };
  let count = 0;
  call.write = data => { call.writes.push(data); if (data.chunk) count++; return !data.chunk; };
  const { connect } = await fixture(t, { enabled: true, open: () => call });
  const socket = connect(); await socket.wait('ready');
  socket.ws.send(Buffer.alloc(3200));
  socket.ws.send(Buffer.alloc(3200));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, 1);
  call.emit('drain');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, 2);
  call.emit('drain');
  socket.ws.close();
  await new Promise(resolve => socket.ws.once('close', resolve));
  await cancellation;
  assert.equal(call.cancelled, true);
});
