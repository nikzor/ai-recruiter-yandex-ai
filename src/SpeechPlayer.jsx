import React, { useEffect, useRef, useState } from 'react';

export default function SpeechPlayer({ sessionId, questionNumber, disabled, autoPlay = false, onActivity }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const player = useRef({ audio: null, url: null, request: null });
  const attempted = useRef(false);
  function stop() {
    const p = player.current;
    p.request?.abort();
    p.request = null;
    if (p.audio) { p.audio.pause(); p.audio.currentTime = 0; }
    setStatus('idle');
    onActivity?.(false);
  }
  useEffect(() => {
    const p = player.current;
    return () => {
      p.request?.abort();
      if (p.audio) { p.audio.onended = null; p.audio.onerror = null; p.audio.pause(); p.audio.removeAttribute('src'); p.audio.load(); }
      if (p.url) URL.revokeObjectURL(p.url);
      onActivity?.(false);
    };
  }, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);
  useEffect(() => {
    if (autoPlay && !disabled && !attempted.current) { attempted.current = true; play(); }
  }, [autoPlay, disabled]);
  async function play() {
    const p = player.current;
    if (p.request) return;
    const controller = new AbortController();
    p.request = controller;
    setError('');
    onActivity?.(true);
    setStatus(p.audio ? 'playing' : 'loading');
    try {
      if (!p.audio) {
        const response = await fetch('/api/speech/synthesize', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionNumber }),
        });
        if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Не удалось озвучить вопрос.'); }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        p.url = URL.createObjectURL(blob);
        p.audio = new Audio(p.url);
        p.audio.onended = () => { setStatus('idle'); onActivity?.(false); };
        p.audio.onerror = () => { setStatus('idle'); onActivity?.(false); setError('Браузер не смог воспроизвести аудио. Продолжайте текстом.'); };
      }
      if (controller.signal.aborted) return;
      p.audio.currentTime = 0;
      await p.audio.play();
      if (controller.signal.aborted) return;
      setStatus('playing');
    } catch (e) {
      if (!controller.signal.aborted) {
        setStatus('idle');
        onActivity?.(false);
        setError(e.name === 'NotAllowedError' ? 'Браузер заблокировал звук. Нажмите «Повторить».' : e.message === 'Failed to fetch' ? 'Не удалось связаться с сервером озвучивания. Продолжайте текстом.' : e.message);
      }
    } finally { if (p.request === controller) p.request = null; }
  }
  const active = status !== 'idle';
  return <div className="speech-player">
    <div className="speech-controls">
      <button type="button" className="secondary" disabled={disabled} onClick={active ? stop : play}>{status === 'loading' ? 'Отменить озвучивание' : status === 'playing' ? 'Остановить' : player.current.audio ? 'Повторить' : 'Озвучить вопрос'}</button>
      <small role="status">{status === 'loading' ? 'Готовим аудио…' : status === 'playing' ? 'Воспроизводится вопрос' : ''}</small>
    </div>
    {error && <p className="speech-error" role="alert">{error}</p>}
  </div>;
}
