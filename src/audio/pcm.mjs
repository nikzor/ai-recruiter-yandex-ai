// Stateful box-filter resampling. Fractional sample positions survive render-quantum boundaries.
export class PCMEncoder {
  constructor(inputRate, emit, frameSamples = 1600) {
    this.ratio = inputRate / 16000;
    this.emit = emit;
    this.frameSamples = frameSamples;
    this.frame = new ArrayBuffer(frameSamples * 2);
    this.view = new DataView(this.frame);
    this.offset = 0;
    this.weight = 0;
    this.sum = 0;
    this.energy = 0;
  }
  push(samples) {
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.view.setInt16(this.offset * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          this.energy += value * value;
          this.offset++;
          this.weight = 0;
          this.sum = 0;
          if (this.offset === this.frameSamples) this.flush();
        }
      }
    }
  }
  flush() {
    if (!this.offset) return;
    const frame = this.frame.slice(0, this.offset * 2);
    this.emit(frame, Math.sqrt(this.energy / this.offset));
    this.frame = new ArrayBuffer(this.frameSamples * 2);
    this.view = new DataView(this.frame);
    this.offset = 0;
    this.energy = 0;
  }
}
