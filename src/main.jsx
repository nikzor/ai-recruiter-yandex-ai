import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import SpeechPlayer from './SpeechPlayer.jsx';
import VoiceAnswer from './VoiceAnswer.jsx';
import RealtimeAnswer from './RealtimeAnswer.jsx';
import { prepareRealtimeInput } from './useRealtimeInput.js';
const levels = ['Intern', 'Junior', 'Middle', 'Senior'];
async function api(path, method = 'GET', data) {
  let response;
  try { response = await fetch(`/api${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined }); }
  catch { throw new Error('Не удалось связаться с сервером. Проверьте, что он запущен.'); }
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error; }
  return result;
}
function App() {
  const [mode, setMode] = useState(null);
  const [speechEnabled, setSpeechEnabled] = useState(false);
  const [recognitionEnabled, setRecognitionEnabled] = useState(false);
  const [realtimeEnabled, setRealtimeEnabled] = useState(false);
  const [interactionMode, setInteractionMode] = useState('voice');
  const [listening, setListening] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [level, setLevel] = useState('Junior');
  const [session, setSession] = useState(null);
  const [realtimeResources, setRealtimeResources] = useState(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { (async () => {
    try {
      const health = await api('/health');
      setMode(health.mode);
      setSpeechEnabled(Boolean(health.speech?.enabled));
      setRecognitionEnabled(Boolean(health.speech?.recognitionEnabled));
      setRealtimeEnabled(Boolean(health.speech?.realtimeEnabled));
      const id = sessionStorage.getItem('interview-id');
      if (id) {
        const saved = await api(`/sessions/${id}`);
        setSession(saved);
        setInteractionMode(sessionStorage.getItem('interview-input-mode') || saved.interactionMode || 'text');
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  })(); }, []);
  async function run(action) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function save(s) { setSession(s); sessionStorage.setItem('interview-id', s.id); }
  function chooseMode(value) { setInteractionMode(value); setListening(false); setBotSpeaking(false); sessionStorage.setItem('interview-input-mode', value); }
  function start() {
    const resources = interactionMode === 'realtime' ? prepareRealtimeInput() : null;
    run(async () => {
      try {
        if (resources) await resources.ready;
        sessionStorage.setItem('interview-input-mode', interactionMode);
        const s = await api('/sessions', 'POST', { level, interactionMode });
        setRealtimeResources(resources); save(s); setMode(s.mode); setAnswer('');
      } catch (e) { resources?.close(); throw e; }
    });
  }
  function submit(e) { e?.preventDefault(); run(async () => {
    const next = await api(`/sessions/${session.id}/answers`, 'POST', { answer, revision: session.revision });
    save(next); setAnswer('');
  }); }
  function report() { run(async () => save(await api(`/sessions/${session.id}/report`, 'POST', { revision: session.revision }))); }
  function finishRealtime() { run(async () => {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const latest = await api(`/sessions/${session.id}`);
        try { save(await api(`/sessions/${session.id}/finish`, 'POST', { revision: latest.revision })); return; }
        catch (e) {
          if (e.status !== 409 || attempt === 3) throw e;
          // A cancelled WebSocket upgrade can briefly retain the session lock.
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    }
    catch (e) { save(await api(`/sessions/${session.id}`)); throw e; }
  }); }
  function reset() { run(async () => {
    if (session) await api(`/sessions/${session.id}`, 'DELETE');
    realtimeResources?.close(); setRealtimeResources(null);
    sessionStorage.removeItem('interview-id'); sessionStorage.removeItem('interview-input-mode'); setSession(null); setAnswer(''); setListening(false); setBotSpeaking(false);
  }); }
  function download() {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'interview-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const answered = session?.turns.filter(t => t.answer !== null).length || 0;
  const currentQuestion = session?.turns.at(-1);
  return <div className="shell">
    <header><h1>Интервью по Flutter</h1><span className="mode">{mode === 'yandex' ? 'Yandex AI Studio' : mode === 'mock' ? 'Демо' : 'Подключение…'}</span></header>
    <main className="workspace" aria-label="Интервью">
      {error && <div role="alert" className="error">{error}<div className="actions">
        {session && <button className="secondary" disabled={busy} onClick={() => run(async () => save(await api(`/sessions/${session.id}`)))}>Обновить сессию</button>}
        <button className="text-button" disabled={busy} onClick={() => { sessionStorage.removeItem('interview-id'); location.reload(); }}>К началу</button>
      </div></div>}
      {!session ? <>
        <p className="setup-intro">Пять вопросов и отчёт по вашим ответам.</p>
        <fieldset disabled={busy}><legend>Режим</legend><div className="choice-row">
          <button className={`choice ${interactionMode === 'voice' ? 'selected' : ''}`} aria-pressed={interactionMode === 'voice'} onClick={() => chooseMode('voice')}>Голосом</button>
          <button className={`choice ${interactionMode === 'text' ? 'selected' : ''}`} aria-pressed={interactionMode === 'text'} onClick={() => chooseMode('text')}>Текстом</button>
          <button className={`choice ${interactionMode === 'realtime' ? 'selected' : ''}`} aria-pressed={interactionMode === 'realtime'} onClick={() => chooseMode('realtime')}>Диалог Realtime</button>
        </div></fieldset>
        <fieldset disabled={busy}><legend>Уровень</legend><div className="choice-row levels">{levels.map(name => <button key={name} className={`choice ${level === name ? 'selected' : ''}`} aria-pressed={level === name} onClick={() => setLevel(name)}>{name}</button>)}</div></fieldset>
        {interactionMode === 'voice' && <p className="muted">{recognitionEnabled ? 'Вопросы озвучиваются. Микрофон включается по нажатию.' : 'Голосовой режим недоступен. Выберите текстовый.'}</p>}
        {interactionMode === 'realtime' && <p className="muted">{realtimeEnabled ? 'Непрерывный голосовой разговор: интервьюер сам слушает ответы и задаёт вопросы. В конце — отчёт.' : 'Realtime недоступен. Выберите другой режим.'}</p>}
        <button className="start-button" disabled={busy || interactionMode === 'voice' && !recognitionEnabled || interactionMode === 'realtime' && !realtimeEnabled} onClick={start}>{busy ? 'Подготовка…' : 'Начать интервью'}</button>
        <p className="notice">{mode === 'mock' ? 'В демо оценки фиксированы и не отражают знания.' : 'Вопросы и ответы обрабатывает Yandex AI Studio.'}</p>
      </> : <>
        <div className="session-head"><span>{session.level}</span><span>{session.report ? 'Отчёт' : session.status === 'completed' ? 'Интервью завершено' : session.status === 'ready' ? `Ответов: ${answered}` : `Вопрос ${session.turns.length} из 5`}</span></div>
        {!session.report && <>
          {session.status === 'completed' ? <div className="ready"><h2>Интервью завершено</h2><p>Ответы не записаны. Начните новое интервью, чтобы получить отчёт.</p></div> : interactionMode === 'realtime' && (session.status === 'active' || listening) ? <>
            <h2 className="current-question">{currentQuestion?.question}</h2>
            <RealtimeAnswer key={session.id} session={session} prepared={realtimeResources} onSession={save} onActive={setListening} onFinishFallback={finishRealtime} busy={busy}/>
          </> : session.status === 'active' ? <>
            <h2 className="current-question">{currentQuestion.question}</h2>
            {speechEnabled && interactionMode !== 'realtime' && <SpeechPlayer key={`${session.id}:${session.turns.length}:${interactionMode}`} sessionId={session.id} questionNumber={session.turns.length} disabled={busy || listening} autoPlay={interactionMode === 'voice'} onActivity={setBotSpeaking}/>}
            {interactionMode === 'voice' ? <VoiceAnswer key={`${session.id}:${session.turns.length}`} session={session} answer={answer} onAnswer={setAnswer} onSubmit={() => submit()} onActive={setListening} botSpeaking={botSpeaking} busy={busy} onTextMode={() => chooseMode('text')}/> : <form onSubmit={submit}>
              <div className="text-mode-heading"><label htmlFor="answer">Ваш ответ</label>{recognitionEnabled && <button type="button" className="text-button" disabled={busy} onClick={() => chooseMode('voice')}>Ответить голосом</button>}</div>
              <textarea id="answer" value={answer} onChange={e => setAnswer(e.target.value)} maxLength={4000} disabled={busy} placeholder="Напишите ответ…"/>
              <div className="form-footer"><small>{answer.length} / 4000</small><button disabled={busy || !answer.trim()}>{busy ? 'Готовим следующий вопрос…' : 'Отправить ответ'}</button></div>
            </form>}
          </> : <div className="ready"><h2>Интервью завершено</h2><button disabled={busy} onClick={report}>{busy ? 'Анализируем ответы…' : 'Получить отчёт'}</button></div>}
          {answered > 0 && <details className="history"><summary>Предыдущие ответы ({answered})</summary>{session.turns.filter(t => t.answer !== null).map((turn, i) => <div className="history-turn" key={i}><p><strong>{i + 1}. {turn.question}</strong></p><p>{turn.answer}</p></div>)}</details>}
        </>}
        {session.report && <div className="report">
          <div className="score"><span>{mode === 'mock' ? 'Демонстрационный балл' : 'Итоговая оценка'}</span><strong>{session.report.score}<small> / 100</small></strong></div>
          <p>{session.report.summary}</p>
          {mode !== 'mock' && <p className="notice">Учебная оценка ИИ.</p>}
          {[["strengths", "Сильные стороны"], ["gaps", "Что улучшить"], ["recommendations", "Рекомендации"]].map(([key, title]) => <section key={key}><h3>{title}</h3><ul>{session.report[key].map((text, i) => <li key={i}>{text}</li>)}</ul></section>)}
          <h3>Разбор ответов</h3>{session.report.assessments.map((a, i) => <details key={a.questionNumber}><summary>Вопрос {a.questionNumber}<span>{a.score} / 4</span></summary><p><strong>{session.turns[i].question}</strong></p><p className="preserve">{session.turns[i].answer}</p><p>{a.rationale}</p></details>)}
          <button className="text-button export" onClick={download}>Скачать отчёт</button>
        </div>}
        {!(interactionMode === 'realtime' && listening) && <div className="session-footer"><button className="text-button" disabled={busy || listening} onClick={reset}>Начать заново</button></div>}
      </>}
      <div role="status" className="sr-only">{busy ? 'Запрос обрабатывается' : ''}</div>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
