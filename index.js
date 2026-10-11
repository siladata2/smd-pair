// ============================================================
// SILA MD — PAIRING + SESSION SERVER
// Created By Sila Tech
// Uses @whiskeysockets/baileys + gifted-btns
// ============================================================

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { sendInteractiveMessage } = require('gifted-btns');

const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');
const zlib = require('zlib');

const config = require('./config.js');
const logger = pino({ level: 'silent' });
const accounts = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// ACCOUNT HELPERS
// ============================================================

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function newQrId() {
  return (
    String(Date.now()) +
    String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
  );
}

function getAccount(key, mode = 'code') {
  const id = normalizePhone(key);
  if (!id) return null;

  if (!accounts.has(id)) {
    const sessionDir = path.join(__dirname, 'sessions', id);

    accounts.set(id, {
      key: id,
      phone: id,
      mode,
      status: 'idle',
      isConnecting: false,
      sock: null,
      pairingCode: null,
      qrDataUrl: null,
      sessionDir,
      sessionSentFlag: path.join(sessionDir, '.session_sent'),
      stopAfterSession: false
    });
  }

  return accounts.get(id);
}

function destroyAccount(key) {
  const account = accounts.get(key);
  if (!account) return;

  account.stopAfterSession = true;

  try {
    if (account.sock) account.sock.end(undefined);
  } catch {}

  try {
    fs.rmSync(account.sessionDir, { recursive: true, force: true });
  } catch {}

  accounts.delete(key);
}

// ============================================================
// SESSION FILES
// ============================================================

function collectSessionFiles(dir, baseDir = dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  if (!files.length) throw new Error('No auth files');

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
      fs.rmSync(account.sessionDir, { recursive: true, force: true });
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
// MESSAGE BUILDERS
// ============================================================

function buildSessionMessage() {
  return [
    '◈ ━━━━━━━━━━━━━━━━━━ ◈',
    '   S I L A   M D',
    '   session  id',
    '◈ ━━━━━━━━━━━━━━━━━━ ◈',
    '',
    '▸ Tap the button below to copy.',
    '▸ Keep this ID private.',
    '',
    '  ::  Created By Sila Tech  ::'
  ].join('\n');
}

function buildLinksMessage() {
  return [
    '◈ ━━━━━━━━━━━━━━━━━━ ◈',
    '   S I L A   M D',
    '   links',
    '◈ ━━━━━━━━━━━━━━━━━━ ◈',
    '',
    `» channel :: ${config.channelLink}`,
    `» group   :: ${config.groupLink}`,
    '',
    '  ::  Created By Sila Tech  ::'
  ].join('\n');
}

// ============================================================
// SEND SESSION + COPY BUTTON (using gifted-btns)
// ============================================================

async function sendSessionWithCopyButton(account, sessionId, number) {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(account.sessionDir);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
      printQRInTerminal: false,
      logger
    });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 30000);

      sock.ev.on('connection.update', update => {
        if (update.connection === 'open') {
          clearTimeout(timer);
          resolve();
        }
        if (update.connection === 'close') {
          clearTimeout(timer);
          reject(new Error('closed'));
        }
      });
    });

    await sleep(2000);

    const jid = `${number}@s.whatsapp.net`;

    // -------- MESSAGE 1: Session + Copy Button via gifted-btns --------
    const sessionMsg = await sendInteractiveMessage(sock, jid, {
      text: buildSessionMessage(),
      footer: 'SILA MD  //  Sila Tech',
      interactiveButtons: [
        {
          name: 'cta_copy',
          buttonParamsJson: JSON.stringify({
            display_text: 'Copy Session',
            copy_code: sessionId
          })
        }
      ]
    });

    await sleep(1500);

    // -------- MESSAGE 2: Reply to session message with links --------
    await sock.sendMessage(
      jid,
      {
        text: buildLinksMessage()
      },
      { quoted: sessionMsg }
    );

    await sleep(2500);

    try {
      sock.end(undefined);
    } catch {}

  } catch (error) {
    console.error('[CopyButton] Failed:', error.message);
  }
}

// ============================================================
// AUTO FOLLOW CHANNEL
// ============================================================

