require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Boom } = require('@hapi/boom');

// Baileys se publica como módulo "ESM" (formato moderno de JavaScript),
// mientras que el resto de este proyecto usa "CommonJS" (require clásico).
// No se pueden mezclar con un require() normal — hay que usar import()
// dinámico, que sí sabe leer módulos ESM desde código CommonJS. Como
// import() es asíncrono, cargamos Baileys una sola vez, la primera vez que
// arranca el bot (dentro de startBot(), que ya es una función async).
let baileysModule = null;
async function loadBaileys() {
  if (!baileysModule) {
    baileysModule = await import('@whiskeysockets/baileys');
  }
  return baileysModule;
}

// ---------- Sistema de actualizaciones ----------
// Cada vez que mejores el código: 1) subes ESTE archivo (server.js) actualizado
// a tu repo de GitHub, y 2) subes el número de "version" en latest.json para
// que coincida con el que pongas aquí abajo (CURRENT_VERSION). El botón del
// panel compara ambos números para saber si hay algo nuevo.
const CURRENT_VERSION = '1.23.0';
const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/kamilodaza15-ux/inversiones360-app/main/latest.json';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(__dirname, 'media');
const TMP_DIR = path.join(__dirname, 'tmp');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const LICENSE_PATH = path.join(DATA_DIR, 'license.json');
const VALID_KEYS_PATH = path.join(DATA_DIR, 'valid-keys.json');
const CONVERSATIONS_PATH = path.join(DATA_DIR, 'conversations.json');
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');
const CHAT_LOGS_PATH = path.join(DATA_DIR, 'chat-logs.json');
const PAUSED_CHATS_PATH = path.join(DATA_DIR, 'paused-chats.json');
const ORDERS_PATH = path.join(DATA_DIR, 'orders.json');
const COLOMBIA_DATA_PATH = path.join(__dirname, 'colombia.json');
const SESSION_DIR = path.join(__dirname, 'session');

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const crypto = require('crypto');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');

// ---------- FFmpeg ----------
// MiniMax devuelve el audio en MP3, pero WhatsApp necesita OGG/Opus para
// enviarlo como nota de voz.
//
// IMPORTANTE:
// En una instalación empaquetada con Electron, ffmpeg-static puede devolver
// una ruta dentro de app.asar. Windows NO puede ejecutar directamente un
// .exe desde dentro de app.asar, aunque fs.existsSync() diga que existe.
//
// Por eso, si la ruta de ffmpeg-static está dentro de app.asar, copiamos
// automáticamente ffmpeg.exe a una carpeta real y escribible de Windows y
// usamos esa copia para fluent-ffmpeg. Esto permite reparar instalaciones
// existentes mediante una actualización de server.js, sin pedir al cliente
// que reinstale ni que ejecute comandos.
function resolveFfmpegPath() {
  const candidates = [];

  let staticPath = null;

  try {
    staticPath = require('ffmpeg-static');

    if (staticPath) {
      // Si Electron empaquetó ffmpeg dentro de app.asar, NO devolver esa ruta
      // para ejecución. La trataremos más abajo copiándola fuera del asar.
      if (!/app\.asar([\\/]|$)/i.test(staticPath)) {
        candidates.push(staticPath);
      }
    }
  } catch (err) {
    console.warn('No se pudo cargar ffmpeg-static:', err.message);
  }

  // Rutas de respaldo para instalaciones no empaquetadas.
  candidates.push(
    path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    path.join(
      __dirname,
      'node_modules',
      'ffmpeg-static',
      'bin',
      'win32',
      'x64',
      'ffmpeg.exe'
    )
  );

  // Rutas típicas de Electron Builder cuando ffmpeg-static está desempaquetado.
  if (process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'ffmpeg-static',
        'ffmpeg.exe'
      ),
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'ffmpeg-static',
        'bin',
        'win32',
        'x64',
        'ffmpeg.exe'
      )
    );
  }

  // FFmpeg colocado manualmente junto al programa.
  candidates.push(
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'bin', 'ffmpeg.exe')
  );

  // Primero usamos una ruta que exista y que NO esté dentro de app.asar.
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (
      fs.existsSync(candidate) &&
      !/app\.asar([\\/]|$)/i.test(candidate)
    ) {
      console.log('✅ FFmpeg encontrado:', candidate);
      return candidate;
    }
  }

  // Si ffmpeg-static está dentro de app.asar, lo copiamos fuera del asar.
  // LOCALAPPDATA es escribible por el usuario y no requiere permisos de
  // administrador. Se usa una carpeta propia de la aplicación.
  if (
    staticPath &&
    /app\.asar([\\/]|$)/i.test(staticPath) &&
    fs.existsSync(staticPath)
  ) {
    const localAppData =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(os.homedir(), 'AppData', 'Local');

    const runtimeDir = path.join(
      localAppData,
      'Inversiones360Chat',
      'ffmpeg-runtime'
    );
    const runtimePath = path.join(runtimeDir, 'ffmpeg.exe');

    try {
      fs.mkdirSync(runtimeDir, { recursive: true });

      // Copiamos la versión incluida en la aplicación a una ubicación real.
      // Si ya existe, la reemplazamos para asegurarnos de usar la versión
      // correspondiente a la aplicación actualizada.
      fs.copyFileSync(staticPath, runtimePath);

      if (fs.existsSync(runtimePath)) {
        console.log('✅ FFmpeg extraído fuera de app.asar:', runtimePath);
        return runtimePath;
      }
    } catch (err) {
      console.warn(
        '⚠️ No se pudo extraer FFmpeg fuera de app.asar:',
        err.message
      );
    }
  }

  // Antes de rendirnos, revisamos si "ffmpeg" ya está disponible directo en
  // el sistema (esto es lo normal en Linux/Termux/Android, donde ffmpeg se
  // instala con el gestor de paquetes del propio sistema — pkg install
  // ffmpeg — en vez de depender de ffmpeg-static, que no tiene versión
  // compilada para esa arquitectura).
  try {
    const { execSync } = require('child_process');
    execSync('ffmpeg -version', { stdio: 'ignore' });
    console.log('✅ FFmpeg encontrado en el PATH del sistema.');
    return 'ffmpeg';
  } catch (err) {
    // no está en el PATH tampoco, seguimos al error final
  }

  throw new Error(
    'FFmpeg no encontrado o no se pudo extraer para su ejecución. ' +
    'Ruta detectada por ffmpeg-static: ' +
    (staticPath || 'ninguna')
  );
}

// IMPORTANTE: NO resolvemos la ruta de ffmpeg aquí arriba (al cargar el
// archivo). Antes se hacía así y, si ffmpeg-static no estaba instalado bien,
// tumbaba TODA la app al arrancar (no solo la función de voz). Ahora se
// resuelve "perezosamente" — solo la primera vez que de verdad se necesita
// enviar un audio — y si falla, el bot simplemente responde en texto en vez
// de audio (ver el try/catch alrededor de sendVoiceReply más abajo).
let cachedFfmpegPath = null;
function ensureFfmpegConfigured() {
  if (!cachedFfmpegPath) {
    cachedFfmpegPath = resolveFfmpegPath();
    console.log('🎙️ FFmpeg que usará fluent-ffmpeg:', cachedFfmpegPath);
    ffmpeg.setFfmpegPath(cachedFfmpegPath);

    // Baileys también necesita "ffmpeg" para procesar audio (por ejemplo,
    // para calcular la forma de onda de las notas de voz) y lo busca por su
    // cuenta en el PATH del sistema, sin que podamos indicarle la ruta
    // directamente. Agregamos la carpeta de nuestro ffmpeg ya resuelto al
    // PATH de este proceso, así Baileys lo encuentra igual que fluent-ffmpeg.
    const ffmpegDir = path.dirname(cachedFfmpegPath);
    if (!process.env.PATH.includes(ffmpegDir)) {
      process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH}`;
    }
  }
  return cachedFfmpegPath;
}

// Convierte un mp3 (lo que devuelve MiniMax) a ogg/opus (lo que exige
// WhatsApp para que una nota de voz se pueda reproducir del otro lado).
function convertMp3ToOggOpus(inputPath, outputPath) {
  ensureFfmpegConfigured(); // lanza el error aquí si falta ffmpeg, no al arrancar la app
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .audioChannels(1)
      .format('ogg')
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
}

function getMachineId() {
  const raw = `${os.hostname()}-${os.userInfo().username}-${os.platform()}-${os.arch()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// Busca la IP de esta PC en la red local (WiFi/cable), para poder mostrar un
// link + QR y así abrir el panel desde el celular u otro computador de la
// misma red, sin tener que escribir la IP a mano.
function getLocalNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function readLicense() {
  if (!fs.existsSync(LICENSE_PATH)) return { activated: false, key: '', machineId: '' };
  return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
}
function writeLicense(lic) {
  fs.writeFileSync(LICENSE_PATH, JSON.stringify(lic, null, 2));
}
function readValidKeys() {
  if (!fs.existsSync(VALID_KEYS_PATH)) return [];
  return JSON.parse(fs.readFileSync(VALID_KEYS_PATH, 'utf8'));
}

app.get('/api/license', (req, res) => {
  const lic = readLicense();
  const currentMachine = getMachineId();
  if (lic.activated && lic.machineId !== currentMachine) {
    // Esta copia fue activada en OTRA computadora: exige reactivar aquí.
    return res.json({ activated: false, key: '', machineId: '' });
  }
  res.json(lic);
});

app.post('/api/license/activate', (req, res) => {
  const { key } = req.body;
  const validKeys = readValidKeys();
  if (!key || !validKeys.includes(key.trim())) {
    return res.status(400).json({ ok: false, error: 'Código inválido' });
  }
  writeLicense({ activated: true, key: key.trim(), machineId: getMachineId() });
  res.json({ ok: true });
});

// Bloquea el resto de la API si la licencia no está activada en ESTA máquina
app.use('/api', (req, res, next) => {
  if (req.path === '/license' || req.path === '/license/activate') return next();
  const lic = readLicense();
  if (!lic.activated || lic.machineId !== getMachineId()) {
    return res.status(403).json({ error: 'No activado' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));

// ---------- Helpers de datos ----------
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
}
function writeProducts(products) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2));
}

// ---------- Subida de imágenes y video ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.fieldname === 'video' ? '.mp4' : '.jpg');
      const id = req.body.id || req.params.id || 'producto';
      cb(null, `${id}-${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') {
      if (!file.mimetype.startsWith('video/')) {
        return cb(new Error('El archivo de video debe ser un video real (mp4, etc.)'));
      }
    } else if (file.fieldname === 'images') {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Las imágenes deben ser archivos de imagen reales'));
      }
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB: alcanza para videos cortos de producto
});
const uploadProductMedia = upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'video', maxCount: 1 },
]);

// ---------- Subida de la muestra de voz (para clonar con MiniMax) ----------
const uploadVoiceSample = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp3';
      cb(null, `voice-sample-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) {
      return cb(new Error('El archivo debe ser un audio real (mp3, wav, m4a)'));
    }
    cb(null, true);
  },
  limits: { fileSize: 25 * 1024 * 1024 },
}).single('sample');

// ---------- API: configuración ----------
app.get('/api/config', (req, res) => res.json(readConfig()));

app.post('/api/config', (req, res) => {
  const current = readConfig();
  const updated = { ...current, ...req.body };
  writeConfig(updated);
  res.json(updated);
});

