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
    this.targetFormats = [
      { name: 'office-ambient.pcm', description: 'Genel ofis ortamı' },
      { name: 'office-busy.pcm', description: 'Yoğun ofis ortamı' },
      { name: 'office-quiet.pcm', description: 'Sakin ofis ortamı' }
    ];
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
      
      // Mevcut PCM dosyalarını kontrol et
      const existingPcmFiles = this.targetFormats.filter(format => 
        files.includes(format.name)
      ).map(format => format.name);
      
      // Eksik PCM dosyalarını tespit et
      const missingPcmFiles = this.targetFormats
        .filter(format => !existingPcmFiles.includes(format.name));
      
      if (missingPcmFiles.length === 0) {
        console.log('✅ Tüm gerekli PCM dosyaları mevcut, dönüştürme atlanıyor.');
        return { success: true, converted: 0, existing: existingPcmFiles.length };
      }
      
      console.log(`🔄 ${missingPcmFiles.length} adet eksik PCM dosyası dönüştürülecek...`);
      
      // WAV dosyalarından PCM dosyaları oluştur
      const conversionPromises = [];
      
      for (let i = 0; i < Math.min(missingPcmFiles.length, wavFiles.length); i++) {
        const targetFormat = missingPcmFiles[i];
        const wavFile = wavFiles[i];
        const inputPath = path.join(this.ambientDir, wavFile);
        const outputPath = path.join(this.ambientDir, targetFormat.name);
        
        console.log(`🔄 Dönüştürülüyor: ${wavFile} → ${targetFormat.name} (${targetFormat.description})`);
        
        const conversionPromise = this.convertWavToPcm(inputPath, outputPath)
          .then(() => {
            console.log(`✅ Dönüştürme tamamlandı: ${targetFormat.name}`);
            return true;
          })
          .catch(err => {
            console.error(`❌ Dönüştürme hatası (${targetFormat.name}): ${err.message}`);
            return false;
          });
        
        conversionPromises.push(conversionPromise);
      }
      
      // Tüm dönüştürmelerin tamamlanmasını bekle
      const results = await Promise.all(conversionPromises);
      const successCount = results.filter(result => result).length;
      
      console.log(`🎉 Dönüştürme işlemi tamamlandı: ${successCount}/${conversionPromises.length} başarılı.`);
      
      return { 
        success: successCount > 0, 
        converted: successCount,
        existing: existingPcmFiles.length,
        total: successCount + existingPcmFiles.length
      };
    } catch (err) {
      console.error(`❌ Dönüştürme işlemi hatası: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

export default AudioConverter;