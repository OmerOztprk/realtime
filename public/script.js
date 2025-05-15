/*=====================================================
   Geliştirilmiş Realtime API WebSocket İstemcisi
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
      log(`🔄 ${delay / 1000} saniye içinde yeniden bağlanılacak...`);
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
let conversationActive = false;
let deltaBuffers = [];
let sessionId = null;
let userSpeaking = false;
let modelSpeaking = false;
let lastTranscript = "";
let transcriptionTimeout = null;
let waitingForResponse = false;
let shouldRestartMic = false;
let lastCommitTime = 0;

/* ------ VAD ve Oturum Yapılandırma ---------- */
// Server VAD - Gürültü filtreleme için daha iyi
const vadConfig = {
  type: "server_vad",       // Gürültü filtreleme için daha iyi
  threshold: 0.6,           // Orta düzey gürültü filtresi (0.1-0.9)
  prefix_padding_ms: 300,   // Başlangıç tamponu
  silence_duration_ms: 600, // Konuşma bitişi için daha uzun süre
  create_response: false,   // Manuel kontrol için
  interrupt_response: true  // Kullanıcı konuşursa yanıtı kes
};

// Ses filtreleme ve temizleme yapılandırması 
const audioConfig = {
  input_audio_noise_reduction: {
    type: "near_field"      // Yakın mesafe mikrofon gürültü filtresi
  }
};

// Model talimatları
const MODEL_INSTRUCTIONS = `
Sen faydalı ve profesyonel bir Türkçe konuşan asistan olarak görev yapıyorsun.
Aşağıdaki kurallara sıkı sıkıya uy:
1. Sadece kullanıcının sorduğu soruları veya belirttiği konuları ele al.
2. Kullanıcı açıkça bir soru veya talep yöneltmeden konuşmaya başlama.
3. Cevaplarını kısa, özlü ve net tut. Gereksiz detaylara girme.
4. Her zaman Türkçe konuş ve nazik ol.
5. Eğer kullanıcının ne dediğini anlayamazsan, daha fazla bilgi iste.
6. Sadece gerçek bilgilere dayalı cevaplar ver.
7. Konuşma transkripti eksik veya hatalı görünüyorsa, bağlam içinde mantıklı bir yanıt oluştur.
8. Kendinden "ben" olarak bahset, "yapay zeka" ya da "asistan" olarak değil.`;

// Threshold değerini güncellemek için fonksiyon
function updateThreshold(value) {
  vadConfig.threshold = parseFloat(value);
  $("thresholdValue").textContent = value;
  
  updateSessionConfig({
    turn_detection: vadConfig
  });
  log(`✅ Gürültü eşiği güncellendi: ${value}`);
}

// VAD tipini değiştir
function changeVADType(type) {
  if (type === "semantic" || type === "server") {
    vadConfig.type = type === "semantic" ? "semantic_vad" : "server_vad";
    
    // Server VAD için threshold göster/gizle
    $("thresholdControl").style.display = type === "server" ? "block" : "none";
    
    // Server VAD için threshold değeri ekle, semantic için sil
    if (type === "server") {
      vadConfig.threshold = parseFloat($("thresholdSlider").value);
    } else {
      delete vadConfig.threshold;
      vadConfig.eagerness = "medium";
    }
    
    updateSessionConfig({
      turn_detection: vadConfig
    });
    
    log(`✅ VAD tipi ${type} olarak değiştirildi`);
  }
}

// Oturum yapılandırmasını güncelle
function updateSessionConfig(config) {
  if (sessionId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: config
      })
    );
  }
}

/*=====================================================
   OpenAI Olay İşleyicisi
   ======================================================= */
