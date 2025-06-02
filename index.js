const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const chalk = require('chalk');

const TARGET_JID = 'TARGETPN@s.whatsapp.net';
const LOG_FILE = 'logs.txt';
const MORNING_LOG_FILE = 'Morning_logs.txt';

let onlineStart = null;
let hasSentGreeting = false;
let lastPresenceStatus = null;

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}s`;
}

function writeLog(durationMs) {
  const now = new Date();
  const weekday = now.toLocaleString('en-GB', { weekday: 'long' });
  const dateStr = now.toLocaleString('en-GB');
  const durationStr = formatDuration(durationMs);
  const line = `| ${weekday.padEnd(10)} | ${dateStr.padEnd(22)} | ${durationStr.padEnd(10)} |\n`;

  const header = `== ${TARGET_JID} ==\n\n| Day        | Date & Time            | Duration   |\n|------------|------------------------|------------|\n`;

  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  const existing = fs.readFileSync(LOG_FILE, 'utf-8');
  if (!existing.includes(`== ${TARGET_JID} ==`)) fs.appendFileSync(LOG_FILE, header);

  fs.appendFileSync(LOG_FILE, line);

  const hour = now.getHours();
  if (hour >= 4 && hour < 11) {
    if (!fs.existsSync(MORNING_LOG_FILE)) fs.writeFileSync(MORNING_LOG_FILE, '');
    fs.appendFileSync(MORNING_LOG_FILE, line);
  }

  console.log(chalk.green(`[LOGGED] ${line.trim()}`));
}

function isMorning() {
  const hour = new Date().getHours();
  return hour >= 4 && hour < 11;
}

function logJson(obj, colorFn = chalk.white) {
  console.log(colorFn(JSON.stringify(obj, null, 2)));
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this QR Code:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    }

    if (connection === 'open') {
      console.log(chalk.green('Connected to WhatsApp'));
      await sock.presenceSubscribe(TARGET_JID);
    }
  });

  sock.ev.on('presence.update', async (update) => {
    if (update.id !== TARGET_JID) return;
    const presence = update.presences?.[TARGET_JID];
    if (!presence) return;

    const status = presence.lastKnownPresence;
    if (status === lastPresenceStatus) return;
    lastPresenceStatus = status;
    logPresence(status);

    if (status === 'available') {
      if (!onlineStart) {
        onlineStart = Date.now();
        if (isMorning() && !hasSentGreeting) {
          await sock.sendMessage(TARGET_JID, { text: 'Good morning' });
          hasSentGreeting = true;
        }
      }
    }

    if (status === 'unavailable' && onlineStart) {
      const duration = Date.now() - onlineStart;
      writeLog(duration);
      onlineStart = null;
    }

    if (new Date().getHours() >= 11) hasSentGreeting = true;
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

    logJson({
      type: isFromMe ? 'sent' : 'received',
      from: msg.key.remoteJid,
      time: new Date().toLocaleString('en-GB'),
      message: text
    });
  });

  sock.ev.on('creds.update', saveCreds);

  function logPresence(status) {
    const statusStr = status === 'available' ? 'online' : 'last seen';
    const color = status === 'available' ? chalk.green : chalk.red;
    logJson(
      {
        target: TARGET_JID,
        status: statusStr,
        time: new Date().toLocaleString('en-GB')
      },
      color
    );
  }
}

startSock();
