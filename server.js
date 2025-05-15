import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const { OPENAI_API_KEY, PORT = 3000 } = process.env;
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY yok! .env dosyasında tanımlanmalı.");
  process.exit(1);
}

const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const OAI_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);

// Aktif bağlantıları takip et
const activeConnections = new Map();

// Bağlantı kontrolü için heartbeat
function heartbeat() {
  this.isAlive = true;
}

const wss = new WebSocketServer({ server, path: "/client" });

wss.on("connection", (cli, req) => {
  const clientId = randomUUID();
  const clientIp = req.socket.remoteAddress;
  console.log(`🌐 Tarayıcı bağlandı [${clientId.slice(0, 8)}] (${clientIp})`);
  
  cli.isAlive = true;
  cli.on("pong", heartbeat);
  
  // OpenAI bağlantısı oluştur
  let oai = connectToOpenAI(clientId);
  
  // Bağlantıyı izle
  activeConnections.set(clientId, { 
    client: cli, 
    openai: oai, 
    lastActivity: Date.now() 
  });

  function connectToOpenAI(id) {
    console.log(`📡 OpenAI bağlantısı başlatılıyor [${id.slice(0, 8)}] (${MODEL})`);
    
    const ws = new WebSocket(OAI_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      },
      perMessageDeflate: false // Performans için sıkıştırmayı devre dışı bırak
    });

    // OpenAI'dan gelen mesajları tarayıcıya ilet
    ws.on("message", (data, isBin) => {
      if (cli.readyState === WebSocket.OPEN) {
        try {
          cli.send(data, { binary: isBin });
          
          // Aktivite zamanını güncelle
          if (activeConnections.has(id)) {
            activeConnections.get(id).lastActivity = Date.now();
          }
        } catch (err) {
          console.error(`💥 Tarayıcıya veri gönderirken hata: ${err.message}`);
        }
      }
    });

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

    ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "Belirtilmedi";
      console.log(`📴 OpenAI bağlantısı kapandı [${id.slice(0, 8)}]: ${code} (${reasonStr})`);
      
      // Temiz kapanma değilse ve istemci hala bağlıysa yeniden bağlan
      if (cli.readyState === WebSocket.OPEN && code !== 1000) {
        console.log(`🔄 OpenAI'a yeniden bağlanılıyor [${id.slice(0, 8)}]...`);
        
        try {
          cli.send(JSON.stringify({
            type: "session.update",
            message: "OpenAI bağlantısı yenileniyor..."
          }));
        } catch (err) {}
        
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

  // Tarayıcıdan gelen mesajları OpenAI'a ilet
  cli.on("message", (data, isBin) => {
    try {
      if (!oai || oai.readyState !== WebSocket.OPEN) {
        if (!oai || oai.readyState === WebSocket.CLOSED) {
          console.log(`🔄 Eksik bağlantı tespit edildi [${clientId.slice(0, 8)}], yeniden bağlanılıyor...`);
          oai = connectToOpenAI(clientId);
          activeConnections.get(clientId).openai = oai;
          
          // Bağlantı kurulana kadar bekle
          const checkAndSend = setInterval(() => {
            if (oai && oai.readyState === WebSocket.OPEN) {
              clearInterval(checkAndSend);
              oai.send(data, { binary: isBin });
              console.log(`✅ Mesaj gönderildi [${clientId.slice(0, 8)}] (geciktirilmiş)`);
            }
          }, 100);
          
          setTimeout(() => clearInterval(checkAndSend), 5000); // Güvenlik için zaman aşımı
          
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
      
      // Mesajı OpenAI'a ilet
      oai.send(data, { binary: isBin });
      
      // Aktivite zamanını güncelle
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

  cli.on("close", (code, reason) => {
    const reasonStr = reason.toString() || "Belirtilmedi";
    console.log(`👋 Tarayıcı bağlantısı kapandı [${clientId.slice(0, 8)}]: ${code} (${reasonStr})`);
    
    // OpenAI bağlantısını temizle
    if (oai && oai.readyState === WebSocket.OPEN) {
      oai.close(1000, "Tarayıcı bağlantısı kapandı");
    }
    
    // Kaynakları temizle
    activeConnections.delete(clientId);
  });
  
  cli.on("error", (err) => {
    console.error(`❌ Tarayıcı WebSocket hatası [${clientId.slice(0, 8)}]: ${err.message}`);
  });
});

// Ping/pong ile bağlantıları canlı tut (30 saniyede bir)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("💤 Yanıt vermeyen bağlantı kapatılıyor");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  
  // Uzun süre aktif olmayan bağlantıları temizle (15 dakika)
  const inactiveTimeout = 15 * 60 * 1000; // 15 dakika
  const now = Date.now();
  
  for (const [id, conn] of activeConnections.entries()) {
    const inactiveDuration = now - conn.lastActivity;
    if (inactiveDuration > inactiveTimeout) {
      console.log(`⏰ Uzun süredir aktif olmayan bağlantı kapatılıyor [${id.slice(0, 8)}] (${inactiveDuration/1000}s)`);
      
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

// Sunucuyu durdurduğumuzda temizlik yap
process.on("SIGINT", () => {
  console.log("🛑 Sunucu kapatılıyor, tüm bağlantılar temizleniyor...");
  
  clearInterval(pingInterval);
  
  // Tüm bağlantıları kapat
  for (const [id, conn] of activeConnections.entries()) {
    if (conn.client.readyState === WebSocket.OPEN) {
      conn.client.close(1000, "Sunucu kapatılıyor");
    }
    
    if (conn.openai && conn.openai.readyState === WebSocket.OPEN) {
      conn.openai.close(1000, "Sunucu kapatılıyor");
    }
  }
  
  // 1 saniye sonra süreci sonlandır
  setTimeout(() => {
    console.log("👋 Sunucu kapatıldı.");
    process.exit(0);
  }, 1000);
});

server.listen(PORT, () =>
  console.log(`🚀 http://localhost:${PORT} adresinde çalışıyor`)
);