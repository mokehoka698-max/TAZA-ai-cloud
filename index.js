import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import SftpClient from 'ssh2-sftp-client';

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const ROOT_DIR = process.cwd();
const AUTH_DIR = path.join(ROOT_DIR, 'auth_info_baileys');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');

function getMessageContent(message) {
  let content = message.message;

  while (content) {
    const nested = content.ephemeralMessage?.message
      ?? content.viewOnceMessage?.message
      ?? content.viewOnceMessageV2?.message
      ?? content.documentWithCaptionMessage?.message;

    if (!nested) return content;
    content = nested;
  }

  return undefined;
}

async function getSenderNumber(socket, message) {
  const candidates = [
    message.key.participantAlt,
    message.key.remoteJidAlt,
    message.key.participant,
    message.key.remoteJid,
  ].filter((jid) => typeof jid === 'string' && jid.length > 0 && !jid.endsWith('@g.us'));

  for (const jid of candidates) {
    let phoneJid = jid;
    if (jid.endsWith('@lid')) {
      phoneJid = await socket.signalRepository.lidMapping.getPNForLID(jid);
    }

    if (phoneJid && !phoneJid.endsWith('@lid') && !phoneJid.endsWith('@g.us')) {
      const number = phoneJid.split('@')[0].replace(/\D/g, '');
      if (number) return number;
    }
  }

  return undefined;
}

function getPdfFileName(document) {
  const originalName = path.basename(document.fileName || 'document.pdf');
  const safeName = originalName.replace(/[^\w.-]+/g, '_').slice(0, 120);
  return safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;
}

async function getSftpConfig() {
  const host = process.env.SFTP_HOST?.trim();
  if (!host) return undefined;

  const username = process.env.SFTP_USERNAME?.trim();
  const password = process.env.SFTP_PASSWORD;
  const privateKeyPath = process.env.SFTP_PRIVATE_KEY_PATH?.trim();
  if (!username || (!password && !privateKeyPath)) {
    throw new Error('SFTP requires SFTP_USERNAME and either SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH.');
  }

  const port = Number(process.env.SFTP_PORT || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SFTP_PORT must be an integer between 1 and 65535.');
  }

  return {
    host,
    port,
    username,
    password,
    privateKey: privateKeyPath ? await readFile(path.resolve(ROOT_DIR, privateKeyPath)) : undefined,
    remoteDirectory: path.posix.normalize(process.env.SFTP_REMOTE_DIR || '/downloads'),
  };
}

async function uploadToSftp(config, localPath, remotePath) {
  const client = new SftpClient();
  try {
    await client.connect(config);
    await client.mkdir(path.posix.dirname(remotePath), true);
    await client.put(localPath, remotePath);
  } finally {
    await client.end();
  }
}

async function react(socket, message, text) {
  try {
    await socket.sendMessage(message.key.remoteJid, {
      react: { text, key: message.key },
    });
  } catch (error) {
    console.error(`[reaction] Could not send ${text} for ${message.key.id}:`, error.message);
    throw error;
  }
}

