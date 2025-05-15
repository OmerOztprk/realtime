/**
 * Realtime API WebSocket İstemcisi
 * Kullanıcı ve yapay zeka arasında kesintisiz ses etkileşimi sağlar
 */

// ----- TEMEL İŞLEVLER -----
const $ = (id) => document.getElementById(id);
const log = (...m) => {
  console.log(...m);
  const logEl = $("log");
  logEl.textContent += m.join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
const b64ToBuf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

// ----- WEBSOCKET BAĞLANTI YÖNETİMİ -----
let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectBackoff = [1000, 2000, 3000, 5000, 8000];

function connectWS() {
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    log("⏳ Bağlantı zaten kuruluyor, lütfen bekleyin...");
    return;
  }

  $("status").textContent = "Bağlanıyor...";
  $("status").className = "disconnected";

  ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/client`);

  ws.onopen = () => {
    log("🔌 Sunucuya bağlandı");
    $("status").textContent = "Bağlı";
    $("status").className = "connected";
    reconnectAttempts = 0;
    $("startBtn").disabled = false;
    $("stopBtn").disabled = true;
  };

  ws.onclose = (event) => {
    const wasClean = event.wasClean;
    log(`🔌 Sunucu bağlantısı kesildi ${wasClean ? '(temiz kapatma)' : '(beklenmeyen kapanma)'}`);
    $("status").textContent = "Bağlantı kesildi";
    $("status").className = "disconnected";
    $("startBtn").disabled = true;
    $("stopBtn").disabled = true;

    if (recording) {
      stopMic();
    }

    if (reconnectAttempts < maxReconnectAttempts) {
      const delayMs = reconnectBackoff[Math.min(reconnectAttempts, reconnectBackoff.length - 1)];
      log(`🔄 ${delayMs / 1000} saniye içinde yeniden bağlanılacak... (Deneme ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
      setTimeout(connectWS, delayMs);
      reconnectAttempts++;
    } else {
      log("❌ Yeniden bağlanma denemeleri başarısız oldu. Sayfayı yenileyin.");
    }
  };

  ws.onerror = (err) => {
    log("❌ WebSocket hatası");
    console.error("WebSocket hatası:", err);
  };

  ws.onmessage = handleMessage;
}

// ----- GLOBAL DEĞİŞKENLER -----
let audioCtx, workletReady = false;
let micStream, micNode, recording = false, responding = false;
let sessionId = null;
let modelSpeaking = false;
let lastUserSpeechTime = 0;
let userWasInterrupted = false;

let audioSourceNodes = [];
let scheduledEndTime = 0;
let firstChunkPlayed = false;
let ambientEnabled = true;

// ----- OTURUM YAPILANDIRMASI -----
const sessionConfig = {
  input_audio_format: "pcm16",
  output_audio_format: "pcm16",
  voice: "shimmer",
  turn_detection: {
    type: "server_vad",
    threshold: 0.7,
    prefix_padding_ms: 300,
    silence_duration_ms: 600,
    create_response: true,
    interrupt_response: true
  },
  input_audio_noise_reduction: {
    type: "far_field"
  },
  instructions: `
    Sen faydalı ve profesyonel bir Türkçe konuşan asistan olarak görev yapıyorsun.
    Sadece kullanıcının sorduğu soruları veya belirttiği konuları ele al.
    Cevaplarını kısa, özlü ve net tut. Her zaman Türkçe konuş ve nazik ol.
    Kullanıcı konuşurken sözünü keserse, hemen durmalı ve dinlemelisin.
    Eğer kullanıcının ne dediğini anlayamazsan, daha fazla bilgi iste.
    Yanıtın araya girme nedeniyle kesilirse, kaldığın yerden değil, yeni soruya odaklanarak devam et.`
};

