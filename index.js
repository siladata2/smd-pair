// ============================================================
// SILA MD — PAIRING + SESSION SERVER
// Created By Sila Tech
// ============================================================

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');
const zlib = require('zlib');

const config = require('./config.js');
const logger = pino({ level: 'silent' });
const accounts = new Map();

// ============================================================
// ACCOUNT HELPERS
// ============================================================

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function getAccount(phoneNumber) {
  const phone = normalizePhone(phoneNumber);

  if (!phone) return null;

  if (!accounts.has(phone)) {
    accounts.set(phone, {
      phone,
      status: 'idle',
      isConnecting: false,
      sock: null,
      pairingCode: null,
      qrDataUrl: null,
      sessionDir: path.join(__dirname, 'sessions', phone),
      sessionSentFlag: path.join(
        __dirname,
        'sessions',
        phone,
        '.session_sent'
      ),
      stopAfterSession: false
    });
  }

  return accounts.get(phone);
}

// ============================================================
// SESSION FILES
// ============================================================

function collectSessionFiles(dir, baseDir = dir) {
  const files = [];

  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, {
    withFileTypes: true
  })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSessionFiles(fullPath, baseDir));
    } else {
      files.push({
        path: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
        data: fs.readFileSync(fullPath).toString('base64')
      });
    }
  }

  return files;
}

function createSessionId(account) {
  const files = collectSessionFiles(account.sessionDir);

  if (!files.length) {
    throw new Error('No auth files');
  }

  const payload = {
    format: 'SILA-MD-SESSION',
    version: 1,
    phone: account.phone,
    files
  };

  const compressed = zlib.gzipSync(
    Buffer.from(JSON.stringify(payload), 'utf8')
  );

  return config.sessionPrefix + compressed.toString('base64');
}

function clearAccountSession(account) {
  if (!account) return;

  try {
    if (fs.existsSync(account.sessionDir)) {
      fs.rmSync(account.sessionDir, {
        recursive: true,
        force: true
      });
    }
  } catch {}

  account.pairingCode = null;
  account.qrDataUrl = null;
  account.sock = null;
  account.status = 'session_not_found';
  account.isConnecting = false;
  account.stopAfterSession = false;
}

// ============================================================
// WAIT HELPER
// ============================================================

function waitFor(condition, timeoutMs = 30000, intervalMs = 250) {
  return new Promise(resolve => {
    const start = Date.now();

    const interval = setInterval(() => {
      try {
        const value = condition();

        if (value) {
          clearInterval(interval);
          return resolve(value);
        }

        if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          return resolve(null);
        }
      } catch {
        clearInterval(interval);
        return resolve(null);
      }
    }, intervalMs);
  });
}

// ============================================================
// SEND SESSION ID
// ============================================================

