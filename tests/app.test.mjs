import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { createProvider, validateReport, AppError } from '../server/provider.mjs';
async function fixture(t, provider = createProvider({})) {
  const server = createApp(provider);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, method = 'GET', data, headers = {}) => {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json() };
  };
}
for (const level of ['Intern', 'Junior', 'Middle', 'Senior']) test(`Полный сценарий ${level}`, async t => {
  const request = await fixture(t);
  let { status, body: session } = await request('/sessions', 'POST', { level });
  assert.equal(status, 201);
  assert.equal(session.level, level);
  assert.equal((await request(`/sessions/${session.id}/report`, 'POST', { revision: 0 })).status, 409);
  for (let i = 0; i < 5; i++) {
    assert.equal(session.turns.length, i + 1);
    const result = await request(`/sessions/${session.id}/answers`, 'POST', { revision: session.revision, answer: 'Мой пример ответа' });
    assert.equal(result.status, 200);
    session = result.body;
  }
  assert.equal(session.status, 'ready');
  const result = await request(`/sessions/${session.id}/report`, 'POST', { revision: session.revision });
  assert.equal(result.status, 200);
  assert.equal(result.body.report.score, 50);
  assert.equal(result.body.report.assessments.length, 5);
  assert.equal(result.body.status, 'completed');
  assert.deepEqual((await request(`/sessions/${session.id}/report`, 'POST', { revision: 0 })).body.report, result.body.report);
  await request(`/sessions/${session.id}`, 'DELETE');
  assert.equal((await request(`/sessions/${session.id}`)).status, 404);
});
test('Валидация уровня, ответа и защита от повторного сохранения', async t => {
  const req = await fixture(t);
  assert.equal((await req('/sessions', 'POST', { level: 'Expert' })).status, 400);
  const { body: s } = await req('/sessions', 'POST', { level: 'Junior' });
  for (const answer of ['', '   ', 'a'.repeat(4001), 42]) assert.equal((await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer })).status, 400);
  assert.equal((await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Пример' })).status, 200);
  assert.equal((await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Повтор' })).status, 409);
  assert.equal((await req(`/sessions/${s.id}`)).body.turns.length, 2);
});
test('Сбой генерации не сохраняет ответ; запрос можно повторить', async t => {
  const mock = createProvider({});
  let fail = true;
  const req = await fixture(t, { ...mock, question: async s => { if (s.turns.length && fail) throw new AppError(504, 'Таймаут'); return mock.question(s); } });
  const { body: s } = await req('/sessions', 'POST', { level: 'Middle' });
  assert.equal((await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Ответ' })).status, 504);
  assert.equal((await req(`/sessions/${s.id}`)).body.turns[0].answer, null);
  fail = false;
  assert.equal((await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Ответ' })).status, 200);
});
test('Конкурентные запросы не дублируют ход', async t => {
  const mock = createProvider({}); let release;
  const req = await fixture(t, { ...mock, question: async s => { if (s.turns.length) await new Promise(r => { release = r; }); return mock.question(s); } });
  const { body: s } = await req('/sessions', 'POST', { level: 'Senior' });
  const first = req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Ответ' });
  while (!release) await new Promise(r => setTimeout(r, 5));
  const second = await req(`/sessions/${s.id}/answers`, 'POST', { revision: 0, answer: 'Повтор' });
  release();
  assert.equal(second.status, 409);
  assert.equal((await first).status, 200);
});
test('Yandex: серверный ключ, схема, история; ошибки не раскрывают ответ провайдера', async () => {
  const env = { AI_MODE: 'yandex', YANDEX_API_KEY: 'test-secret', YANDEX_FOLDER_ID: 'folder' };
  let outgoing;
  const provider = createProvider(env, async (url, options) => { outgoing = { url, ...options }; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"question":"Следующий вопрос?"}' } }] }); });
  const session = { level: 'Junior', turns: [{ question: 'Первый?', answer: 'Ответ' }] };
  assert.equal(await provider.question(session), 'Следующий вопрос?');
  const data = JSON.parse(outgoing.body);
  assert.equal(outgoing.headers.Authorization, 'Api-Key test-secret');
  assert.equal(outgoing.headers['OpenAI-Project'], 'folder');
  assert.equal(data.model, 'gpt://folder/yandexgpt-5.1');
  assert.equal(data.response_format.type, 'json_schema');
  assert.ok(data.messages.some(m => m.content === 'Ответ' && m.role === 'user'));
  for (const status of [401, 403, 429, 500]) {
    const bad = createProvider(env, async () => new Response('test-secret', { status }));
    await assert.rejects(bad.question(session), e => e.status === 502 && !e.message.includes('test-secret'));
  }
  const malformed = createProvider(env, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'no JSON' } }] }));
  await assert.rejects(malformed.question(session), { status: 502 });
  const timeout = createProvider(env, async () => { throw new Error('timeout'); });
  await assert.rejects(timeout.question(session), { status: 504 });
  assert.throws(() => createProvider({ AI_MODE: 'yandex' }));
});
test('Конфигурация: API_KEY поддерживается, имеет приоритет и не включает облако автоматически', async () => {
  for (const [keys, expected] of [
    [{ API_KEY: ' current ' }, 'current'],
    [{ YANDEX_API_KEY: 'legacy' }, 'legacy'],
    [{ API_KEY: 'current', YANDEX_API_KEY: 'legacy' }, 'current'],
    [{ API_KEY: ' ', YANDEX_API_KEY: 'legacy' }, 'legacy'],
  ]) {
    let authorization;
    const provider = createProvider({ AI_MODE: 'yandex', YANDEX_FOLDER_ID: 'folder', ...keys }, async (_, options) => {
      authorization = options.headers.Authorization;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"question":"Вопрос?"}' } }] });
    });
    await provider.question({ level: 'Junior', turns: [] });
    assert.equal(authorization, `Api-Key ${expected}`);
  }
  assert.equal(createProvider({ API_KEY: 'key', YANDEX_FOLDER_ID: 'folder' }).mode, 'mock');
  assert.throws(() => createProvider({ AI_MODE: 'yandex', API_KEY: 'key' }), /YANDEX_FOLDER_ID/);
  assert.throws(() => createProvider({ AI_MODE: 'yandex', API_KEY: ' ', YANDEX_FOLDER_ID: 'folder' }), /API_KEY/);
});
test('Отчёт отклоняет неверный балл, число и порядок оценок', () => {
  const r = { summary: 'Итог', strengths: [], gaps: [], recommendations: [], assessments: [{ questionNumber: 1, score: 3, rationale: 'Основание' }] };
  assert.equal(validateReport(r, 1).score, 75);
  assert.throws(() => validateReport(r, 5));
  assert.throws(() => validateReport({ ...r, assessments: [{ ...r.assessments[0], score: 10 }] }, 1));
  assert.throws(() => validateReport({ ...r, assessments: [{ ...r.assessments[0], questionNumber: 2 }] }, 1));
});

test('Origin: dev-прокси разрешён, посторонний сайт отклонён', async t => {
  const req = await fixture(t);
  assert.equal((await req('/sessions', 'POST', { level: 'Intern' }, { Origin: 'http://127.0.0.1:5173' })).status, 201);
  assert.equal((await req('/sessions', 'POST', { level: 'Intern' }, { Origin: 'https://example.com' })).status, 403);
});
test('Сбой отчёта сохраняет пять ответов и допускает повтор', async t => {
  const mock = createProvider({}); let fail = true;
  const req = await fixture(t, { ...mock, report: async s => { if (fail) throw new AppError(502, 'Некорректный отчёт'); return mock.report(s); } });
  let { body: s } = await req('/sessions', 'POST', { level: 'Junior' });
  for (let i = 0; i < 5; i++) s = (await req(`/sessions/${s.id}/answers`, 'POST', { revision: s.revision, answer: 'Ответ' })).body;
  assert.equal((await req(`/sessions/${s.id}/report`, 'POST', { revision: s.revision })).status, 502);
  const saved = (await req(`/sessions/${s.id}`)).body;
  assert.equal(saved.status, 'ready');
  assert.equal(saved.turns.filter(t => t.answer !== null).length, 5);
  fail = false;
  assert.equal((await req(`/sessions/${s.id}/report`, 'POST', { revision: s.revision })).body.status, 'completed');
});

test('Realtime: завершение до первого ответа не создаёт оценку и идемпотентно', async t => {
  const request = await fixture(t);
  const { body: session } = await request('/sessions', 'POST', { level: 'Junior', interactionMode: 'realtime' });
  const ended = await request(`/sessions/${session.id}/finish`, 'POST', { revision: session.revision });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.status, 'completed');
  assert.equal(ended.body.report, null);
  assert.deepEqual(ended.body.turns, []);
  assert.equal((await request(`/sessions/${session.id}/finish`, 'POST', { revision: 0 })).status, 200);
});
test('Realtime: досрочный отчёт включает только обсуждённые вопросы; сбой допускает повтор', async t => {
  const mock = createProvider({}); let failed = true;
  const request = await fixture(t, { ...mock, report: async s => { if (failed) throw new AppError(504, 'Таймаут'); return mock.report(s); } });
  let { body: s } = await request('/sessions', 'POST', { level: 'Junior', interactionMode: 'realtime' });
  ({ body: s } = await request(`/sessions/${s.id}/answers`, 'POST', { revision: s.revision, answer: 'Один ответ' }));
  assert.equal((await request(`/sessions/${s.id}/finish`, 'POST', { revision: s.revision })).status, 504);
  ({ body: s } = await request(`/sessions/${s.id}`));
  assert.equal(s.status, 'ready');
  assert.equal(s.turns.length, 1);
  failed = false;
  const ended = await request(`/sessions/${s.id}/report`, 'POST', { revision: s.revision });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.report.assessments.length, 1);
  assert.equal(ended.body.report.score, 50);
});
test('Yandex: уточнение валидируется, частичный отчёт запрашивает фактическое число вопросов', async () => {
  const env = { AI_MODE: 'yandex', API_KEY: 'test', YANDEX_FOLDER_ID: 'folder' };
  const session = { level: 'Junior', turns: [{ question: 'Вопрос?', answer: 'Неполный ответ' }] };
  let outgoing; let result = { needsClarification: true, question: 'А какой пример?' };
  const provider = createProvider(env, async (_, options) => {
    outgoing = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  });
  assert.equal(await provider.followup(session), 'А какой пример?');
  result = { needsClarification: false, question: '' };
  assert.equal(await provider.followup(session), null);
  result = { needsClarification: true, question: '' };
  await assert.rejects(provider.followup(session), { status: 502 });
  result = { summary: 'Оценка ограничена одним вопросом.', strengths: [], gaps: [], recommendations: [], assessments: [{ questionNumber: 1, score: 2, rationale: 'Частично верно' }] };
  assert.equal((await provider.report(session)).assessments.length, 1);
  assert.match(outgoing.messages.at(-1).content, /ровно 1 элементов/);
  assert.match(outgoing.messages.at(-1).content, /завершено досрочно/);
  assert.throws(() => validateReport({ ...result, assessments: [] }, 0));
});