async function savePdf(socket, message, document, sftpConfig) {
  const senderNumber = await getSenderNumber(socket, message);
  if (!senderNumber) {
    console.warn(`[pdf] Could not resolve sender phone number for message ${message.key.id}; key=${JSON.stringify(message.key)}`);
    return;
  }

  const declaredSize = Number(document.fileLength?.toString() ?? 0);
  console.log(`[pdf] Received from ${senderNumber}: ${document.fileName ?? 'unnamed.pdf'}; MIME=${document.mimetype ?? 'unknown'}; declaredSize=${declaredSize || 'unknown'} bytes`);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PDF_BYTES) {
    console.warn(`[pdf] Rejected ${message.key.id}: declared size exceeds 100 MiB.`);
    await react(socket, message, '🚫');
    return;
  }

  await react(socket, message, '⬇️');

  const userDirectory = path.join(DOWNLOADS_DIR, senderNumber);
  const messageId = message.key.id?.replace(/[^\w.-]/g, '_') ?? 'message';
  const fileName = `${Date.now()}-${messageId}-${getPdfFileName(document)}`;
  const destination = path.join(userDirectory, fileName);
  const temporaryFile = `${destination}.part`;
  let downloadedBytes = 0;
  let nextProgressLog = 10 * 1024 * 1024;

  try {
    console.log(`[pdf] Starting download for message ${message.key.id} to ${path.relative(ROOT_DIR, destination)}`);
    await mkdir(userDirectory, { recursive: true });
    const content = await downloadContentFromMessage(document, 'document');
    const sizeLimit = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_PDF_BYTES) {
          callback(new Error('PDF exceeds the 100 MB limit'));
          return;
        }
        if (downloadedBytes >= nextProgressLog) {
          console.log(`[pdf] Download progress ${message.key.id}: ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MiB`);
          nextProgressLog += 10 * 1024 * 1024;
        }
        callback(null, chunk);
      },
    });

    await pipeline(content, sizeLimit, createWriteStream(temporaryFile, { flags: 'wx' }));
    await rename(temporaryFile, destination);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    console.error(`[pdf] Download failed for ${message.key.id} from ${senderNumber} after ${downloadedBytes} bytes:`, error);
    await react(socket, message, downloadedBytes > MAX_PDF_BYTES ? '🚫' : '❌');
    return;
  }

  await react(socket, message, '✅');
  console.log(`[pdf] Saved ${downloadedBytes} bytes: ${path.relative(ROOT_DIR, destination)}`);

  if (sftpConfig) {
    const remotePath = path.posix.join(sftpConfig.remoteDirectory, senderNumber, fileName);
    try {
      console.log(`[sftp] Uploading message ${message.key.id} to ${remotePath}`);
      await uploadToSftp(sftpConfig, destination, remotePath);
      console.log(`[sftp] Upload complete: ${remotePath}`);
    } catch (error) {
      console.error(`[sftp] Upload failed for ${message.key.id}; local copy is kept at ${path.relative(ROOT_DIR, destination)}:`, error);
      await react(socket, message, '⚠️');
    }
  }
}

async function handleMessage(socket, message, sftpConfig) {
  if (message.key.fromMe || message.key.remoteJid === 'status@broadcast') return;

  const content = getMessageContent(message);
  const contentTypes = content ? Object.keys(content) : [];
  const senderNumber = await getSenderNumber(socket, message);
  console.log(`[message] Received id=${message.key.id ?? 'unknown'} from=${senderNumber ?? 'unknown'} chat=${message.key.remoteJid ?? 'unknown'} content=${contentTypes.join(',') || 'empty'}`);
  const document = content?.documentMessage;
  if (!document) {
    console.log(`[message] No document attachment in message ${message.key.id ?? 'unknown'}.`);
    return;
  }

  const isPdf = document.mimetype?.toLowerCase() === 'application/pdf'
    || document.fileName?.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    await savePdf(socket, message, document, sftpConfig);
  } else {
    console.log(`[message] Ignored non-PDF document: ${document.fileName ?? 'unnamed'}; MIME=${document.mimetype ?? 'unknown'}`);
  }
}

async function startBot() {
  const sftpConfig = await getSftpConfig();
  console.log(sftpConfig ? `[sftp] Enabled: ${sftpConfig.host}:${sftpConfig.port}${sftpConfig.remoteDirectory}` : '[sftp] Disabled; PDFs will be saved locally only.');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const socket = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'open') console.log('WhatsApp bot connected.');
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.error(`[connection] Closed with status=${statusCode ?? 'unknown'}:`, lastDisconnect?.error?.message ?? 'no error details');
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Connection closed; reconnecting...');
        void startBot();
      } else {
        console.error('WhatsApp session logged out. Remove auth_info_baileys and restart to pair again.');
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[messages.upsert] type=${type} count=${messages.length}`);
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handleMessage(socket, message, sftpConfig);
      } catch (error) {
        console.error(`[message] Failed to process ${message.key.id ?? 'unknown'}:`, error);
      }
    }
  });
}

startBot().catch((error) => {
  console.error('Could not start WhatsApp bot:', error);
  process.exitCode = 1;
});