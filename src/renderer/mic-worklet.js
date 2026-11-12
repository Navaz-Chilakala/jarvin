class JarvinMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1024);
    this.used = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(this.chunk.length - this.used, samples.length - offset);
      this.chunk.set(samples.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.chunk.length) {
        const ready = this.chunk;
        this.port.postMessage(ready, [ready.buffer]);
        this.chunk = new Float32Array(1024);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('jarvin-mic', JarvinMicProcessor);
