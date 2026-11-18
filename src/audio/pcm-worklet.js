import { PCMEncoder } from './pcm.mjs';

class InterviewPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.encoder = new PCMEncoder(sampleRate, (buffer, level) => this.port.postMessage({ type: 'audio', buffer, level }, [buffer]));
    this.port.onmessage = ({ data }) => {
      if (data.type === 'flush') {
        this.active = false;
        this.encoder.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    this.encoder.push(mono);
    return true;
  }
}
registerProcessor('interview-pcm', InterviewPCM);
