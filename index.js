const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const TARGET_JID = 'TARGETPN@s.whatsapp.net';
let onlineStart = null;
let hasSentGreeting = false;
const LOG_FILE = 'logs.txt';
const MORNING_LOG_FILE = 'Morning_logs.txt';

function formatDuration(ms) {
  const s = ms / 1000;
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${min}m${sec}s`;
}

function logOnlineEvent(jid, durationMs) {
  const now = new Date();
  const timestamp = now.toLocaleString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const logLine = `${timestamp} online:${formatDuration(durationMs)}\n`;

  fs.appendFileSync(LOG_FILE, logLine);

  const hour = now.getHours();
  if (hour >= 4 && hour < 11) {
    fs.appendFileSync(MORNING_LOG_FILE, logLine);
  }
}

function isMorningWindow() {
  const hour = new Date().getHours();
  return hour >= 4 && hour < 11;
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR Code:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      console.log('Disconnected. Reconnecting...', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp');
      await sock.presenceSubscribe(TARGET_JID);
      console.log(`👁️ Subscribed to presence for ${TARGET_JID}`);
    }
  });

  sock.ev.on('presence.update', async (update) => {
    console.log('Presence update:', update);

    const presence = update.presences?.[TARGET_JID];
    if (!presence) return;

    const isOnline = presence.lastKnownPresence === 'available';

    if (isOnline) {
      if (!onlineStart) {
        onlineStart = Date.now();

        if (isMorningWindow() && !hasSentGreeting) {
          await sock.sendMessage(TARGET_JID, { text: 'Good morning' });
          console.log('Sent good morning message.');
          hasSentGreeting = true;
        }
      }
    } else {
      if (onlineStart) {
        const duration = Date.now() - onlineStart;
        logOnlineEvent(TARGET_JID, duration);
        console.log(`Logged online session: ${formatDuration(duration)}`);
        onlineStart = null;
      }
    }

    if (new Date().getHours() >= 11) {
      hasSentGreeting = true;
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const isFromMe = msg.key.fromMe;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '[Non-text message]';

    const log = {
      type: isFromMe ? 'sent' : 'received',
      from: msg.key.remoteJid,
      timestamp: new Date().toISOString(),
      message: text
    };

    console.log(JSON.stringify(log, null, 2));
  });

  sock.ev.on('creds.update', saveCreds);
}

startSock();
