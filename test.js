import WebSocket from 'ws';

// De WebSocket-server van PumpPortal
const ws = new WebSocket('wss://pumpportal.fun/api/data');

// De contract-address van de coin die je wilt volgen
const coinToTrack = "2oMLiB2y2HnXxSXXfC6eKAifud8i8nK3yizump";

// Wordt uitgevoerd wanneer de verbinding is geopend
ws.on('open', function open() {
  console.log('✅ Verbonden met de PumpPortal WebSocket.');

  // Stel de payload in om je te abonneren op de transacties van de specifieke coin
  const payload = {
      method: "subscribeTokenTrade",
      keys: [coinToTrack] // Array met de contract-address(es) van de token(s)
    };

  // Verzend de abonnementsaanvraag
  ws.send(JSON.stringify(payload));
  console.log(`📡 Abonnement op transacties voor coin ${coinToTrack} is verzonden.`);
});

// Wordt uitgevoerd wanneer er een bericht (transactie-data) binnenkomt
ws.on('message', function message(data) {
  // Parse de JSON-data en log het naar de console
  const tradeData = JSON.parse(data);
  console.log('🧾 Nieuwe transactie:', tradeData);
});

// Wordt uitgevoerd bij een fout
ws.on('error', function error(err) {
  console.error('❌ WebSocket-fout:', err);
});

// Wordt uitgevoerd wanneer de verbinding sluit
ws.on('close', function close() {
  console.log('🔌 Verbinding met de WebSocket is verbroken.');
});