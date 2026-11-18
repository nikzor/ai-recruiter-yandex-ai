import test from 'node:test';
import assert from 'node:assert/strict';
import { openMicrophone } from '../src/audio/microphone.mjs';

function fixture() {
  const state = { stopped: 0, closed: 0, connected: 0, disconnected: 0, chunks: [] };
  const track = { readyState: 'live', stop() { state.stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    constructor(options) { state.requestedRate = options?.sampleRate; this.audioWorklet = { addModule: async url => { state.module = url; } }; }
    resume() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() { state.connected++; }, disconnect() { state.disconnected++; } }; }
    close() { state.closed++; return Promise.resolve(); }
  }
  class Node {
    constructor() {
      this.port = { onmessage: null, postMessage: data => {
        assert.equal(data.type, 'flush');
        this.port.onmessage({ data: { type: 'audio', buffer: new ArrayBuffer(4), level: .3 } });
        this.port.onmessage({ data: { type: 'flushed' } });
      } };
    }
    connect() {}
    disconnect() {}
  }
  return { state, stream, environment: { navigator: { mediaDevices: { getUserMedia: async () => stream } }, AudioContext: Context, AudioWorkletNode: Node } };
}
test('Микрофон: захват начинается по start, finish отправляет остаток и освобождает ресурсы', async () => {
  const { state, environment } = fixture();
  const mic = await openMicrophone((buffer, level) => state.chunks.push({ buffer, level }), { environment, moduleURL: 'pcm.js' });
  assert.equal(state.connected, 0);
  assert.equal(state.requestedRate, 16000);
  assert.equal(state.module, 'pcm.js');
  mic.start();
  assert.equal(state.connected, 1);
  await mic.finish();
  assert.equal(state.chunks[0].buffer.byteLength, 4);
  assert.equal(state.chunks[0].level, .3);
  assert.equal(state.stopped, 1);
  assert.equal(state.closed, 1);
  mic.cancel();
  assert.equal(state.stopped, 1);
});
test('Микрофон: отмена во время запроса разрешения закрывает поздно полученный поток', async () => {
  const { state, environment, stream } = fixture();
  let grant;
  environment.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const controller = new AbortController();
  const pending = openMicrophone(() => {}, { environment, signal: controller.signal });
  controller.abort(); grant(stream);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(state.stopped, 1);
  assert.equal(state.closed, 0);
});
test('Микрофон: отказ разрешения, занятое устройство, ошибка worklet и неподдерживаемый браузер', async () => {
  for (const name of ['NotAllowedError', 'NotReadableError']) {
    const { environment } = fixture();
    environment.navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('private details', name); };
    await assert.rejects(openMicrophone(() => {}, { environment }), e => !e.message.includes('private details') && /текст/.test(e.message));
  }
  const { environment, state } = fixture();
  const Base = environment.AudioContext;
  environment.AudioContext = class extends Base {
    constructor(options) { super(options); this.audioWorklet.addModule = async () => { throw new Error('worklet failed'); }; }
  };
  await assert.rejects(openMicrophone(() => {}, { environment }), /worklet failed/);
  assert.equal(state.stopped, 1);
  assert.equal(state.closed, 1);
  await assert.rejects(openMicrophone(() => {}, { environment: {} }), /недоступен голосовой ввод/);
});
