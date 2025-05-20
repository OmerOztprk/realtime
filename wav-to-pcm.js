import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';

const fsExists = promisify(fs.exists);
const fsReaddir = promisify(fs.readdir);
const fsMkdir = promisify(fs.mkdir);

class AudioConverter {
  constructor(options = {}) {
    this.ambientDir = options.ambientDir || path.join(process.cwd(), 'ambient');
    this.sampleRate = options.sampleRate || 24000;
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg'; // FFmpeg executable path
    this.targetFormat = { name: 'office-ambient.pcm', description: 'Ofis ortamı' };
  }

  /**
   * FFmpeg'in kurulu olup olmadığını kontrol eder
   */
  async checkFFmpeg() {
    return new Promise((resolve) => {
      const ffmpeg = spawn(this.ffmpegPath, ['-version']);

      ffmpeg.on('error', () => {
        resolve(false);
      });

      ffmpeg.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }

  /**
   * WAV dosyasını PCM formatına dönüştürür
   */
  async convertWavToPcm(inputFile, outputFile) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(this.ffmpegPath, [
        '-i', inputFile,
        '-ar', this.sampleRate.toString(),
        '-ac', '1',
        '-f', 's16le',
        outputFile
      ]);

      let errorOutput = '';

      ffmpeg.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`FFmpeg çıkış kodu: ${code}, Hata: ${errorOutput}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`FFmpeg çalıştırma hatası: ${err.message}`));
      });
    });
  }

  /**
   * Ambient klasöründeki WAV dosyalarını PCM'e dönüştürür
   */
  async processAmbientFiles() {
    try {
      // FFmpeg kontrolü
      const ffmpegInstalled = await this.checkFFmpeg();
      if (!ffmpegInstalled) {
        console.error('❌ FFmpeg kurulu değil! Otomatik dönüşüm yapılamayacak.');
        console.error('🔍 FFmpeg\'i şuradan indirebilirsiniz: https://ffmpeg.org/download.html');
        return { success: false, error: 'FFmpeg kurulu değil' };
      }

      // Ambient klasörünü oluştur (yoksa)
      if (!await fsExists(this.ambientDir)) {
        await fsMkdir(this.ambientDir, { recursive: true });
        console.log(`📂 Ambiyans klasörü oluşturuldu: ${this.ambientDir}`);
      }

      // Klasördeki dosyaları kontrol et
      const files = await fsReaddir(this.ambientDir);

      // WAV dosyalarını filtrele
      const wavFiles = files.filter(file =>
        file.toLowerCase().endsWith('.wav')
      );

      if (wavFiles.length === 0) {
        console.log(`⚠️ ${this.ambientDir} klasöründe WAV dosyası bulunamadı.`);
        return { success: false, error: 'WAV dosyası bulunamadı' };
      }

      // Mevcut PCM dosyasını kontrol et
      const targetPcmExists = files.includes(this.targetFormat.name);

      if (targetPcmExists) {
        console.log('✅ PCM dosyası zaten mevcut, dönüştürme atlanıyor.');
        return { success: true, converted: 0, existing: 1 };
      }

      console.log(`🔄 ${this.targetFormat.name} dosyası dönüştürülecek...`);

      // İlk WAV dosyasından PCM dosyası oluştur
      const wavFile = wavFiles[0];
      const inputPath = path.join(this.ambientDir, wavFile);
      const outputPath = path.join(this.ambientDir, this.targetFormat.name);

      console.log(`🔄 Dönüştürülüyor: ${wavFile} → ${this.targetFormat.name} (${this.targetFormat.description})`);

      try {
        await this.convertWavToPcm(inputPath, outputPath);
        console.log(`✅ Dönüştürme tamamlandı: ${this.targetFormat.name}`);
        
        return {
          success: true,
          converted: 1,
          existing: 0,
          total: 1
        };
      } catch (err) {
        console.error(`❌ Dönüştürme hatası (${this.targetFormat.name}): ${err.message}`);
        return { success: false, error: err.message };
      }
    } catch (err) {
      console.error(`❌ Dönüştürme işlemi hatası: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

export default AudioConverter;