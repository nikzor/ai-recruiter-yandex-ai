import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRealtimeProvider, createPcmResampler } from '../server/realtime.mjs';
import { attachRealtime } from '../server/realtime-socket.mjs';
import { createSpeechProvider } from '../server/speech.mjs';

// Paid, opt-in end-to-end cloud check. Synthetic phrases only; no candidate data.
const realtime = createRealtimeProvider({ ...process.env, AI_MODE: 'yandex' });
assert.equal(realtime.enabled, true, 'Set API_KEY and YANDEX_FOLDER_ID; enable Realtime.');
const openCloud = realtime.open.bind(realtime);
realtime.open = () => {
  const socket = openCloud();
  socket.on('message', raw => { const event = JSON.parse(raw); if (event.type === 'error') console.error('Cloud protocol code:', event.error?.code || event.error?.type, event.error?.message); });
  return socket;
};
const session = { id: 'smoke', updated: Date.now(), revision: 0, status: 'active', turns: [{ question: 'Расскажите о вашем опыте разработки.', answer: null }], report: null };
const provider = {
  nextTurn: async () => ({ action: 'question', question: 'Как вы проверяете качество своей работы?' }),
  question: async () => 'Как вы проверяете качество своей работы?',
  followup: async () => null,
  report: async s => ({ summary: `Synthetic smoke: ${s.turns.length} answers`, overallScore: 0 }),
};
const server = createServer();
const speech = createSpeechProvider({ ...process.env, AI_MODE: 'yandex' });
const syntheticAnswer = realtime.speechMode === 'speechkit' && speech.enabled ? await speech.synthesize('Я разрабатываю приложения на Flutter и проверяю качество автоматическими тестами.', { pcm: true }) : null;
attachRealtime(server, { sessions: new Map([[session.id, session]]), realtime, provider, speech });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/speech/realtime?sessionId=smoke&revision=0`, { origin });
let audio = [];
let feeding = false;
let rounds = 0;
let vad = 0;
let finishing = false;
let success = false;
let questionReadyAt;
let waitingForAudio = false;
let audioSampleRate = 44100;
let inputEpoch = 0;
const timer = setTimeout(() => { console.error('FAIL: continuous Realtime timeout'); process.exitCode = 1; ws.terminate(); server.close(); }, 90000);
ws.on('message', async raw => {
  const event = JSON.parse(raw);
  if (event.type === 'assistant_transcript') { questionReadyAt = performance.now(); waitingForAudio = true; inputEpoch++; feeding = false; audio = []; }
  if (['audio', 'audio_file'].includes(event.type) && waitingForAudio) {
    console.log(`Question ${rounds + 1}: first audio ${Math.round(performance.now() - questionReadyAt)} ms after question text`);
    waitingForAudio = false;
  }
  if (event.type === 'audio' && !feeding) { audioSampleRate = event.sampleRate; audio.push(Buffer.from(event.audio, 'base64')); }
  if (event.type === 'audio_file') {
    assert.equal(event.mimeType, 'audio/mpeg');
    assert(Buffer.from(event.audio, 'base64').length > 100);
    audioSampleRate = 16000;
    audio = [syntheticAnswer];
  }
  if (event.type === 'audio_done' && !feeding && audio.length && rounds < 2) {
    feeding = true;
    const epoch = inputEpoch;
    rounds++;
    const pcm = Buffer.concat([createPcmResampler(audioSampleRate, 16000)(Buffer.concat(audio)), Buffer.alloc(64000)]);
    audio = [];
    console.log(`Round ${rounds}: streamed cloud audio received; feeding synthetic 16 kHz microphone`);
    for (let offset = 0; offset < pcm.length && ws.readyState === WebSocket.OPEN && !finishing && epoch === inputEpoch; offset += 3200) {
      ws.send(pcm.subarray(offset, offset + 3200));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (epoch === inputEpoch) feeding = false;
  }
  if (event.type === 'speech_start') vad++;
  if (event.type === 'session' && event.session.turns.filter(turn => turn.answer).length >= 2 && !finishing) {
    finishing = true;
    ws.send(JSON.stringify({ type: 'finish' }));
  }
  if (event.type === 'done') {
    assert.equal(rounds, 2); assert(vad >= 2);
    assert.equal(event.session.status, 'completed');
    assert.equal(event.session.turns.length, 2);
    assert(event.session.turns.every(turn => turn.answer?.trim()));
    assert(event.session.report); assert.equal(session.realtimeBusy, false);
    success = true;
    console.log('PASS: same WebSocket, two autonomous questions, cloud audio, 16 kHz input resampling, VAD, final transcripts, whole-interview finish, partial report');
  }
  if (event.type === 'error') {
    console.error('FAIL:', event.message); process.exitCode = 1; ws.close();
  }
});
ws.on('unexpected-response', (_, response) => { console.error('FAIL: bridge HTTP', response.statusCode); response.resume(); ws.terminate(); process.exitCode = 1; });
ws.on('error', error => { console.error('FAIL: transport', error.code || error.name); process.exitCode = 1; });
ws.on('close', () => { clearTimeout(timer); if (!success) process.exitCode = 1; server.close(); });