async function handleMessage(e) {
  try {
    const txt = typeof e.data === "string" ? e.data : await e.data.text();
    const ev = JSON.parse(txt);

    // Geliştirme amaçlı, delta haricindeki olayları logla
    if (ev.type !== "response.audio.delta") {
      console.debug("Gelen olay:", ev.type);
    }

    // Oturum oluşturuldu
    if (ev.type === "session.created") {
      sessionId = ev.session.id;
      log(`✅ Oturum oluşturuldu: ${sessionId}`);
      updateStatus("Oturum hazır");

      // Gelişmiş oturum yapılandırması
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            voice: "shimmer",
            instructions: MODEL_INSTRUCTIONS,
            turn_detection: vadConfig,
            ...audioConfig
          },
        })
      );
      log("✅ Oturum yapılandırıldı");
    }

    // Oturum güncellendi
    if (ev.type === "session.updated") {
      log("✅ Oturum güncellendi");
    }

    // Konuşma başladı
    if (ev.type === "input_audio_buffer.speech_started") {
      userSpeaking = true;
      updateStatus("Konuşma algılandı");
      log("🎤 Konuşma başladı");
      
      // Varsa bekleyen yanıt zamanlayıcısını iptal et
      if (transcriptionTimeout) {
        clearTimeout(transcriptionTimeout);
        transcriptionTimeout = null;
      }
      
      // Yeni transkript başlangıcı
      lastTranscript = "";
      
      // Konuşma algılandığında UI'ı güncelle
      $("transcriptDisplay").textContent = "Dinleniyor...";
    }

    // Konuşma bitti
    if (ev.type === "input_audio_buffer.speech_stopped") {
      userSpeaking = false;
      updateStatus("Konuşma işleniyor");
      log("🛑 Konuşma bitti");
      
      // VAD ile alakasız çift tetiklemeyi önle
      const now = Date.now();
      if (now - lastCommitTime < 2000) {
        log("⚠️ Çok hızlı tetikleme, işlem atlanıyor");
        return;
      }
      lastCommitTime = now;
      
      // Yanıt almak için bekle ve otomatik yanıt istemeyi ayarla
      waitingForResponse = true;
      
      // VAD'in yanlış algılamalarını önlemek için biraz bekle
      transcriptionTimeout = setTimeout(() => {
        if (waitingForResponse && !responding && !userSpeaking) {
          createResponse();
        }
      }, 700); // 700ms gözlemlenmiş güvenli bir süre
    }

    // Girdi sesi işlendi
    if (ev.type === "input_audio_buffer.committed") {
      log("📝 Ses girişi işlendi");
    }

    // Konuşma yazıya dönüştürülüyor
    if (ev.type === "response.audio_transcript.delta") {
      lastTranscript += ev.delta;
      updateStatus("İşleniyor: " + lastTranscript);
      
      // Görüntülenen transkripti gerçek zamanlı güncelle
      $("transcriptDisplay").textContent = lastTranscript;
    }

    // Konuşmanın yazısı tamamlandı
    if (ev.type === "response.audio_transcript.done") {
      log("🔤 Transkript: " + ev.transcript);
      
      // Transkripti göster ve UI'da vurgula
      $("transcriptDisplay").textContent = ev.transcript;
      $("transcriptDisplay").className = "transcript-complete";
      
      // 1 saniye sonra vurgulamayı kaldır
      setTimeout(() => {
        $("transcriptDisplay").className = "";
      }, 1000);
    }

    // Yanıt oluşturuldu
    if (ev.type === "response.created") {
      responding = true;
      waitingForResponse = false;
      updateStatus("Yanıt oluşturuluyor...");
      $("botResponseDisplay").textContent = "Yanıt oluşturuluyor...";
      log("⏳ Yanıt oluşturuluyor...");
    }

    // Yanıt ses parçası geldi
    if (ev.type === "response.audio.delta") {
      modelSpeaking = true;
      updateStatus("Model konuşuyor");
      deltaBuffers.push(b64ToBuf(ev.delta));
    }

    // Yanıttaki ses bitti
    if (ev.type === "response.audio.done") {
      modelSpeaking = false;
      updateStatus("Ses yanıtı tamamlandı");
      playCombined(deltaBuffers);
      deltaBuffers = [];
    }

    // Yanıttaki metin bitti
    if (ev.type === "response.text.done") {
      $("botResponseDisplay").textContent = ev.text;
      log("📝 Metin: " + ev.text);
    }

    // Yanıt tamamen bitti
    if (ev.type === "response.done") {
      responding = false;
      modelSpeaking = false;
      waitingForResponse = false;
      updateStatus("Dinlemeye hazır");
      log("✅ Yanıt tamamlandı");
      
      // Eğer otomatik yeniden başlatma gerekiyorsa
      if (shouldRestartMic && !recording) {
        shouldRestartMic = false;
        setTimeout(startMic, 100);
      } else if (!recording) {
        $("startBtn").disabled = false;
      }
    }

    // Hata mesajları
    if (ev.type === "error") {
      const errorMsg = ev.error?.message || ev.code || "Bilinmeyen hata";
      log("⛔ HATA: " + errorMsg);
      updateStatus("Hata oluştu");
      
      if (recording) {
        stopMic();
      }
      responding = false;
      waitingForResponse = false;
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
  if (!buffArr.length) {
    log("⚠️ Oynatılacak ses verisi yok");
    return;
  }
  
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
    console.error("Ses oynatma hatası:", err);
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
    
    // Gelişmiş mikrofon erişimi yapılandırması
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
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
    conversationActive = true;
    waitingForResponse = false;
    lastTranscript = "";
    
    // UI güncellemeleri
    $("startBtn").disabled = true;
    $("stopBtn").disabled = false;
    $("transcriptDisplay").textContent = "Dinleniyor...";
    $("botResponseDisplay").textContent = "";
    updateStatus("Dinleniyor...");
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
    $("startBtn").disabled = !(modelSpeaking === false);
    $("stopBtn").disabled = true;
    
    updateStatus(waitingForResponse ? "İşleniyor..." : "Dinleme durdu");
    log("🛑 Kayıt bitti" + (waitingForResponse ? " – yanıt bekleniyor..." : ""));
    
    // Manuel olarak yanıt oluştur - bazen VAD düzgün çalışmayabilir
    if (!userSpeaking && !responding && lastTranscript) {
      setTimeout(createResponse, 500);
    }
  } catch (err) {
    log("⛔ Mikrofon durdurma hatası: " + err.message);
    console.error("Mikrofon durdurma hatası:", err);
  }
}

