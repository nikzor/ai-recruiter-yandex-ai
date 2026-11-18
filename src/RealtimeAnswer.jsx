import React from 'react';
import useRealtimeInput from './useRealtimeInput.js';

export default function RealtimeAnswer({ session, prepared, onSession, onActive, onFinishFallback, busy }) {
  const realtime = useRealtimeInput({ session, prepared, onSession, onActive, onFinishFallback });
  const status = realtime.state === 'permission' ? 'Разрешите микрофон' : realtime.state === 'connecting' ? 'Подключаю интервью' : realtime.state === 'finishing' ? 'Готовлю отчёт…' : realtime.state === 'thinking' ? 'Обдумываю ваш ответ…' : realtime.speaking ? 'Интервьюер говорит — можно перебить' : realtime.active ? 'Слушаю вас' : 'Продолжите голосовое интервью';
  return <div className="voice-answer">
    <p className="voice-status" role="status">{status}{realtime.active && <span> · {realtime.seconds} с</span>}</p>
    <div className="voice-primary-actions">
      {realtime.active ? <button disabled={realtime.state === 'finishing'} onClick={realtime.finish}>Завершить интервью</button> : <>
        <button className="mic-button" disabled={busy} onClick={realtime.start}>Продолжить разговор</button>
        <button className="secondary" disabled={busy} onClick={onFinishFallback}>Завершить интервью</button>
      </>}
    </div>
    <p className="notice">Говорите свободно. После паузы интервьюер продолжит разговор. По завершении появится отчёт.</p>
    {realtime.error && <div className="error" role="alert">{realtime.error}</div>}
    {(realtime.transcript || realtime.partial) && <div className="transcript-card"><div className="transcript-heading">Ваш ответ</div><p className="live-transcript">{realtime.transcript} <span className="partial-transcript">{realtime.partial}</span></p></div>}
  </div>;
}
