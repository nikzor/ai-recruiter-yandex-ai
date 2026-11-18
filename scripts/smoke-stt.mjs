import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.mjs';
import { createProvider } from '../server/provider.mjs';
import { createRecognitionProvider } from '../server/stt.mjs';

let server;
let ws;
try {
  const recognition = createRecognitionProvider();
  if (!recognition.enabled) throw new Error('Для проверки задайте AI_MODE=yandex, API_KEY и включите STT.');
  console.log('STT: 2 платных вызова (TTS учебной фразы + потоковое распознавание), без микрофона и без повторов.');
  const response = await fetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Api-Key ${(process.env.API_KEY || process.env.YANDEX_API_KEY).trim()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text: 'Переменной можно присвоить значение только один раз. Константа известна во время компиляции.', voice: 'filipp', lang: 'ru-RU', format: 'lpcm', sampleRateHertz: '16000' }),
  });
  if (!response.ok) throw new Error(`TTS HTTP ${response.status}: проверьте права синтеза.`);
  const audio = Buffer.from(await response.arrayBuffer());
  server = createApp(createProvider({}), { recognition });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await (await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'Intern', interactionMode: 'voice' }) })).json();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let finish;
  let fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  // A rejection may arrive while audio is still being paced into the socket.
  completed.catch(() => {});
  ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/speech/recognize?sessionId=${s.id}&revision=0`, { origin: base });
  let partials = 0;
  ws.on('message', raw => {
    const event = JSON.parse(raw);
    if (event.type === 'ready') ready();
    if (event.type === 'transcript') { if (event.partial) partials++; }
    if (event.type === 'done') finish(event);
    if (event.type === 'error') { ready(); fail(new Error(event.message)); }
  });
  ws.on('error', () => { ready(); fail(new Error('Ошибка соединения с локальным STT-сервером.')); });
  ws.on('close', () => { ready(); fail(new Error('Поток закрыт до завершения распознавания.')); });
  const timeout = setTimeout(() => { ready(); fail(new Error('Таймаут проверки STT.')); ws.terminate(); }, 30000);
  try {
    await started;
    for (let offset = 0; offset < audio.length && ws.readyState === WebSocket.OPEN; offset += 3200) {
      ws.send(audio.subarray(offset, offset + 3200));
      await delay(100);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' }));
    const result = await completed;
    assert.ok(result.text.toLowerCase().includes('компиляц'), 'Ожидалась учебная фраза о компиляции');
    console.log(`Проверка пройдена. Промежуточных результатов: ${partials}. Итог: ${result.text}`);
    const saved = await (await fetch(base + `/api/sessions/${s.id}`)).json();
    assert.equal(saved.turns[0].answer, null, 'Распознавание не должно само отправлять ответ');
  } finally { clearTimeout(timeout); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  ws?.terminate();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
