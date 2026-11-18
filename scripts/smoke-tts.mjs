import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpeechProvider } from '../server/speech.mjs';

try {
  const speech = createSpeechProvider();
  console.log('SpeechKit TTS v1: один платный запрос, без повторов.');
  const audio = await speech.synthesize('Расскажи, чем StatefulWidget отличается от StatelessWidget во Flutter. Когда нужен setState, и как работают Future, async и await?');
  const path = join(tmpdir(), 'flutter-interview-tts-smoke.mp3');
  await writeFile(path, audio, { mode: 0o600 });
  console.log(`Синтез успешен: ${audio.length} байт MP3. Файл: ${path}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
