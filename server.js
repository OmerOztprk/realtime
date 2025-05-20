/**
 * OpenAI Realtime API Sesli Asistan Sunucusu
 */

// ----- MODÜL İMPORTLARI -----
import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import AudioMixer from "./audio-mixer.js";

// ----- TEMEL YAPILANDIRMA -----
const { OPENAI_API_KEY, PORT = 3000 } = process.env;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY yok! .env dosyasında tanımlanmalı.");
  process.exit(1);
}

const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const OAI_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

// ----- EXPRESS SUNUCU KURULUMU -----
const app = express();
app.use(express.static("public"));
const server = http.createServer(app);

// ----- SES MİKSLEME KURULUMU -----
const audioMixer = new AudioMixer({
  ambientVolume: 0.50,
  voiceVolume: 0.95,
});

// Sunucu başlangıcında ambiyans sesini yükle
(async function () {
  await audioMixer.loadAmbient();
})();

// ----- BAĞLANTI YÖNETİMİ -----
const activeConnections = new Map();

function heartbeat() {
  this.isAlive = true;
}

// ----- WEBSOCKET SUNUCUSU -----
const wss = new WebSocketServer({ server, path: "/client" });

// ----- TARAYICI BAĞLANTISI KURULDUĞUNDA -----
wss.on("connection", (cli, req) => {
  const clientId = randomUUID();
  const clientIp = req.socket.remoteAddress;
  console.log(`🌐 Tarayıcı bağlandı [${clientId.slice(0, 8)}] (${clientIp})`);

  cli.isAlive = true;
  cli.on("pong", heartbeat);

  // OpenAI bağlantısı kur
  let oai = connectToOpenAI(clientId);

  // Ambiyans durumu özelliğini ekle
  activeConnections.set(clientId, {
    client: cli,
    openai: oai,
    lastActivity: Date.now(),
    ambientEnabled: true,
    ambientStreamActive: false, // Yeni özellik: aktif ambiyans akışı durumu
    ambientInterval: null  // Yeni özellik: ambiyans gönderim aralığı referansı
  });

  /**
   * OpenAI API bağlantısı oluşturur
   */
  function connectToOpenAI(id) {
    console.log(`📡 OpenAI bağlantısı başlatılıyor [${id.slice(0, 8)}] (${MODEL})`);

    const ws = new WebSocket(OAI_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      },
      perMessageDeflate: false
    });

    // ----- OPENAI MESAJ İŞLEME -----
    ws.on("message", (data, isBin) => {
      if (cli.readyState === WebSocket.OPEN) {
        try {
          let jsonData;
          let isAudioDelta = false;
          let audioBase64;

          if (!isBin) {
            try {
              const txt = data.toString();
              jsonData = JSON.parse(txt);

              if (jsonData.type === "response.audio.delta" && jsonData.delta) {
                isAudioDelta = true;
                audioBase64 = jsonData.delta;
              }
            } catch (parseError) {
              cli.send(data, { binary: isBin });
              return;
            }
          }

          // Ses verisi işleme ve miksleme
          if (isAudioDelta) {
            const conn = activeConnections.get(id);
            if (conn && conn.ambientEnabled && audioMixer.isLoaded) {
              try {
                process.env.DEBUG = conn.debugMode ? "true" : "";

                const audioBuffer = Buffer.from(audioBase64, 'base64');

                if (audioBuffer.length === 0) {
                  cli.send(JSON.stringify(jsonData));
                  return;
                }

                console.log(`🔊 Ses verisi alındı: ${audioBuffer.length} bayt`);

                const mixedBuffer = audioMixer.mixAudioBuffer(audioBuffer.buffer.slice(
                  audioBuffer.byteOffset,
                  audioBuffer.byteOffset + audioBuffer.byteLength
                ));

                const mixedBase64 = Buffer.from(new Uint8Array(mixedBuffer)).toString('base64');

                jsonData.delta = mixedBase64;

                cli.send(JSON.stringify(jsonData));
              } catch (mixError) {
                console.error(`❌ Ses miksleme hatası: ${mixError.message}`);
                cli.send(JSON.stringify(jsonData));
              }
            } else {
              cli.send(JSON.stringify(jsonData));
            }
          } else {
            cli.send(data, { binary: isBin });
          }

          if (activeConnections.has(id)) {
            activeConnections.get(id).lastActivity = Date.now();
          }
        } catch (err) {
          console.error(`💥 Tarayıcıya veri gönderirken hata: ${err.message}`);
          try {
            cli.send(data, { binary: isBin });
          } catch (sendErr) {
            console.error(`💥 Orijinal veriyi gönderme hatası: ${sendErr.message}`);
          }
        }
      }
    });

    // ----- OPENAI HATA DURUMU -----
    ws.on("error", (e) => {
      console.error(`❌ OpenAI WS hatası [${id.slice(0, 8)}]: ${e.message}`);

      if (cli.readyState === WebSocket.OPEN) {
        try {
          cli.send(JSON.stringify({
            type: "error",
            message: "OpenAI bağlantı hatası: " + e.message
          }));
        } catch (sendErr) {
          console.error(`💥 Hata bildirimi gönderilemedi: ${sendErr.message}`);
        }
      }
    });

    // ----- OPENAI BAĞLANTI KAPANDIĞINDA -----
    ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "Belirtilmedi";
      console.log(`📴 OpenAI bağlantısı kapandı [${id.slice(0, 8)}]: ${code} (${reasonStr})`);

      if (cli.readyState === WebSocket.OPEN && code !== 1000) {
        console.log(`🔄 OpenAI'a yeniden bağlanılıyor [${id.slice(0, 8)}]...`);

        try {
          cli.send(JSON.stringify({
            type: "session.update",
            message: "OpenAI bağlantısı yenileniyor..."
          }));
        } catch (err) { }

        setTimeout(() => {
          if (activeConnections.has(id)) {
            const newOai = connectToOpenAI(id);
            activeConnections.get(id).openai = newOai;
            oai = newOai;
          }
        }, 1000);
      }
    });

    return ws;
  }

  // ----- TARAYICIDAN GELEN MESAJLARI İŞLEME -----
  cli.on("message", (data, isBin) => {
    try {
      // OpenAI'a mesaj gönderme
      if (!oai || oai.readyState !== WebSocket.OPEN) {
        if (!oai || oai.readyState === WebSocket.CLOSED) {
          console.log(`🔄 Eksik bağlantı tespit edildi [${clientId.slice(0, 8)}], yeniden bağlanılıyor...`);
          oai = connectToOpenAI(clientId);
          activeConnections.get(clientId).openai = oai;

          const checkAndSend = setInterval(() => {
            if (oai && oai.readyState === WebSocket.OPEN) {
              clearInterval(checkAndSend);
              oai.send(data, { binary: isBin });
              console.log(`✅ Mesaj gönderildi [${clientId.slice(0, 8)}] (geciktirilmiş)`);
            }
          }, 100);

          setTimeout(() => clearInterval(checkAndSend), 5000);

          cli.send(JSON.stringify({
            type: "session.update",
            message: "OpenAI'a yeniden bağlanılıyor, lütfen bekleyin..."
          }));
        } else {
          cli.send(JSON.stringify({
            type: "error",
            message: "OpenAI bağlantısı hazır değil, lütfen tekrar deneyin"
          }));
        }
        return;
      }

      // JSON mesajı ise ve özel komut içeriyorsa işle
      if (!isBin) {
        try {
          const jsonData = JSON.parse(data.toString());
          
          // Ambiyans kontrolü komutu
          if (jsonData.type === "ambient.control") {
            const conn = activeConnections.get(clientId);
            
            if (jsonData.action === "start" && conn && !conn.ambientStreamActive) {
              // Ambiyans akışını başlat
              startAmbientStream(clientId);
              
              // Durum bildir
              cli.send(JSON.stringify({
                type: "ambient.status",
                enabled: true,
                isActive: true,
                isLoaded: audioMixer.isLoaded
              }));
              
              return; // OpenAI'a iletme
            }
            else if (jsonData.action === "stop" && conn && conn.ambientStreamActive) {
              // Ambiyans akışını durdur
              stopAmbientStream(clientId);
              
              // Durum bildir
              cli.send(JSON.stringify({
                type: "ambient.status",
                enabled: true,
                isActive: false,
                isLoaded: audioMixer.isLoaded
              }));
              
              return; // OpenAI'a iletme
            }
          }
        } catch (parseError) {
          // JSON parse hatası, normal veriyi OpenAI'a ilet
        }
      }
      
      oai.send(data, { binary: isBin });
      activeConnections.get(clientId).lastActivity = Date.now();
    } catch (err) {
      console.error(`💥 OpenAI'a veri gönderirken hata [${clientId.slice(0, 8)}]: ${err.message}`);
      try {
        cli.send(JSON.stringify({
          type: "error",
          message: "Veri gönderme hatası: " + err.message
        }));
      } catch (sendErr) {
        console.error(`💥 Hata bildirimi gönderilemedi: ${sendErr.message}`);
      }
    }
  });

  // Bağlantı kapandığında ambiyans akışını durdur
  cli.on("close", (code, reason) => {
    const reasonStr = reason.toString() || "Belirtilmedi";
    console.log(`👋 Tarayıcı bağlantısı kapandı [${clientId.slice(0, 8)}]: ${code} (${reasonStr})`);

    if (oai && oai.readyState === WebSocket.OPEN) {
      oai.close(1000, "Tarayıcı bağlantısı kapandı");
    }

    // Ambiyans akışını durdur
    stopAmbientStream(clientId);
    
    activeConnections.delete(clientId);
  });

  cli.on("error", (err) => {
    console.error(`❌ Tarayıcı WebSocket hatası [${clientId.slice(0, 8)}]: ${err.message}`);
  });

  // Basit ambiyans durumu bildirimi
  cli.send(JSON.stringify({
    type: "ambient.status",
    enabled: true,
    isLoaded: audioMixer.isLoaded
  }));
});