// ---------- API: exportar / importar respaldo (productos + configuración) ----------
// Útil para pasar tu catálogo y configuración de una PC a otra (ej. del
// portátil al computador de mesa) sin tener que copiar carpetas a mano.
// Incluye data/ (config, productos, claves válidas) y media/ (fotos/videos
// de los productos). NO incluye license.json (queda atado a cada máquina) ni
// session/ (la conexión de WhatsApp — mejor escanear el QR de nuevo en cada
// equipo, para evitar líos con dos sesiones activas del mismo número).
app.get('/api/backup/export', (req, res) => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();

    fs.readdirSync(DATA_DIR).forEach((file) => {
      if (file === 'license.json') return; // atado a esta máquina, no se exporta
      zip.addLocalFile(path.join(DATA_DIR, file), 'data');
    });

    if (fs.existsSync(MEDIA_DIR)) {
      zip.addLocalFolder(MEDIA_DIR, 'media');
    }

    const zipBuffer = zip.toBuffer();
    const filename = `respaldo-inversiones360-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar el respaldo: ' + err.message });
  }
});

const uploadBackupZip = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `backup-${Date.now()}.zip`),
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      return cb(new Error('El respaldo debe ser un archivo .zip'));
    }
    cb(null, true);
  },
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB: alcanza de sobra para fotos/videos de productos
}).single('backup');

app.post('/api/backup/import', uploadBackupZip, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo .zip' });
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(req.file.path);

    // Solo se permite reemplazar data/ y media/ — nunca nada fuera de la
    // carpeta de la app, por seguridad.
    zip.getEntries().forEach((entry) => {
      const isData = entry.entryName.startsWith('data/');
      const isMedia = entry.entryName.startsWith('media/');
      if ((isData || isMedia) && !entry.entryName.includes('..')) {
        zip.extractEntryTo(entry, __dirname, true, true);
      }
    });

    res.json({ ok: true, message: 'Respaldo restaurado correctamente. Los productos y la configuración ya se actualizaron.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo restaurar el respaldo: ' + err.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---------- API: productos ----------
app.get('/api/products', (req, res) => res.json(readProducts()));

app.post('/api/products', uploadProductMedia, (req, res) => {
  const products = readProducts();
  const id = req.body.id || `prod-${Date.now()}`;
  const files = req.files || {};
  const newProduct = {
    id,
    name: req.body.name || '',
    keywords: (req.body.keywords || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
    priceBefore: req.body.priceBefore || '',
    priceAfter: req.body.priceAfter || '',
    details: req.body.details || '',
    dropiProductId: req.body.dropiProductId || '',
    images: (files.images || []).map((f) => `/media/${f.filename}`),
    video: (files.video || [])[0] ? `/media/${files.video[0].filename}` : '',
  };
  products.push(newProduct);
  writeProducts(products);
  res.json(newProduct);
});

app.put('/api/products/:id', uploadProductMedia, (req, res) => {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });

  const existing = products[idx];
  const files = req.files || {};
  const newImages = (files.images || []).map((f) => `/media/${f.filename}`);
  const newVideo = (files.video || [])[0] ? `/media/${files.video[0].filename}` : null;
  const updated = {
    ...existing,
    name: req.body.name ?? existing.name,
    priceBefore: req.body.priceBefore ?? existing.priceBefore,
    priceAfter: req.body.priceAfter ?? existing.priceAfter,
    details: req.body.details ?? existing.details,
    dropiProductId: req.body.dropiProductId ?? (existing.dropiProductId || ''),
    keywords:
      req.body.keywords !== undefined
        ? req.body.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
        : existing.keywords,
    images: newImages.length > 0 ? newImages : existing.images,
    video: newVideo !== null ? newVideo : (existing.video || ''),
  };
  products[idx] = updated;
  writeProducts(products);
  res.json(updated);
});

app.delete('/api/products/:id', (req, res) => {
  let products = readProducts();
  products = products.filter((p) => p.id !== req.params.id);
  writeProducts(products);
  res.json({ ok: true });
});

// ---------- API: CRM (clientes, chat en vivo, pausas) ----------
app.get('/api/clients', (req, res) => {
  const list = Array.from(clients.entries()).map(([jid, rec]) => ({
    jid,
    ...rec,
    pausedUntil: pausedChats.get(jid) || null,
  }));
  list.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  res.json(list);
});

// Mover manualmente la etapa de un cliente en el tablero (útil para las
// etapas de logística, que todavía no se mueven solas hasta que conectemos
// el seguimiento automático de envíos).
app.post('/api/clients/:jid/status', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const status = req.body.status;
  if (!status) return res.status(400).json({ error: 'Falta el status' });
  updateClientStatus(jid, status, {});
  res.json({ ok: true });
});

// Cambiar la etiqueta (Lead/Interesado/Cliente/Descartado) a mano — una vez
// se cambia manualmente, deja de actualizarse sola con los mensajes nuevos.
app.post('/api/clients/:jid/tag', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const tag = req.body.tag;
  if (!tag) return res.status(400).json({ error: 'Falta la etiqueta' });
  const rec = clients.get(jid);
  if (!rec) return res.status(404).json({ error: 'Cliente no encontrado' });
  rec.tag = tag;
  rec.tagManual = true;
  clients.set(jid, rec);
  saveClients();
  io.emit('clientUpdate', { jid, client: rec });
  res.json({ ok: true });
});

app.post('/api/clients/:jid/notes', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const rec = clients.get(jid);
  if (!rec) return res.status(404).json({ error: 'Cliente no encontrado' });
  rec.notes = req.body.notes || '';
  clients.set(jid, rec);
  saveClients();
  io.emit('clientUpdate', { jid, client: rec });
  res.json({ ok: true });
});

app.get('/api/clients/:jid/messages', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json(chatLogs.get(jid) || []);
});

app.post('/api/clients/:jid/send', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
  if (!sock) return res.status(400).json({ error: 'El bot no está conectado a WhatsApp' });
  try {
    // Se manda igual que si fuera el bot (queda registrado como propio, no
    // dispara la pausa), pero lo marcamos como "owner" en el historial del
    // panel para que se vea claro quién lo escribió.
    await sendAndTrack(jid, { text });
    ensureClientRecord(jid);
    appendChatLog(jid, { from: 'owner', text, type: 'text', timestamp: Date.now() });
    const cfgNow = readConfig();
    const minutes = Number(cfgNow.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
    pauseChat(jid, minutes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo enviar: ' + err.message });
  }
});

// Enviar una imagen o un audio desde la misma ventana de chat del panel.
const uploadChatMedia = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `chat-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (
      !file.mimetype.startsWith('image/') &&
      !file.mimetype.startsWith('audio/') &&
      !file.mimetype.startsWith('video/')
    ) {
      return cb(new Error('Solo se pueden enviar imágenes, videos o audios desde aquí'));
    }
    cb(null, true);
  },
  limits: { fileSize: 60 * 1024 * 1024 }, // un poco más grande, para permitir videos cortos
}).single('media');

app.post('/api/clients/:jid/send-media', uploadChatMedia, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  if (!req.file) return res.status(400).json({ error: 'No llegó ningún archivo' });
  if (!sock) return res.status(400).json({ error: 'El bot no está conectado a WhatsApp' });
  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);
    const isImage = req.file.mimetype.startsWith('image/');
    const isVideo = req.file.mimetype.startsWith('video/');
    let content, type, text;
    if (isImage) {
      content = { image: buffer };
      type = 'image';
      text = '(imagen enviada)';
    } else if (isVideo) {
      content = { video: buffer };
      type = 'video';
      text = '(video enviado)';
    } else {
      content = { audio: buffer, mimetype: req.file.mimetype, ptt: false };
      type = 'audio';
      text = '(audio enviado)';
    }
    await sendAndTrack(jid, content);

    ensureClientRecord(jid);
    appendChatLog(jid, {
      from: 'owner',
      text,
      type,
      mediaUrl: `/media/${req.file.filename}`,
      timestamp: Date.now(),
    });
    const cfgNow = readConfig();
    const minutes = Number(cfgNow.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
    pauseChat(jid, minutes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo enviar: ' + err.message });
  }
});