async function handlePostConnect(sock, account) {
  try {
    if (fs.existsSync(account.sessionSentFlag)) {
      return true;
    }

    console.log(
      `[Session:${account.phone}] Waiting for credentials...`
    );

    await new Promise(resolve => setTimeout(resolve, 3000));

    const sessionId = createSessionId(account);

    console.log(
      `\n[Session:${account.phone}] SESSION ID GENERATED\n${sessionId}\n`
    );

    const selfJid = sock.user?.id;

    if (!selfJid) return false;

    await sock.sendMessage(selfJid, {
      text: sessionId
    });

    await new Promise(resolve => setTimeout(resolve, 1200));

    const message =
      `╭━━〔 SILA MD SESSION 〕━━╮\n` +
      `✅ *SESSION ID GENERATED SUCCESSFULLY*\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `⚠️ Never share your Session ID with anyone.\n\n` +
      `📢 *Channel:*\n${config.channelLink}\n\n` +
      `👥 *Group:*\n${config.groupLink}\n` +
      `▬▬▬▬▬▬▬▬▬▬▬▬\n` +
      `🧑‍💻 Deploy your bot on any panel.\n` +
      `_Created By Sila Tech_\n` +
      `╰━━━━━━━━━━━━━━╯`;

    await sock.sendMessage(selfJid, {
      text: message
    });

    fs.mkdirSync(account.sessionDir, {
      recursive: true
    });

    fs.writeFileSync(
      account.sessionSentFlag,
      new Date().toISOString(),
      'utf8'
    );

    console.log(
      `[Session:${account.phone}] Session ID sent successfully.`
    );

    return true;
  } catch (error) {
    console.error('[Session] Failed:', error.message);
    return false;
  }
}

// ============================================================
// CONNECT WHATSAPP
// ============================================================

async function connect(phoneNumber) {
  const phone = normalizePhone(phoneNumber);
  const account = getAccount(phone);

  if (!account || account.isConnecting) return;

  account.isConnecting = true;
  account.stopAfterSession = false;

  try {
    if (!fs.existsSync(account.sessionDir)) {
      fs.mkdirSync(account.sessionDir, {
        recursive: true
      });
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(account.sessionDir);

    let version;

    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = [2, 3000, 1017546695];
    }

    console.log(
      `[Bot:${phone}] Registered: ${state.creds.registered}`
    );

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          logger
        )
      },
      browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
      printQRInTerminal: false,
      logger
    });

    account.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (qr) {
        account.qrDataUrl = await QRCode.toDataURL(qr, {
          width: 300
        });

        account.pairingCode = null;
        account.status = 'qr_ready';

        console.log(`[Bot:${phone}] QR ready.`);
      }

      if (connection === 'open') {
        console.log(`[Bot:${phone}] WhatsApp connected.`);

        account.status = 'connected';
        account.isConnecting = false;

        await new Promise(resolve => setTimeout(resolve, 1500));

        // ----------------------------------------------------
        // GENERATE AND SEND SESSION ID
        // ----------------------------------------------------

        await new Promise(resolve => setTimeout(resolve, 1500));

        const sent = await handlePostConnect(sock, account);

        if (sent) {
          account.stopAfterSession = true;

          console.log(
            `[Bot:${phone}] Session captured. Closing pairing socket.`
          );

          try {
            sock.end(undefined);
          } catch {}

          account.sock = null;
          account.status = 'session_ready';
        }
      }

      if (connection === 'close') {
        console.log(`[Bot:${phone}] Connection closed.`);

        account.sock = null;
        account.isConnecting = false;

        if (account.stopAfterSession) {
          console.log(
            `[Bot:${phone}] Pairing socket stopped intentionally.`
          );
          return;
        }

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession
        ) {
          clearAccountSession(account);
          return;
        }

        account.status = 'disconnected';

        if (config.autoReconnect) {
          setTimeout(() => {
            const current = accounts.get(phone);

            if (
              current &&
              current.status !== 'connected' &&
              !current.isConnecting
            ) {
              connect(phone).catch(() => {});
            }
          }, 5000);
        }
      }
    });

    if (!state.creds.registered) {
      account.status = 'generating_code';

      await new Promise(resolve => setTimeout(resolve, 1500));

      console.log(`[Bot:${phone}] Requesting pairing code...`);

      const code = await sock.requestPairingCode(phone);

      const formatted =
        String(code)
          .replace(/[^A-Za-z0-9]/g, '')
          .match(/.{1,4}/g)
          ?.join('-') || String(code);

      account.pairingCode = formatted;
      account.status = 'waiting_approval';

      console.log(`[Bot:${phone}] Pairing code: ${formatted}`);
    }
  } catch (error) {
    console.error(`[Bot:${phone}] Fatal:`, error.message);

    account.status = 'failed';
    account.sock = null;
    account.isConnecting = false;
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(
  path.join(__dirname, 'public')
));

app.get('/health', (req, res) => {
  res.send('SILA MD Pairing Server Running');
});

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.get('/pair', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.get('/api/info', (req, res) => {
  res.json({
    botName: config.botName,
    developer: config.developer,
    channelLink: config.channelLink,
    groupLink: config.groupLink,
    logoUrl: config.logoUrl
  });
});

app.get('/api/status', (req, res) => {
  const phone = normalizePhone(req.query.phone);

  if (!phone) {
    return res.json({
      status: 'idle',
      connected: false,
      pairingCode: null,
      qrDataUrl: null,
      phone: null
    });
  }

  const account = accounts.get(phone);

  if (!account) {
    return res.json({
      status: 'session_not_found',
      connected: false,
      pairingCode: null,
      qrDataUrl: null,
      phone
    });
  }

  return res.json({
    status: account.status,
    connected: account.status === 'connected',
    pairingCode: account.pairingCode || null,
    qrDataUrl: account.qrDataUrl || null,
    phone
  });
});

app.post('/api/pair', async (req, res) => {
  const clean = normalizePhone(req.body.phone);

  if (!clean || clean.length < 7) {
    return res.status(400).json({
      success: false,
      error: 'Valid number required'
    });
  }

  const account = getAccount(clean);

  if (account.status === 'connected') {
    return res.status(400).json({
      success: false,
      error: 'Already connected'
    });
  }

  if (
    account.pairingCode &&
    (
      account.status === 'waiting_approval' ||
      account.status === 'pairing_code_ready'
    )
  ) {
    return res.json({
      success: true,
      phone: clean,
      pairingCode: account.pairingCode,
      status: 'waiting_approval'
    });
  }

  if (account.isConnecting) {
    const existingCode = await waitFor(
      () => accounts.get(clean)?.pairingCode || null,
      30000,
      250
    );

    if (!existingCode) {
      return res.status(408).json({
        success: false,
        error: 'Timeout'
      });
    }

    return res.json({
      success: true,
      phone: clean,
      pairingCode: existingCode,
      status: 'waiting_approval'
    });
  }

  account.pairingCode = null;
  account.qrDataUrl = null;
  account.status = 'generating_code';
  account.stopAfterSession = false;

  connect(clean).catch(() => {});

  const code = await waitFor(
    () => accounts.get(clean)?.pairingCode || null,
    30000,
    250
  );

  if (!code) {
    return res.status(408).json({
      success: false,
      error: 'Timeout generating code'
    });
  }

  return res.json({
    success: true,
    phone: clean,
    pairingCode: code,
    status: 'waiting_approval'
  });
});

app.post('/api/start-qr', async (req, res) => {
  const clean = normalizePhone(req.body.phone);

  if (!clean || clean.length < 7) {
    return res.status(400).json({
      success: false,
      error: 'Valid number required'
    });
  }

  const account = getAccount(clean);

  if (account.status === 'connected') {
    return res.status(400).json({
      success: false,
      error: 'Already connected'
    });
  }

  account.pairingCode = null;
  account.qrDataUrl = null;
  account.status = 'connecting';
  account.stopAfterSession = false;

  connect(clean).catch(() => {});

  const qr = await waitFor(
    () => accounts.get(clean)?.qrDataUrl || null,
    15000,
    300
  );

  if (!qr) {
    return res.status(408).json({
      success: false,
      error: 'Timeout waiting QR'
    });
  }

  return res.json({
    success: true,
    phone: clean,
    qrDataUrl: qr,
    status: 'qr_ready'
  });
});

app.get('/api/qr', (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const account = accounts.get(phone);

  if (!account || !account.qrDataUrl) {
    return res.status(404).json({
      success: false,
      error: 'No QR'
    });
  }

  return res.json({
    success: true,
    phone,
    qrDataUrl: account.qrDataUrl,
    status: account.status
  });
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  console.log(
    '\nSILA MD PAIRING SERVER — Created By Sila Tech\n'
  );

  const sessionsDir = path.join(__dirname, 'sessions');

  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, {
      recursive: true
    });
  }

  app.listen(config.port, () => {
    console.log(
      `[Server] Running on port ${config.port}`
    );
  });
}

process.on('uncaughtException', error => {
  console.error('[Bot] Uncaught:', error);
});

process.on('unhandledRejection', error => {
  console.error('[Bot] Unhandled:', error);
});

start();