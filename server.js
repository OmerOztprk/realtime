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

const wss = new WebSocketServer({ server, path: "/client" });

wss.on("connection", (cli) => {
  console.log("🌐  Tarayıcı bağlandı");

  const oai = new WebSocket(OAI_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // OpenAI ➜ Tarayıcı
  oai.on("message", (data, isBin) => {
    if (cli.readyState === 1) cli.send(data, { binary: isBin });
  });
  oai.on("error", (e) => console.error("OpenAI WS hata:", e));

  // Tarayıcı ➜ OpenAI
  cli.on("message", (data, isBin) => {
    if (oai.readyState === 1) oai.send(data, { binary: isBin });
  });
  cli.on("close", () => oai.close());
});

server.listen(PORT, () =>
  console.log(`🚀  http://localhost:${PORT} çalışıyor`)
);
