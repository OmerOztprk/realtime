import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const { OPENAI_API_KEY, PORT = 3000 } = process.env;
if (!OPENAI_API_KEY) {
  console.error("❌  OPENAI_API_KEY yok!");
  process.exit(1);
}

const MODEL = "gpt-4o-realtime-preview-2024-12-17";
const OAI_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

const app = express();
app.use(express.static("public"));
const server = http.createServer(app);

// Aktif bağlantıları takip et
const activeConnections = new Map();

const wss = new WebSocketServer({ server, path: "/client" });

wss.on("connection", (cli) => {
  console.log("🌐  Tarayıcı bağlandı");
  const clientId = Date.now().toString(36) + Math.random().toString(36).substring(2);
  let oai = connectToOpenAI();
  
  // Bağlantıyı kaydet
  activeConnections.set(clientId, { cli, oai });

  function connectToOpenAI() {
    console.log(`📡 OpenAI bağlantısı başlatılıyor (${MODEL})`);
    
    const ws = new WebSocket(OAI_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    // OpenAI ➜ Tarayıcı
    ws.on("message", (data, isBin) => {
      if (cli.readyState === WebSocket.OPEN) {
        cli.send(data, { binary: isBin });
      }
    });

    ws.on("error", (e) => {
      console.error("❌ OpenAI WS hatası:", e.message);
      // Hata durumunda oai referansını temizle, böylece yeniden bağlanılabilir
      if (oai === ws) oai = null;
      
      // Tarayıcıya hatayı bildir
      if (cli.readyState === WebSocket.OPEN) {
        cli.send(JSON.stringify({
          type: "error",
          code: "openai_error",
          message: "OpenAI bağlantı hatası: " + e.message
        }));
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`📴 OpenAI bağlantısı kapandı: ${code} ${reason ? reason.toString() : ""}`);
      // Tarayıcı hala bağlıysa ve anormal kapanma olduysa yeniden bağlan
      if (cli.readyState === WebSocket.OPEN && code !== 1000) {
        console.log("🔄 OpenAI'a yeniden bağlanılıyor...");
        setTimeout(() => {
          oai = connectToOpenAI();
          // Bağlantıyı güncelle
          if (activeConnections.has(clientId)) {
            activeConnections.set(clientId, { cli, oai });
          }
        }, 1000);
      }
    });

    return ws;
  }

  // Tarayıcı ➜ OpenAI
  cli.on("message", (data, isBin) => {
    // Eğer OpenAI bağlantısı kopmuşsa ve yeniden bağlanmamışsa
    if (!oai || oai.readyState !== WebSocket.OPEN) {
      if (!oai) {
        console.log("🔄 Eksik bağlantı tespit edildi, yeniden bağlanılıyor...");
        oai = connectToOpenAI();
        // Bağlantıyı güncelle
        activeConnections.set(clientId, { cli, oai });
      } else {
        console.log("⚠️ Beklenmedik bağlantı durumu:", oai.readyState);
        cli.send(JSON.stringify({
          type: "error",
          code: "connection_lost",
          message: "OpenAI bağlantısı kaybedildi, yeniden bağlanmaya çalışılıyor..."
        }));
        return;
      }
    }
    
    try {
      oai.send(data, { binary: isBin });
    } catch (err) {
      console.error("💥 Veri gönderirken hata:", err.message);
      cli.send(JSON.stringify({
        type: "error",
        code: "send_error",
        message: "Veri gönderme hatası: " + err.message
      }));
    }
  });

  cli.on("close", () => {
    console.log("👋 Tarayıcı bağlantısı kapandı");
    
    // Bağlantıyı temizle
    activeConnections.delete(clientId);
    
    if (oai && oai.readyState === WebSocket.OPEN) {
      oai.close(1000, "Tarayıcı bağlantısı kapandı");
    }
  });
});

// Sunucu kapatılırken tüm bağlantıları temizle
process.on('SIGINT', () => {
  console.log("🛑 Sunucu kapatılıyor...");
  
  // Tüm bağlantıları kapat
  for (const { cli, oai } of activeConnections.values()) {
    if (cli.readyState === WebSocket.OPEN) {
      cli.close(1000, "Sunucu kapatılıyor");
    }
    
    if (oai && oai.readyState === WebSocket.OPEN) {
      oai.close(1000, "Sunucu kapatılıyor");
    }
  }
  
  // Sunucuyu kapat
  server.close(() => {
    console.log("👋 Sunucu kapatıldı");
    process.exit(0);
  });
});

server.listen(PORT, () =>
  console.log(`🚀 http://localhost:${PORT} çalışıyor`)
);