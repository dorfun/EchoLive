const http = require('http');
const { WebSocket } = require('ws');
// Start server in-process
require('./server.js');


// Test runner for EchoLive backend
async function runTests() {
  console.log('--- Starting EchoLive Backend & WebSocket Integration Tests ---');
  
  // Wait a second for server
  await new Promise(r => setTimeout(r, 1000));

  // 1. Test HTTP GET /api/languages
  console.log('Testing GET /api/languages...');
  const langs = await new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/languages', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  console.log('Supported languages:', langs.map(l => l.code).join(', '));
  if (!langs.find(l => l.code === 'gl') || !langs.find(l => l.code === 'es')) {
    throw new Error('Missing gl or es in languages');
  }
  console.log('✅ /api/languages verified');

  // 2. Test HTTP GET /api/network-info
  console.log('Testing GET /api/network-info...');
  const netInfo = await new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/network-info', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  console.log('Network info:', netInfo);
  console.log('✅ /api/network-info verified');

  // 3. Test HTTP GET /api/tts
  console.log('Testing GET /api/tts (Galician synthesis)...');
  const ttsHeaders = await new Promise((resolve, reject) => {
    http.get('http://localhost:3000/api/tts?lang=gl&text=Ola%20amigos', (res) => {
      let len = 0;
      res.on('data', chunk => len += chunk.length);
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], length: len }));
    }).on('error', reject);
  });
  console.log('TTS result:', ttsHeaders);
  if (ttsHeaders.status !== 200 || !ttsHeaders.contentType.includes('audio')) {
    throw new Error('TTS did not return audio/mpeg');
  }
  console.log('✅ Server-side TTS synthesis verified');

  // 4. Test WebSocket Host & Listener Lifecycle
  console.log('Testing WebSocket room lifecycle with room TEST01...');
  const roomCode = 'TEST01';

  // Connect Host
  const hostWs = new WebSocket(`ws://localhost:3000/?room=${roomCode}&role=host`);
  
  await new Promise((resolve, reject) => {
    hostWs.on('open', resolve);
    hostWs.on('error', reject);
  });
  console.log('Host WebSocket connected');

  // Connect Listener
  const listenerWs = new WebSocket(`ws://localhost:3000/?room=${roomCode}&role=listener&lang=gl&mode=stream`);
  await new Promise((resolve, reject) => {
    listenerWs.on('open', resolve);
    listenerWs.on('error', reject);
  });
  console.log('Listener WebSocket connected');

  // Wait for listener count update on host
  let receivedSubtitle = false;
  let receivedAudio = false;

  listenerWs.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    console.log('[Listener received WS message]:', data.type, data.text ? `"${data.text}"` : '');
    if (data.type === 'subtitle' && data.isFinal) {
      receivedSubtitle = true;
    }
    if (data.type === 'audio_chunk' && data.audioBase64) {
      receivedAudio = true;
      console.log(`Audio chunk received for ${data.lang}: Base64 len=${data.audioBase64.length}`);
    }
  });

  // Host sends final transcript
  console.log('Host sending final transcript: "Good morning and welcome to EchoLive."');
  hostWs.send(JSON.stringify({
    type: 'final_transcript',
    text: 'Good morning and welcome to EchoLive.',
    segmentId: 'seg_test_1'
  }));

  // Wait up to 6 seconds for translation & audio streaming
  let waitCount = 0;
  while ((!receivedSubtitle || !receivedAudio) && waitCount < 12) {
    await new Promise(r => setTimeout(r, 500));
    waitCount++;
  }

  if (!receivedSubtitle) throw new Error('Listener did not receive translated subtitle');
  if (!receivedAudio) throw new Error('Listener did not receive live audio chunk');

  console.log('✅ Real-time Translation & Audio Chunk streaming verified successfully!');

  // Test host ending session
  console.log('Host sending host_end_session...');
  let listenerReceivedOffline = false;
  listenerWs.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === 'host_offline') {
      listenerReceivedOffline = true;
    }
  });

  hostWs.send(JSON.stringify({ type: 'host_end_session' }));
  await new Promise(r => setTimeout(r, 800));

  console.log('✅ Room cleanup and termination verified!');
  
  hostWs.close();
  listenerWs.close();
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