// ----- OPENAI MESAJ İŞLEME -----
async function handleMessage(e) {
  try {
    const txt = typeof e.data === "string" ? e.data : await e.data.text();
    const ev = JSON.parse(txt);

    if (ev.type === "session.created") {
      sessionId = ev.session.id;
      log(`✅ Oturum oluşturuldu: ${sessionId.slice(0, 8)}...`);

      ws.send(JSON.stringify({
        type: "session.update",
        session: sessionConfig
      }));
      log("✅ Oturum yapılandırıldı");
    }

    if (ev.type === "session.updated") {
      log("✅ Oturum ayarları güncellendi");
    }

    if (ev.type === "input_audio_buffer.speech_started") {
      lastUserSpeechTime = Date.now();
      log("🎤 Konuşma başladı");
      $("status").textContent = "Dinleniyor...";
      $("status").className = "listening";

      if (modelSpeaking) {
        userWasInterrupted = true;
        log("⚠️ Kullanıcı modelin konuşmasını kesti");
        stopAllAudio();
      }
    }

    if (ev.type === "input_audio_buffer.speech_stopped") {
      const duration = ((Date.now() - lastUserSpeechTime) / 1000).toFixed(1);
      log(`🛑 Konuşma bitti (${duration}s)`);
      $("status").textContent = "İşleniyor...";
      $("status").className = "thinking";
    }

    if (ev.type === "response.created") {
      responding = true;
      firstChunkPlayed = false;
      scheduledEndTime = 0;
      log("⚙️ Yanıt oluşturuluyor...");
    }

    if (ev.type === "response.audio_transcript.delta") {
      if (ev.delta && ev.delta.trim()) {
        log(`📝 Transkript: "${ev.delta}"`);
      }
    }

    if (ev.type === "response.audio.delta") {
      if (!modelSpeaking) {
        modelSpeaking = true;
        $("status").textContent = "Model konuşuyor...";
      }

      const audioBuffer = b64ToBuf(ev.delta);
      playAudioChunk(audioBuffer);
    }

    if (ev.type === "response.audio.done") {
      modelSpeaking = false;

      if (userWasInterrupted) {
        log("⏭️ Model yanıtı kesildi");
        userWasInterrupted = false;
      } else {
        log("✅ Ses akışı tamamlandı");
      }
    }

    if (ev.type === "response.done") {
      responding = false;
      modelSpeaking = false;
      userWasInterrupted = false;

      log("✅ Yanıt tamamlandı");

      if (recording) {
        $("status").textContent = "Dinleniyor...";
        $("status").className = "listening";
      } else {
        $("status").textContent = "Bağlı - Bekleniyor";
        $("status").className = "connected";
        $("startBtn").disabled = false;
      }
    }

    if (ev.type === "ambient.status") {
      ambientEnabled = ev.enabled;
      updateAmbientUI(ev);
    }

    if (ev.type === "ambient.switched") {
      log(`🔊 Ambiyans sesi değiştirildi: ${ev.current}`);
    }

    if (ev.type === "ambient.levels") {
      log(`🔊 Ambiyans seviyesi: ${Math.round(ev.levels.ambient * 100)}%, Ses seviyesi: ${Math.round(ev.levels.voice * 100)}%`);
    }

    if (ev.type === "error") {
      const errorMsg = ev.error?.message || ev.message || "Bilinmeyen hata";
      log("⛔ HATA: " + errorMsg);

      if (recording) {
        stopMic();
      }

      responding = false;
      modelSpeaking = false;
      $("startBtn").disabled = false;
      $("status").textContent = "Bağlı";
      $("status").className = "connected";
    }
  } catch (error) {
    log("⛔ Mesaj işleme hatası: " + error.message);
    console.error("Mesaj işleme hatası:", error);
  }
}

// ----- AMBİYANS KONTROL FONKSİYONLARI -----
function updateAmbientUI(status) {
  const ambientBtn = $("ambientBtn");
  if (ambientBtn) {
    ambientBtn.textContent = ambientEnabled ? "🔊 Ambiyans: Açık" : "🔇 Ambiyans: Kapalı";
    ambientBtn.className = ambientEnabled ? "ambient-on" : "ambient-off";
  }

  if (status && status.isLoaded === false) {
    log("⚠️ Ambiyans ses yüklenmemiş! Lütfen sunucudaki ambient klasörüne PCM16 formatında ses dosyaları ekleyin.");
  }
}

function toggleAmbient() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "ambient.control",
      action: "toggle"
    }));
  }
}

function switchAmbient() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "ambient.control",
      action: "switch"
    }));
  }
}

function setAmbientLevels(ambient, voice) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "ambient.control",
      action: "levels",
      levels: {
        ambient: Math.max(0, Math.min(1, ambient)),
        voice: Math.max(0, Math.min(1, voice))
      }
    }));
  }
}

// ----- SES İŞLEME FONKSİYONLARI -----
async function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 24000 });
  }

  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  return audioCtx;
}

