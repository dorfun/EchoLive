const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const url = require('url');
const cors = require('cors');

// Load environment variables from .env file if present (zero external dependencies)
const envFilePath = path.join(__dirname, '.env');
if (fs.existsSync(envFilePath)) {
  try {
    const envFileContent = fs.readFileSync(envFilePath, 'utf-8');
    for (const rawLine of envFileContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line && !line.startsWith('#') && line.includes('=')) {
        const eqIdx = line.indexOf('=');
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
    console.log('[EchoLive] Loaded environment configuration from .env file');
  } catch (err) {
    console.warn('[EchoLive] Warning: Could not read .env file:', err.message);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supported language schema - modular and extensible
const SUPPORTED_LANGUAGES = [
  { code: 'gl', name: 'Galego', flag: '🔵' },
  { code: 'es', name: 'Castelán', flag: '🇪🇸' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' }
];

// Ephemeral in-memory room management (Zero database)
// Room format:
// code -> {
//   code: string,
//   hostWs: WebSocket | null,
//   listeners: Map<WebSocket, { lang: string, mode: 'stream' | 'local', joinedAt: number }>,
//   geminiApiKey: string | null,
//   geminiModel: string,
//   cleanupTimer: Timeout | null,
//   createdAt: number
// }
const rooms = new Map();

// In-memory caches for low-latency delivery
const translationCache = new Map(); // `${lang}:${text}` -> string
const ttsAudioCache = new Map();    // `${lang}:${text}` -> Buffer

// Helper to determine local network IP for easy LAN/mobile QR access
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Generate unique 6-character room code (alphanumeric, easily readable)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous 0, O, 1, I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// Room retrieval or creation
function getOrCreateRoom(code) {
  const normalized = (code || '').toUpperCase().trim();
  if (!rooms.has(normalized)) {
    rooms.set(normalized, {
      code: normalized,
      hostWs: null,
      listeners: new Map(),
      geminiApiKey: process.env.GEMINI_API_KEY || null,
      geminiModel: DEFAULT_GEMINI_MODEL,
      cleanupTimer: null,
      createdAt: Date.now()
    });
  }
  return rooms.get(normalized);
}

// Clean up and destroy room completely
function destroyRoom(code, reason = 'Host disconnected') {
  const room = rooms.get(code);
  if (!room) return;

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  // Notify and disconnect all listeners
  for (const [listenerWs] of room.listeners.entries()) {
    try {
      if (listenerWs.readyState === WebSocket.OPEN) {
        listenerWs.send(JSON.stringify({
          type: 'host_offline',
          reason: reason
        }));
        listenerWs.close(1000, reason);
      }
    } catch (e) {
      // Ignore socket closing error
    }
  }

  // Close host socket if still open
  if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
    try {
      room.hostWs.close(1000, reason);
    } catch (e) {}
  }

  rooms.delete(code);
  console.log(`[EchoLive] Room ${code} destroyed (${reason}). Total active rooms: ${rooms.size}`);
}

// Schedule room destruction if host drops
function scheduleRoomCleanup(code, delayMs = 15000) {
  const room = rooms.get(code);
  if (!room) return;

  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);

  // Notify listeners that host is temporarily disconnected
  for (const [listenerWs] of room.listeners.entries()) {
    try {
      if (listenerWs.readyState === WebSocket.OPEN) {
        listenerWs.send(JSON.stringify({
          type: 'host_status',
          status: 'reconnecting',
          message: 'Host temporarily disconnected. Reconnecting...'
        }));
      }
    } catch (e) {}
  }

  room.cleanupTimer = setTimeout(() => {
    destroyRoom(code, 'Host session timed out');
  }, delayMs);
}

// Calculate active languages in a room to optimize translation calls
function getActiveRoomLanguages(room) {
  const langCounts = {};
  for (const info of room.listeners.values()) {
    langCounts[info.lang] = (langCounts[info.lang] || 0) + 1;
  }
  return langCounts;
}

// Notify host about listener presence
function notifyHostStats(room) {
  if (room && room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
    const activeLanguages = getActiveRoomLanguages(room);
    room.hostWs.send(JSON.stringify({
      type: 'listener_update',
      count: room.listeners.size,
      activeLanguages
    }));
  }
}

// ---------------------------------------------------------
// TRANSLATION ENGINE (Hybrid Gemini 2.5 Flash + Free Fallback)
// ---------------------------------------------------------

// Helper to make HTTPS requests as Promise
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(data)
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(8000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// ---------------------------------------------------------
// TRANSLATION ENGINE (Multi-Tier Resilient Architecture)
// ---------------------------------------------------------
// Tier 1: High-Precision Gemini Flash (Server or Host API key)
// Tier 2: Free Cloud-Safe Neural Fallback (MyMemory API - works reliably on Render / Cloud)
// Tier 3: Google GTX Translation Fallback (sl=auto for local LANs)

// 1. Cloud-Safe Neural Translation (MyMemory API)
async function translateMyMemory(text, sourceLang = 'en', targetLang = 'gl') {
  const cacheKey = `mymemory:${sourceLang}:${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const pair = `${sourceLang}|${targetLang}`;
    const targetUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
    const parsed = new URL(targetUrl);

    const response = await httpsRequest({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EchoLive/1.0; speech-translation)'
      }
    });

    if (response.statusCode === 200) {
      const json = JSON.parse(response.body.toString('utf-8'));
      if (json && json.responseData && json.responseData.translatedText) {
        const translated = json.responseData.translatedText.trim();
        // Discard MyMemory rate warnings or failure echoes
        if (translated && !translated.startsWith('MYMEMORY WARNING') && !translated.startsWith('QUERY LENGTH LIMIT')) {
          if (translated.toLowerCase() !== text.toLowerCase() || sourceLang === targetLang) {
            translationCache.set(cacheKey, translated);
            return translated;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[MyMemory] Translation warning for ${sourceLang}->${targetLang}:`, err.message);
  }

  return null;
}

// 2. Google GTX Free Fallback with Dynamic Source Language
async function translateGoogleGtx(text, sourceLang = 'auto', targetLang = 'gl') {
  const sl = sourceLang || 'auto';
  const cacheKey = `gtx:${sl}:${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const parsed = new URL(targetUrl);

    const response = await httpsRequest({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    if (response.statusCode === 200) {
      const json = JSON.parse(response.body.toString('utf-8'));
      if (Array.isArray(json) && Array.isArray(json[0])) {
        const translated = json[0].map(item => item[0]).filter(Boolean).join('');
        if (translated && translated.trim()) {
          translationCache.set(cacheKey, translated.trim());
          return translated.trim();
        }
      }
    }
  } catch (err) {
    console.warn(`[GTX] Translation warning for ${targetLang}:`, err.message);
  }

  return null;
}

// 3. High-Precision Gemini Flash Translation
async function translateWithGemini(text, targetLangs, apiKey, model = DEFAULT_GEMINI_MODEL, sourceLang = 'en') {
  // Normalize model name (convert legacy/invalid 'gemini-2.5-flash' to 'gemini-2.0-flash')
  let actualModel = model || DEFAULT_GEMINI_MODEL;
  if (actualModel === 'gemini-2.5-flash') {
    actualModel = 'gemini-2.0-flash';
  }

  const langListStr = targetLangs.map(code => {
    const found = SUPPORTED_LANGUAGES.find(l => l.code === code);
    return `${code} (${found ? found.name : code})`;
  }).join(', ');

  const srcLangObj = SUPPORTED_LANGUAGES.find(l => l.code === sourceLang);
  const srcName = srcLangObj ? `${srcLangObj.name} (${srcLangObj.code})` : sourceLang;

  const systemPrompt = `You are a real-time simultaneous conference interpreter. Translate the spoken input text from ${srcName} into the requested target languages: ${langListStr}.
Maintain natural speech rhythm, colloquial fluency, and precise nuance.
Crucial: Return ONLY a raw JSON object mapping language code to translated string. No markdown formatting, no backticks, no comments.
Example format:
{
  "gl": "Ola a todos e benvidos.",
  "es": "Hola a todos y bienvenidos."
}`;

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: `Spoken input to translate: "${text}"` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  const apiPath = `/v1beta/models/${encodeURIComponent(actualModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    if (response.statusCode === 200) {
      const respJson = JSON.parse(response.body.toString('utf-8'));
      const candidateText = respJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (candidateText) {
        // Clean potential markdown wrappers
        let cleanJsonStr = candidateText.trim();
        if (cleanJsonStr.startsWith('```json')) {
          cleanJsonStr = cleanJsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanJsonStr.startsWith('```')) {
          cleanJsonStr = cleanJsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }
        const parsed = JSON.parse(cleanJsonStr);
        return parsed;
      }
    } else {
      console.warn(`[Gemini] HTTP ${response.statusCode}:`, response.body.toString('utf-8'));
    }
  } catch (err) {
    console.warn(`[Gemini] Translation failed:`, err.message);
  }

  return null;
}

// Unified multi-tier translation dispatcher
async function performTranslation(text, targetLangs, geminiApiKey, geminiModel, sourceLang = 'en') {
  if (!text || !text.trim() || targetLangs.length === 0) {
    return {};
  }

  const results = {};
  const neededLangs = [...new Set(targetLangs)];
  const remainingLangs = [];

  // If target language is same as source language, use original text directly
  for (const lang of neededLangs) {
    if (lang === sourceLang) {
      results[lang] = text;
    } else {
      remainingLangs.push(lang);
    }
  }

  if (remainingLangs.length === 0) {
    return results;
  }

  // 1. Try Gemini if API key is provided (either from room or server environment)
  const effectiveKey = (geminiApiKey && geminiApiKey.trim()) || process.env.GEMINI_API_KEY;
  if (effectiveKey && effectiveKey.trim()) {
    try {
      const geminiRes = await translateWithGemini(text, remainingLangs, effectiveKey.trim(), geminiModel, sourceLang);
      if (geminiRes && typeof geminiRes === 'object') {
        for (const lang of remainingLangs) {
          if (geminiRes[lang] && typeof geminiRes[lang] === 'string' && geminiRes[lang].trim()) {
            results[lang] = geminiRes[lang].trim();
          }
        }
      }
    } catch (e) {
      console.warn('[Translate] Gemini execution error, using fallback:', e.message);
    }
  }

  // 2. Free fallbacks for any languages not yet resolved
  for (const lang of remainingLangs) {
    if (results[lang]) continue;

    // Try MyMemory (cloud-friendly, works on Render / Datacenters)
    let tr = await translateMyMemory(text, sourceLang, lang);

    // If MyMemory failed or returned empty, try Google GTX
    if (!tr) {
      tr = await translateGoogleGtx(text, sourceLang, lang);
    }

    if (tr) {
      results[lang] = tr;
    } else {
      // Graceful fallback to avoid crash
      console.warn(`[Translate] Notice: Could not translate chunk to ${lang}, using original text`);
      results[lang] = text;
    }
  }

  return results;
}

// ---------------------------------------------------------
// SERVER-SIDE AUDIO SYNTHESIS (Live Audio Stream Pipeline)
// ---------------------------------------------------------
// Produces native, consistent pronunciation (e.g. Galician)
// across iOS, Android, and Desktop without OS voice reliance.
async function fetchTTSAudio(text, lang = 'gl') {
  if (!text || !text.trim()) return null;

  const trimmed = text.trim().slice(0, 200); // Max chunk length
  const cacheKey = `${lang}:${trimmed}`;
  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey);
  }

  try {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(trimmed)}`;
    const parsed = new URL(ttsUrl);

    const res = await httpsRequest({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      }
    });

    if (res.statusCode === 200 && res.body && res.body.length > 0) {
      if (ttsAudioCache.size > 300) {
        // Simple LRU cache size control
        const firstKey = ttsAudioCache.keys().next().value;
        ttsAudioCache.delete(firstKey);
      }
      ttsAudioCache.set(cacheKey, res.body);
      return res.body;
    }
  } catch (err) {
    console.warn(`[TTS] Audio synthesis error for ${lang}:`, err.message);
  }

  return null;
}

// ---------------------------------------------------------
// REST API ROUTES
// ---------------------------------------------------------

// Network information for dynamic QR generation
app.get('/api/network-info', (req, res) => {
  const localIp = getLocalIpAddress();
  res.json({
    localIp,
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    networkUrl: `http://${localIp}:${PORT}`
  });
});

