import { useEffect, useRef, useState } from 'react';
import { openMicrophone } from './audio/microphone.mjs';
import workletURL from './audio/pcm-worklet.js?worker&url';

export default function useVoiceInput({ session, answer, onAnswer, onActive }) {
  const [state, setState] = useState('idle');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const current = useRef(null);
  const callbacks = useRef({ onAnswer, onActive });
  callbacks.current = { onAnswer, onActive };
  function dispose(run) {
    clearTimeout(run.timeout); clearInterval(run.clock);
    run.controller.abort();
    run.mic?.cancel();
    if (run.ws) { run.ws.onopen = run.ws.onmessage = run.ws.onclose = run.ws.onerror = null; run.ws.close(); }
  }
  function cancel() {
    const run = current.current;
    current.current = null;
    if (run) dispose(run);
    setState('idle'); setLevel(0); setPartial('');
    callbacks.current.onActive(false);
  }
  useEffect(() => () => {
    const run = current.current;
    current.current = null;
    if (run) dispose(run);
  }, []);

  async function start() {
    if (current.current) return;
    const run = { base: answer.trim(), final: '', partial: '', ws: null, mic: null, controller: new AbortController() };
    const combined = text => [run.base, text].filter(Boolean).join(' ').trim();
    current.current = run;
    setError(''); setPartial(''); setSeconds(0); setState('permission');
    callbacks.current.onActive(true);
    function complete(message, uncertain = false) {
      if (current.current !== run) return;
      current.current = null;
      // On failure preserve the last partial as an editable draft, never send it automatically.
      const value = combined([run.final, uncertain ? run.partial : ''].filter(Boolean).join(' '));
      callbacks.current.onAnswer(value.slice(0, 4000));
      dispose(run);
      setState('idle'); setPartial(''); setLevel(0);
      setError(message || (!run.final ? 'Речь не распознана. Попробуйте ещё раз или ответьте текстом.' : ''));
      callbacks.current.onActive(false);
    }
    try {
      run.mic = await openMicrophone((buffer, rms) => {
        if (current.current !== run || run.ws?.readyState !== WebSocket.OPEN) return;
        if (run.ws.bufferedAmount > 64000) return complete('Соединение не успевает передавать аудио. Полученный текст сохранён.', true);
        run.ws.send(buffer);
        setLevel(rms);
      }, { signal: run.controller.signal, moduleURL: workletURL });
      if (current.current !== run) { run.mic.cancel(); return; }
      setState('connecting');
      const url = new URL('/api/speech/recognize', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('sessionId', session.id);
      url.searchParams.set('revision', session.revision);
      run.ws = new WebSocket(url);
      run.timeout = setTimeout(() => complete('Не удалось подключиться к распознаванию. Попробуйте снова или перейдите к тексту.', true), 12000);
      run.ws.onerror = () => complete('Распознавание недоступно. Проверьте соединение или перейдите к тексту.', true);
      run.ws.onclose = () => complete('Соединение прервалось. Полученный текст сохранён в черновике.', true);
      run.ws.onmessage = async ({ data }) => {
        if (current.current !== run) return;
        let event;
        try { event = JSON.parse(data); } catch { return complete('Получен некорректный ответ распознавания.', true); }
        if (event.type === 'ready') {
          clearTimeout(run.timeout);
          setState('recording');
          run.mic.start();
          run.clock = setInterval(() => setSeconds(value => value + 1), 1000);
        } else if (event.type === 'transcript') {
          run.final = event.text || '';
          run.partial = event.partial || '';
          if (combined(run.final).length + run.partial.length > 4000) return complete('Ответ достиг лимита 4000 символов. Проверьте текст перед отправкой.', true);
          callbacks.current.onAnswer(combined(run.final));
          setPartial(run.partial);
        } else if (event.type === 'finishing') {
          setState('finishing'); clearInterval(run.clock); setLevel(0);
          await run.mic.finish();
        } else if (event.type === 'done' || event.type === 'error') {
          run.final = event.text || run.final;
          run.partial = event.partial || '';
          complete(event.message || (event.partial ? 'Последняя фраза не подтверждена. Проверьте расшифровку.' : ''), Boolean(event.partial));
        }
      };
    } catch (e) { complete(e.message || 'Не удалось включить микрофон.', true); }
  }
  async function finish() {
    const run = current.current;
    if (!run) return;
    if (state !== 'recording') return cancel();
    setState('finishing'); setLevel(0); clearInterval(run.clock);
    await run.mic.finish();
    if (current.current === run && run.ws?.readyState === WebSocket.OPEN) run.ws.send(JSON.stringify({ type: 'finish' }));
  }
  return { state, partial, error, level, seconds, start, finish, cancel, active: state !== 'idle' };
}