async function playAudioChunk(buffer) {
  if (userWasInterrupted || !buffer.byteLength) return;

  try {
    const audioContext = await ctx();

    const i16 = new Int16Array(buffer);
    const f32 = Float32Array.from(i16, v => v / 32768.0);

    const audioBuffer = audioContext.createBuffer(1, f32.length, 24000);
    audioBuffer.getChannelData(0).set(f32);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    audioSourceNodes.push(source);

    const now = audioContext.currentTime;
    const duration = audioBuffer.duration;

    if (!firstChunkPlayed) {
      source.start(now);
      scheduledEndTime = now + duration;
      firstChunkPlayed = true;
      log(`🔊 Ses akışı başladı (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
    } else {
      source.start(scheduledEndTime);
      scheduledEndTime += duration;
    }

    source.onended = () => {
      const index = audioSourceNodes.indexOf(source);
      if (index !== -1) {
        audioSourceNodes.splice(index, 1);
      }
    };
  } catch (error) {
    console.error("Ses chunk oynatma hatası:", error);
  }
}

function stopAllAudio() {
  audioSourceNodes.forEach(source => {
    try {
      source.stop();
    } catch (e) {
      // Halihazırda durmuş olabilir
    }
  });

  audioSourceNodes = [];
  scheduledEndTime = 0;
  firstChunkPlayed = false;
}

async function loadWorklet() {
  if (workletReady) return;

  try {
    await ctx();
    await audioCtx.audioWorklet.addModule("pcm16-worklet.js");
    workletReady = true;
    log("✅ AudioWorklet yüklendi");
  } catch (err) {
    log("⛔ AudioWorklet yükleme hatası: " + err.message);
    console.error("AudioWorklet yükleme hatası:", err);
    throw err;
  }
}

// ----- MİKROFON KONTROL FONKSİYONLARI -----
async function startMic() {
  try {
    if (recording) return;

    if (modelSpeaking) {
      userWasInterrupted = true;
      log("⏺️ Kullanıcı konuşmaya başladı, model yanıtı kesiliyor");
      stopAllAudio();
    }

    await loadWorklet();

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

    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    $("status").textContent = "Dinleniyor...";
    $("status").className = "listening";
    log("🎙️ Kayıt başladı");
  } catch (err) {
    log("⛔ Mikrofon başlatma hatası: " + err.message);
    console.error("Mikrofon başlatma hatası:", err);
    $("status").textContent = "Mikrofon erişimi başarısız";
    $("status").className = "disconnected";
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

    $("stopBtn").disabled = true;

    if (modelSpeaking) {
      $("status").textContent = "Model konuşuyor...";
      $("startBtn").disabled = true;
    } else {
      $("status").textContent = "Bağlı";
      $("status").className = "connected";
      $("startBtn").disabled = false;
    }

    log("🛑 Kayıt bitti");
  } catch (err) {
    log("⛔ Mikrofon durdurma hatası: " + err.message);
    console.error("Mikrofon durdurma hatası:", err);
  }
}

// ----- OTURUM YÖNETİMİ -----
function resetSession() {
  if (recording) {
    stopMic();
  }

  stopAllAudio();

  responding = false;
  modelSpeaking = false;
  userWasInterrupted = false;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, "Kullanıcı oturumu yeniledi");
  }

  $("status").textContent = "Yeniden bağlanıyor...";
  $("status").className = "disconnected";
  $("startBtn").disabled = true;
  $("stopBtn").disabled = true;

  log("🔄 Oturum yenileniyor...");
  setTimeout(connectWS, 1000);
}

// ----- SAYFA YÜKLEME VE OLAY DİNLEYİCİLERİ -----
window.onload = () => {
  connectWS();
  $("startBtn").onclick = startMic;
  $("stopBtn").onclick = stopMic;
  $("resetBtn").onclick = resetSession;

  if ($("ambientBtn")) {
    $("ambientBtn").onclick = toggleAmbient;
  }

  if ($("switchAmbientBtn")) {
    $("switchAmbientBtn").onclick = switchAmbient;
  }

  if ($("ambientVolume")) {
    $("ambientVolume").oninput = e => {
      const ambient = parseFloat(e.target.value) / 100;
      const voice = $("voiceVolume") ? parseFloat($("voiceVolume").value) / 100 : 0.9;
      setAmbientLevels(ambient, voice);
    };
  }

  if ($("voiceVolume")) {
    $("voiceVolume").oninput = e => {
      const voice = parseFloat(e.target.value) / 100;
      const ambient = $("ambientVolume") ? parseFloat($("ambientVolume").value) / 100 : 0.15;
      setAmbientLevels(ambient, voice);
    };
  }

  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }, { once: true });

  window.addEventListener('beforeunload', () => {
    if (recording) {
      stopMic();
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Sayfa kapandı");
    }
  });
};