// Supported languages
app.get('/api/languages', (req, res) => {
  res.json(SUPPORTED_LANGUAGES);
});

// Check room existence
app.get('/api/rooms/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ exists: false, error: 'Room does not exist' });
  }
  res.json({
    exists: true,
    code: room.code,
    hostOnline: !!(room.hostWs && room.hostWs.readyState === WebSocket.OPEN),
    listenerCount: room.listeners.size
  });
});

// Server config and engine status
app.get('/api/config', (req, res) => {
  res.json({
    hasServerApiKey: !!process.env.GEMINI_API_KEY,
    defaultModel: DEFAULT_GEMINI_MODEL,
    supportedModels: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Recommended: Ultra-fast & High Precision)' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
    ]
  });
});

// Test Gemini API key endpoint
app.post('/api/test-gemini', async (req, res) => {
  const { apiKey, model, sourceLang } = req.body;
  const effectiveKey = (apiKey && apiKey.trim()) || process.env.GEMINI_API_KEY;
  if (!effectiveKey) {
    return res.status(400).json({ success: false, error: 'API key is required to test' });
  }

  try {
    const testResult = await translateWithGemini(
      'Hello everyone, welcome to EchoLive broadcast.',
      ['gl', 'es'],
      effectiveKey,
      model || DEFAULT_GEMINI_MODEL,
      sourceLang || 'en'
    );
    if (testResult && (testResult.gl || testResult.es)) {
      return res.json({ success: true, result: testResult });
    }
    res.status(400).json({ success: false, error: 'Gemini responded but did not return valid translation JSON' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Direct TTS audio test route
app.get('/api/tts', async (req, res) => {
  const { text, lang } = req.query;
  if (!text) return res.status(400).send('Text parameter required');
  const buffer = await fetchTTSAudio(text, lang || 'gl');
  if (buffer) {
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400'
    });
    res.send(buffer);
  } else {
    res.status(500).send('Synthesis failed');
  }
});

// HTML page routes
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/listen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'listen.html'));
});

