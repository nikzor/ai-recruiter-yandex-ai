import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimePlayback } from '../src/audio/realtime-playback.mjs';

function fixture() {
  const state = { nodes: [], buffers: [], closed: 0, statuses: [] };
  class Context {
    constructor() { state.context = this; }
    currentTime = 1;
    destination = {};
    resume() { return Promise.resolve(); }
    createBuffer(channels, length, sampleRate) {
      const samples = new Float32Array(length);
      const buffer = { duration: length / sampleRate, samples, sampleRate, getChannelData: () => samples };
      state.buffers.push(buffer);
      return buffer;
    }
    createBufferSource() {
      const node = { connect() {}, disconnect() { node.disconnected = true; }, start(time) { node.time = time; }, stop() { node.stopped = true; } };
      state.nodes.push(node);
      return node;
    }
    close() { state.closed++; return Promise.resolve(); }
  }
  const player = createRealtimePlayback({ environment: { AudioContext: Context, atob: value => Buffer.from(value, 'base64').toString('binary') }, onSpeaking: value => state.statuses.push(value) });
  return { player, state };
}
test('Realtime PCM playback: signed little endian, declared sample rate and ordered scheduling', async () => {
  const { player, state } = fixture();
  await player.ready;
  player.enqueue(Buffer.from([0, 128, 255, 127]).toString('base64'), 24000);
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  assert.equal(state.buffers[0].sampleRate, 24000);
  assert.equal(state.buffers[0].samples[0], -1);
  assert.equal(state.buffers[0].samples[1], 32767 / 32768);
  assert.equal(state.nodes[1].time, state.nodes[0].time + 2 / 24000);
  assert.equal(state.statuses.at(-1), true);
  state.nodes[0].onended();
  assert.equal(state.statuses.at(-1), true);
  state.nodes[1].onended();
  assert.equal(state.statuses.at(-1), false);
  player.close();
});
test('Realtime PCM playback: a packet arriving near the queue end remains sample-contiguous', () => {
  const { player, state } = fixture();
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  const end = state.nodes[0].time + state.buffers[0].duration;
  // Five milliseconds remain: the old per-packet 15 ms lead-in inserted a gap.
  state.context.currentTime = end - .005;
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  assert.equal(state.nodes[1].time, end);
  assert.equal(state.nodes[0].time, 1.06);
  player.close();
});
test('Realtime PCM playback: after an actual underrun a new jitter buffer is applied once', () => {
  const { player, state } = fixture();
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  state.context.currentTime = state.nodes[0].time + state.buffers[0].duration + .01;
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  assert.equal(state.nodes[1].time, state.context.currentTime + .06);
  const end = state.nodes[1].time + state.buffers[1].duration;
  player.enqueue(Buffer.alloc(3200).toString('base64'), 16000);
  assert.equal(state.nodes[2].time, end);
  player.close();
});
test('Realtime PCM playback: interruption clears all scheduled sources, close is idempotent', () => {
  const { player, state } = fixture();
  player.enqueue(Buffer.alloc(3200).toString('base64'));
  player.enqueue(Buffer.alloc(3200).toString('base64'));
  player.stop();
  assert.ok(state.nodes.every(n => n.stopped && n.disconnected && !n.onended));
  assert.equal(state.statuses.at(-1), false);
  player.close(); player.close();
  assert.equal(state.closed, 1);
  player.enqueue(Buffer.alloc(3200).toString('base64'));
  assert.equal(state.nodes.length, 2);
});
test('Realtime PCM playback: malformed PCM, unsupported rates and unbounded queue are rejected', () => {
  const { player } = fixture();
  assert.throws(() => player.enqueue(Buffer.alloc(3).toString('base64')), /некорректное/);
  assert.throws(() => player.enqueue(Buffer.alloc(4).toString('base64'), 12345), /частота/);
  assert.throws(() => player.enqueue(Buffer.alloc(16000 * 2 * 31).toString('base64')), /переполнена/);
  player.close();
});

test('Realtime MP3 playback: the entire utterance is decoded once and rendered by a single source', async () => {
  const { player, state } = fixture();
  let decoded;
  state.context.decodeAudioData = async data => { decoded = Buffer.from(data); return { duration: 3 }; };
  await player.enqueueEncoded(Buffer.from('ID3compressed-utterance').toString('base64'), 'audio/mpeg');
  assert.equal(decoded.toString(), 'ID3compressed-utterance');
  assert.equal(state.nodes.length, 1);
  assert.equal(state.nodes[0].buffer.duration, 3);
  assert.equal(state.nodes[0].time, 1.06);
  player.stop();
  assert.equal(state.nodes[0].stopped, true);
  player.close();
});
test('Realtime MP3 playback: barge-in during decoding discards late decoded audio', async () => {
  const { player, state } = fixture();
  let finishDecode;
  state.context.decodeAudioData = () => new Promise(resolve => { finishDecode = resolve; });
  const decoding = player.enqueueEncoded(Buffer.from('ID3audio').toString('base64'), 'audio/mpeg');
  player.stop();
  finishDecode({ duration: 3 });
  await decoding;
  assert.equal(state.nodes.length, 0);
  await assert.rejects(player.enqueueEncoded('AA==', 'audio/unknown'), /формат/);
  player.close();
});