// ----- BAĞLANTI KONTROLÜ VE TEMİZLİĞİ -----
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("💤 Yanıt vermeyen bağlantı kapatılıyor");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });

  // İnaktif bağlantıları temizle (15 dakika)
  const inactiveTimeout = 15 * 60 * 1000;
  const now = Date.now();

  for (const [id, conn] of activeConnections.entries()) {
    const inactiveDuration = now - conn.lastActivity;
    if (inactiveDuration > inactiveTimeout) {
      console.log(`⏰ Uzun süredir aktif olmayan bağlantı kapatılıyor [${id.slice(0, 8)}] (${inactiveDuration / 1000}s)`);

      if (conn.client.readyState === WebSocket.OPEN) {
        conn.client.close(1000, "Uzun süre inaktif");
      }

      if (conn.openai && conn.openai.readyState === WebSocket.OPEN) {
        conn.openai.close(1000, "Uzun süre inaktif");
      }

      activeConnections.delete(id);
    }
  }
}, 30000);

// ----- SUNUCU KAPATMA İŞLEMİ -----
process.on("SIGINT", () => {
  console.log("🛑 Sunucu kapatılıyor, tüm bağlantılar temizleniyor...");

  clearInterval(pingInterval);

  for (const [id, conn] of activeConnections.entries()) {
    if (conn.client.readyState === WebSocket.OPEN) {
      conn.client.close(1000, "Sunucu kapatılıyor");
    }

    if (conn.openai && conn.openai.readyState === WebSocket.OPEN) {
      conn.openai.close(1000, "Sunucu kapatılıyor");
    }
  }

  setTimeout(() => {
    console.log("👋 Sunucu kapatıldı.");
    process.exit(0);
  }, 1000);
});

