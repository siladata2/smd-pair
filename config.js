// ============================================================
// SILA MD — PAIRING SERVER CONFIG
// WhatsApp Multi-Device Bot — Created By Sila Tech
// ============================================================

require('dotenv').config();

module.exports = {
  botName: 'SILA MD',
  developer: 'Sila Tech',
  version: '1.0.0',

  // Hosting platforms provide PORT automatically
  port: process.env.PORT || 3000,

  // Optional owner number
  ownerNumber: String(process.env.OWNER_NUMBER || '')
    .replace(/\D/g, ''),

  // Private server API protection
  apiKey: process.env.PRIVATE_API_KEY || '',

  // Session prefix (exactly as is, nothing added in front)
  sessionPrefix: 'SILA',

  // Official links
  channelLink: 'https://whatsapp.com/channel/0029VbBG4gfISTkCpKxyMH02',
  groupLink: 'https://chat.whatsapp.com/LexNEPHRmU96sOmZCIOK8G',
  logoUrl: 'https://i.ibb.co/bMmWvXvx/silamd.jpg',

  // Session storage
  sessionsDir: './sessions',

  // Automatically reconnect while generating the session
  autoReconnect: true
};
