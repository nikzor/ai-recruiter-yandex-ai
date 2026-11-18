import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { createProvider } from '../server/provider.mjs';

// Explicit opt-in: npm run check never calls the paid API.
let server;
try {
  if (process.env.AI_MODE !== 'yandex') throw new Error('Для облачной проверки задайте AI_MODE=yandex в .env. Проверка выполняет 6 платных запросов.');
  const provider = createProvider();
  server = createApp(provider);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, data, method = 'POST') {
    const response = await fetch(base + path, {
      method, signal: AbortSignal.timeout(55000),
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || 'Ошибка проверки'}`);
    return result;
  }
  const started = Date.now();
  console.log('YandexGPT: полное интервью Intern, 5 вопросов и отчёт; без автоматических повторов.');
  let session = await request('/sessions', { level: 'Intern' });
  const answers = [
    'final присваивается один раз во время выполнения, const — константа времени компиляции. Например: final now = DateTime.now(); const limit = 5;',
    'StatelessWidget не имеет собственного изменяемого State. StatefulWidget создаёт State; при изменении данных через setState Flutter планирует перестроение. Оба виджета неизменяемы.',
    'setState обновляет экран, но точный механизм объяснить не могу.',
    'Future блокирует главный поток до завершения запроса, а await запускает новый поток.',
    'Не знаю, как проверить это тестом.',
  ];
  for (const [i, answer] of answers.entries()) {
    assert.equal(session.turns.length, i + 1);
    console.log(`Вопрос ${i + 1}: ${session.turns[i].question}`);
    session = await request(`/sessions/${session.id}/answers`, { answer, revision: session.revision });
  }
  assert.equal(session.status, 'ready');
  session = await request(`/sessions/${session.id}/report`, { revision: session.revision });
  assert.equal(session.status, 'completed');
  assert.equal(session.report.assessments.length, 5);
  assert.equal(session.report.score, Math.round(session.report.assessments.reduce((sum, a) => sum + a.score, 0) / 20 * 100));
  const restored = await request(`/sessions/${session.id}`, undefined, 'GET');
  assert.deepEqual(restored.report, session.report);
  // Only synthetic interview data is printed; never dump env or raw provider responses.
  console.log(JSON.stringify(session.report, null, 2));
  await request(`/sessions/${session.id}`, undefined, 'DELETE');
  console.log(`Проверка пройдена за ${Math.round((Date.now() - started) / 1000)} с. Сессия удалена.`);
} catch (error) {
  console.error(error instanceof assert.AssertionError ? 'Проверка контракта интервью не пройдена.' : error.message);
  process.exitCode = 1;
} finally {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