// Enviar una nota de voz grabada en vivo desde el navegador (botón de
// micrófono, como WhatsApp). El navegador graba en un formato genérico
// (webm/ogg según el navegador) — lo convertimos a OGG/Opus con el mismo
// ffmpeg que ya usamos para la voz clonada de MiniMax, para que llegue como
// nota de voz de verdad, reproducible en cualquier WhatsApp.
const uploadVoiceRecording = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `recording-${Date.now()}${path.extname(file.originalname) || '.webm'}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
}).single('recording');

app.post('/api/clients/:jid/send-voice-recording', uploadVoiceRecording, async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  if (!req.file) return res.status(400).json({ error: 'No llegó ninguna grabación' });
  if (!sock) return res.status(400).json({ error: 'El bot no está conectado a WhatsApp' });

  const inputPath = req.file.path;
  const oggFilename = `voice-owner-${Date.now()}.ogg`;
  const oggPath = path.join(MEDIA_DIR, oggFilename);

  try {
    ensureFfmpegConfigured();
    // Aunque se llama "Mp3ToOggOpus", en realidad convierte cualquier audio
    // de entrada (ffmpeg detecta el formato solo) — sirve igual para webm.
    await convertMp3ToOggOpus(inputPath, oggPath);
    const oggBuffer = fs.readFileSync(oggPath);
    await sendAndTrack(jid, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });

    ensureClientRecord(jid);
    appendChatLog(jid, {
      from: 'owner',
      text: '(nota de voz enviada)',
      type: 'voice',
      mediaUrl: `/media/${oggFilename}`,
      timestamp: Date.now(),
    });
    const cfgNow = readConfig();
    const minutes = Number(cfgNow.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
    pauseChat(jid, minutes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo enviar la nota de voz: ' + err.message });
  } finally {
    fs.unlink(inputPath, () => {});
  }
});

app.post('/api/clients/:jid/pause', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  if (req.body.indefinite) {
    const until = pauseChatIndefinitely(jid);
    return res.json({ ok: true, pausedUntil: until });
  }
  const minutes = Number(req.body.minutes) || DEFAULT_PAUSE_MINUTES;
  const until = pauseChat(jid, minutes);
  res.json({ ok: true, pausedUntil: until });
});

app.post('/api/clients/:jid/resume', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  resumeChat(jid);
  res.json({ ok: true });
});

// Borra TODO lo de un cliente (para pruebas): el chat que se ve en el panel,
// la memoria que usa la IA para recordar la conversación, y su registro del
// CRM. La próxima vez que ese número escriba, el bot lo trata como si fuera
// completamente nuevo (con mensaje de bienvenida otra vez).
app.delete('/api/clients/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);

  chatLogs.delete(jid);
  saveChatLogs();

  conversations.delete(jid);
  saveConversations();

  clients.delete(jid);
  saveClients();

  seenUsers.delete(jid);
  pausedChats.delete(jid);
  savePausedChats();

  io.emit('clientDeleted', { jid });
  res.json({ ok: true });
});

// "Activar bot": re-dispara la respuesta al último mensaje del cliente —
// útil si el bot se quedó callado por algún error puntual.
app.post('/api/clients/:jid/activate-bot', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  try {
    resumeChat(jid); // si estaba pausado, lo reanuda de una vez también
    const reply = await generateAndSendReply(jid);
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo activar el bot: ' + err.message });
  }
});

// "Activar asistente de un producto": fuerza a que la próxima respuesta
// hable de un producto específico (útil cuando sabes por la campaña de
// dónde viene el cliente, aunque él no haya dicho cuál producto le interesa).
app.post('/api/clients/:jid/activate-product', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const productId = req.body.productId;
  const products = readProducts();
  const product = products.find((p) => p.id === productId);
  if (!product) return res.status(400).json({ error: 'Producto no encontrado' });

  try {
    resumeChat(jid);
    if (!conversations.has(jid)) {
      conversations.set(jid, [{ role: 'system', content: buildSystemPrompt(jid) }]);
    }
    const history = conversations.get(jid);
    history.push({
      role: 'system',
      content: `El dueño del negocio activó manualmente el asistente para el producto "${product.name}" en esta conversación. Retoma la conversación con el cliente enfocándote en ESE producto específico — preséntalo con naturalidad, como si continuaras la charla, sin decir que "te activaron" nada.`,
    });
    const reply = await generateAndSendReply(jid);
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo activar el asistente: ' + err.message });
  }
});

// ---------- API: Pedidos ----------
app.get('/api/colombia', (req, res) => res.json(colombiaData));

app.get('/api/orders', (req, res) => {
  res.json([...orders].sort((a, b) => b.createdAt - a.createdAt));
});

// Comprobante en PDF de un pedido — con el nombre de empresa que tengas en
// Configuración, así que si lo cambias ahí, el comprobante se actualiza solo.
app.get('/api/orders/:id/pdf', (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  const cfg = readConfig();
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="comprobante-${order.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).fillColor('#16a34a').text(cfg.companyName || 'Comprobante de pedido', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#6b7280').text('Comprobante de pedido', { align: 'center' });
  doc.moveDown(1.5);

  doc.fontSize(14).fillColor('#111827').text(`Pedido: ${order.id}`);
  doc.fontSize(10).fillColor('#6b7280').text(`Fecha: ${new Date(order.createdAt).toLocaleString('es-CO')}`);
  doc.moveDown(1);

  const statusInfo = ORDER_STATUS_LABELS[order.status] || order.status;
  doc.fontSize(12).fillColor('#111827').text('Cliente', { underline: true });
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Nombre: ${order.clientName || '-'}`);
  doc.text(`Teléfono: ${order.clientPhone || '-'}`);
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor('#111827').text('Entrega', { underline: true });
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Tipo: ${order.deliveryType === 'oficina' ? 'Recogida en oficina' : 'Domicilio'}`);
  if (order.deliveryType !== 'oficina') doc.text(`Dirección: ${order.address || '-'}`);
  doc.text(`Ciudad: ${order.city || '-'}${order.department ? ', ' + order.department : ''}`);
  if (order.neighborhood) doc.text(`Barrio: ${order.neighborhood}`);
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor('#111827').text('Producto', { underline: true });
  doc.fontSize(10).fillColor('#374151');
  doc.text(`${order.product || '-'}  x${order.quantity || 1}`);
  doc.text(`Precio: ${order.price || '-'}`);
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor('#111827').text('Estado', { underline: true });
  doc.fontSize(10).fillColor('#374151').text(statusInfo);

  doc.moveDown(2);
  doc.fontSize(9).fillColor('#9ca3af').text(`Generado por ${cfg.companyName || 'Inversiones 360 CHAT'}`, { align: 'center' });

  doc.end();
});

app.post('/api/orders', (req, res) => {
  const order = createOrder({ ...req.body, source: req.body.source || 'manual' });
  // Si el pedido viene de un cliente real, lo marcamos como comprado en el CRM también.
  if (order.clientJid) {
    updateClientStatus(order.clientJid, 'comprado', {});
  }
  res.json(order);
});

app.put('/api/orders/:id', (req, res) => {
  const order = updateOrder(req.params.id, req.body);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(order);
});

app.delete('/api/orders/:id', (req, res) => {
  orders = orders.filter((o) => o.id !== req.params.id);
  saveOrders();
  res.json({ ok: true });
});

// "Confirmar y subir": toma el resumen de pedido que la IA ya detectó para
// ese cliente (guardado cuando dijo "ORDEN DE COMPRA REGISTRADA") y lo
// convierte en un Pedido de verdad, con los datos prellenados — quedan
// editables antes de mandarlos a Dropi/Skydropx.
app.post('/api/clients/:jid/confirm-order', async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const client = clients.get(jid);
  if (!client || !client.lastOrderSummary) {
    return res.status(400).json({ error: 'Este cliente todavía no tiene un pedido detectado por la IA' });
  }
  // Normalmente esto ya pasa solo apenas la IA cierra la venta — este
  // endpoint queda como respaldo manual por si algo falló en el momento.
  const order = await autoCreateOrderFromSummary(jid, client, client.lastOrderSummary);
  if (!order) {
    return res.status(400).json({ error: 'Ya existe un pedido creado para esta venta — revísalo en la pestaña Pedidos.' });
  }
  res.json(order);
});

// "Cerrar pedido (manual)": para cuando la IA no cerró la venta pero el
// cliente sí dejó los datos en la conversación — se llenan a mano.
app.post('/api/clients/:jid/manual-order', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const order = createOrder({
    clientJid: jid,
    clientName: req.body.clientName || '',
    clientPhone: req.body.clientPhone || '',
    product: req.body.product || '',
    quantity: req.body.quantity || 1,
    price: req.body.price || '',
    address: req.body.address || '',
    department: req.body.department || '',
    city: req.body.city || '',
    neighborhood: req.body.neighborhood || '',
    deliveryType: req.body.deliveryType || 'domicilio',
    status: 'pendiente',
    source: 'manual',
  });
  updateClientStatus(jid, 'comprado', {});
  res.json(order);
});

// Botones "Subir a Dropi" / "Subir a Skydropx" — quedan conectados al panel
// desde ya, pero avisan honestamente que falta la documentación/credenciales
// reales de cada API antes de poder crear la guía de verdad.
// Estas dos funciones quedan listas para conectar la API real de cada
// plataforma en cuanto tengamos su documentación — por ahora, avisan
// honestamente que falta la conexión, sin romper nada más de la app.
async function uploadOrderToDropi(order) {
  const cfg = readConfig();
  if (!cfg.dropiApiKey) {
    throw new Error('Falta configurar la API de Dropi (todavía no tenemos la documentación/credenciales conectadas).');
  }
  // TODO: cuando tengamos la documentación real de la API de Dropi, aquí va
  // la llamada real para crear la orden/guía.
  throw new Error('La conexión real con Dropi todavía no está implementada.');
}

async function uploadOrderToSkydropx(order) {
  const cfg = readConfig();
  if (!cfg.skydropxApiKey) {
    throw new Error('Falta configurar la API de Skydropx (todavía no tenemos la documentación/credenciales conectadas).');
  }
  // TODO: cuando tengamos la documentación real de la API de Skydropx, aquí
  // va la llamada real para crear el envío/guía.
  throw new Error('La conexión real con Skydropx todavía no está implementada.');
}

// Si el interruptor de subida automática está encendido, se llama sola apenas
// se crea un pedido nuevo — sin que nadie tenga que ir a darle clic. Falla
// en silencio (solo queda en el log) mientras no tengamos la API real, para
// no interrumpir el resto del flujo del pedido.
async function autoUploadIfEnabled(order) {
  const cfg = readConfig();
  if (cfg.autoUploadProvider === 'dropi') {
    try {
      await uploadOrderToDropi(order);
      io.emit('log', `🚀 Pedido ${order.id} subido automático a Dropi`);
    } catch (err) {
      io.emit('log', `⚠️ No se pudo subir automático a Dropi (${order.id}): ${err.message}`);
    }
  } else if (cfg.autoUploadProvider === 'skydropx') {
    try {
      await uploadOrderToSkydropx(order);
      io.emit('log', `🚀 Pedido ${order.id} subido automático a Skydropx`);
    } catch (err) {
      io.emit('log', `⚠️ No se pudo subir automático a Skydropx (${order.id}): ${err.message}`);
    }
  }
}

app.post('/api/orders/:id/upload-dropi', async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  try {
    await uploadOrderToDropi(order);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/:id/upload-skydropx', async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  try {
    await uploadOrderToSkydropx(order);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Simulador de pruebas ----------
// Usa el mismo "cerebro" (prompt, catálogo, herramientas) que el bot real,
// pero NUNCA toca WhatsApp, ni clientes reales, ni pedidos reales — es una
// conversación aislada, solo para probar cambios al prompt con calma.
function emptySimOrderData() {
  return {
    nombre: '', telefono: '', direccion: '', departamento: '',
    ciudad: '', barrio: '', producto: '', cantidad: '', tipoEntrega: '',
  };
}
let simulationSession = { history: [], orderData: emptySimOrderData() };

app.post('/api/simulator/message', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
  try {
    if (simulationSession.history.length === 0) {
      simulationSession.history.push({ role: 'system', content: '' });
    }
    simulationSession.history[0] = {
      role: 'system',
      content: buildSystemPrompt(null, simulationSession.orderData),
    };
    simulationSession.history.push({ role: 'user', content: text });

    let aiMessage = await getAIMessage(simulationSession.history, [
      productImageTool, productVideoTool, updateOrderDataTool, checkOrderStatusTool,
    ]);
    const mediaPreview = [];

    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      simulationSession.history.push({
        role: 'assistant',
        content: aiMessage.content || null,
        tool_calls: aiMessage.tool_calls,
      });

      for (const toolCall of aiMessage.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {}

        let resultText = 'No se encontró el producto solicitado.';
        if (toolCall.function.name === 'enviar_imagen_producto') {
          const product = findProductByQuery(args.producto);
          if (product && product.images?.length) {
            mediaPreview.push(...product.images.map((url) => ({ type: 'image', url })));
            resultText = `Imagen(es) de "${product.name}" mostradas en la simulación (no se envían a ningún WhatsApp real).`;
          } else {
            resultText = 'No hay imágenes disponibles para ese producto.';
          }
        } else if (toolCall.function.name === 'enviar_video_producto') {
          const product = findProductByQuery(args.producto);
          if (product && product.video) {
            mediaPreview.push({ type: 'video', url: product.video });
            resultText = `Video de "${product.name}" mostrado en la simulación (no se envía a ningún WhatsApp real).`;
          } else {
            resultText = 'Ese producto no tiene un video cargado.';
          }
        } else if (toolCall.function.name === 'actualizar_datos_pedido') {
          const fields = ['nombre', 'telefono', 'direccion', 'departamento', 'ciudad', 'barrio', 'producto', 'cantidad', 'tipoEntrega'];
          fields.forEach((f) => {
            if (args[f] !== undefined && args[f] !== null && String(args[f]).trim() !== '') {
              simulationSession.orderData[f] = String(args[f]).trim();
            }
          });
          resultText = `Datos guardados (solo en esta simulación, no toca clientes reales). ${describeMissingOrderFields(simulationSession.orderData)}`;
        } else if (toolCall.function.name === 'consultar_estado_pedido') {
          resultText = 'En el simulador no hay pedidos reales que consultar — esto es solo una prueba.';
        }

        simulationSession.history.push({ role: 'tool', tool_call_id: toolCall.id, content: resultText });
      }

      aiMessage = await getAIMessage(simulationSession.history);
    }

    const reply = (aiMessage.content || '').trim() || 'Listo 😊';
    simulationSession.history.push({ role: 'assistant', content: reply });

    res.json({ ok: true, reply, media: mediaPreview, orderData: simulationSession.orderData });
  } catch (err) {
    res.status(500).json({ error: 'Error en la simulación: ' + err.message });
  }
});

app.post('/api/simulator/reset', (req, res) => {
  simulationSession = { history: [], orderData: emptySimOrderData() };
  res.json({ ok: true });
});

// ---------- Secuencia de seguimiento / remarketing ----------
// Mensajes por defecto — quedan editables desde el panel, esto solo se usa
// si el negocio nunca ha guardado los suyos propios.
const DEFAULT_FOLLOWUP_MESSAGES = [
  {
    id: 'seguimiento-1',
    text: '¡Hola! 😊 ¿Sigues interesado en {producto}? Recuerda que todavía tenemos el descuento activo si quieres aprovecharlo.',
    delayMinutes: 30,
    enabled: true,
  },
  {
    id: 'seguimiento-2',
    text: '¡Hola de nuevo! 👋 Te cuento que el descuento en {producto} está por terminar pronto — no te vayas a quedar sin el tuyo.',
    delayMinutes: 210, // ~3.5 horas
    enabled: true,
  },
  {
    id: 'seguimiento-3',
    text: 'Últimas unidades con descuento en {producto} 🙌 Si todavía te interesa, este es un buen momento para aprovecharlo antes de que se agote.',
    delayMinutes: 1200, // al día siguiente (~20 horas)
    enabled: true,
  },
];

function isWithinBusinessHours(cfg) {
  if (!cfg.followUpHoursStart || !cfg.followUpHoursEnd) return true; // sin horario configurado = siempre permitido
  const now = new Date();
  const [startH, startM] = cfg.followUpHoursStart.split(':').map(Number);
  const [endH, endM] = cfg.followUpHoursEnd.split(':').map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

const NON_FOLLOWUP_STATUSES = [
  'comprado', 'guia_generada', 'en_camino', 'con_novedad', 'entregado', 'devuelto', 'cancelado',
];

// Revisa a todos los clientes cada cierto rato — si alguno "se quedó callado"
// después de que el bot le habló de un producto, y le toca el siguiente
// mensaje de la secuencia (según el tiempo configurado), se lo manda solo.
// Respeta el horario configurado, y nunca le escribe dos veces el mismo paso.
async function checkFollowUps() {
  const cfg = readConfig();
  if (!cfg.followUpEnabled) return;
  if (!sock) return; // el bot no está conectado, no hay cómo mandar nada
  if (!isWithinBusinessHours(cfg)) return;

  const messages = (cfg.followUpMessages && cfg.followUpMessages.length > 0)
    ? cfg.followUpMessages
    : DEFAULT_FOLLOWUP_MESSAGES;
  const activeMessages = messages.filter((m) => m.enabled !== false).sort((a, b) => a.delayMinutes - b.delayMinutes);
  if (activeMessages.length === 0) return;

  for (const [jid, client] of clients.entries()) {
    if (!client.orderData?.producto) continue; // sin saber qué producto le interesaba, no mandamos nada
    if (NON_FOLLOWUP_STATUSES.includes(client.status)) continue; // ya compró, canceló, etc.
    if (isPaused(jid)) continue; // no molestar si interviniste manualmente ahí

    const log = chatLogs.get(jid) || [];
    const lastEntry = log[log.length - 1];
    if (!lastEntry || lastEntry.from !== 'bot') continue; // el cliente ya respondió, o no hay historial

    const sentSteps = client.followUpsSent || [];
    const elapsedMinutes = (Date.now() - lastEntry.timestamp) / 60000;

    for (const msg of activeMessages) {
      if (sentSteps.includes(msg.id)) continue;
      if (elapsedMinutes < msg.delayMinutes) continue;

      const text = msg.text.replace(/\{producto\}/g, client.orderData.producto);
      try {
        await sendAndTrack(jid, { text });
        appendChatLog(jid, { from: 'bot', text, type: 'text', timestamp: Date.now() });
        client.followUpsSent = [...sentSteps, msg.id];
        clients.set(jid, client);
        saveClients();
        io.emit('log', `📨 Seguimiento enviado a ${jid.split('@')[0]}`);
      } catch (e) {
        console.error('Error enviando mensaje de seguimiento:', e);
      }
      break; // solo un paso de la secuencia por revisión, para no mandar varios de golpe
    }
  }
}

setInterval(() => {
  checkFollowUps().catch((e) => console.error('Error revisando seguimientos:', e));
}, 5 * 60 * 1000); // revisa cada 5 minutos

app.get('/api/followup-config', (req, res) => {
  const cfg = readConfig();
  res.json({
    enabled: !!cfg.followUpEnabled,
    hoursStart: cfg.followUpHoursStart || '',
    hoursEnd: cfg.followUpHoursEnd || '',
    messages: (cfg.followUpMessages && cfg.followUpMessages.length > 0) ? cfg.followUpMessages : DEFAULT_FOLLOWUP_MESSAGES,
  });
});

app.post('/api/followup-config', (req, res) => {
  const cfg = readConfig();
  writeConfig({
    ...cfg,
    followUpEnabled: !!req.body.enabled,
    followUpHoursStart: req.body.hoursStart || '',
    followUpHoursEnd: req.body.hoursEnd || '',
    followUpMessages: req.body.messages || [],
  });
  res.json({ ok: true });
});

// ---------- IA: helpers de proveedor ----------
function getGroqClient(cfg) {
  const Groq = require('groq-sdk');
  return new Groq({ apiKey: cfg.groqApiKey });
}
function getOpenAIClient(cfg) {
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: cfg.openaiApiKey });
}

// ---------- Tool: enviar imagen o video del producto ----------
// En vez de depender de palabras clave, dejamos que el modelo decida cuándo
// llamar estas "herramientas". Solo cuando el modelo las invoca de verdad se
// disparan las imágenes/video reales por WhatsApp.
const productImageTool = {
  type: 'function',
  function: {
    name: 'enviar_imagen_producto',
    description:
      'Envía la o las fotos reales del producto por WhatsApp. Úsala cada vez que el cliente pida ver fotos, imágenes, cómo se ve el producto, catálogo, o algo similar. Nunca digas que enviaste una foto sin llamar a esta función primero.',
    parameters: {
      type: 'object',
      properties: {
        producto: {
          type: 'string',
          description:
            'Nombre (o parte del nombre) del producto del que el cliente quiere ver fotos. Si solo hay un producto en el catálogo, usa ese nombre.',
        },
      },
      required: ['producto'],
    },
  },
};

const productVideoTool = {
  type: 'function',
  function: {
    name: 'enviar_video_producto',
    description:
      'Envía el video real del producto por WhatsApp. Úsala cuando el cliente pida ver un video, cómo funciona, una demostración, o algo similar. Solo funciona si el producto tiene un video cargado — si no lo tiene, la función te lo va a indicar. Nunca digas que enviaste un video sin llamar a esta función primero.',
    parameters: {
      type: 'object',
      properties: {
        producto: {
          type: 'string',
          description:
            'Nombre (o parte del nombre) del producto del que el cliente quiere ver el video. Si solo hay un producto en el catálogo, usa ese nombre.',
        },
      },
      required: ['producto'],
    },
  },
};

// ---- Herramienta: guardar/corregir datos del pedido, de a poco ----
// La IA la llama CADA VEZ que el cliente da o corrige cualquiera de estos
// datos, aunque sea uno solo — así queda guardado de verdad, en vez de que
// la IA tenga que "recordarlo" solo leyendo el chat de atrás para adelante.
const updateOrderDataTool = {
  type: 'function',
  function: {
    name: 'actualizar_datos_pedido',
    description:
      'Guarda o corrige uno o varios datos del cliente para su pedido. Llámala cada vez que el cliente dé o corrija cualquiera de estos datos, aunque sea uno solo a la vez — no esperes a tener todos los datos para llamarla.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del cliente' },
        telefono: { type: 'string', description: 'Número de teléfono/celular que el cliente escribió (tal cual lo dio)' },
        direccion: { type: 'string', description: 'Dirección completa, con nomenclatura (ej. Carrera 4 #3-40, o Manzana 15 Casa 27)' },
        departamento: { type: 'string', description: 'Departamento de Colombia' },
        ciudad: { type: 'string', description: 'Ciudad o municipio' },
        barrio: { type: 'string', description: 'Barrio (opcional)' },
        producto: { type: 'string', description: 'Producto que quiere comprar' },
        cantidad: { type: 'string', description: 'Cantidad de unidades' },
        tipoEntrega: { type: 'string', enum: ['domicilio', 'oficina'], description: 'Cómo prefiere recibirlo' },
      },
    },
  },
};

// ---- Herramienta: consultar el estado real de un pedido ya existente ----
const checkOrderStatusTool = {
  type: 'function',
  function: {
    name: 'consultar_estado_pedido',
    description:
      'Consulta el estado real y actual de un pedido en la base de datos. Úsala cuando el cliente pregunte por el estado/seguimiento de un pedido que ya hizo (ej. "¿cómo va mi pedido?", "¿ya tiene guía?"). NUNCA inventes ni asumas un estado sin llamar esta función primero.',
    parameters: {
      type: 'object',
      properties: {
        numeroOrden: { type: 'string', description: 'El número de orden si el cliente lo dio (ej. ORD-0001). Si no lo dio, deja vacío.' },
      },
    },
  },
};

// Cuando la IA llama actualizar_datos_pedido: solo actualiza los campos que
// vinieron con valor (no borra los demás), y avanza el tipo de entrega si
// vino. Devuelve un texto para que la IA sepa qué le falta todavía.
function handleUpdateOrderData(jid, args) {
  ensureClientRecord(jid);
  const client = clients.get(jid);
  const fields = ['nombre', 'telefono', 'direccion', 'departamento', 'ciudad', 'barrio', 'producto', 'cantidad', 'tipoEntrega'];
  fields.forEach((f) => {
    if (args[f] !== undefined && args[f] !== null && String(args[f]).trim() !== '') {
      client.orderData[f] = String(args[f]).trim();
    }
  });
  if (args.nombre) client.name = client.orderData.nombre; // también se ve en la lista de Chats
  clients.set(jid, client);
  saveClients();
  io.emit('clientUpdate', { jid, client });
  return `Datos guardados. ${describeMissingOrderFields(client.orderData)}`;
}

function describeMissingOrderFields(orderData) {
  const required = orderData.tipoEntrega === 'oficina'
    ? ['nombre', 'ciudad', 'departamento', 'telefono', 'producto', 'cantidad', 'tipoEntrega']
    : ['nombre', 'direccion', 'ciudad', 'departamento', 'telefono', 'producto', 'cantidad', 'tipoEntrega'];
  const missing = required.filter((f) => !orderData[f]);
  return missing.length === 0
    ? 'Ya están todos los datos necesarios completos.'
    : `Todavía faltan: ${missing.join(', ')}.`;
}

// Cuando la IA llama consultar_estado_pedido: busca de verdad en Pedidos,
// por número de orden si lo dio, o si no, el pedido más reciente de este
// cliente. Nunca inventa el estado.
function handleCheckOrderStatus(jid, args) {
  let order = null;
  if (args.numeroOrden) {
    order = orders.find((o) => o.id.toLowerCase() === String(args.numeroOrden).trim().toLowerCase());
  }
  if (!order) {
    const clientOrders = orders.filter((o) => o.clientJid === jid).sort((a, b) => b.createdAt - a.createdAt);
    order = clientOrders[0] || null;
  }
  if (!order) return 'Este cliente no tiene ningún pedido registrado todavía.';

  const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;
  return `Pedido ${order.id}: producto "${order.product}", estado actual: ${statusLabel}.${order.transportadora ? ` Transportadora: ${order.transportadora}.` : ''}`;
}

// Genera y manda una respuesta de la IA para un cliente, asumiendo que su
// historial (conversations) ya tiene el turno más reciente listo — se usa
// tanto para "Activar bot (re-disparar último mensaje)" como para "Activar
// asistente de un producto" desde el panel derecho. Es básicamente el mismo
// flujo que corre automáticamente en processMessage, pero disparado a mano.
async function generateAndSendReply(userId) {
  const cfg = readConfig();
  const history = conversations.get(userId);
  if (!history) throw new Error('No hay conversación con este cliente todavía');

  let aiMessage = await getAIMessage(history, [productImageTool, productVideoTool, updateOrderDataTool, checkOrderStatusTool]);

  if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
    history.push({
      role: 'assistant',
      content: aiMessage.content || null,
      tool_calls: aiMessage.tool_calls,
    });

    for (const toolCall of aiMessage.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch (e) {}

      let resultText = 'No se encontró el producto solicitado.';
      if (toolCall.function.name === 'enviar_imagen_producto') {
        const product = findProductByQuery(args.producto);
        const sent = await sendProductImages(userId, product);
        resultText = sent
          ? `Imagen(es) de "${product.name}" enviadas correctamente.`
          : 'No hay imágenes disponibles para ese producto.';
      } else if (toolCall.function.name === 'enviar_video_producto') {
        const product = findProductByQuery(args.producto);
        const sent = await sendProductVideo(userId, product);
        resultText = sent
          ? `Video de "${product.name}" enviado correctamente.`
          : 'Ese producto no tiene un video cargado.';
      } else if (toolCall.function.name === 'actualizar_datos_pedido') {
        resultText = handleUpdateOrderData(userId, args);
      } else if (toolCall.function.name === 'consultar_estado_pedido') {
        resultText = handleCheckOrderStatus(userId, args);
      }

      history.push({ role: 'tool', tool_call_id: toolCall.id, content: resultText });
    }

    aiMessage = await getAIMessage(history);
  }

  const reply = (aiMessage.content || '').trim() || 'Listo 😊';
  history.push({ role: 'assistant', content: reply });
  saveConversations();
  appendChatLog(userId, { from: 'bot', text: reply, type: 'text', timestamp: Date.now() });

  const isOrderConfirmation = reply.includes('ORDEN DE COMPRA REGISTRADA') || reply.includes('PEDIDO CANCELADO');
  const voiceMode = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
  const minimaxReady = cfg.minimaxApiKey && cfg.minimaxGroupId && cfg.minimaxVoiceId;
  const shouldReplyWithVoice = !isOrderConfirmation && minimaxReady && voiceMode === 'voice';

  if (shouldReplyWithVoice) {
    try {
      await sendVoiceReply(userId, reply);
    } catch (err) {
      console.error('Error generando audio con MiniMax, se responde en texto:', err);
      await sendAndTrack(userId, { text: reply });
    }
  } else {
    await sendAndTrack(userId, { text: reply });
  }

  if (reply.includes('ORDEN DE COMPRA REGISTRADA') && cfg.notificationPhoneNumber) {
    try {
      await notifyOwnerOfSale(cfg, userId, reply);
    } catch (err) {
      console.error('Error notificando la venta:', err);
    }
  }
  if (reply.includes('ORDEN DE COMPRA REGISTRADA')) {
    const name = extractNameFromOrderText(reply);
    updateClientStatus(userId, 'comprado', { lastOrderSummary: reply, ...(name ? { name } : {}) });
    await autoCreateOrderFromSummary(userId, clients.get(userId), reply);
  }
  if (reply.includes('PEDIDO CANCELADO') && cfg.notificationPhoneNumber) {
    try {
      await notifyOwnerOfCancellation(cfg, userId, reply);
    } catch (err) {
      console.error('Error notificando la cancelación:', err);
    }
  }
  if (reply.includes('PEDIDO CANCELADO')) {
    updateClientStatus(userId, 'cancelado', {});
  }

  if (reply.includes('NECESITA INTERVENCIÓN HUMANA')) {
    if (cfg.notificationPhoneNumber) {
      try {
        await notifyOwnerOfIntervention(cfg, userId, reply);
      } catch (err) {
        console.error('Error notificando la intervención:', err);
      }
    }
    const minutes = Number(cfg.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
    pauseChat(userId, minutes);
  }

  return reply;
}

function findProductByQuery(query) {
  const products = readProducts();
  if (!query) return products.length === 1 ? products[0] : null;
  const q = query.toLowerCase();
  // 1) coincidencia por nombre
  let match = products.find((p) => p.name && p.name.toLowerCase().includes(q));
  if (match) return match;
  // 2) coincidencia por palabras clave configuradas
  match = products.find((p) => (p.keywords || []).some((k) => q.includes(k) || k.includes(q)));
  if (match) return match;
  // 3) si solo hay un producto, asumimos que es ese
  return products.length === 1 ? products[0] : null;
}

async function sendProductImages(userId, product) {
  if (!product || !Array.isArray(product.images) || product.images.length === 0) {
    return false;
  }
  for (const imgRelPath of product.images) {
    const imgPath = path.join(__dirname, imgRelPath.replace(/^\//, ''));
    if (fs.existsSync(imgPath)) {
      await sendAndTrack(userId, { image: fs.readFileSync(imgPath) });
    }
  }
  return true;
}

async function sendProductVideo(userId, product) {
  if (!product || !product.video) {
    return false;
  }
  const videoPath = path.join(__dirname, product.video.replace(/^\//, ''));
  if (!fs.existsSync(videoPath)) {
    return false;
  }
  await sendAndTrack(userId, { video: fs.readFileSync(videoPath) });
  return true;
}

// ---------- Voz clonada (MiniMax): subir muestra, clonar, y generar audio ----------
// MiniMax necesita API Key + Group ID (los dos, a diferencia de Groq que solo
// pide una clave). A diferencia de Groq, MiniMax NO es gratis: cobra tanto por
// clonar la voz como por cada audio que genera después.
const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';

async function minimaxUploadSample(cfg, filePath, mimetype) {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('purpose', 'voice_clone');
  form.append('file', new Blob([fileBuffer], { type: mimetype }), path.basename(filePath));

  const res = await fetch(`${MINIMAX_BASE_URL}/files/upload?GroupId=${cfg.minimaxGroupId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.minimaxApiKey}` },
    body: form,
  });
  const data = await res.json();
  if (data?.base_resp?.status_code !== 0) {
    throw new Error(data?.base_resp?.status_msg || 'MiniMax rechazó la subida del audio');
  }
  return data.file.file_id;
}

async function minimaxCloneVoice(cfg, fileId, voiceId) {
  const res = await fetch(`${MINIMAX_BASE_URL}/voice_clone?GroupId=${cfg.minimaxGroupId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.minimaxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      // Incluir texto+modelo aquí genera una pequeña muestra de inmediato,
      // lo cual además "activa" la voz clonada (si no se usa en un T2A
      // dentro de 7 días, MiniMax la borra automáticamente).
      text: 'Hola, esta es una prueba de la voz clonada para el asistente.',
      model: 'speech-2.8-hd',
    }),
  });
  const data = await res.json();
  if (data?.base_resp?.status_code !== 0) {
    throw new Error(data?.base_resp?.status_msg || 'MiniMax no pudo clonar la voz');
  }
  return true;
}

