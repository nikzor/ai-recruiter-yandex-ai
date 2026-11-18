import React, { useEffect, useState } from 'react';
import useVoiceInput from './useVoiceInput.js';

function MicrophoneIcon() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>;
}
export default function VoiceAnswer({ session, answer, onAnswer, onSubmit, onActive, botSpeaking, busy, onTextMode }) {
  const [editing, setEditing] = useState(false);
  const voice = useVoiceInput({ session, answer, onAnswer, onActive });
  useEffect(() => { if (busy && voice.active) voice.cancel(); }, [busy]);
  const recording = voice.state === 'recording';
  const status = busy ? 'ИИ готовит следующий шаг' : voice.state === 'permission' ? 'Разрешите доступ к микрофону' : voice.state === 'connecting' ? 'Подключаю распознавание' : voice.state === 'finishing' ? 'Завершаю расшифровку' : recording ? 'Слушаю вас' : botSpeaking ? 'Интервьюер задаёт вопрос' : answer ? 'Ответ готов к отправке' : 'Ваш ход';
  return <div className="voice-answer">
    <p className="voice-status" role="status">{status}{recording && <span> · {voice.seconds} с</span>}</p>
    {recording && <meter className="mic-level" aria-label="Уровень микрофона" min="0" max="0.25" value={voice.level}/>}
    <div className="voice-primary-actions">
      {voice.active ? <button className="mic-button" disabled={voice.state === 'finishing'} onClick={voice.finish}>{recording ? 'Закончить ответ' : voice.state === 'finishing' ? 'Завершаю…' : 'Отменить подключение'}</button> : <>
        <button className={answer ? 'secondary' : 'mic-button'} disabled={busy} onClick={() => { setEditing(false); voice.start(); }}><MicrophoneIcon/>{answer ? 'Дополнить голосом' : 'Ответить голосом'}</button>
        {answer && <button disabled={busy || !answer.trim()} onClick={onSubmit}>{busy ? 'Отправляем…' : 'Отправить ответ'}</button>}
      </>}
    </div>
    {voice.active && <small className="muted">{recording ? 'Микрофон включён · до 2 минут' : 'Ожидайте завершения'}</small>}
    {voice.error && <div className="error" role="alert">{voice.error}</div>}
    {(answer || voice.active || editing) && <div className="transcript-card">
      <div className="transcript-heading"><span>Расшифровка</span><button className="text-button" disabled={voice.active || busy} onClick={() => setEditing(value => !value)}>{editing ? 'Готово' : 'Исправить'}</button></div>
      {editing ? <textarea aria-label="Исправить расшифровку" value={answer} maxLength={4000} onChange={e => onAnswer(e.target.value)} disabled={busy}/> : <p className="live-transcript">{answer || !voice.partial && <span className="muted">Говорите, текст появится здесь…</span>} {voice.partial && <span className="partial-transcript">{voice.partial}</span>}</p>}
    </div>}
    <button className="text-button voice-fallback" disabled={voice.active || busy} onClick={onTextMode}>Ответить текстом</button>
  </div>;
}