// Manuel yanıt oluşturma
function createResponse() {
  if (!sessionId || responding || userSpeaking) return;
  
  try {
    ws.send(JSON.stringify({
      type: "response.create"
    }));
    log("🔄 Manuel yanıt isteği gönderildi");
    responding = true;
    waitingForResponse = false;
  } catch (err) {
    log("⛔ Yanıt oluşturma hatası: " + err.message);
  }
}

// Sürekli konuşma modu (konuşmayı durdurmayacak)
function toggleContinuousMode() {
  const isContinuous = $("continuousMode").checked;
  
  if (isContinuous) {
    log("✅ Sürekli konuşma modu etkinleştirildi");
    shouldRestartMic = true;
  } else {
    log("⏹️ Sürekli konuşma modu devre dışı bırakıldı");
    shouldRestartMic = false;
  }
}

// Durumu güncelle
function updateStatus(status) {
  const statusEl = $("status");
  statusEl.textContent = status;
}

// Yeni oturum başlat
function resetSession() {
  if (recording) {
    stopMic();
  }
  
  responding = false;
  conversationActive = false;
  waitingForResponse = false;
  
  // Zamanlayıcıyı temizle
  if (transcriptionTimeout) {
    clearTimeout(transcriptionTimeout);
    transcriptionTimeout = null;
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  
  setTimeout(() => {
    log("🔄 Oturum yenileniyor...");
    $("transcriptDisplay").textContent = "";
    $("botResponseDisplay").textContent = "";
    connectWS();
  }, 1000);
}

// Gürültü filtreleme seviyesini değiştir
function changeNoiseReduction(type) {
  audioConfig.input_audio_noise_reduction.type = type;
  
  updateSessionConfig(audioConfig);
  
  log(`✅ Gürültü filtreleme ${type} olarak ayarlandı`);
}

/*=====================================================
   UI ve Sayfa Yüklenmesi
   ======================================================= */
window.onload = () => {
  connectWS();
  $("startBtn").onclick = startMic;
  $("stopBtn").onclick = stopMic;
  $("resetBtn").onclick = resetSession;
  $("createResponseBtn").onclick = createResponse;
  $("continuousMode").onchange = toggleContinuousMode;
  $("vadTypeSelect").onchange = (e) => changeVADType(e.target.value);
  $("noiseReductionSelect").onchange = (e) => changeNoiseReduction(e.target.value);
  
  // Threshold ayarı için global fonksiyon
  window.updateThreshold = updateThreshold;
};