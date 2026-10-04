# 🎙️ EchoLive — Real-Time Live Speech Translation & Audio Broadcast

**EchoLive** is a lightweight, high-performance, production-ready web application enabling a speaker (host) to broadcast real-time spoken English audio transcribed and translated simultaneously into target languages—with initial first-class support for **Galician (Galego - `gl`)** and **Spanish (Castelán - `es`)**, extensible to any additional language.

Listeners connect instantly by scanning a dynamic QR code on mobile or desktop, watching live synchronized subtitles, and listening to native-pronunciation audio streams.

---

## 🌟 Key Highlights & Architecture

### 1. Zero Database / Ephemeral Room Lifecycle
- **Pure In-Memory State:** Rooms exist purely in-memory (`Map`). Each broadcast generates a unique, human-friendly 6-character room code (e.g. `ABC123`).
- **Immediate Cleanup:** When the host ends the session or closes their browser tab, all connected WebSockets are terminated and room data is immediately purged.
- **Grace Period:** Includes a 15-second reconnection grace period in case the host accidentally refreshes their browser.

### 2. Multi-Tier Resilient Translation Pipeline (Gemini AI + Free Neural Fallback)
- **Speech Capture & Multilingual Source:** Host can speak in English (`en-US`), Spanish/Castelán (`es-ES`), Galician/Galego (`gl-ES`), Portuguese (`pt-PT`), French (`fr-FR`), or German (`de-DE`). Continuous speech is captured using Web Speech API with real-time interim tentative captions and confirmed final phrases.
- **External API (Gemini 2.0 Flash - Strongly Recommended):** Configure `GEMINI_API_KEY` in your `.env` file, server environment (Render dashboard), or Host settings modal. Uses Google's ultra-low latency `gemini-2.0-flash` simultaneous conference interpreter for literary-grade contextual translations.
  - *Get a free API key in 1 click:* [Google AI Studio](https://aistudio.google.com/apikey)
- **Cloud-Safe Neural Fallback (MyMemory + Google GTX):** Automatic zero-configuration fallback ensures translation continues to function even if no API key is provided, bypassing cloud datacenter IP restrictions (e.g. Render / AWS).
- **Extensible Language Schema:** Modifying or adding languages is as simple as adding an item to `SUPPORTED_LANGUAGES`:
  ```javascript
  const SUPPORTED_LANGUAGES = [
    { code: 'gl', name: 'Galego', flag: '🔵' },
    { code: 'es', name: 'Castelán', flag: '🇪🇸' },
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'pt', name: 'Português', flag: '🇵🇹' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' }
  ];
  ```

### 3. Dual-Mode Audio Delivery (Stream Audio by Default)
- **Mode 1: Live Audio Stream (Default):** The server synthesizes translated text chunks into native audio streams and broadcasts them to listeners over WebSockets. Listeners decode and queue audio seamlessly using the Web Audio API.
  - *Why this is critical:* iOS Safari and Android devices notoriously lack built-in local Galician (`gl`) voices in `window.speechSynthesis`. Server-side streaming guarantees flawless, native Galician pronunciation on every phone!
- **Mode 2: Local Device Synthesis (Low-Data Alternative):** Fallback mode where the listener's browser synthesizes incoming text chunks locally using `window.speechSynthesis`.

### 4. Real-Time High-Contrast Subtitles
- Smooth auto-scrolling subtitle box.
- Visual distinction between tentative interim captions (pulsing, italicized) and confirmed final phrases.
- Dynamic font size toggle (`aA`) for lecture halls, conferences, and auditoriums.

---

## 🚀 Quick Start Guide

### Prerequisites
- [Node.js](https://nodejs.org/) (v18.0.0 or higher recommended).
- A microphone (built-in or USB headset).
- A modern browser: Google Chrome, Microsoft Edge, or Safari.

### Installation
1. Clone or navigate to the project directory:
   ```bash
   cd c:\Users\Amador\Downloads\escoita
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the EchoLive server:
   ```bash
   npm start
   ```

4. The server will output:
   ```
   ======================================================
     🎙️ EchoLive Broadcast Server Running!
     Local:   http://localhost:3000
     Network: http://192.168.1.150:3000
     Host:    http://192.168.1.150:3000/host?room=DEMO01
     Listen:  http://192.168.1.150:3000/listen?room=DEMO01
   ======================================================
   ```

---

## 📱 Testing Across Devices on the Same Local Network (WiFi)

To test EchoLive with your computer as the host and your smartphone as a listener:

1. **Ensure Both Devices are on the Same WiFi Network.**
2. On your host computer, open Google Chrome or Edge and navigate to:
   ```
   http://localhost:3000/host
   ```
   (A random 6-character room code will be generated automatically, e.g. `http://localhost:3000/host?room=ECHO24`).
3. **Allow Microphone Permissions** when prompted by your browser.
4. On the host screen, you will see a large **dynamic QR code**:
   - The QR code automatically encodes your local network IP (e.g. `http://192.168.1.xxx:3000/listen?room=ECHO24`).
5. **Scan the QR Code with your smartphone camera**:
   - Open the camera on your iPhone or Android phone and tap the banner to open the listener page.
6. On your smartphone:
   - Tap the prominent **"Start Audio 🔊"** button at the top to satisfy mobile autoplay policies.
   - Select your preferred language (default is **Galego 🔵**).
7. On your computer:
   - Click the big **Microphone** button to start broadcasting.
   - Speak in English: *"Good morning everyone, welcome to the live presentation."*
8. **Observe the Magic:**
   - English speech appears live on the host dashboard.
   - Your smartphone immediately displays the translated Galician subtitle: *"Bo día a todos, benvidos á presentación en directo."*
   - Your smartphone immediately plays the crystal-clear Galician audio stream!

---

## ⚙️ Configuring Gemini AI (Recommended for Cloud Hosting & 100% Reliability)

While EchoLive includes zero-configuration neural fallbacks (MyMemory and Google GTX), configuring a **Google Gemini API Key** is strongly recommended for production, conference environments, and cloud hosting (like Render):

### Option A: Server-Wide Configuration (Best for Render / Deployments)
1. Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).
2. Set the environment variable:
   - **On Render:** In your service dashboard under **Environment Variables**, add `GEMINI_API_KEY` and your key.
   - **Locally:** Create a `.env` file (copy from `.env.example`):
     ```env
     GEMINI_API_KEY=AIzaSy...
     GEMINI_MODEL=gemini-2.0-flash
     ```
3. Restart or deploy the server. All broadcasts and rooms will automatically use Gemini 2.0 Flash without any speaker needing to enter an API key!

### Option B: Host Browser Configuration
1. On the host screen (`/host`), click the **Settings (⚙️)** icon in the top header.
2. Enter your `GEMINI_API_KEY`.
3. Select **Gemini 2.0 Flash** (or `gemini-1.5-flash`).
4. Click **"Test Connection"** to verify translation to Galego and Castelán.
5. Click **"Save Settings"**.
6. The engine badge changes to **"Gemini AI"**. Spoken phrases will now be translated with literary conversational accuracy and natural cadence.

---

## 📂 Project Structure

```
escoita/
├── package.json         # Project metadata and dependencies (express, ws, cors)
├── server.js            # Node.js backend: Express, WebSockets, Gemini API, TTS stream & room manager
├── README.md            # Documentation and instructions
└── public/
    ├── index.html       # Landing page: Create broadcast or enter room code
    ├── host.html        # Host Studio: Mic capture, QR generator, translation preview, settings modal
    └── listen.html      # Listener View: Mobile-first layout, subtitles, audio queue, dual playback modes
```

---

## 🛡️ Troubleshooting & Tips

- **Microphone Not Starting:**
  - Web Speech API requires permission. Click the lock icon in Chrome's address bar to ensure Microphone is allowed.
  - SpeechRecognition requires an internet connection on Chrome to connect to Google speech services.
- **Audio Not Playing on Mobile:**
  - Mobile browsers (Safari on iOS, Chrome on Android) require a user touch gesture before playing audio. Make sure you tap the **"Start Audio 🔊"** button upon entering the listener room.
- **Firewall Notice on Windows:**
  - If connecting from a mobile phone doesn't load the page, Windows Firewall might be blocking port 3000. Run PowerShell as Administrator and run:
    ```powershell
    New-NetFirewallRule -DisplayName "EchoLive 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
    ```
- **Language Pronunciation Quality:**
  - Keep the audio mode set to **"Live Audio Stream"** (the default). If switched to "Local Voice", phones that lack a Galician voice installed will fallback to another language.

---

## 📄 License
MIT License. Built for seamless multilingual communication.
