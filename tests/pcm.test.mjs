import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMEncoder } from '../src/audio/pcm.mjs';

for (const rate of [16000, 44100, 48000]) test(`PCM ${rate} → 16000: длительность, little endian, границы блоков`, () => {
  function encode(blockSize) {
    const frames = [];
    const encoder = new PCMEncoder(rate, buffer => frames.push(Buffer.from(buffer)));
    const input = Float32Array.from({ length: rate }, (_, i) => .5 * Math.sin(2 * Math.PI * 440 * i / rate));
    for (let i = 0; i < input.length; i += blockSize) encoder.push(input.subarray(i, i + blockSize));
    encoder.flush();
    assert.equal(frames.length, 10);
    assert.ok(frames.every(f => f.length === 3200));
    return Buffer.concat(frames);
  }
  const audio = encode(128);
  assert.equal(audio.length, 32000);
  assert.deepEqual(audio, encode(rate));
  const samples = Array.from({ length: 16000 }, (_, i) => audio.readInt16LE(i * 2));
  assert.ok(Math.max(...samples) <= 16384);
  assert.ok(Math.max(...samples) > 16000);
});
test('PCM: отсечение амплитуды, последний неполный чанк, тишина', () => {
  const frames = [];
  const encoder = new PCMEncoder(16000, b => frames.push(Buffer.from(b)));
  encoder.push(new Float32Array([2, -2, 0, .5])); encoder.flush(); encoder.flush();
  assert.equal(frames.length, 1);
  assert.deepEqual([0, 1, 2, 3].map(i => frames[0].readInt16LE(i * 2)), [32767, -32768, 0, 16384]);
});
