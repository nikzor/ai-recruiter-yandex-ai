export async function openMicrophone(onChunk, { signal, moduleURL, environment = globalThis } = {}) {
  if (!environment.navigator?.mediaDevices?.getUserMedia || !environment.AudioWorkletNode || !environment.AudioContext) throw new Error('В этом браузере недоступен голосовой ввод. Используйте Chrome, Edge или Safari с HTTPS либо localhost.');
  let stream;
  let context;
  let source;
  let node;
  let disposed = false;
  let flushDone;
  const cancel = () => {
    if (disposed) return;
    disposed = true;
    stream?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    if (node) { node.port.onmessage = null; node.disconnect(); }
    context?.close().catch(() => {});
    flushDone?.();
    signal?.removeEventListener('abort', cancel);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    stream = await environment.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (signal?.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Отменено', 'AbortError'); }
    try { context = new environment.AudioContext({ sampleRate: 16000 }); } catch { context = new environment.AudioContext(); }
    await context.resume();
    await context.audioWorklet.addModule(moduleURL);
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    if (stream.getAudioTracks().some(track => track.readyState === 'ended')) throw new Error('Микрофон отключён. Подключите его и попробуйте снова.');
    source = context.createMediaStreamSource(stream);
    node = new environment.AudioWorkletNode(context, 'interview-pcm');
    node.port.onmessage = ({ data }) => {
      if (data.type === 'audio') onChunk(data.buffer, data.level);
      if (data.type === 'flushed') flushDone?.();
    };
    // The processor emits silence to the destination; captured microphone audio is never monitored.
    node.connect(context.destination);
    return {
      start() { if (!disposed) source.connect(node); },
      cancel,
      async finish() {
        if (disposed) return;
        let timeout;
        await new Promise(resolve => { flushDone = resolve; timeout = setTimeout(resolve, 300); node.port.postMessage({ type: 'flush' }); });
        clearTimeout(timeout);
        cancel();
      },
    };
  } catch (error) {
    cancel();
    if (['NotAllowedError', 'SecurityError'].includes(error.name)) throw new Error('Доступ к микрофону запрещён. Разрешите его в настройках сайта или перейдите к тексту.');
    if (['NotFoundError', 'NotReadableError'].includes(error.name)) throw new Error('Микрофон не найден или занят другим приложением. Можно ответить текстом.');
    throw error;
  }
}
