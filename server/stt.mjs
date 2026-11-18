import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { AppError } from './provider.mjs';

const definition = loadSync(fileURLToPath(new URL('./proto/recognizer.proto', import.meta.url)), { longs: String, enums: String, oneofs: true, defaults: true });
export const Recognizer = grpc.loadPackageDefinition(definition).speechkit.stt.v3.Recognizer;
export const recognitionOptions = {
  recognitionModel: {
    model: 'general',
    audioFormat: { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: 16000, audioChannelCount: 1 } },
    textNormalization: { textNormalization: 'TEXT_NORMALIZATION_ENABLED' },
    languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] },
    audioProcessingType: 'REAL_TIME',
  },
};

export function createRecognitionProvider(env = process.env, { clientFactory = () => new Recognizer('stt.api.cloud.yandex.net:443', grpc.credentials.createSsl()), deadlineMs = 140000 } = {}) {
  const apiKey = env.API_KEY?.trim() || env.YANDEX_API_KEY?.trim();
  return {
    enabled: env.AI_MODE === 'yandex' && Boolean(apiKey) && env.STT_ENABLED !== 'false',
    open() {
      if (!this.enabled) throw new AppError(503, 'Распознавание SpeechKit выключено. Выберите текстовый режим.');
      const client = clientFactory();
      const metadata = new grpc.Metadata();
      metadata.set('authorization', `Api-Key ${apiKey}`);
      const stream = client.recognizeStreaming(metadata, { deadline: Date.now() + deadlineMs });
      stream.once('status', () => client.close());
      return stream;
    },
  };
}

export function recognitionError(error) {
  if ([grpc.status.PERMISSION_DENIED, grpc.status.UNAUTHENTICATED].includes(error.code)) return 'SpeechKit: проверьте роль ai.speechkit-stt.user и область действия ключа для распознавания речи. Можно перейти к тексту.';
  if (error.code === grpc.status.RESOURCE_EXHAUSTED) return 'Лимит распознавания SpeechKit исчерпан. Сохраните расшифровку и продолжайте текстом.';
  return 'Распознавание прервалось. Уже полученный текст сохранён в черновике. Попробуйте снова или продолжайте текстом.';
}
