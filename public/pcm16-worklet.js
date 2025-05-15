/* AudioWorklet: Float32 ➜ PCM16 (little‑endian) */
class PCM16 extends AudioWorkletProcessor {
  constructor() {
    super();
    // Optimum performans için değerler
    this.bufferSize = 512;  // Daha küçük buffer daha düşük gecikme
    this.processorCalled = 0;
  }
  
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch || ch.length === 0) return true;
    
    this.processorCalled++;
    
    // Float32 -> Int16 dönüşümü
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      // -1 ile 1 arasına sınırla
      const s = Math.max(-1, Math.min(1, ch[i]));
      // Int16 formatına dönüştür (-32768 ile 32767 arası)
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    
    // Buffer'ı ana thread'e gönder
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm16", PCM16);