test('Yandex: следующий шаг объединяет уточнение и вопрос в один запрос и проверяет границы', async () => {
  let calls = 0; let body; let result = { action: 'question', question: 'Следующий вопрос?' };
  const provider = createProvider({ AI_MODE: 'yandex', API_KEY: 'test', YANDEX_FOLDER_ID: 'folder' }, async (_, options) => {
    calls++; body = JSON.parse(options.body);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  });
  const session = { level: 'Junior', turns: [{ question: 'Вопрос?', answer: 'Ответ' }] };
  assert.deepEqual(await provider.nextTurn(session), result);
  assert.equal(calls, 1);
  assert.equal(body.max_tokens, 600);
  result = { action: 'followup', question: 'Уточните пример?' };
  assert.deepEqual(await provider.nextTurn(session), result);
  session.turns[0].followUps = [{ question: 'Уточните?', answer: 'Пример' }];
  await assert.rejects(provider.nextTurn(session), { status: 502 });
  result = { action: 'finish', question: '' };
  await assert.rejects(provider.nextTurn(session), { status: 502 });
  session.turns = Array.from({ length: 5 }, () => ({ question: 'Вопрос?', answer: 'Ответ' }));
  result = { action: 'question', question: 'Лишний шестой?' };
  await assert.rejects(provider.nextTurn(session), { status: 502 });
  session.turns[4].followUps = [{ question: 'Уточните?', answer: 'Пример' }];
  const before = calls;
  assert.deepEqual(await provider.nextTurn(session), { action: 'finish', question: '' });
  assert.equal(calls, before);
});
