/* =========================================================
   script.js – Realtime API WS (deltaları birleştirerek oynatır)
   ======================================================= */
const $ = (id) => document.getElementById(id);
const log = (...m) => {
  console.log(...m);
  $("log").textContent += m.join(" ") + "\n";
};
const b64ToBuf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/* ---------- WS ---------- */
const WS = new WebSocket(`${location.origin.replace(/^http/, "ws")}/client`);

/* ---------- Global ---------- */
let audioCtx,
  workletReady = false;
let micStream,
  micNode,
  recording,
  responding = false;

/* ---- gelen yanıtı tutmak için delta tamponu ---- */
let deltaBuffers = []; // ArrayBuffer list
let expectedResId = null; // Yanıtlar çakışırsa ayırt etmek için

/* =========================================================
   OpenAI olayları
   ======================================================= */
WS.onmessage = async (e) => {
  const txt = typeof e.data === "string" ? e.data : await e.data.text();
  const ev = JSON.parse(txt);

  if (ev.type === "session.created") {
    WS.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          voice: "shimmer",
          instructions: "Tüm cevaplarını sadece Türkçe ver.",
        },
      })
    );
    log("✅ session.update gönderildi");
  }

  if (ev.type === "response.audio.delta") {
    deltaBuffers.push(b64ToBuf(ev.delta));
  }

  if (ev.type === "response.audio.done") {
    playCombined(deltaBuffers);
    deltaBuffers = [];
    responding = false; // Yanıt tamamlandı
    log("✅ Yanıt tamamlandı");
    expectedResId = null;
  }

  if (ev.type === "error") log("⛔", ev.error?.message || ev.code);
};

/* =========================================================
   Ses oynatma (birleştirerek)
   ======================================================= */
async function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
function playCombined(buffArr) {
  if (!buffArr.length) return;
  const totalBytes = buffArr.reduce((t, b) => t + b.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const b of buffArr) {
    combined.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }

  ctx().then(() => {
    const i16 = new Int16Array(combined.buffer);
    const f32 = Float32Array.from(i16, (v) => v / 0x8000);
    const aBuf = audioCtx.createBuffer(1, f32.length, 24000);
    aBuf.getChannelData(0).set(f32);
    const src = audioCtx.createBufferSource();
    src.buffer = aBuf;
    src.connect(audioCtx.destination);
    src.start();
    log("🔊 Ses oynatıldı (" + (totalBytes / 1024).toFixed(1) + " KB)");
  });
}

/* =========================================================
   Mikrofon (değişmedi, commit yok – VAD’e bırakıyoruz)
   ======================================================= */
async function loadWorklet() {
  if (workletReady) return;
  await ctx();
  await audioCtx.audioWorklet.addModule("pcm16-worklet.js");
  workletReady = true;
}

async function startMic() {
  if (recording) return;
  if (responding) {
    // ➕ aktif cevap varken izin verme
    log("⏳ Model konuşmayı tamamlasın, sonra tekrar deneyin");
    return;
  }
  await loadWorklet();

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const src = audioCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(audioCtx, "pcm16");
  src.connect(micNode);

  micNode.port.onmessage = (e) => {
    if (WS.readyState !== 1) return;
    WS.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: btoa(String.fromCharCode(...new Uint8Array(e.data))),
      })
    );
  };

  recording = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  responding = false;
  log("🎙️  Kayıt başladı");
}

function stopMic() {
  if (!recording) return;
  micStream.getTracks().forEach((t) => t.stop());
  micNode.disconnect();
  recording = false;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  responding = true; // ➕ henüz cevap bekliyoruz
  log("🛑  Kayıt bitti – modelin cevabı bekleniyor…");
}

/* =========================================================
   UI
   ======================================================= */
$("startBtn").onclick = startMic;
$("stopBtn").onclick = stopMic;
