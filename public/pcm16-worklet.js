/**
 * AudioWorklet: Float32 ➜ PCM16 (little‑endian)
 * Mikrofon verilerini OpenAI Realtime API için uygun formata dönüştürür
 */
class PCM16 extends AudioWorkletProcessor {
  constructor() {
    super();
    // Mikrofon gürültü eşiği
    this.noiseThreshold = 0.015;
  }
  
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch || ch.length === 0) return true;
    
    // Float32 -> Int16 dönüşümü (basit gürültü filtreleme ile)
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      // Gürültü filtreleme
      let s = Math.abs(ch[i]) < this.noiseThreshold ? 0 : ch[i];
      
      // -1 ile 1 arasına sınırla
      s = Math.max(-1, Math.min(1, s));
      
      // Int16 formatına dönüştür (-32768 ile 32767 arası)
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    
    // Buffer'ı ana thread'e gönder
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm16", PCM16);