async function autoFollowChannel(sock) {
  try {
    if (!config.channelLink) return false;

    const match = config.channelLink.match(/channel\/([0-9A-Za-z]+)/);
    if (!match) return false;

    const channelJid = `${match[1]}@newsletter`;

    await sock.newsletterFollow(channelJid);
    console.log(`[Auto] Followed channel: ${channelJid}`);
    return true;
  } catch (error) {
    console.error('[Auto] Channel follow failed:', error.message);
    return false;
  }
}

// ============================================================
// AUTO JOIN GROUP
// ============================================================

async function autoJoinGroup(sock) {
  try {
    if (!config.groupLink) return false;

    const match = config.groupLink.match(/([A-Za-z0-9]{20,})/);
    if (!match) return false;

    const inviteCode = match[1];

    await sock.groupAcceptInvite(inviteCode);
    console.log(`[Auto] Joined group: ${inviteCode}`);
    return true;
  } catch (error) {
    console.error('[Auto] Group join failed:', error.message);
    return false;
  }
}

async function autoActions(sock) {
  await sleep(2000);
  await autoFollowChannel(sock);
  await sleep(1000);
  await autoJoinGroup(sock);
}

// ============================================================
// SEND SESSION ID (plain text backup)
// ============================================================

async function handlePostConnect(sock, account) {
  try {
    if (fs.existsSync(account.sessionSentFlag)) {
      return { ok: true, sessionId: null };
    }

    console.log(`[Session:${account.phone}] Waiting for credentials...`);

    await sleep(3000);

    const sessionId = createSessionId(account);

    console.log(
      `\n[Session:${account.phone}] SESSION ID GENERATED\n${sessionId}\n`
    );

    const selfJid = sock.user?.id;
    if (!selfJid) return { ok: false, sessionId: null };

    await sock.sendMessage(selfJid, { text: sessionId });
    await sleep(1200);

    fs.mkdirSync(account.sessionDir, { recursive: true });
    fs.writeFileSync(
      account.sessionSentFlag,
      new Date().toISOString(),
      'utf8'
    );

    console.log(`[Session:${account.phone}] Session ID sent successfully.`);

    return { ok: true, sessionId };
  } catch (error) {
    console.error('[Session] Failed:', error.message);
    return { ok: false, sessionId: null };
  }
}

// ============================================================
// CONNECT WHATSAPP
// ============================================================

async function connect(key) {
  const id = normalizePhone(key);
  const account = accounts.get(id);

  if (!account || account.isConnecting) return;

  account.isConnecting = true;
  account.stopAfterSession = false;

  try {
    if (!fs.existsSync(account.sessionDir)) {
      fs.mkdirSync(account.sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(account.sessionDir);

    let version;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      version = [2, 3000, 1017546695];
    }

    console.log(
      `[Bot:${id}] Mode: ${account.mode} | Registered: ${state.creds.registered}`
    );

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
      printQRInTerminal: false,
      logger
    });

    account.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (qr && account.mode === 'qr') {
        account.qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
        account.pairingCode = null;
        account.status = 'qr_ready';
        console.log(`[Bot:${id}] QR ready.`);
      }

      if (connection === 'open') {
        console.log(`[Bot:${id}] WhatsApp connected.`);

        const real = normalizePhone(
          String(sock.user?.id || '').split('@')[0].split(':')[0]
        );
        if (real) account.phone = real;

        account.status = 'connected';
        account.isConnecting = false;

        await sleep(3000);

        await autoActions(sock);

        await sleep(2000);

        const result = await handlePostConnect(sock, account);

        if (result.ok) {
          account.stopAfterSession = true;
          console.log(`[Bot:${id}] Session captured. Closing pairing socket.`);

          try {
            sock.end(undefined);
          } catch {}

          account.sock = null;

          if (result.sessionId) {
            try {
              await sleep(1500);
              await sendSessionWithCopyButton(
                account,
                result.sessionId,
                account.phone
              );
              console.log(`[Bot:${id}] Session + copy button sent.`);
            } catch (error) {
              console.error(`[Bot:${id}] Copy button failed:`, error.message);
            }
          }

          account.status = 'session_ready';
        }
      }

      if (connection === 'close') {
        console.log(`[Bot:${id}] Connection closed.`);

        account.sock = null;
        account.isConnecting = false;

        if (account.stopAfterSession) {
          console.log(`[Bot:${id}] Pairing socket stopped intentionally.`);
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

        const delay =
          statusCode === DisconnectReason.restartRequired ? 500 : 5000;

        if (config.autoReconnect) {
          setTimeout(() => {
            const current = accounts.get(id);
            if (
              current &&
              current.status !== 'connected' &&
              current.status !== 'session_ready' &&
              !current.isConnecting
            ) {
              connect(id).catch(() => {});
            }
          }, delay);
        }
      }
    });

    if (!state.creds.registered && account.mode === 'code') {
      account.status = 'generating_code';
      await sleep(1500);

      console.log(`[Bot:${id}] Requesting pairing code...`);

      const code = await sock.requestPairingCode(id);

      const formatted =
        String(code)
          .replace(/[^A-Za-z0-9]/g, '')
          .match(/.{1,4}/g)
          ?.join('-') || String(code);

      account.pairingCode = formatted;
      account.status = 'waiting_approval';

      console.log(`[Bot:${id}] Pairing code: ${formatted}`);
    }
  } catch (error) {
    console.error(`[Bot:${id}] Fatal:`, error.message);

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
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.send('SILA MD Pairing Server Running');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/pair', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
  const key = normalizePhone(req.query.id || req.query.phone);

  if (!key) {
    return res.json({
      status: 'idle',
      connected: false,
      pairingCode: null,
      qrDataUrl: null
    });
  }

  const account = accounts.get(key);

  if (!account) {
    return res.json({
      status: 'session_not_found',
      connected: false,
      pairingCode: null,
      qrDataUrl: null
    });
  }

  return res.json({
    status: account.status,
    connected:
      account.status === 'connected' || account.status === 'session_ready',
    pairingCode: account.pairingCode || null,
    qrDataUrl: account.qrDataUrl || null
  });
});

