/**
 * Realtime API WebSocket İstemcisi
 * Kullanıcı ve yapay zeka arasında kesintisiz ses etkileşimi sağlar
 */
const $ = (id) => document.getElementById(id);
const log = (...m) => {
  console.log(...m);
  const logEl = $("log");
  logEl.textContent += m.join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
const b64ToBuf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/* ---- WS Bağlantısı ---------- */
let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectBackoff = [1000, 2000, 3000, 5000, 8000]; // Geri çekilme stratejisi

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
      log(`🔄 ${delayMs/1000} saniye içinde yeniden bağlanılacak... (Deneme ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
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

/* ---- Global Değişkenler ---------- */
let audioCtx, workletReady = false;
let micStream, micNode, recording = false, responding = false;
let sessionId = null;
let modelSpeaking = false;
let lastUserSpeechTime = 0;
let userWasInterrupted = false;

// Gerçek zamanlı ses akışı için değişkenler
let audioSourceNodes = [];
let scheduledEndTime = 0;
let firstChunkPlayed = false;

// Oturum yapılandırması
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

/**
 * OpenAI Olay İşleyicisi
 */
async function handleMessage(e) {
  try {
    const txt = typeof e.data === "string" ? e.data : await e.data.text();
    const ev = JSON.parse(txt);

    // Oturum oluşturuldu
    if (ev.type === "session.created") {
      sessionId = ev.session.id;
      log(`✅ Oturum oluşturuldu: ${sessionId.slice(0, 8)}...`);
      
      ws.send(JSON.stringify({
        type: "session.update",
        session: sessionConfig
      }));
      log("✅ Oturum yapılandırıldı");
    }
    
    // Oturum güncellendi
    if (ev.type === "session.updated") {
      log("✅ Oturum ayarları güncellendi");
    }

    // Konuşma başladı
    if (ev.type === "input_audio_buffer.speech_started") {
      lastUserSpeechTime = Date.now();
      log("🎤 Konuşma başladı");
      $("status").textContent = "Dinleniyor...";
      $("status").className = "listening";
      
      // Kullanıcı modelin konuşmasını kestiyse
      if (modelSpeaking) {
        userWasInterrupted = true;
        log("⚠️ Kullanıcı modelin konuşmasını kesti");
        stopAllAudio();
      }
    }

    // Konuşma bitti
    if (ev.type === "input_audio_buffer.speech_stopped") {
      const duration = ((Date.now() - lastUserSpeechTime) / 1000).toFixed(1);
      log(`🛑 Konuşma bitti (${duration}s)`);
      $("status").textContent = "İşleniyor...";
      $("status").className = "thinking";
    }
    
    // Yanıt oluşturuluyor
    if (ev.type === "response.created") {
      responding = true;
      firstChunkPlayed = false;
      scheduledEndTime = 0;
      log("⚙️ Yanıt oluşturuluyor...");
    }
    
    // Transkript geldi
    if (ev.type === "response.audio_transcript.delta") {
      if (ev.delta && ev.delta.trim()) {
        log(`📝 Transkript: "${ev.delta}"`);
      }
    }

    // Ses parçası geldi
    if (ev.type === "response.audio.delta") {
      if (!modelSpeaking) {
        modelSpeaking = true;
        $("status").textContent = "Model konuşuyor...";
      }
      
      const audioBuffer = b64ToBuf(ev.delta);
      playAudioChunk(audioBuffer);
    }

    // Ses bitti
    if (ev.type === "response.audio.done") {
      modelSpeaking = false;
      
      if (userWasInterrupted) {
        log("⏭️ Model yanıtı kesildi");
        userWasInterrupted = false;
      } else {
        log("✅ Ses akışı tamamlandı");
      }
    }

    // Yanıt tamamlandı
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

    // Hata mesajları
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

/**
 * Ses işleme için AudioContext oluşturur veya mevcut olanı döndürür
 */
async function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 24000 });
  }
  
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  
  return audioCtx;
}

/**
 * Gerçek zamanlı ses oynatma
 */
async function playAudioChunk(buffer) {
  if (userWasInterrupted || !buffer.byteLength) return;
  
  try {
    const audioContext = await ctx();
    
    // PCM16 ses verilerini Float32'ye dönüştür
    const i16 = new Int16Array(buffer);
    const f32 = Float32Array.from(i16, v => v / 32768.0);
    
    // AudioBuffer oluştur
    const audioBuffer = audioContext.createBuffer(1, f32.length, 24000);
    audioBuffer.getChannelData(0).set(f32);
    
    // BufferSource oluştur
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    
    // Kaynak düğümünü izle
    audioSourceNodes.push(source);
    
    // Akış zamanlamasını hesapla
    const now = audioContext.currentTime;
    const duration = audioBuffer.duration;
    
    if (!firstChunkPlayed) {
      // İlk chunk hemen başlatılır
      source.start(now);
      scheduledEndTime = now + duration;
      firstChunkPlayed = true;
      log(`🔊 Ses akışı başladı (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
    } else {
      // Sonraki chunk'lar kesintisiz akış için zamanlanır
      source.start(scheduledEndTime);
      scheduledEndTime += duration;
    }
    
    // Kaynak tamamlandığında temizle
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

/**
 * Tüm aktif ses oynatmalarını durdur
 */
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

/**
 * AudioWorklet yükleyici
 */
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

/**
 * Mikrofonu başlat
 */
async function startMic() {
  try {
    if (recording) return;
    
    // Model konuşuyorsa kes
    if (modelSpeaking) {
      userWasInterrupted = true;
      log("⏺️ Kullanıcı konuşmaya başladı, model yanıtı kesiliyor");
      stopAllAudio();
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
    $("status").className = "listening";
    log("🎙️ Kayıt başladı");
  } catch (err) {
    log("⛔ Mikrofon başlatma hatası: " + err.message);
    console.error("Mikrofon başlatma hatası:", err);
    $("status").textContent = "Mikrofon erişimi başarısız";
    $("status").className = "disconnected";
  }
}

/**
 * Mikrofonu durdur
 */
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

/**
 * Oturumu sıfırla
 */
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

/**
 * Sayfa yükleme
 */
window.onload = () => {
  connectWS();
  $("startBtn").onclick = startMic;
  $("stopBtn").onclick = stopMic;
  $("resetBtn").onclick = resetSession;
  
  // Safari için AudioContext izni
  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }, { once: true });
  
  // Sayfa kapanırken temizlik
  window.addEventListener('beforeunload', () => {
    if (recording) {
      stopMic();
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Sayfa kapandı");
    }
  });
};