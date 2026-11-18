import { useEffect, useRef, useState } from 'react';
import { openMicrophone } from './audio/microphone.mjs';
import { createRealtimePlayback } from './audio/realtime-playback.mjs';
import workletURL from './audio/pcm-worklet.js?worker&url';

// Called directly by the setup button, before the HTTP session request.
export function prepareRealtimeInput() {
  const resource = { controller: new AbortController(), onChunk: () => {}, onSpeaking: () => {} };
  resource.close = () => { resource.controller.abort(); resource.mic?.cancel(); resource.player?.close(); };
  try {
    resource.player = createRealtimePlayback({ onSpeaking: value => resource.onSpeaking(value) });
    resource.ready = Promise.all([
      resource.player.ready,
      openMicrophone(buffer => resource.onChunk(buffer), { signal: resource.controller.signal, moduleURL: workletURL }).then(mic => { resource.mic = mic; }),
    ]).then(() => resource).catch(error => { resource.close(); throw error; });
  } catch (error) { resource.close(); resource.ready = Promise.reject(error); }
  return resource;
}

export default function useRealtimeInput({ session, prepared, onSession, onActive, onFinishFallback }) {
  const [state, setState] = useState('idle');
  const [speaking, setSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const current = useRef(null);
  const callbacks = useRef({ onSession, onActive, onFinishFallback });
  callbacks.current = { onSession, onActive, onFinishFallback };
  function dispose(run) {
    clearTimeout(run.timeout); clearInterval(run.clock);
    run.resources.close();
    if (run.ws) { run.ws.onopen = run.ws.onmessage = run.ws.onclose = run.ws.onerror = null; run.ws.close(); }
  }
  useEffect(() => () => { const run = current.current; current.current = null; if (run) dispose(run); }, []);
  async function start(resources) {
    if (current.current) return;
    const run = { resources: resources || prepareRealtimeInput() };
    current.current = run;
    run.complete = (message = '') => {
      if (current.current !== run) return;
      current.current = null; dispose(run);
      setState('idle'); setSpeaking(false); setError(message);
      callbacks.current.onActive?.(false);
    };
    setError(''); setPartial(''); setTranscript(''); setSeconds(0); setState('permission');
    callbacks.current.onActive?.(true);
    run.resources.onSpeaking = value => { if (current.current === run) setSpeaking(value); };
    run.resources.onChunk = buffer => {
      if (current.current !== run || run.ws?.readyState !== WebSocket.OPEN || run.finishing) return;
      if (run.ws.bufferedAmount > 64000) return run.complete('Соединение не успевает передавать аудио. Подключитесь снова.');
      run.ws.send(buffer);
    };
    try {
      await run.resources.ready;
      if (current.current !== run) return;
      setState('connecting');
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { signal: run.resources.controller.signal });
      const latest = await response.json();
      if (current.current !== run) return;
      if (!response.ok) throw new Error(latest.error || 'Не удалось обновить интервью.');
      callbacks.current.onSession(latest);
      if (latest.status !== 'active') { run.complete(); return; }
      const url = new URL('/api/speech/realtime', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('sessionId', latest.id); url.searchParams.set('revision', latest.revision);
      run.ws = new WebSocket(url);
      run.timeout = setTimeout(() => run.complete('Realtime не подключился вовремя. Попробуйте подключиться снова.'), 20000);
      run.ws.onerror = () => run.complete('Realtime недоступен. Проверьте подключение и попробуйте снова.');
      run.ws.onclose = () => run.complete('Соединение закрыто. Сохранённые ответы доступны после повторного подключения.');
      run.ws.onmessage = async ({ data }) => {
        if (current.current !== run) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'ready') {
            clearTimeout(run.timeout); setState('listening'); run.resources.mic.start();
            run.clock = setInterval(() => setSeconds(v => v + 1), 1000);
          } else if (event.type === 'audio' && !run.finishing) run.resources.player.enqueue(event.audio, event.sampleRate || 44100);
          else if (event.type === 'audio_file' && !run.finishing) await run.resources.player.enqueueEncoded(event.audio, event.mimeType);
          else if (event.type === 'speech_start') { run.resources.player.stop(); setState('listening'); }
          else if (event.type === 'transcript') { setTranscript(event.text || ''); setPartial(event.partial || ''); }
          else if (event.type === 'session') {
            callbacks.current.onSession(event.session); setTranscript(''); setPartial('');
          } else if (event.type === 'status') {
            if (!run.finishing) setState(event.phase);
          } else if (event.type === 'finishing') {
            setState('finishing'); run.finishing = true; clearInterval(run.clock); run.resources.player.stop(); await run.resources.mic.finish();
          } else if (event.type === 'done') {
            if (event.session) callbacks.current.onSession(event.session);
            run.complete();
          } else if (event.type === 'error') {
            if (event.session) callbacks.current.onSession(event.session);
            setTranscript(event.text || ''); setPartial(event.partial || '');
            run.complete(event.message || 'Ошибка Realtime. Попробуйте подключиться снова.');
          }
        } catch { run.complete('Ошибка обработки Realtime. Подключитесь снова.'); }
      };
    } catch (e) { run.complete(e.message || 'Не удалось включить микрофон.'); }
  }
  useEffect(() => { if (prepared) start(prepared); }, [prepared]);
  async function finish() {
    const run = current.current;
    if (!run || run.finishing) return;
    if (run.ws?.readyState !== WebSocket.OPEN) {
      run.finishing = true;
      run.complete();
      await callbacks.current.onFinishFallback?.();
      return;
    }
    run.finishing = true; setState('finishing'); clearInterval(run.clock); run.resources.player.stop();
    await run.resources.mic.finish();
    if (current.current === run && run.ws?.readyState === WebSocket.OPEN) {
      run.ws.send(JSON.stringify({ type: 'finish' }));
      run.timeout = setTimeout(() => run.complete('Отчёт ещё готовится. Обновите сессию через несколько секунд.'), 120000);
    }
  }
  return { state, speaking, transcript, partial, error, seconds, active: state !== 'idle', start: () => start(), finish };
}
