/* AudioWorklet: Float32 ➜ PCM16 (little‑endian) */
class PCM16 extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor("pcm16", PCM16);
