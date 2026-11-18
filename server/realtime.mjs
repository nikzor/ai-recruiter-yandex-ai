import { WebSocket } from 'ws';

export const REALTIME_SAMPLE_RATE = 44100;
export const MICROPHONE_SAMPLE_RATE = 16000;

export function createRealtimeProvider(env = process.env, { socketFactory = (url, options) => new WebSocket(url, options) } = {}) {
  const apiKey = env.API_KEY?.trim() || env.YANDEX_API_KEY?.trim();
  const folder = env.YANDEX_FOLDER_ID?.trim();
  const name = env.REALTIME_MODEL?.trim() || 'speech-realtime-deepseek-v4-flash';
  const model = name.startsWith('gpt://') ? name : `gpt://${folder}/${name}`;
  return {
    enabled: env.AI_MODE === 'yandex' && Boolean(apiKey && folder) && env.REALTIME_ENABLED !== 'false',
    sampleRate: REALTIME_SAMPLE_RATE,
    voice: env.REALTIME_VOICE?.trim() || 'filipp',
    speechMode: env.REALTIME_TTS === 'native' ? 'native' : 'speechkit',
    open() {
      if (!this.enabled) throw new Error('Realtime выключен.');
      const url = new URL('wss://ai.api.cloud.yandex.net/v1/realtime/openai');
      url.searchParams.set('model', model);
      return socketFactory(url.toString(), { headers: { Authorization: `Api-Key ${apiKey}` }, handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
    },
  };
}

// Preserve interpolation state across browser chunks, including their boundary sample.
export function createPcmResampler(inputRate = MICROPHONE_SAMPLE_RATE, outputRate = REALTIME_SAMPLE_RATE) {
  let previous = null;
  let position = 0;
  const step = inputRate / outputRate;
  return chunk => {
    const samples = Array.from({ length: chunk.length / 2 }, (_, i) => chunk.readInt16LE(i * 2));
    if (previous !== null) samples.unshift(previous);
    const result = [];
    while (position < samples.length - 1) {
      const left = Math.floor(position);
      result.push(Math.round(samples[left] + (samples[left + 1] - samples[left]) * (position - left)));
      position += step;
    }
    position -= samples.length - 1;
    previous = samples.at(-1);
    const output = Buffer.allocUnsafe(result.length * 2);
    result.forEach((sample, i) => output.writeInt16LE(sample, i * 2));
    return output;
  };
}

export function realtimeSession(question, voice = 'filipp') {
  return {
    type: 'realtime',
    instructions: `Ты голосовой интерфейс учебного интервью. Произнеси дословно только следующий вопрос: ${JSON.stringify(question)}. Не добавляй приветствие или комментарии, не отвечай на вопрос сам. После речи пользователя молчи. Не оценивай ответ, не задавай следующий вопрос, не меняй сценарий интервью.`,
    output_modalities: ['audio'],
    audio: {
      input: { format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE }, turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 1200 } },
      output: { format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE }, voice },
    },
    tools: [],
  };
}
