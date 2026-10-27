/* SakkuPay — WhatsApp integration wrapper using @whiskeysockets/baileys */
'use strict';
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');

let baileys = null;
try { baileys = require('@whiskeysockets/baileys'); } catch { /* not installed */ }

const state = { available: !!baileys, connected: false, phone: null, qrReady: false, qrDataUrl: null, socket: null, store: null };

function cleanup() {
  state.connected = false;
  state.phone = null;
  state.qrReady = false;
  state.qrDataUrl = null;
  state.socket = null;
}

async function start() {
  if (!baileys) return { available: false, error: 'Install @whiskeysockets/baileys to enable WhatsApp' };
  if (state.socket) return { started: true, already: true };
  try {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
    const sessDir = path.join(__dirname, 'whatsapp-session');
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessDir);
    const sock = makeWASocket({ auth: authState, printQRInTerminal: false, browser: ['SakkuPay','Chrome','1.0'] });
    state.socket = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr);
          state.qrReady = true;
        } catch (e) { console.error('QR encode error', e.message); }
      }
      if (connection === 'open') {
        state.connected = true;
        state.qrReady = false;
        state.qrDataUrl = null;
        state.phone = sock.user?.id?.split(':')[0] || null;
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        cleanup();
        if (shouldReconnect) { setTimeout(() => start(), 5000); }
      }
    });
    return { started: true };
  } catch (e) {
    cleanup();
    return { started: false, error: e.message };
  }
}

function getStatus() {
  return { available: state.available, connected: state.connected, phone: state.phone, qrReady: state.qrReady };
}

function getQR() {
  return state.qrDataUrl ? { qr: state.qrDataUrl } : { qr: null };
}

async function sendMessage(to, text) {
  if (!baileys) return { available: false };
  if (!state.socket || !state.connected) return { sent: false, error: 'WhatsApp not connected' };
  try {
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
    await state.socket.sendMessage(jid, { text });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

async function disconnect() {
  if (state.socket) {
    try { await state.socket.logout(); } catch { /* ignore */ }
    try { state.socket.end(); } catch { /* ignore */ }
  }
  cleanup();
  const sessDir = path.join(__dirname, 'whatsapp-session');
  try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { disconnected: true };
}

module.exports = { start, getStatus, getQR, sendMessage, disconnect };
