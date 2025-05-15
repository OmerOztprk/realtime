// ----- MODÜL İMPORTLARI -----
import fs from 'fs';
import path from 'path';
import AudioConverter from './wav-to-pcm.js';

class AudioMixer {
  constructor(options = {}) {
    this.ambientVolume = options.ambientVolume || 0.15;
    this.voiceVolume = options.voiceVolume || 0.9;
    this.ambientBuffers = [];
    this.ambientPosition = 0;
    this.isLoaded = false;
    this.sampleRate = 24000;
    
    this.ambientDir = options.ambientDir || path.join(process.cwd(), 'ambient');
    
    this.ambientTypes = [
      'office-ambient.pcm',
      'office-busy.pcm',
      'office-quiet.pcm'
    ];
    
    this.currentAmbient = 0;
    
    this.converter = new AudioConverter({
      ambientDir: this.ambientDir,
      sampleRate: this.sampleRate
    });
  }
  
  // ----- AMBİYANS SES YÜKLEME -----
  async loadAmbient() {
    try {
      if (!fs.existsSync(this.ambientDir)) {
        fs.mkdirSync(this.ambientDir, { recursive: true });
        console.log(`📂 Ambiyans ses klasörü oluşturuldu: ${this.ambientDir}`);
      }
      
      const ambientPath = path.join(this.ambientDir, this.ambientTypes[this.currentAmbient]);
      
      if (!fs.existsSync(ambientPath)) {
        console.log(`⚠️ PCM dosyası bulunamadı: ${ambientPath}, dönüştürme deneniyor...`);
        
        const conversionResult = await this.converter.processAmbientFiles();
        
        if (!conversionResult.success) {
          console.log(`⚠️ Otomatik dönüştürme başarısız. Lütfen ambient klasörüne PCM16 formatında ses dosyaları ekleyin.`);
          return false;
        }
        
        if (!fs.existsSync(ambientPath)) {
          console.log(`⚠️ Dönüştürmeden sonra bile ${this.ambientTypes[this.currentAmbient]} bulunamadı.`);
          
          for (let i = 0; i < this.ambientTypes.length; i++) {
            const altPath = path.join(this.ambientDir, this.ambientTypes[i]);
            if (fs.existsSync(altPath)) {
              this.currentAmbient = i;
              console.log(`🔄 Alternatif PCM dosyasına geçildi: ${this.ambientTypes[i]}`);
              break;
            }
          }
          
          if (!fs.existsSync(path.join(this.ambientDir, this.ambientTypes[this.currentAmbient]))) {
            return false;
          }
        }
      }
      
      const ambientData = fs.readFileSync(path.join(this.ambientDir, this.ambientTypes[this.currentAmbient]));
      
      const arrayBuffer = ambientData.buffer.slice(
        ambientData.byteOffset, 
        ambientData.byteOffset + ambientData.byteLength
      );
      
      this.ambientBuffers = new Int16Array(arrayBuffer);
      this.ambientPosition = 0;
      this.isLoaded = true;
      
      console.log(`🔊 Ambiyans ses yüklendi: ${this.ambientTypes[this.currentAmbient]} (${(ambientData.length / 1024).toFixed(1)} KB)`);
      console.log(`ℹ️ Ambient buffer uzunluğu: ${this.ambientBuffers.length} örnek`);
      return true;
    } catch (err) {
      console.error(`❌ Ambiyans ses yükleme hatası: ${err.message}`);
      return false;
    }
  }
  
  // ----- AMBİYANS DEĞİŞTİRME -----
  async switchAmbient() {
    this.currentAmbient = (this.currentAmbient + 1) % this.ambientTypes.length;
    return this.loadAmbient();
  }
  
  // ----- SES MİKSLEME FONKSİYONU -----
  mixAudioBuffer(voiceBuffer) {
    if (!this.isLoaded || !voiceBuffer || voiceBuffer.byteLength === 0) {
      return voiceBuffer;
    }
    
    try {
      const voiceView = new DataView(voiceBuffer);
      const resultBuffer = new ArrayBuffer(voiceBuffer.byteLength);
      const resultView = new DataView(resultBuffer);
      
      const sampleCount = Math.floor(voiceBuffer.byteLength / 2);
      
      console.log(`Miksleniyor: ${sampleCount} örnek`);
      
      for (let i = 0; i < sampleCount; i++) {
        if (this.ambientPosition >= this.ambientBuffers.length) {
          this.ambientPosition = 0;
        }
        
        const voiceSample = voiceView.getInt16(i*2, true);
        const ambientSample = this.ambientBuffers[this.ambientPosition];
        
        const voiceNormalized = (voiceSample / 32767) * this.voiceVolume;
        const ambientNormalized = (ambientSample / 32767) * this.ambientVolume;
        
        let mixedSample = voiceNormalized + ambientNormalized;
        
        mixedSample = Math.max(-1.0, Math.min(1.0, mixedSample));
        
        const finalSample = Math.round(mixedSample * 32767);
        
        resultView.setInt16(i*2, finalSample, true);
        
        this.ambientPosition++;
      }
      
      if (process.env.DEBUG) {
        const debugSamples = 5;
        console.log("İlk birkaç örnek (ham ses, ambiyans, mikslenen):");
        for (let i = 0; i < debugSamples && i < sampleCount; i++) {
          const originalSample = voiceView.getInt16(i*2, true);
          const ambientSample = this.ambientBuffers[i % this.ambientBuffers.length];
          const mixedSample = resultView.getInt16(i*2, true);
          console.log(`Örnek ${i}: Ses=${originalSample}, Ambiyans=${ambientSample}, Miks=${mixedSample}`);
        }
      }
      
      return resultBuffer;
    } catch (err) {
      console.error(`❌ Ses miksleme hatası: ${err.message}`);
      return voiceBuffer;
    }
  }
  
  // ----- SES SEVİYESİ AYARLAMA -----
  setLevels(ambientVolume, voiceVolume) {
    if (ambientVolume !== undefined) {
      this.ambientVolume = Math.max(0, Math.min(1, ambientVolume/100));
    }
    
    if (voiceVolume !== undefined) {
      this.voiceVolume = Math.max(0, Math.min(1, voiceVolume/100));
    }
    
    return { ambientVolume: this.ambientVolume, voiceVolume: this.voiceVolume };
  }
}

export default AudioMixer;