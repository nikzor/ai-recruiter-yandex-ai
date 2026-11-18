import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechProvider } from '../server/speech.mjs';
import { createProvider, AppError } from '../server/provider.mjs';
import { createApp } from '../server/app.mjs';

const env = { AI_MODE: 'yandex', API_KEY: 'test-secret', YANDEX_FOLDER_ID: 'folder' };
const audioResponse = () => new Response(Buffer.from('ID3fake-audio'), { headers: { 'Content-Type': 'audio/mpeg' } });
test('TTS v1: MP3, серверный ключ, исходный текст и filipp со стандартной скоростью', async () => {
  let outgoing;
  const speech = createSpeechProvider(env, async (url, options) => { outgoing = { url, ...options }; return audioResponse(); });
  assert.equal((await speech.synthesize('Вопрос?')).toString(), 'ID3fake-audio');
  assert.equal(outgoing.url, 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize');
  assert.equal(outgoing.headers.Authorization, 'Api-Key test-secret');
  assert.equal(outgoing.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(outgoing.body);
  assert.equal(body.get('format'), 'mp3');
  assert.equal(body.get('text'), 'Вопрос?');
  assert.equal(body.get('voice'), 'filipp');
  assert.equal(body.get('speed'), '1.0');
  assert.equal(body.has('folderId'), false);
});
test('TTS: mock, отключение и ограничения текста не вызывают облако', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return audioResponse(); };
  for (const config of [{}, { ...env, AI_MODE: 'mock' }, { ...env, TTS_ENABLED: 'false' }]) {
    await assert.rejects(createSpeechProvider(config, fetcher).synthesize('Вопрос'), { status: 503 });
  }
  const speech = createSpeechProvider(env, fetcher);
  for (const text of ['', '   ', 12, 'a'.repeat(4001), 'я'.repeat(3000)]) await assert.rejects(speech.synthesize(text), { status: 400 });
  assert.equal(calls, 0);

});
test('TTS: ошибки доступа/квот/сервера скрывают сырой ответ, пустой и неверный формат отклоняются', async () => {
  for (const status of [401, 403, 429, 500]) {
    const speech = createSpeechProvider(env, async () => new Response('test-secret', { status }));
    await assert.rejects(speech.synthesize('Вопрос'), e => e.status === (status === 429 ? 429 : 502) && !e.message.includes('test-secret'));
  }
  for (const response of [Response.json({ secret: 'test-secret' }), new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }), new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'audio/mpeg' } })]) {
    await assert.rejects(createSpeechProvider(env, async () => response).synthesize('Вопрос'), { status: 502 });
  }
});

test('TTS: таймаут и отмена прерывают upstream', async () => {
  const blocked = async (_, { signal }) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(createSpeechProvider(env, blocked, { timeoutMs: 5 }).synthesize('Вопрос'), { status: 504 });
    const controller = new AbortController();
    const request = createSpeechProvider(env, blocked).synthesize('Вопрос', { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { status: 499 });
  } finally { clearTimeout(keepAlive); }
});

async function fixture(t, speech) {
  const server = createApp(createProvider({}), { speech });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, data, options = {}) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, ...options });
  const session = await (await request('/sessions', { level: 'Intern' })).json();
  return { request, session };
}
test('TTS HTTP: берётся сохранённый вопрос, аудио не меняет интервью; ошибка допускает повтор', async t => {
  let fail = true;
  let text;
  const { request, session } = await fixture(t, { enabled: true, synthesize: async value => { text = value; if (fail) throw new AppError(504, 'Таймаут'); return Buffer.from('ID3audio'); } });
  const data = { sessionId: session.id, questionNumber: 1, text: 'Подменённый текст' };
  assert.equal((await request('/speech/synthesize', data)).status, 504);
  fail = false;
  const response = await request('/speech/synthesize', data);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'ID3audio');
  assert.equal(text, session.turns[0].question);
  assert.deepEqual(await (await request(`/sessions/${session.id}`)).json(), session);
  for (const questionNumber of [0, 2, '1']) assert.equal((await request('/speech/synthesize', { ...data, questionNumber })).status, 400);
  assert.equal((await request('/speech/synthesize', { ...data, sessionId: 'missing' })).status, 404);
  assert.equal((await request('/speech/synthesize', data, { headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' } })).status, 403);
});
test('TTS HTTP: mock без SpeechKit не обращается в облако', async t => {
  const { request, session } = await fixture(t);
  assert.equal((await request('/speech/synthesize', { sessionId: session.id, questionNumber: 1 })).status, 503);
});
test('TTS HTTP: параллельный синтез блокируется, отмена клиента закрывает upstream', async t => {
  let upstream;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const { request, session } = await fixture(t, { enabled: true, synthesize: async (_, { signal }) => {
    upstream = signal;
    began();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(new AppError(499, 'Отмена')); }, { once: true }));
  } });
  const controller = new AbortController();
  const data = { sessionId: session.id, questionNumber: 1 };
  const pending = request('/speech/synthesize', data, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  assert.equal((await request('/speech/synthesize', data)).status, 409);
  controller.abort();
  await rejected;
  await aborted;
  assert.equal(upstream.aborted, true);
});

test('TTS: PCM 16 kHz is forwarded before the HTTP response completes', async () => {
  let stream; let options;
  const speech = createSpeechProvider(env, async (_, outgoing) => {
    options = outgoing;
    return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Uint8Array.from([1, 2])); } }), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  let received;
  const first = new Promise(resolve => { received = resolve; });
  const synthesis = speech.synthesize('Вопрос?', { pcm: true, onChunk: received });
  assert.deepEqual(await first, Buffer.from([1, 2]));
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('format'), 'lpcm');
  assert.equal(body.get('sampleRateHertz'), '16000');
  assert.equal(body.get('speed'), '1.0');
  stream.enqueue(Uint8Array.from([3, 4])); stream.close();
  assert.deepEqual(await synthesis, Buffer.from([1, 2, 3, 4]));
});