server.listen(PORT, () =>
  console.log(`🚀 http://localhost:${PORT} adresinde çalışıyor`)
);

/**
 * Belirli bir istemci için ambiyans ses akışını başlatır
 */
function startAmbientStream(clientId) {
  const conn = activeConnections.get(clientId);
  if (!conn || !conn.client || conn.client.readyState !== WebSocket.OPEN || conn.ambientStreamActive) {
    return false;
  }
  
  // Ambiyans ses buffer boyutu ve gönderim aralığı
  // 24kHz için 480ms'lik buffer ~11.5KB
  const chunkDurationMs = 480;
  const samplesPerChunk = Math.floor((audioMixer.sampleRate * chunkDurationMs) / 1000);
  
  conn.ambientStreamActive = true;
  
  // Her aralıkta ambiyans sesi gönder
  conn.ambientInterval = setInterval(() => {
    if (!conn.ambientStreamActive || conn.client.readyState !== WebSocket.OPEN) {
      stopAmbientStream(clientId);
      return;
    }
    
    try {
      // Ses mixer'dan sadece ambiyans içeren buffer al
      const ambientBuffer = audioMixer.getAmbientOnlyBuffer(samplesPerChunk);
      
      if (ambientBuffer) {
        // Ambiyans buffer'ını Base64'e dönüştür
        const base64Data = Buffer.from(ambientBuffer).toString('base64');
        
        // Ambiyans ses verisini JSON içinde gönder
        conn.client.send(JSON.stringify({
          type: "ambient.audio",
          delta: base64Data
        }));
      }
    } catch (err) {
      console.error(`💥 Ambiyans ses gönderme hatası [${clientId.slice(0,8)}]: ${err.message}`);
      stopAmbientStream(clientId);
    }
  }, chunkDurationMs);
  
  return true;
}

/**
 * Belirli bir istemci için ambiyans ses akışını durdurur
 */
function stopAmbientStream(clientId) {
  const conn = activeConnections.get(clientId);
  if (!conn) return;
  
  if (conn.ambientInterval) {
    clearInterval(conn.ambientInterval);
    conn.ambientInterval = null;
  }
  
  conn.ambientStreamActive = false;
}