async function minimaxListVoices(cfg) {
  const res = await fetch(`${MINIMAX_BASE_URL}/get_voice?GroupId=${cfg.minimaxGroupId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.minimaxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ voice_type: 'voice_cloning' }),
  });
  const data = await res.json();
  if (data?.base_resp?.status_code !== 0) {
    throw new Error(data?.base_resp?.status_msg || 'MiniMax no pudo listar las voces');
  }
  return data.voice_cloning || [];
}

async function minimaxTextToSpeech(cfg, text) {
  const res = await fetch(`${MINIMAX_BASE_URL}/t2a_v2?GroupId=${cfg.minimaxGroupId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.minimaxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'speech-2.8-hd',
      text,
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: cfg.minimaxVoiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  const data = await res.json();
  if (!data?.data?.audio) {
    throw new Error(data?.base_resp?.status_msg || 'MiniMax no devolvió audio');
  }
  return Buffer.from(data.data.audio, 'hex');
}

// MiniMax lee el símbolo "$" como dólares por defecto, sin importar lo que
// diga el texto alrededor — es una limitación de su lector de voz, no algo
// que se arregle con el prompt. La solución es quitar el símbolo antes de
// mandarlo a hablar, dejando la palabra "pesos" en su lugar. Esto SOLO
// afecta el audio — el texto normal en WhatsApp se sigue viendo igual.
// Convierte un número entero a palabras en español (ej. 25000 -> "veinticinco mil").
// Cubre hasta cientos de millones, más que suficiente para precios de productos.
function numberToSpanishWords(num) {
  if (num === 0) return 'cero';

  const unidades = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  const especiales = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
  const decenas = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const centenas = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  function convertirGrupo(n) {
    if (n === 100) return 'cien';
    let str = '';
    const c = Math.floor(n / 100);
    const resto = n % 100;
    if (c > 0) str += centenas[c] + ' ';
    if (resto >= 10 && resto <= 19) {
      str += especiales[resto - 10];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      if (d === 2 && u > 0) {
        str += 'veinti' + unidades[u];
      } else {
        if (d > 0) str += decenas[d];
        if (d > 0 && u > 0) str += ' y ';
        if (u > 0) str += unidades[u];
      }
    }
    return str.trim();
  }

  let result = '';
  const millones = Math.floor(num / 1000000);
  const miles = Math.floor((num % 1000000) / 1000);
  const resto = num % 1000;

  if (millones > 0) {
    result += (millones === 1 ? 'un millón' : convertirGrupo(millones) + ' millones') + ' ';
  }
  if (miles > 0) {
    result += (miles === 1 ? 'mil' : convertirGrupo(miles) + ' mil') + ' ';
  }
  if (resto > 0) {
    result += convertirGrupo(resto);
  }

  return result.trim();
}

// MiniMax lee el símbolo "$" como dólares por defecto, y además puede leer
// mal números con puntos de miles (ej. "25.000" a veces sale como "veinticinco
// punto cero cero cero"). Para evitar ambigüedad, convertimos el precio
// completo a palabras antes de mandarlo a hablar — esto SOLO afecta el
// audio, el texto normal en WhatsApp se sigue viendo igual ("$25.000").
function prepareTextForSpeech(text) {
  return text
    .replace(/\$\s?([\d.,]+)/g, (match, numStr) => {
      const digitsOnly = numStr.replace(/[.,]/g, '');
      const num = parseInt(digitsOnly, 10);
      if (isNaN(num)) return match; // no se pudo interpretar, se deja tal cual
      return `${numberToSpanishWords(num)} pesos`;
    })
    .replace(/\bCOP\b/gi, ''); // evita que quede "...pesos COP" repetido
}

async function sendVoiceReply(userId, text) {
  const cfg = readConfig();
  const speechText = prepareTextForSpeech(text);
  const audioBuffer = await minimaxTextToSpeech(cfg, speechText);
  const mp3Path = path.join(TMP_DIR, `voice-reply-${Date.now()}.mp3`);
  const oggPath = mp3Path.replace(/\.mp3$/, '.ogg');
  fs.writeFileSync(mp3Path, audioBuffer);
  try {
    // WhatsApp exige que las notas de voz vengan en OGG/Opus. MiniMax nos da
    // MP3, así que hay que convertirlo antes — si no, WhatsApp recibe el
    // archivo pero no lo puede reproducir ("no se pudo descargar el audio").
    await convertMp3ToOggOpus(mp3Path, oggPath);
    const oggBuffer = fs.readFileSync(oggPath);
    // ptt: true hace que llegue como nota de voz (con el ícono de
    // micrófono), no como un archivo de audio adjunto normal.
    await sendAndTrack(userId, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  } finally {
    fs.unlink(mp3Path, () => {});
    fs.unlink(oggPath, () => {});
  }
}

// ---------- Notificación de venta al número del dueño ----------
function normalizeWhatsAppNumber(rawNumber) {
  // Acepta números escritos con +, espacios o guiones y los deja listos
  // para WhatsApp (solo dígitos + "@s.whatsapp.net", que es como Baileys
  // identifica los chats individuales).
  const digitsOnly = (rawNumber || '').replace(/[^\d]/g, '');
  return digitsOnly ? `${digitsOnly}@s.whatsapp.net` : null;
}

// Busca el teléfono que el CLIENTE mismo escribió durante la compra (ya lo
// pides como parte del pedido: "📱 Teléfono: ..."). Es la fuente más
// confiable, porque no depende de cómo WhatsApp identifique internamente al
// contacto (a veces usa un "@lid", un id interno que NO es el número real).
function extractPhoneFromOrderText(text) {
  const match = (text || '').match(/tel[eé]fono[:\s]*([\d\s\-+]{7,})/i);
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, '');
  return digits || null;
}

// Los clientes suelen escribir su celular sin el indicativo del país (ej.
// "3001234567"). Para que el link wa.me funcione, hace falta el indicativo
// completo — asumimos Colombia (57) para el patrón típico de celular local.
function normalizeColombianNumber(digits) {
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

// Intenta identificar el número real de WhatsApp del cliente, probando
// varias fuentes en orden de confiabilidad. Esto NO es 100% infalible — es
// un problema conocido y sin arreglo perfecto del lado de WhatsApp/Baileys
// (algunos contactos se identifican con un "@lid" interno en vez de su
// número real, y no siempre se puede traducir uno al otro).
async function resolveClientPhoneNumber(clientUserId, replyText) {
  const fromOrder = normalizeColombianNumber(extractPhoneFromOrderText(replyText));
  if (fromOrder) return fromOrder;

  if (clientUserId && clientUserId.endsWith('@s.whatsapp.net')) {
    return clientUserId.split('@')[0];
  }

  if (clientUserId && clientUserId.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(clientUserId);
      if (pn) return pn.split('@')[0];
    } catch (e) {
      // no se pudo resolver, seguimos sin número
    }
  }

  return null;
}

async function notifyOwner(cfg, clientUserId, headerLine, reply) {
  const ownerJid = normalizeWhatsAppNumber(cfg.notificationPhoneNumber);
  if (!ownerJid) return;

  const phoneNumber = await resolveClientPhoneNumber(clientUserId, reply);
  const chatLine = phoneNumber
    ? `📱 Cliente: ${phoneNumber}\n💬 Abrir chat: https://wa.me/${phoneNumber}`
    : `📱 Cliente: no se pudo identificar el número real (revisa el teléfono que dio en el pedido, si aplica).`;

  const notification = `${headerLine}\n${chatLine}\n\n${reply}`;
  await sendAndTrack(ownerJid, { text: notification });
}

async function notifyOwnerOfSale(cfg, clientUserId, reply) {
  await notifyOwner(cfg, clientUserId, '🛎️ *Nueva venta registrada*', reply);
}

async function notifyOwnerOfCancellation(cfg, clientUserId, reply) {
  await notifyOwner(cfg, clientUserId, '❌ *Pedido cancelado*', reply);
}

async function notifyOwnerOfIntervention(cfg, clientUserId, reply) {
  await notifyOwner(cfg, clientUserId, '🆘 *Este chat necesita intervención humana*', reply);
}


// ---------- IA: llamada según proveedor configurado (con soporte de tools) ----------
// Devuelve el mensaje completo del modelo (content + tool_calls si los hay).
// Si Groq/OpenAI responde con error 429 (límite de tokens o mensajes por minuto),
// espera el tiempo que ellos indican y reintenta, en vez de fallar de una vez.
async function getAIMessage(messages, tools, attempt = 1) {
  const cfg = readConfig();
  const payload = {
    messages,
    temperature: 0.6,
    max_tokens: 400,
  };
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  try {
    if (cfg.aiProvider === 'openai') {
      const openai = getOpenAIClient(cfg);
      const completion = await openai.chat.completions.create({
        ...payload,
        model: cfg.openaiModel || 'gpt-4o-mini',
      });
      return completion.choices[0].message;
    }

    const groq = getGroqClient(cfg);
    const completion = await groq.chat.completions.create({
      ...payload,
      model: cfg.groqModel || 'llama-3.1-8b-instant',
    });
    return completion.choices[0].message;
  } catch (err) {
    const isRateLimit = err?.status === 429;
    const MAX_ATTEMPTS = 3;
    if (isRateLimit && attempt < MAX_ATTEMPTS) {
      // Groq/OpenAI indican cuántos segundos esperar en este header.
      const retryAfterHeader = err?.headers?.['retry-after'];
      const waitSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : 5 * attempt;
      io.emit(
        'log',
        `⏳ Límite de la IA alcanzado, reintentando en ${Math.ceil(waitSeconds)}s (intento ${attempt}/${MAX_ATTEMPTS})...`
      );
      await sleep((waitSeconds + 1) * 1000);
      return getAIMessage(messages, tools, attempt + 1);
    }
    throw err;
  }
}

// ---------- Transcripción de audio (notas de voz) ----------
async function transcribeAudio(base64Data, mimetype) {
  const cfg = readConfig();
  const ext = (mimetype || '').includes('ogg') ? 'ogg' : (mimetype || '').includes('mp4') ? 'm4a' : 'oga';
  const tmpPath = path.join(TMP_DIR, `audio-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));

  try {
    if (cfg.aiProvider === 'openai') {
      const openai = getOpenAIClient(cfg);
      const result = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-1',
        language: 'es',
      });
      return (result.text || '').trim();
    }
    const groq = getGroqClient(cfg);
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      language: 'es',
    });
    return (result.text || '').trim();
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

function buildSystemPrompt(jid, overrideOrderData) {
  const cfg = readConfig();
  const products = readProducts();
  const catalog = products
    .map((p) => {
      const priceLine =
        p.priceBefore && p.priceAfter
          ? `Precio: antes ${p.priceBefore}, HOY EN DESCUENTO a ${p.priceAfter}`
          : `Precio: ${p.priceAfter || p.priceBefore || 'consultar'}`;
      const videoLine = p.video ? '  Tiene video disponible: SÍ' : '  Tiene video disponible: NO';
      return `- ${p.name} | ${priceLine}\n  Detalle: ${p.details}\n${videoLine}`;
    })
    .join('\n');

  // overrideOrderData se usa solo desde el simulador de pruebas — así puede
  // reutilizar este mismo prompt sin tocar ningún cliente real.
  const client = jid ? clients.get(jid) : null;
  const orderData = overrideOrderData || client?.orderData || {};
  const fichaLines = [
    `Nombre: ${orderData.nombre || '(falta)'}`,
    `Teléfono: ${orderData.telefono || '(falta)'}`,
    `Tipo de entrega: ${orderData.tipoEntrega || '(falta — preguntar domicilio u oficina)'}`,
    orderData.tipoEntrega !== 'oficina' ? `Dirección: ${orderData.direccion || '(falta)'}` : null,
    `Ciudad: ${orderData.ciudad || '(falta)'}`,
    `Departamento: ${orderData.departamento || '(falta)'}`,
    orderData.barrio ? `Barrio: ${orderData.barrio}` : null,
    `Producto: ${orderData.producto || '(falta)'}`,
    `Cantidad: ${orderData.cantidad || '(falta)'}`,
  ].filter(Boolean).join('\n');

  const confirmBeforeClosing = !!cfg.confirmOrderDataBeforeClosing;

  return `
Eres ${cfg.assistantName}, asistente virtual de ventas de ${cfg.companyName}, atendiendo por WhatsApp.

${cfg.baseInstructions}

CATÁLOGO DE PRODUCTOS (usa SOLO esta información, nunca inventes precios ni beneficios):
${catalog || '(Todavía no hay productos cargados)'}

REGLA DE CATÁLOGO — LA MÁS IMPORTANTE DE TODAS, NUNCA LA ROMPAS:
Los ÚNICOS productos que existen son los que aparecen en el catálogo de arriba. Si el cliente pregunta por algo que NO está en esa lista (otro producto, otro nombre, otra categoría), debes decir con claridad que no lo tienes disponible — NUNCA inventes un producto, nombre, precio, uso o característica que no esté escrito exactamente en el catálogo, así el cliente insista o describa algo que "suena parecido". Inventar un producto que no existe es el peor error que puedes cometer — genera confusión, pedidos que no se pueden cumplir, y hace quedar mal al negocio.

Igual de importante cuando hay VARIOS productos reales en el catálogo: cada detalle (precio, forma de uso, beneficios, ingredientes) pertenece SOLO al producto exacto donde está escrito. Antes de responder, verifica de cuál producto está hablando el cliente en ESE momento de la conversación, y usa ÚNICAMENTE los detalles de ese producto — nunca tomes prestado un dato de otro producto del catálogo, aunque parezca similar.

Si el cliente pregunta por un producto específico, responde con los detalles de ESE producto.
Si pregunta en general, puedes mencionar brevemente los productos disponibles y preguntar cuál le interesa.

Cuando el cliente pida ver fotos, imágenes o cómo se ve el producto, usa la función enviar_imagen_producto para enviarlas de verdad.
Cuando el cliente pida ver un video, una demostración o cómo funciona, usa la función enviar_video_producto — pero solo si el catálogo dice que ese producto SÍ tiene video disponible; si no lo tiene, dilo con naturalidad en vez de llamar la función.
Nunca digas frases como "ya te la envío" o "aquí tienes la foto/video" si no llamaste a la función correspondiente — el cliente no recibirá nada si solo lo dices en texto.

FICHA DE DATOS DE ESTE CLIENTE (lo que ya tienes guardado, en este momento):
${fichaLines}

REGLA DE LA FICHA DE DATOS — MUY IMPORTANTE:
Cada vez que el cliente te dé o corrija CUALQUIERA de estos datos (nombre, teléfono, dirección, departamento, ciudad, barrio, producto, cantidad, tipo de entrega), llama SIEMPRE a la función actualizar_datos_pedido con ese dato — aunque sea uno solo. Así nunca se te olvida ni preguntas dos veces algo que ya te dieron. Antes de pedir un dato, revisa la ficha de arriba — si ya lo tienes, NO lo vuelvas a pedir.
Cuando el cliente muestre intención clara de comprar, pregunta EXACTAMENTE: "¿Cómo prefieres recibirlo? 🚚 Envío a domicilio o 🏢 recoges en oficina/punto de entrega?" — y guarda la respuesta con actualizar_datos_pedido.

REGLA DE DIRECCIÓN COMPLETA — MUY IMPORTANTE:
Una dirección solo cuenta como completa si identifica una casa/unidad ESPECÍFICA, no solo una zona o cruce general. Son válidas, por ejemplo:
- Con nomenclatura: "Carrera 4 #3-40", "Calle 15 # 20-10", "Transversal 25a 11 03" (con o sin el símbolo #, con o sin guion)
- Manzana y casa: "Manzana 15 Casa 27", "Mz 15 Cs 27"
- Supermanzana y casa: "Supermanzana 3 Casa 12"
NO son direcciones completas (pide que la complete, con un ejemplo del formato que necesitas): cruces sin número de casa ("Carrera 15 con 14"), o referencias sin número ("cerca al parque, casa amarilla"). Si la dirección que te dan ya trae un número que identifica la casa/unidad, acéptala tal cual la escribieron — no le exijas un formato exacto si ya es clara.

${orderData.ciudad || orderData.departamento ? `NOTA: Colombia tiene 32 departamentos — si el cliente solo dice la ciudad (ej. "Cumaral"), identifica tú el departamento correcto (ej. Meta) y guarda los dos por separado con actualizar_datos_pedido — nunca los mezcles en un solo campo.` : ''}

${confirmBeforeClosing ? `REGLA DE CONFIRMACIÓN — ACTIVADA:
Antes de cerrar el pedido, cuando ya tengas TODOS los datos completos, primero repítele al cliente un resumen breve de todos los datos y pregúntale si están correctos. SOLO cuando el cliente confirme que sí (diga "sí", "correcto", "así está bien" o similar), ahí sí cierra el pedido con la frase obligatoria. Si el cliente corrige algo en la confirmación, guarda la corrección con actualizar_datos_pedido y vuelve a confirmar.` : `Apenas la ficha de datos esté completa (según lo que necesite el tipo de entrega elegido), cierra el pedido de una vez, sin pedir una confirmación extra.`}

REGLA DE CANCELACIÓN — MUY IMPORTANTE:
Si el cliente dice que YA NO QUIERE el producto, se arrepintió de la compra, quiere anular o cancelar su PEDIDO — responde con empatía, sin insistir ni presionar, y SIEMPRE incluye en tu respuesta, exactamente así, la frase:
❌ PEDIDO CANCELADO ❌
Después de esa frase, agrega un resumen breve (producto del que se trataba, y el motivo si el cliente lo mencionó).
Esta frase es SOLO para cuando el cliente cancela el pedido completo (ya no lo quiere). NUNCA la uses si el cliente solo está cambiando la forma de pago, preguntando por el precio, o teniendo dudas normales — eso NO es una cancelación.

REGLA DE INTERVENCIÓN HUMANA — MUY IMPORTANTE:
Si el cliente pide explícitamente hablar con una persona/humano/asesor, está muy molesto o agresivo, tiene un reclamo complicado que no puedes resolver con la información que tienes, o cualquier situación donde el buen criterio diga que esto ya no lo debe manejar un bot — responde con calma y empatía, e incluye SIEMPRE, exactamente así, la frase:
🆘 NECESITA INTERVENCIÓN HUMANA 🆘
Dile al cliente que ya le avisaste a alguien del equipo y que en un momento le van a escribir. No sigas insistiendo en vender ni resolver tú solo la situación después de usar esta frase.

REGLA DE CONSULTA DE PEDIDOS — MUY IMPORTANTE:
Si el cliente pregunta por el estado de un pedido que ya hizo (ej. "¿cómo va mi pedido?", "¿ya tiene guía?", "¿cuándo me llega?"), usa SIEMPRE la función consultar_estado_pedido antes de responder — nunca inventes ni asumas un estado. Cuéntale el resultado con naturalidad, no leas el texto tal cual salga de la función.
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Cliente de WhatsApp ----------
let sock = null;
let botStatus = 'stopped'; // stopped | starting | qr | connected
const MAX_HISTORY = 12;

// ---- Conversaciones persistentes en disco ----
// Antes vivían solo en RAM (se perdían al cerrar el bot). Ahora se guardan en
// data/conversations.json y se recargan al arrancar, para no "olvidar" a un
// cliente a mitad de una compra si el bot se reinicia.
let conversations = new Map();
let seenUsers = new Set();

function loadConversations() {
  if (!fs.existsSync(CONVERSATIONS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, 'utf8'));
    conversations = new Map(Object.entries(raw.conversations || {}));
    seenUsers = new Set(raw.seenUsers || []);
  } catch (e) {
    console.error('No se pudo cargar conversations.json, se empieza limpio:', e);
  }
}

function saveConversations() {
  const data = {
    conversations: Object.fromEntries(conversations),
    seenUsers: Array.from(seenUsers),
  };
  fs.writeFile(CONVERSATIONS_PATH, JSON.stringify(data, null, 2), (err) => {
    if (err) console.error('Error guardando conversations.json:', err);
  });
}

loadConversations();

// ---- CRM: clientes, historial de chat, y pausas por conversación ----
let clients = new Map(); // jid -> { phone, name, status, lastMessageAt, createdAt, lastOrderSummary }
let chatLogs = new Map(); // jid -> [{ from: 'client'|'bot'|'owner', text, type, timestamp }]
let pausedChats = new Map(); // jid -> timestamp hasta cuándo queda pausado

const DEFAULT_PAUSE_MINUTES = 10;
const MAX_CHAT_LOG_PER_CLIENT = 300;

function loadCrmData() {
  if (fs.existsSync(CLIENTS_PATH)) {
    try {
      clients = new Map(Object.entries(JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8'))));
    } catch (e) {
      console.error('No se pudo cargar clients.json:', e);
    }
  }
  if (fs.existsSync(CHAT_LOGS_PATH)) {
    try {
      chatLogs = new Map(Object.entries(JSON.parse(fs.readFileSync(CHAT_LOGS_PATH, 'utf8'))));
    } catch (e) {
      console.error('No se pudo cargar chat-logs.json:', e);
    }
  }
  if (fs.existsSync(PAUSED_CHATS_PATH)) {
    try {
      pausedChats = new Map(Object.entries(JSON.parse(fs.readFileSync(PAUSED_CHATS_PATH, 'utf8'))));
    } catch (e) {
      console.error('No se pudo cargar paused-chats.json:', e);
    }
  }
}
loadCrmData();

function saveClients() {
  fs.writeFile(CLIENTS_PATH, JSON.stringify(Object.fromEntries(clients), null, 2), (err) => {
    if (err) console.error('Error guardando clients.json:', err);
  });
}
function saveChatLogs() {
  fs.writeFile(CHAT_LOGS_PATH, JSON.stringify(Object.fromEntries(chatLogs), null, 2), (err) => {
    if (err) console.error('Error guardando chat-logs.json:', err);
  });
}
function savePausedChats() {
  fs.writeFile(PAUSED_CHATS_PATH, JSON.stringify(Object.fromEntries(pausedChats), null, 2), (err) => {
    if (err) console.error('Error guardando paused-chats.json:', err);
  });
}

function ensureClientRecord(jid) {
  if (!clients.has(jid)) {
    clients.set(jid, {
      phone: jid.split('@')[0],
      name: '',
      status: 'nuevo',
      tag: 'lead',
      tagManual: false,
      messageCount: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      // Ficha de datos del pedido — se va llenando de a poco a medida que el
      // cliente da información, con la herramienta actualizar_datos_pedido.
      // Esto reemplaza tener que "adivinar" los datos leyendo el texto final
      // de la conversación — cada dato queda guardado en el momento exacto
      // en que el cliente lo da, y se puede corregir sin perder lo demás.
      orderData: {
        nombre: '',
        telefono: '',
        direccion: '',
        departamento: '',
        ciudad: '',
        barrio: '',
        producto: '',
        cantidad: '',
        tipoEntrega: '', // "domicilio" | "oficina"
      },
      notes: '', // notas internas del dueño — nunca las ve el cliente ni la IA
      followUpsSent: [], // IDs de los mensajes de seguimiento/remarketing ya enviados
    });
  } else {
    const rec = clients.get(jid);
    rec.lastMessageAt = Date.now();
    if (!rec.orderData) {
      // Cliente creado antes de este cambio — le agregamos la ficha vacía.
      rec.orderData = {
        nombre: '', telefono: '', direccion: '', departamento: '',
        ciudad: '', barrio: '', producto: '', cantidad: '', tipoEntrega: '',
      };
    }
    if (!rec.followUpsSent) rec.followUpsSent = [];
  }
  saveClients();
  io.emit('clientUpdate', { jid, client: clients.get(jid) });
}

// Traduce la etapa detallada del tablero a una etiqueta simple (Lead /
// Interesado / Cliente / Descartado), para poder filtrar la lista de chats
// sin tener que pensar en las 10 etapas del tablero una por una.
function deriveTagFromStatus(status) {
  if (status === 'nuevo') return 'lead';
  if (status === 'conversando' || status === 'interesado') return 'interesado';
  if (status === 'cancelado' || status === 'devuelto') return 'descartado';
  return 'cliente'; // comprado, guia_generada, en_camino, con_novedad, entregado
}

// Avanza la etapa del cliente sola, según cuántos mensajes lleva la
// conversación — solo si todavía está en una etapa "temprana" (nuevo o en
// conversación). Nunca retrocede una etapa, y nunca pisa "comprado" ni
// "cancelado" (esas se marcan aparte, con la frase exacta detectada).
function advanceClientStageIfNeeded(jid) {
  const rec = clients.get(jid);
  if (!rec) return;
  rec.messageCount = (rec.messageCount || 0) + 1;

  if (rec.status === 'nuevo') {
    rec.status = 'conversando';
  }
  if (rec.status === 'conversando' && rec.messageCount >= 3) {
    rec.status = 'interesado';
  }
  if (!rec.tagManual) rec.tag = deriveTagFromStatus(rec.status);
  clients.set(jid, rec);
  saveClients();
  io.emit('clientUpdate', { jid, client: rec });
}

function updateClientStatus(jid, status, extra) {
  const rec = clients.get(jid) || {
    phone: jid.split('@')[0],
    name: '',
    createdAt: Date.now(),
  };
  Object.assign(rec, { status, lastMessageAt: Date.now() }, extra || {});
  if (!rec.tagManual) rec.tag = deriveTagFromStatus(status);
  clients.set(jid, rec);
  saveClients();
  io.emit('clientUpdate', { jid, client: rec });
}

function appendChatLog(jid, entry) {
  if (!chatLogs.has(jid)) chatLogs.set(jid, []);
  const log = chatLogs.get(jid);
  log.push(entry);
  if (log.length > MAX_CHAT_LOG_PER_CLIENT) {
    log.splice(0, log.length - MAX_CHAT_LOG_PER_CLIENT);
  }
  saveChatLogs();
  io.emit('chatMessage', { jid, entry });
}

function isPaused(jid) {
  const until = pausedChats.get(jid);
  if (!until) return false;
  if (Date.now() > until) {
    pausedChats.delete(jid);
    savePausedChats();
    io.emit('pauseUpdate', { jid, pausedUntil: null });
    return false;
  }
  return true;
}

function pauseChat(jid, minutes) {
  const base = Math.max(pausedChats.get(jid) || 0, Date.now());
  const until = base + minutes * 60 * 1000;
  pausedChats.set(jid, until);
  savePausedChats();
  io.emit('pauseUpdate', { jid, pausedUntil: until });
  return until;
}

// "Hasta que yo reactive": en vez de inventar un tipo de dato nuevo (que
// complicaría guardar/leer el archivo), simplemente se pausa por un tiempo
// tan largo (~100 años) que en la práctica equivale a "indefinido" — el
// panel lo muestra como "Pausado indefinidamente" en vez de una hora exacta.
const INDEFINITE_PAUSE_MS = 100 * 365 * 24 * 60 * 60 * 1000;
function pauseChatIndefinitely(jid) {
  const until = Date.now() + INDEFINITE_PAUSE_MS;
  pausedChats.set(jid, until);
  savePausedChats();
  io.emit('pauseUpdate', { jid, pausedUntil: until });
  return until;
}

function resumeChat(jid) {
  pausedChats.delete(jid);
  savePausedChats();
  io.emit('pauseUpdate', { jid, pausedUntil: null });
}

// Busca el nombre que el CLIENTE mismo escribió durante la compra (igual que
// hacemos con el teléfono), para mostrarlo en la lista de clientes.
function extractNameFromOrderText(text) {
  const match = (text || '').match(/nombre[:\s]*([^\n📍🏙️📱💰🛍️]{2,60})/i);
  return match ? match[1].trim() : null;
}

// Estas extracciones son "mejor esfuerzo" — sirven para prellenar el
// formulario de "Confirmar y subir", pero siempre quedan editables antes de
// mandarlas a Dropi/Skydropx, así que no tienen que ser perfectas.
function extractProductFromOrderText(text) {
  const match = (text || '').match(/producto[:\s]*([^\n💰📍🏙️📱]{2,80})/i);
  return match ? match[1].trim() : null;
}
function extractPriceFromOrderText(text) {
  const match = (text || '').match(/precio[:\s]*\$?\s?([\d.,]+)/i);
  return match ? match[1].trim() : null;
}
function extractAddressFromOrderText(text) {
  const match = (text || '').match(/direcci[oó]n[:\s]*([^\n🏙️📱💰🛍️]{3,100})/i);
  return match ? match[1].trim() : null;
}
function extractCityFromOrderText(text) {
  const match = (text || '').match(/ciudad y departamento[:\s]*([^\n📱💰🛍️]{2,80})/i);
  return match ? match[1].trim() : null;
}

// ---- Pedidos (Orders): la lista que se sube a Dropi/Skydropx ----
let orders = [];
// Mismas 10 etapas que ya usa el tablero del panel (STATUS_COLUMNS en
// app.js) — se mantienen igual aquí para que la IA describa el estado con
// las mismas palabras que ves tú en el tablero.
const ORDER_STATUS_LABELS = {
  pendiente: 'Pendiente (todavía no se ha generado la guía)',
  nuevo: 'Nuevo',
  conversando: 'En conversación',
  interesado: 'Interesado',
  comprado: 'Compra confirmada',
  guia_generada: 'Guía generada',
  en_camino: 'En camino',
  con_novedad: 'Con novedad',
  entregado: 'Entregado',
  devuelto: 'Devuelto',
  cancelado: 'Cancelado',
};

let nextOrderNumber = 1;

function loadOrders() {
  if (fs.existsSync(ORDERS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
      orders = raw.orders || [];
      nextOrderNumber = raw.nextOrderNumber || orders.length + 1;
    } catch (e) {
      console.error('No se pudo cargar orders.json:', e);
    }
  }
}
function saveOrders() {
  fs.writeFile(
    ORDERS_PATH,
    JSON.stringify({ orders, nextOrderNumber }, null, 2),
    (err) => {
      if (err) console.error('Error guardando orders.json:', err);
    }
  );
}
loadOrders();

// ---- Departamentos y municipios de Colombia (para el desplegable de pedidos y para que la IA valide direcciones/ciudades) ----
let colombiaData = {};
try {
  colombiaData = JSON.parse(fs.readFileSync(COLOMBIA_DATA_PATH, 'utf8'));
} catch (e) {
  console.error('No se pudo cargar colombia.json:', e);
}
function findDepartmentForCity(cityName) {
  if (!cityName) return null;
  const normalized = cityName.trim().toLowerCase();
  for (const [dept, cities] of Object.entries(colombiaData)) {
    if (cities.some((c) => c.toLowerCase() === normalized)) return dept;
  }
  return null;
}

function createOrder(fields) {
  const id = `ORD-${String(nextOrderNumber).padStart(4, '0')}`;
  nextOrderNumber += 1;
  const order = {
    id,
    clientJid: fields.clientJid || '',
    clientName: fields.clientName || '',
    clientPhone: fields.clientPhone || '',
    product: fields.product || '',
    quantity: fields.quantity || 1,
    price: fields.price || '',
    address: fields.address || '',
    department: fields.department || '',
    city: fields.city || '',
    neighborhood: fields.neighborhood || '',
    deliveryType: fields.deliveryType || 'domicilio',
    transportadora: fields.transportadora || '',
    status: fields.status || 'pendiente',
    source: fields.source || 'manual', // 'ia' | 'manual'
    rawSummary: fields.rawSummary || '',
    dropiStatus: null,
    skydropxStatus: null,
    possibleDuplicateOf: fields.possibleDuplicateOf || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  orders.push(order);
  saveOrders();
  io.emit('orderUpdate', { order });
  return order;
}

function updateOrder(id, fields) {
  const order = orders.find((o) => o.id === id);
  if (!order) return null;
  Object.assign(order, fields, { updatedAt: Date.now() });
  saveOrders();
  io.emit('orderUpdate', { order });
  return order;
}

// Crea el pedido automáticamente apenas la IA cierra una venta — sin
// necesitar que nadie le dé clic a nada. Evita duplicados: si el cliente
// vuelve a preguntar "¿ya quedó confirmado?" y la IA repite exactamente el
// mismo resumen, no crea un segundo pedido igual.
async function autoCreateOrderFromSummary(jid, client, summary) {
  const alreadyExists = orders.some((o) => o.clientJid === jid && o.rawSummary === summary);
  if (alreadyExists) return null;

  // La ficha de datos estructurada (si ya está llena) es más confiable que
  // "adivinar" leyendo el texto final — se usa de primera, y el texto
  // extraído queda solo como respaldo si algún campo no se llegó a guardar.
  const od = client?.orderData || {};
  const phone = od.telefono || client?.phone || jid.split('@')[0];

  // Aviso de pedido duplicado: si este mismo teléfono ya tiene otro pedido
  // reciente (últimas 24h) sin resolver todavía, lo marcamos para que se
  // note en el panel — no bloquea la creación, solo avisa.
  const UNRESOLVED = ['pendiente', 'guia_generada', 'en_camino'];
  const recentDuplicate = orders.find(
    (o) =>
      o.clientPhone === phone &&
      UNRESOLVED.includes(o.status) &&
      Date.now() - o.createdAt < 24 * 60 * 60 * 1000
  );

  const order = createOrder({
    clientJid: jid,
    clientName: od.nombre || client?.name || extractNameFromOrderText(summary) || '',
    clientPhone: phone,
    product: od.producto || extractProductFromOrderText(summary) || '',
    quantity: od.cantidad || 1,
    price: extractPriceFromOrderText(summary) || '',
    address: od.direccion || extractAddressFromOrderText(summary) || '',
    department: od.departamento || '',
    city: od.ciudad || extractCityFromOrderText(summary) || '',
    neighborhood: od.barrio || '',
    deliveryType: od.tipoEntrega || 'domicilio',
    status: 'pendiente',
    source: 'ia',
    rawSummary: summary,
    possibleDuplicateOf: recentDuplicate ? recentDuplicate.id : null,
  });

  if (recentDuplicate) {
    io.emit('log', `⚠️ Posible pedido duplicado: ${order.id} y ${recentDuplicate.id} son del mismo teléfono, en menos de 24h`);
  }

  // Avisar al cliente el número de orden, para que lo tenga guardado y pueda
  // consultarlo después (con la función consultar_estado_pedido).
  try {
    const text = `Tu pedido quedó registrado con el código *${order.id}* 📦 — guárdalo por si necesitas consultar el estado más adelante.`;
    await sendAndTrack(jid, { text });
    appendChatLog(jid, { from: 'bot', text, type: 'text', timestamp: Date.now() });
  } catch (e) {
    console.error('No se pudo enviar el número de orden al cliente:', e);
  }

  await autoUploadIfEnabled(order);

  return order;
}

// Recuerda los IDs de los mensajes que el PROPIO bot mandó (no los del
// cliente ni del dueño). Sirve para diferenciar, cuando llega un mensaje
// "fromMe" de WhatsApp, si es solo el eco de algo que el bot ya envió, o si
// es el dueño escribiendo manualmente desde su propio celular — casos muy
// distintos que necesitan tratarse diferente (el segundo pausa el chat).
const botSentMessageIds = new Set();
const MAX_BOT_SENT_IDS = 500;

// Recuerda los IDs de TODOS los mensajes ya procesados (de clientes y del
// dueño), para no volver a procesarlos si Baileys los entrega de nuevo —
// pasa seguido justo después de una reconexión. IMPORTANTE: esto vive fuera
// de startBot() a propósito, para que sobreviva cuando el bot se reconecta
// solo (si estuviera adentro, se resetearía en cada reconexión y volvería a
// tratar mensajes viejos como si fueran nuevos).
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 500;

async function sendAndTrack(jid, content, options) {
  const result = await sock.sendMessage(jid, content, options);
  if (result?.key?.id) {
    botSentMessageIds.add(result.key.id);
    if (botSentMessageIds.size > MAX_BOT_SENT_IDS) {
      const oldest = botSentMessageIds.values().next().value;
      botSentMessageIds.delete(oldest);
    }
  }
  return result;
}

// ---- Cola de mensajes por cliente ----
// Sin esto, si un cliente manda 2-3 mensajes seguidos muy rápido, cada uno se
// procesa en paralelo y pueden pisarse o responderse en desorden. Con la cola,
// los mensajes del MISMO número se procesan uno por uno, en orden. Distintos
// clientes sí se siguen atendiendo en paralelo entre sí.
const userQueues = new Map();

function enqueueForUser(userId, task) {
  const previous = userQueues.get(userId) || Promise.resolve();
  const next = previous.then(task).catch((err) => {
    console.error(`Error en la cola de ${userId}:`, err);
  });
  userQueues.set(userId, next);
  return next;
}

async function startBot() {
  if (sock) return;
  botStatus = 'starting';
  io.emit('status', botStatus);

  // Deja el ffmpeg (necesario para las notas de voz) listo desde ahora, antes
  // de que lleguen mensajes — si falla, solo se pierde la función de voz, el
  // resto del bot sigue funcionando normal.
  try {
    ensureFfmpegConfigured();
  } catch (e) {
    console.warn('⚠️ FFmpeg no disponible, la voz clonada no va a funcionar:', e.message);
  }

  const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    downloadMediaMessage,
  } = await loadBaileys();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // el QR lo dibujamos nosotros mismos, como imagen en el panel
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botStatus = 'qr';
      const qrImage = await QRCode.toDataURL(qr);
      io.emit('qr', qrImage);
      io.emit('status', botStatus);
    }

    if (connection === 'open') {
      botStatus = 'connected';
      io.emit('status', botStatus);
      io.emit('log', `✅ Bot conectado. (versión ${CURRENT_VERSION})`);
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      botStatus = 'stopped';
      io.emit('status', botStatus);
      io.emit('log', `⚠️ Desconectado. ${shouldReconnect ? 'Reintentando conexión...' : 'Sesión cerrada.'}`);
      sock = null;
      if (shouldReconnect) {
        startBot().catch((err) => console.error('Error reconectando:', err));
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    // El propio número del bot (el que escaneaste) — WhatsApp a veces manda
    // mensajes de "auto-chat"/sincronización con este mismo número como
    // remitente, que no son ni un cliente real ni una intervención tuya.
    // Los ignoramos por completo.
    const ownNumber = sock.user?.id ? sock.user.id.split(':')[0] : null;
    const ownJid = ownNumber ? `${ownNumber}@s.whatsapp.net` : null;

    for (const msg of messages) {
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (ownJid && msg.key.remoteJid === ownJid) continue;

      // Anti-duplicados: aplica a CUALQUIER mensaje (del cliente o tuyo si
      // interviniste), para que una reconexión no lo vuelva a procesar dos veces.
      const msgId = msg.key.id;
      if (msgId) {
        if (processedMessageIds.has(msgId)) {
          io.emit('log', `⏭️ Mensaje duplicado ignorado (${msgId})`);
          continue;
        }
        processedMessageIds.add(msgId);
        if (processedMessageIds.size > MAX_PROCESSED_IDS) {
          const oldest = processedMessageIds.values().next().value;
          processedMessageIds.delete(oldest);
        }
      }

      if (msg.key.fromMe) {
        if (msgId && botSentMessageIds.has(msgId)) {
          continue; // eco de un mensaje que el propio bot ya mandó, no es una intervención
        }
        // Llegó un mensaje "fromMe" que el bot NO mandó -> el dueño escribió
        // manualmente desde su propio WhatsApp. Pausamos ese chat para que el
        // bot no se cruce con lo que la persona esté diciendo.
        const jid = msg.key.remoteJid;
        const ownerText =
          msg.message?.conversation || msg.message?.extendedTextMessage?.text || '(mensaje sin texto)';
        ensureClientRecord(jid);
        appendChatLog(jid, { from: 'owner', text: ownerText, type: 'text', timestamp: Date.now() });
        const cfgNow = readConfig();
        const minutes = Number(cfgNow.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
        pauseChat(jid, minutes);
        io.emit('log', `✋ Interviniste en ${jid.split('@')[0]} — bot pausado ${minutes} min ahí`);
        continue;
      }

      // Encola el mensaje: si el mismo cliente manda varios seguidos, se procesan
      // uno por uno y en orden, sin pisarse entre sí.
      enqueueForUser(msg.key.remoteJid, () => processMessage(msg));
    }
  });

  async function processMessage(msg) {
    try {
      const cfg = readConfig();
      const userId = msg.key.remoteJid;
      const isNewUser = !seenUsers.has(userId);
      seenUsers.add(userId);

      const rawText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      // ---- Notas de voz: transcribir antes de seguir el flujo normal ----
      let messageText = rawText;
      const audioMsg = msg.message?.audioMessage;
      const isVoiceMessage = !!audioMsg;
      if (isVoiceMessage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            reuploadRequest: sock.updateMediaMessage,
          });
          io.emit('log', `🎙️ Transcribiendo audio de ${userId}...`);
          messageText = await transcribeAudio(buffer.toString('base64'), audioMsg.mimetype);
          if (!messageText) {
            await sendAndTrack(userId, { text: 'No logré entender el audio 🙏. ¿Me lo puedes escribir?' });
            return;
          }
          io.emit('log', `🎙️ Transcripción: ${messageText}`);
        } catch (e) {
          console.error('Error transcribiendo audio:', e);
          await sendAndTrack(userId, { text: 'No pude procesar el audio 🙏. ¿Me lo escribes en texto?' });
          return;
        }
      }

      if (!messageText) return; // otro tipo de mensaje (sticker, ubicación, etc.) — lo ignoramos por ahora

      // ---- Registrar en el CRM: se guarda SIEMPRE, esté pausado o no ----
      ensureClientRecord(userId);
      advanceClientStageIfNeeded(userId);
      appendChatLog(userId, {
        from: 'client',
        text: messageText,
        type: isVoiceMessage ? 'voice' : 'text',
        timestamp: Date.now(),
      });

      // ---- Si el chat está pausado (interviniste manualmente), no respondemos automático ----
      if (isPaused(userId)) {
        io.emit('log', `⏸️ ${userId} está pausado, no respondo automático`);
        return;
      }

      if (!conversations.has(userId)) {
        conversations.set(userId, [{ role: 'system', content: buildSystemPrompt(userId) }]);
      }
      const history = conversations.get(userId);
      history[0] = { role: 'system', content: buildSystemPrompt(userId) }; // refresca por si cambiaron productos/config/ficha de datos
      history.push({ role: 'user', content: messageText });

      if (history.length > MAX_HISTORY + 1) {
        history.splice(1, history.length - (MAX_HISTORY + 1));
      }
      saveConversations();

      try {
        await sock.sendPresenceUpdate('composing', userId);
      } catch (e) {
        // sin problema si no se puede mostrar "escribiendo..."
      }

      if (isNewUser) {
        await sendAndTrack(userId, { text: cfg.welcomeMessage });
      }

      await sleep((cfg.responseDelaySeconds ?? 5) * 1000);

      // ---- Primera llamada a la IA, con las herramientas de imagen y video disponibles ----
      let aiMessage = await getAIMessage(history, [productImageTool, productVideoTool, updateOrderDataTool, checkOrderStatusTool]);

      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        // El modelo decidió enviar imagen o video: lo hacemos de verdad.
        history.push({
          role: 'assistant',
          content: aiMessage.content || null,
          tool_calls: aiMessage.tool_calls,
        });

        for (const toolCall of aiMessage.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {}

          let resultText = 'No se encontró el producto solicitado.';
          if (toolCall.function.name === 'enviar_imagen_producto') {
            const product = findProductByQuery(args.producto);
            const sent = await sendProductImages(userId, product);
            resultText = sent
              ? `Imagen(es) de "${product.name}" enviadas correctamente.`
              : 'No hay imágenes disponibles para ese producto.';
          } else if (toolCall.function.name === 'enviar_video_producto') {
            const product = findProductByQuery(args.producto);
            const sent = await sendProductVideo(userId, product);
            resultText = sent
              ? `Video de "${product.name}" enviado correctamente.`
              : 'Ese producto no tiene un video cargado.';
          } else if (toolCall.function.name === 'actualizar_datos_pedido') {
            resultText = handleUpdateOrderData(userId, args);
          } else if (toolCall.function.name === 'consultar_estado_pedido') {
            resultText = handleCheckOrderStatus(userId, args);
          }

          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultText,
          });
        }

        // Segunda llamada para que la IA redacte el mensaje final ya sabiendo
        // qué se envió de verdad (o si no había disponible).
        aiMessage = await getAIMessage(history);
      }

      const reply = (aiMessage.content || '').trim() || 'Listo 😊';
      history.push({ role: 'assistant', content: reply });
      saveConversations();
      appendChatLog(userId, { from: 'bot', text: reply, type: 'text', timestamp: Date.now() });

      // ---- Responder con audio (voz clonada) según el modo configurado ----
      // voiceMode: 'off' (siempre texto), 'voice' (siempre audio),
      // 'mirror' (responde en el mismo formato en que llegó el mensaje).
      // Excepción: las confirmaciones de venta/cancelación SIEMPRE van en
      // texto, sin importar el modo — traen datos importantes (dirección,
      // teléfono, precio) que el cliente necesita poder leer y guardar, no
      // solo escuchar una vez.
      const isOrderConfirmation =
        reply.includes('ORDEN DE COMPRA REGISTRADA') || reply.includes('PEDIDO CANCELADO');
      const voiceMode = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
      const minimaxReady = cfg.minimaxApiKey && cfg.minimaxGroupId && cfg.minimaxVoiceId;
      const shouldReplyWithVoice =
        !isOrderConfirmation &&
        minimaxReady &&
        (voiceMode === 'voice' || (voiceMode === 'mirror' && isVoiceMessage));

      if (shouldReplyWithVoice) {
        try {
          await sendVoiceReply(userId, reply);
        } catch (err) {
          console.error('Error generando audio con MiniMax, se responde en texto:', err);
          io.emit('log', `⚠️ Falló la voz (MiniMax), respondí en texto: ${err.message}`);
          await sendAndTrack(userId, { text: reply });
        }
      } else {
        await sendAndTrack(userId, { text: reply });
      }

      // ---- Si esta respuesta cerró una venta, avisar al número del dueño ----
      if (reply.includes('ORDEN DE COMPRA REGISTRADA') && cfg.notificationPhoneNumber) {
        try {
          await notifyOwnerOfSale(cfg, userId, reply);
          io.emit('log', `🛎️ Venta notificada a ${cfg.notificationPhoneNumber}`);
        } catch (err) {
          console.error('Error notificando la venta:', err);
          io.emit('log', `⚠️ No se pudo notificar la venta: ${err.message}`);
        }
      }
      if (reply.includes('ORDEN DE COMPRA REGISTRADA')) {
        const name = extractNameFromOrderText(reply);
        updateClientStatus(userId, 'comprado', {
          lastOrderSummary: reply,
          ...(name ? { name } : {}),
        });
        await autoCreateOrderFromSummary(userId, clients.get(userId), reply);
      }

      // ---- Si el cliente canceló el pedido, avisar también ----
      if (reply.includes('PEDIDO CANCELADO') && cfg.notificationPhoneNumber) {
        try {
          await notifyOwnerOfCancellation(cfg, userId, reply);
          io.emit('log', `❌ Cancelación notificada a ${cfg.notificationPhoneNumber}`);
        } catch (err) {
          console.error('Error notificando la cancelación:', err);
          io.emit('log', `⚠️ No se pudo notificar la cancelación: ${err.message}`);
        }
      }
      if (reply.includes('PEDIDO CANCELADO')) {
        updateClientStatus(userId, 'cancelado', {});
      }

      // ---- Si la IA detectó que hace falta una persona real, avisar y pausar ----
      if (reply.includes('NECESITA INTERVENCIÓN HUMANA')) {
        if (cfg.notificationPhoneNumber) {
          try {
            await notifyOwnerOfIntervention(cfg, userId, reply);
            io.emit('log', `🆘 Intervención humana notificada a ${cfg.notificationPhoneNumber}`);
          } catch (err) {
            console.error('Error notificando la intervención:', err);
            io.emit('log', `⚠️ No se pudo notificar la intervención: ${err.message}`);
          }
        }
        const minutes = Number(cfg.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
        pauseChat(userId, minutes);
        io.emit('log', `⏸️ ${userId} pausado — necesita intervención humana`);
      }

      io.emit('log', `💬 ${userId}: ${messageText}`);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
      io.emit('log', `❌ Error: ${err.message}`);
      const isRateLimit = err?.status === 429;
      const fallbackMsg = isRateLimit
        ? 'Estamos con muchos mensajes en este momento 🙏. Dame un minuto y te respondo enseguida.'
        : 'Disculpa, tuve un problema técnico 🙏. ¿Puedes repetir tu mensaje?';
      try {
        await sendAndTrack(msg.key.remoteJid, { text: fallbackMsg });
      } catch (e) {}
    }
  }
}

app.post('/api/start', (req, res) => {
  startBot().catch((err) => {
    console.error('Error arrancando el bot:', err);
    botStatus = 'stopped';
    io.emit('status', botStatus);
    io.emit('log', `❌ No se pudo iniciar: ${err.message}`);
  });
  res.json({ status: botStatus });
});

app.get('/api/status', (req, res) => res.json({ status: botStatus }));

// ---------- API: acceder al panel desde otro dispositivo en la misma red ----------
// No es una copia — es literalmente el mismo panel, la misma base de datos.
// Cualquier cambio hecho desde otro dispositivo se guarda en esta misma PC.
app.get('/api/network-info', async (req, res) => {
  try {
    const ip = getLocalNetworkIP();
    if (!ip) {
      return res.json({ available: false });
    }
    const url = `http://${ip}:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ available: true, url, qrDataUrl, port: PORT });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

// ---------- API: cerrar sesión de WhatsApp (desvincula el número, conserva la app abierta) ----------
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.error('Error cerrando sesión:', e);
      }
      sock = null;
    }
    botStatus = 'stopped';
    io.emit('status', botStatus);
    io.emit('log', '🔌 Sesión de WhatsApp cerrada.');

    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo cerrar la sesión: ' + err.message });
  }
});

// ---------- API: cerrar el bot por completo (no solo minimizarlo a la bandeja) ----------
// A diferencia de /api/logout (que solo desvincula el número de WhatsApp),
// esto apaga el proceso entero de la app. global.quitApp lo expone main.js
// (mismo proceso de Electron), así que si el bot corre fuera de Electron
// (ej. con "npm start" directo) caemos de vuelta a process.exit.
app.post('/api/quit-app', async (req, res) => {
  res.json({ ok: true });
  io.emit('log', '🛑 Cerrando el asistente...');
  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (e) {
    console.error('Error cerrando la conexión antes de salir:', e);
  }
  setTimeout(() => {
    if (typeof global.quitApp === 'function') {
      global.quitApp();
    } else {
      process.exit(0);
    }
  }, 500);
});

// ---------- API: reiniciar la app (cierra y vuelve a abrir sola) ----------
// Útil sobre todo después de instalar una actualización, para no tener que
// cerrar y abrir a mano. Si corre fuera de Electron (ej. "npm start" directo),
// no hay forma de "reabrirse sola" — en ese caso solo se cierra, como
// /api/quit-app, y hay que volver a abrirla a mano.
app.post('/api/restart-app', async (req, res) => {
  res.json({ ok: true });
  io.emit('log', '🔄 Reiniciando la aplicación...');
  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (e) {
    console.error('Error cerrando la conexión antes de reiniciar:', e);
  }
  setTimeout(() => {
    if (typeof global.restartApp === 'function') {
      global.restartApp();
    } else if (typeof global.quitApp === 'function') {
      global.quitApp();
    } else {
      process.exit(0);
    }
  }, 500);
});

// ---------- API: voz clonada (MiniMax) ----------
app.post('/api/voice/clone', uploadVoiceSample, async (req, res) => {
  try {
    const cfg = readConfig();
    if (!cfg.minimaxApiKey || !cfg.minimaxGroupId) {
      return res.status(400).json({ error: 'Falta configurar la API Key y/o el Group ID de MiniMax' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No llegó ningún archivo de audio' });
    }

    const voiceId = `inv360_${Date.now()}`;
    const fileId = await minimaxUploadSample(cfg, req.file.path, req.file.mimetype);
    await minimaxCloneVoice(cfg, fileId, voiceId);

    const updated = { ...cfg, minimaxVoiceId: voiceId };
    writeConfig(updated);

    res.json({ ok: true, voiceId, message: 'Voz clonada correctamente.' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo clonar la voz: ' + err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

app.get('/api/voice/list', async (req, res) => {
  try {
    const cfg = readConfig();
    if (!cfg.minimaxApiKey || !cfg.minimaxGroupId) {
      return res.status(400).json({ error: 'Falta configurar la API Key y/o el Group ID de MiniMax' });
    }
    const voices = await minimaxListVoices(cfg);
    res.json({ voices, currentVoiceId: cfg.minimaxVoiceId || '' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron listar las voces: ' + err.message });
  }
});

app.post('/api/voice/select', (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId) return res.status(400).json({ error: 'Falta el voiceId' });
  const cfg = readConfig();
  writeConfig({ ...cfg, minimaxVoiceId: voiceId });
  res.json({ ok: true });
});

// ---------- API: probar la voz clonada (solo la escuchas en el panel, no se manda a ningún cliente) ----------
app.post('/api/voice/preview', async (req, res) => {
  try {
    const cfg = readConfig();
    if (!cfg.minimaxApiKey || !cfg.minimaxGroupId || !cfg.minimaxVoiceId) {
      return res.status(400).json({ error: 'Falta configurar MiniMax o clonar/seleccionar una voz primero' });
    }
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Escribe un texto para probar' });

    const audioBuffer = await minimaxTextToSpeech(cfg, prepareTextForSpeech(text));
    res.json({ ok: true, audioBase64: audioBuffer.toString('base64') });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar el audio de prueba: ' + err.message });
  }
});

// ---------- API: revisar y aplicar actualizaciones ----------
app.get('/api/check-update', async (req, res) => {
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`No se pudo consultar el manifiesto (${response.status})`);
    const manifest = await response.json();
    res.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: manifest.version,
      updateAvailable: !!manifest.version && manifest.version !== CURRENT_VERSION,
      notes: manifest.notes || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo revisar actualizaciones: ' + err.message });
  }
});

// Busca un npm utilizable: primero el node-portable que viaja dentro de la
// propia carpeta de la app (como en el instalador), si no existe, confía en
// que "npm" esté disponible en el PATH del sistema.
function resolveNpmCommand() {
  const portableNpm = path.join(__dirname, 'node-portable', 'npm.cmd');
  if (fs.existsSync(portableNpm)) return `"${portableNpm}"`;
  return 'npm';
}

// Corre "npm install <paquetes>" dentro de la carpeta de la app, mostrando
// el progreso en el log del panel en tiempo real.
function installDependencies(packages) {
  return new Promise((resolve, reject) => {
    if (!packages || packages.length === 0) return resolve();
    const { spawn } = require('child_process');
    const npmCmd = resolveNpmCommand();
    io.emit('log', `📦 Instalando dependencias nuevas: ${packages.join(', ')}...`);

    const child = spawn(`${npmCmd} install ${packages.join(' ')}`, {
      cwd: __dirname,
      shell: true,
    });

    child.stdout.on('data', (data) => io.emit('log', data.toString().trim()));
    child.stderr.on('data', (data) => io.emit('log', data.toString().trim()));

    child.on('close', (code) => {
      if (code === 0) {
        io.emit('log', '✔ Dependencias instaladas correctamente.');
        resolve();
      } else {
        reject(new Error(`npm install terminó con código ${code}`));
      }
    });
    child.on('error', reject);
  });
}

app.post('/api/apply-update', async (req, res) => {
  try {
    const manifestResponse = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error('No se pudo consultar el manifiesto');
    const manifest = await manifestResponse.json();

    // Formato nuevo: manifest.files = { "ruta/relativa": "url raw de GitHub", ... }
    // permite actualizar varios archivos a la vez (server.js, main.js, public/...).
    // Formato viejo (compatibilidad): manifest.serverUrl = "url" — solo actualizaba server.js.
    const filesToUpdate =
      manifest.files && typeof manifest.files === 'object' && Object.keys(manifest.files).length > 0
        ? manifest.files
        : manifest.serverUrl
        ? { 'server.js': manifest.serverUrl }
        : null;

    if (!filesToUpdate) {
      throw new Error('El manifiesto no indica qué archivo(s) actualizar');
    }

    const updatedFiles = [];
    for (const [relPath, url] of Object.entries(filesToUpdate)) {
      // Seguridad básica: nunca dejar que una ruta se salga de la carpeta de la app.
      const safeRelPath = relPath.replace(/^[/\\]+/, '');
      if (safeRelPath.includes('..')) {
        throw new Error(`Ruta de archivo no permitida: ${relPath}`);
      }
      const targetPath = path.join(__dirname, safeRelPath);

      const fileResponse = await fetch(url, { cache: 'no-store' });
      if (!fileResponse.ok) throw new Error(`No se pudo descargar ${relPath}`);
      const newContent = await fileResponse.text();

      if (fs.existsSync(targetPath)) {
        const backupPath = `${targetPath}.bak-${Date.now()}`;
        fs.copyFileSync(targetPath, backupPath);
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      }
      fs.writeFileSync(targetPath, newContent, 'utf8');
      updatedFiles.push(safeRelPath);
    }

    // Si el manifiesto indica librerías nuevas que el código actualizado
    // necesita, las instala automáticamente antes de terminar.
    if (Array.isArray(manifest.newDependencies) && manifest.newDependencies.length > 0) {
      await installDependencies(manifest.newDependencies);
    }

    res.json({
      ok: true,
      newVersion: manifest.version,
      updatedFiles,
      message: `Actualización descargada (${updatedFiles.length} archivo${updatedFiles.length === 1 ? '' : 's'}: ${updatedFiles.join(', ')}). Cierra el bot y ábrelo de nuevo para aplicar los cambios.`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error aplicando la actualización: ' + err.message });
  }
});

io.on('connection', (socket) => {
  socket.emit('status', botStatus);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Panel disponible en http://localhost:${PORT}`);
});
