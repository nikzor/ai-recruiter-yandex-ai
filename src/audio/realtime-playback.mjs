// PCM16 fragments arrive independently of network and audio render boundaries.
export function createRealtimePlayback({ environment = globalThis, onSpeaking = () => {} } = {}) {
  const context = new environment.AudioContext();
  const sources = new Set();
  let nextTime = 0;
  let closed = false;
  let generation = 0;
  const ready = context.resume();
  function stop() {
    generation++;
    for (const source of sources) {
      source.onended = null;
      try { source.stop(); } catch { /* Already ended. */ }
      source.disconnect();
    }
    sources.clear();
    nextTime = context.currentTime;
    onSpeaking(false);
  }
  function schedule(buffer) {
    const start = sources.size && nextTime > context.currentTime ? nextTime : context.currentTime + .06;
    if (start - context.currentTime + buffer.duration > 30) throw new Error('Очередь звука Realtime переполнена. Попробуйте снова.');
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => { sources.delete(source); source.disconnect(); if (!sources.size) onSpeaking(false); };
    sources.add(source);
    nextTime = start + buffer.duration;
    source.start(start);
    onSpeaking(true);
  }
  return {
    ready,
    async enqueueEncoded(base64, mimeType) {
      if (closed) return;
      if (mimeType !== 'audio/mpeg') throw new Error('Неподдерживаемый формат озвучивания.');
      const version = generation;
      const raw = environment.atob(base64);
      if (!raw.length || raw.length > 2 * 1024 * 1024) throw new Error('Некорректный размер аудио.');
      const data = Uint8Array.from(raw, char => char.charCodeAt(0));
      // Decode an entire utterance once. Browser codec/resampling preserves
      // continuity instead of rendering independent raw PCM fragments.
      const buffer = await context.decodeAudioData(data.buffer);
      if (closed || generation !== version) return;
      schedule(buffer);
    },
    enqueue(base64, sampleRate = 16000) {
      if (closed) return;
      if (![16000, 22050, 24000, 44100, 48000].includes(sampleRate)) throw new Error('Неподдерживаемая частота аудио Realtime.');
      const raw = environment.atob(base64);
      if (!raw.length || raw.length % 2) throw new Error('Получено некорректное аудио Realtime.');
      const buffer = context.createBuffer(1, raw.length / 2, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        let value = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8;
        if (value >= 32768) value -= 65536;
        samples[i] = value / 32768;
      }
      schedule(buffer);
    },
    stop,
    close() {
      if (closed) return;
      closed = true;
      stop();
      context.close().catch(() => {});
    },
  };
}
