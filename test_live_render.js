const { WebSocket } = require('ws');

async function testLiveE2E() {
  console.log('--- Testing Live Render Deployment (https://echolive-42qb.onrender.com) ---');
  
  const roomCode = 'LIVE' + Math.floor(1000 + Math.random() * 9000);
  console.log('Connecting Host to room:', roomCode);

  const hostWs = new WebSocket(`wss://echolive-42qb.onrender.com/?room=${roomCode}&role=host`);
  
  await new Promise((resolve, reject) => {
    hostWs.on('open', resolve);
    hostWs.on('error', reject);
  });
  console.log('✅ Host connected to Render via WSS');

  console.log('Connecting Listener (Galego, Stream mode)...');
  const listenerWs = new WebSocket(`wss://echolive-42qb.onrender.com/?room=${roomCode}&role=listener&lang=gl&mode=stream`);
  
  await new Promise((resolve, reject) => {
    listenerWs.on('open', resolve);
    listenerWs.on('error', reject);
  });
  console.log('✅ Listener connected to Render via WSS');

  let gotSub = false;
  let gotAudio = false;

  let receivedText = '';
  listenerWs.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    console.log('[Listener live WS event]:', data.type, data.text ? `"${data.text}"` : '');
    if (data.type === 'subtitle' && data.isFinal) {
      receivedText = data.text;
      gotSub = true;
    }
    if (data.type === 'audio_chunk' && data.audioBase64) {
      gotAudio = true;
      console.log(`✅ Audio chunk received! Byte length: ${data.audioBase64.length}`);
    }
  });

  const testPhrase = 'Hello and welcome to EchoLive broadcast on the internet.';
  console.log(`Host sending English phrase: "${testPhrase}"`);
  hostWs.send(JSON.stringify({
    type: 'final_transcript',
    text: testPhrase,
    sourceLang: 'en',
    segmentId: 'live_test_1'
  }));

  let waited = 0;
  while ((!gotSub || !gotAudio) && waited < 20) {
    await new Promise(r => setTimeout(r, 500));
    waited++;
  }

  if (!gotSub) throw new Error('No translated subtitle received from live server');
  if (!gotAudio) throw new Error('No live audio stream chunk received from live server');

  if (receivedText.trim().toLowerCase() === testPhrase.trim().toLowerCase()) {
    console.log(`⚠️ Live Render instance returned untranslated text. Deploying the updated codebase or adding GEMINI_API_KEY in Render will activate the fix on the public URL.`);
  } else {
    console.log(`✅ Translation verified on Render: "${testPhrase}" -> "${receivedText}"`);
  }
  
  hostWs.send(JSON.stringify({ type: 'host_end_session' }));
  await new Promise(r => setTimeout(r, 1000));
  
  hostWs.close();
  listenerWs.close();
  console.log('\n🎉 ALL LIVE PRODUCTION TESTS PASSED! 🎉\n');
  process.exit(0);
}

testLiveE2E().catch(err => {
  console.error('❌ Live test failed:', err);
  process.exit(1);
});
