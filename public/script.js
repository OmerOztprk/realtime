/*=====================================================
   Basitleştirilmiş Realtime API WebSocket İstemcisi
   ======================================================= */
const $ = (id) => document.getElementById(id);
const log = (...m) => {
  console.log(...m);
  const logEl = $("log");
  logEl.textContent += m.join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
const b64ToBuf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/* ------ WS Bağlantısı ---------- */
let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

function connectWS() {
  ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/client`);

  ws.onopen = () => {
    log("🔌 Sunucuya bağlandı");
    $("status").textContent = "Bağlı";
    $("status").className = "connected";
    reconnectAttempts = 0;
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
  };

  ws.onclose = () => {
    log("🔌 Sunucu bağlantısı kesildi");
    $("status").textContent = "Bağlantı kesildi";
    $("status").className = "disconnected";
    $("startBtn").disabled = true;
    $("stopBtn").disabled = true;

    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const delay = Math.min(1000 * reconnectAttempts, 5000);
      log(`🔄 ${delay/1000} saniye içinde yeniden bağlanılacak...`);
      setTimeout(connectWS, delay);
    } else {
      log("❌ Yeniden bağlanma denemesi başarısız oldu. Sayfayı yenileyin.");
    }
  };

  ws.onerror = (err) => {
    log("❌ WebSocket hatası:", err);
  };

  ws.onmessage = handleMessage;
}

/* ------ Global Değişkenler ---------- */
let audioCtx, workletReady = false;
let micStream, micNode, recording = false, responding = false;
let deltaBuffers = [];
let sessionId = null;
let modelSpeaking = false;

// Sabit VAD ve ses ayarları
const sessionConfig = {
  input_audio_format: "pcm16",
  output_audio_format: "pcm16",
  voice: "shimmer",
  turn_detection: {
    type: "server_vad",
    threshold: 0.6,
    prefix_padding_ms: 300,
    silence_duration_ms: 600,
    create_response: true,
    interrupt_response: true
  },
  input_audio_noise_reduction: {
    type: "near_field"
  },
  instructions: `
    Sen faydalı ve profesyonel bir Türkçe konuşan asistan olarak görev yapıyorsun.
    Sadece kullanıcının sorduğu soruları veya belirttiği konuları ele al.
    Cevaplarını kısa, özlü ve net tut. Her zaman Türkçe konuş ve nazik ol.
    Eğer kullanıcının ne dediğini anlayamazsan, daha fazla bilgi iste.`
};

/*=====================================================
   OpenAI Olay İşleyicisi
   ======================================================= */
async function handleMessage(e) {
  try {
    const txt = typeof e.data === "string" ? e.data : await e.data.text();
    const ev = JSON.parse(txt);

    // Oturum oluşturuldu
    if (ev.type === "session.created") {
      sessionId = ev.session.id;
      log(`✅ Oturum oluşturuldu`);
      
      // Oturum yapılandırması
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: sessionConfig
        })
      );
      log("✅ Oturum yapılandırıldı");
    }

    // Konuşma başladı
    if (ev.type === "input_audio_buffer.speech_started") {
      log("🎤 Konuşma başladı");
    }

    // Konuşma bitti
    if (ev.type === "input_audio_buffer.speech_stopped") {
      log("🛑 Konuşma bitti");
    }

    // Yanıt ses parçası geldi
    if (ev.type === "response.audio.delta") {
      modelSpeaking = true;
      deltaBuffers.push(b64ToBuf(ev.delta));
    }

    // Yanıttaki ses bitti
    if (ev.type === "response.audio.done") {
      modelSpeaking = false;
      playCombined(deltaBuffers);
      deltaBuffers = [];
    }

    // Yanıt tamamen bitti
    if (ev.type === "response.done") {
      responding = false;
      modelSpeaking = false;
      log("✅ Yanıt tamamlandı");
      
      if (!recording) {
        $("startBtn").disabled = false;
      }
    }

    // Hata mesajları
    if (ev.type === "error") {
      const errorMsg = ev.error?.message || ev.message || "Bilinmeyen hata";
      log("⛔ HATA: " + errorMsg);
      
      if (recording) {
        stopMic();
      }
      responding = false;
      $("startBtn").disabled = false;
    }
  } catch (error) {
    log("⛔ Mesaj işleme hatası: " + error.message);
    console.error("Mesaj işleme hatası:", error);
  }
}

/*=====================================================
   Ses Oynatma ve İşleme
   ======================================================= */
async function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 24000 });
  }
  
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  
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
    // PCM16 formatından Float32'ye dönüştürme
    const i16 = new Int16Array(combined.buffer);
    const f32 = Float32Array.from(i16, (v) => v / 32768.0);
    
    // AudioBuffer oluşturma ve oynatma
    const aBuf = audioCtx.createBuffer(1, f32.length, 24000);
    aBuf.getChannelData(0).set(f32);
    const src = audioCtx.createBufferSource();
    src.buffer = aBuf;
    src.connect(audioCtx.destination);
    src.start();
    
    const sizeKB = (totalBytes / 1024).toFixed(1);
    log("🔊 Ses oynatıldı (" + sizeKB + " KB)");
  }).catch(err => {
    log("⛔ Ses oynatma hatası: " + err.message);
  });
}

/*=====================================================
   Mikrofon Yönetimi
   ======================================================= */
async function loadWorklet() {
  if (workletReady) return;
  
  try {
    await ctx();
    await audioCtx.audioWorklet.addModule("pcm16-worklet.js");
    workletReady = true;
    log("✅ AudioWorklet yüklendi");
  } catch (err) {
    log("⛔ AudioWorklet yükleme hatası: " + err.message);
    throw err;
  }
}

async function startMic() {
  try {
    if (recording) return;
    
    // Model konuşuyorsa bekle
    if (modelSpeaking) {
      log("⏳ Model konuşmayı tamamlasın, sonra tekrar deneyin");
      return;
    }
    
    await loadWorklet();
    
    // Mikrofon erişimi
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
    
    const src = audioCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(audioCtx, "pcm16");
    src.connect(micNode);
    
    micNode.port.onmessage = (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: btoa(String.fromCharCode(...new Uint8Array(e.data))),
          })
        );
      }
    };
    
    recording = true;
    
    // UI güncellemeleri
    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    $("status").textContent = "Dinleniyor...";
    log("🎙️ Kayıt başladı");
  } catch (err) {
    log("⛔ Mikrofon başlatma hatası: " + err.message);
    console.error("Mikrofon başlatma hatası:", err);
  }
}

function stopMic() {
  try {
    if (!recording) return;
    
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
    }
    
    if (micNode) {
      micNode.disconnect();
    }
    
    recording = false;
    
    // UI güncellemeleri
    $("startBtn").disabled = modelSpeaking;
    $("stopBtn").disabled = true;
    $("status").textContent = "Dinleme durdu";
    log("🛑 Kayıt bitti");
  } catch (err) {
    log("⛔ Mikrofon durdurma hatası: " + err.message);
    console.error("Mikrofon durdurma hatası:", err);
  }
}

// Oturumu sıfırla
function resetSession() {
  if (recording) {
    stopMic();
  }
  
  responding = false;
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  setTimeout(() => {
    log("🔄 Oturum yenileniyor...");
    connectWS();
  }, 1000);
}

/*=====================================================
   UI ve Sayfa Yüklenmesi
   ======================================================= */
window.onload = () => {
  connectWS();
  $("startBtn").onclick = startMic;
  $("stopBtn").onclick = stopMic;
  $("resetBtn").onclick = resetSession;
};