// ---------------------------------------------------------
// WEBSOCKET REAL-TIME DISPATCHER
// ---------------------------------------------------------
wss.on('connection', (ws, req) => {
  const host = req.headers.host || 'localhost';
  const parsedUrl = new URL(req.url, `http://${host}`);
  const role = parsedUrl.searchParams.get('role') || 'listener';
  const roomCode = (parsedUrl.searchParams.get('room') || '').toUpperCase().trim();
  const query = Object.fromEntries(parsedUrl.searchParams.entries());


  if (!roomCode) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room code is required' }));
    ws.close(1008, 'Room code missing');
    return;
  }

  const room = getOrCreateRoom(roomCode);

  // ---------------- Host Handler ----------------
  if (role === 'host') {
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }

    room.hostWs = ws;
    console.log(`[EchoLive] Host connected to room ${roomCode}`);

    // Send confirmation to host with engine details
    ws.send(JSON.stringify({
      type: 'host_ready',
      room: roomCode,
      listenerCount: room.listeners.size,
      activeLanguages: getActiveRoomLanguages(room),
      supportedLanguages: SUPPORTED_LANGUAGES,
      hasServerApiKey: !!process.env.GEMINI_API_KEY,
      geminiModel: room.geminiModel || DEFAULT_GEMINI_MODEL
    }));

    // Notify listeners that host is live
    for (const [listenerWs] of room.listeners.entries()) {
      try {
        if (listenerWs.readyState === WebSocket.OPEN) {
          listenerWs.send(JSON.stringify({
            type: 'host_status',
            status: 'online',
            message: 'Host is online'
          }));
        }
      } catch (e) {}
    }

    ws.on('message', async (messageData) => {
      try {
        const data = JSON.parse(messageData.toString());

        // Update settings (Gemini API Key or model)
        if (data.type === 'update_settings') {
          if (data.geminiApiKey !== undefined) room.geminiApiKey = data.geminiApiKey;
          if (data.geminiModel !== undefined) {
            room.geminiModel = data.geminiModel === 'gemini-2.5-flash' ? 'gemini-2.0-flash' : data.geminiModel;
          }
          ws.send(JSON.stringify({ 
            type: 'settings_updated', 
            status: 'ok',
            geminiModel: room.geminiModel,
            hasEffectiveKey: !!(room.geminiApiKey || process.env.GEMINI_API_KEY)
          }));
          return;
        }

        // Host manually ending session
        if (data.type === 'host_end_session') {
          destroyRoom(roomCode, 'Host closed broadcast');
          return;
        }

        // Interim live speech transcript (tentative)
        if (data.type === 'interim_transcript') {
          const text = (data.text || '').trim();
          if (!text) return;

          const sourceLang = data.sourceLang || 'en';

          // Collect languages currently listened to by participants
          const activeLangs = Object.keys(getActiveRoomLanguages(room));
          // Always translate at least to gl and es for host monitor
          const targetLangs = [...new Set(['gl', 'es', ...activeLangs])];

          // Quick translation for interim subtitles
          const translations = await performTranslation(text, targetLangs, room.geminiApiKey, room.geminiModel, sourceLang);

          // Echo preview back to host
          ws.send(JSON.stringify({
            type: 'transcript_preview',
            isFinal: false,
            original: text,
            sourceLang,
            translations,
            segmentId: data.segmentId
          }));

          // Broadcast interim subtitles to listeners
          for (const [listenerWs, listenerInfo] of room.listeners.entries()) {
            if (listenerWs.readyState === WebSocket.OPEN) {
              listenerWs.send(JSON.stringify({
                type: 'subtitle',
                isFinal: false,
                segmentId: data.segmentId,
                lang: listenerInfo.lang,
                text: translations[listenerInfo.lang] || text,
                original: text
              }));
            }
          }
          return;
        }

        // Final spoken speech segment (confirmed phrase)
        if (data.type === 'final_transcript') {
          const text = (data.text || '').trim();
          if (!text) return;

          const sourceLang = data.sourceLang || 'en';

          const activeLangs = Object.keys(getActiveRoomLanguages(room));
          const targetLangs = [...new Set(['gl', 'es', ...activeLangs])];

          // High-accuracy translation
          const translations = await performTranslation(text, targetLangs, room.geminiApiKey, room.geminiModel, sourceLang);

          // Send confirmation back to host
          ws.send(JSON.stringify({
            type: 'transcript_preview',
            isFinal: true,
            original: text,
            sourceLang,
            translations,
            segmentId: data.segmentId
          }));

          // Broadcast confirmed final subtitles to all listeners
          for (const [listenerWs, listenerInfo] of room.listeners.entries()) {
            if (listenerWs.readyState === WebSocket.OPEN) {
              const translatedChunk = translations[listenerInfo.lang] || text;
              listenerWs.send(JSON.stringify({
                type: 'subtitle',
                isFinal: true,
                segmentId: data.segmentId,
                lang: listenerInfo.lang,
                text: translatedChunk,
                original: text
              }));
            }
          }

          // Generate and stream Live Audio for listeners in 'stream' mode
          // Generate audio chunks for needed languages in parallel
          const streamLangs = new Set();
          for (const info of room.listeners.values()) {
            if (info.mode === 'stream') {
              streamLangs.add(info.lang);
            }
          }

          for (const lang of streamLangs) {
            const translatedText = translations[lang];
            if (translatedText) {
              // Asynchronously synthesize and push audio
              fetchTTSAudio(translatedText, lang).then(audioBuffer => {
                if (!audioBuffer) return;
                const audioBase64 = audioBuffer.toString('base64');

                for (const [listenerWs, info] of room.listeners.entries()) {
                  if (info.mode === 'stream' && info.lang === lang && listenerWs.readyState === WebSocket.OPEN) {
                    listenerWs.send(JSON.stringify({
                      type: 'audio_chunk',
                      segmentId: data.segmentId,
                      lang,
                      mimeType: 'audio/mpeg',
                      audioBase64,
                      text: translatedText
                    }));
                  }
                }
              }).catch(err => console.warn('[Audio Broadcast] Stream error:', err));
            }
          }
        }
      } catch (err) {
        console.error('[EchoLive] Host message error:', err);
      }
    });

    ws.on('close', () => {
      console.log(`[EchoLive] Host socket closed for room ${roomCode}`);
      scheduleRoomCleanup(roomCode);
    });

    ws.on('error', (err) => {
      console.warn(`[EchoLive] Host socket error in room ${roomCode}:`, err.message);
    });

  // ---------------- Listener Handler ----------------
  } else {
    const initialLang = query.lang || 'gl';
    const initialMode = query.mode || 'stream'; // Default Live Audio Stream mode

    room.listeners.set(ws, {
      lang: initialLang,
      mode: initialMode,
      joinedAt: Date.now()
    });

    console.log(`[EchoLive] Listener joined room ${roomCode} (lang: ${initialLang}, mode: ${initialMode}). Total: ${room.listeners.size}`);

    // Inform listener about room status
    ws.send(JSON.stringify({
      type: 'listener_ready',
      room: roomCode,
      lang: initialLang,
      mode: initialMode,
      hostOnline: !!(room.hostWs && room.hostWs.readyState === WebSocket.OPEN),
      supportedLanguages: SUPPORTED_LANGUAGES
    }));

    // Update host listener metrics
    notifyHostStats(room);

    ws.on('message', (messageData) => {
      try {
        const data = JSON.parse(messageData.toString());

        if (data.type === 'change_language') {
          const info = room.listeners.get(ws);
          if (info && data.lang) {
            info.lang = data.lang;
            notifyHostStats(room);
          }
        }

        if (data.type === 'change_mode') {
          const info = room.listeners.get(ws);
          if (info && data.mode) {
            info.mode = data.mode;
          }
        }
      } catch (e) {
        console.warn('[EchoLive] Listener message error:', e.message);
      }
    });

    ws.on('close', () => {
      room.listeners.delete(ws);
      console.log(`[EchoLive] Listener left room ${roomCode}. Remaining: ${room.listeners.size}`);
      notifyHostStats(room);
    });

    ws.on('error', (err) => {
      console.warn(`[EchoLive] Listener socket error:`, err.message);
    });
  }
});

// Periodic maintenance for stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // If no host connected for > 15 minutes, cleanup
    if (!room.hostWs || room.hostWs.readyState !== WebSocket.OPEN) {
      if (!room.cleanupTimer && (now - room.createdAt > 900000)) {
        destroyRoom(code, 'Room inactivity timeout');
      }
    }
  }
}, 60000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIpAddress();
  console.log(`\n======================================================`);
  console.log(`  🎙️ EchoLive Broadcast Server Running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIp}:${PORT}`);
  console.log(`  Host:    http://${localIp}:${PORT}/host?room=DEMO01`);
  console.log(`  Listen:  http://${localIp}:${PORT}/listen?room=DEMO01`);
  console.log(`======================================================\n`);
});
