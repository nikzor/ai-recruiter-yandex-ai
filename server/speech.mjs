import { AppError } from './provider.mjs';

export function createSpeechProvider(env = process.env, fetcher = fetch, { timeoutMs = 30000 } = {}) {
  const apiKey = env.API_KEY?.trim() || env.YANDEX_API_KEY?.trim();
  const enabled = env.AI_MODE === 'yandex' && Boolean(apiKey) && env.TTS_ENABLED !== 'false';
  return {
    enabled,
    async synthesize(text, { signal, pcm = false, onChunk } = {}) {
      if (!enabled) throw new AppError(503, 'Озвучивание SpeechKit выключено. Продолжайте текстом.');
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new AppError(400, 'Вопрос для озвучивания должен содержать от 1 до 4000 символов.');
      const body = new URLSearchParams({ text, lang: 'ru-RU', voice: env.TTS_VOICE || 'filipp', format: pcm ? 'lpcm' : 'mp3', speed: '1.0', ...(pcm ? { sampleRateHertz: '16000' } : {}) }).toString();
      if (Buffer.byteLength(body) > 15000) throw new AppError(400, 'Вопрос слишком длинный для озвучивания. Продолжайте текстом.');
      const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      try {
        const response = await fetcher('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
          method: 'POST', signal: requestSignal,
          headers: { Authorization: `Api-Key ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status)) throw new AppError(502, 'SpeechKit: проверьте ключ, роль ai.speechkit-tts.user и область действия ключа для синтеза речи. Можно продолжить текстом.');
          if (response.status === 429) throw new AppError(429, 'Лимит SpeechKit исчерпан. Попробуйте позже или продолжайте текстом.');
          throw new AppError(502, 'SpeechKit не смог озвучить вопрос. Повторите или продолжайте текстом.');
        }
        const audioType = pcm ? /^(audio\/(x-pcm|pcm|l16)|application\/octet-stream)(;|$)/i : /^(audio\/(mpeg|mp3)|application\/octet-stream)(;|$)/i;
        if (!audioType.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw new AppError(502, 'SpeechKit вернул некорректное аудио. Продолжайте текстом.');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new AppError(502, 'Аудио SpeechKit слишком большое. Продолжайте текстом.');
          chunks.push(chunk);
          onChunk?.(Buffer.from(chunk));
        }
        if (!size) throw new AppError(502, 'SpeechKit вернул пустое аудио. Повторите запрос.');
        return Buffer.concat(chunks);
      } catch (error) {
        if (signal?.aborted) throw new AppError(499, 'Озвучивание отменено.');
        if (error instanceof AppError) throw error;
        throw new AppError(504, 'SpeechKit недоступен или не ответил вовремя. Повторите или продолжайте текстом.');
      }
    },
  };
}