app.post('/api/pair', async (req, res) => {
  const clean = normalizePhone(req.body.phone);

  if (!clean || clean.length < 7) {
    return res
      .status(400)
      .json({ success: false, error: 'Valid number required' });
  }

  const account = getAccount(clean, 'code');

  if (account.status === 'connected') {
    return res
      .status(400)
      .json({ success: false, error: 'Already connected' });
  }

  if (
    account.pairingCode &&
    (account.status === 'waiting_approval' ||
      account.status === 'pairing_code_ready')
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
      return res.status(408).json({ success: false, error: 'Timeout' });
    }

    return res.json({
      success: true,
      phone: clean,
      pairingCode: existingCode,
      status: 'waiting_approval'
    });
  }

  account.mode = 'code';
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
    return res
      .status(408)
      .json({ success: false, error: 'Timeout generating code' });
  }

  return res.json({
    success: true,
    phone: clean,
    pairingCode: code,
    status: 'waiting_approval'
  });
});

app.post('/api/start-qr', async (req, res) => {
  const previous = normalizePhone(req.body?.id);

  if (previous && accounts.get(previous)?.mode === 'qr') {
    const old = accounts.get(previous);
    if (old.status !== 'connected' && old.status !== 'session_ready') {
      destroyAccount(previous);
    }
  }

  const id = newQrId();
  const account = getAccount(id, 'qr');

  account.status = 'connecting';
  connect(id).catch(() => {});

  setTimeout(() => {
    const current = accounts.get(id);
    if (
      current &&
      current.status !== 'connected' &&
      current.status !== 'session_ready'
    ) {
      destroyAccount(id);
    }
  }, 3 * 60 * 1000);

  const qr = await waitFor(() => accounts.get(id)?.qrDataUrl || null, 20000, 300);

  if (!qr) {
    destroyAccount(id);
    return res.status(408).json({ success: false, error: 'Timeout waiting QR' });
  }

  return res.json({
    success: true,
    id,
    qrDataUrl: qr,
    status: 'qr_ready'
  });
});

// ============================================================
// START SERVER
// ============================================================

async function start() {
  console.log('\nSILA MD PAIRING SERVER — Created By Sila Tech\n');

  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  app.listen(config.port, () => {
    console.log(`[Server] Running on port ${config.port}`);
  });
}

process.on('uncaughtException', error => {
  console.error('[Bot] Uncaught:', error);
});

process.on('unhandledRejection', error => {
  console.error('[Bot] Unhandled:', error);
});

start();