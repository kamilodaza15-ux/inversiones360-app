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
const CURRENT_VERSION = '1.10.0';
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
      await sock.sendMessage(userId, { image: fs.readFileSync(imgPath) });
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
  await sock.sendMessage(userId, { video: fs.readFileSync(videoPath) });
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

async function sendVoiceReply(userId, text) {
  const cfg = readConfig();
  const audioBuffer = await minimaxTextToSpeech(cfg, text);
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
    await sock.sendMessage(userId, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
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

async function notifyOwnerOfSale(cfg, clientUserId, reply) {
  const ownerJid = normalizeWhatsAppNumber(cfg.notificationPhoneNumber);
  if (!ownerJid) return;
  const clientNumber = (clientUserId || '').split('@')[0];
  const notification =
    `🛎️ *Nueva venta registrada*\n` +
    `📱 Cliente: ${clientNumber}\n\n` +
    `${reply}`;
  await sock.sendMessage(ownerJid, { text: notification });
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

function buildSystemPrompt() {
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

  return `
Eres ${cfg.assistantName}, asistente virtual de ventas de ${cfg.companyName}, atendiendo por WhatsApp.

${cfg.baseInstructions}

CATÁLOGO DE PRODUCTOS (usa SOLO esta información, nunca inventes precios ni beneficios):
${catalog || '(Todavía no hay productos cargados)'}

Si el cliente pregunta por un producto específico, responde con los detalles de ESE producto.
Si pregunta en general, puedes mencionar brevemente los productos disponibles y preguntar cuál le interesa.

Cuando el cliente pida ver fotos, imágenes o cómo se ve el producto, usa la función enviar_imagen_producto para enviarlas de verdad.
Cuando el cliente pida ver un video, una demostración o cómo funciona, usa la función enviar_video_producto — pero solo si el catálogo dice que ese producto SÍ tiene video disponible; si no lo tiene, dilo con naturalidad en vez de llamar la función.
Nunca digas frases como "ya te la envío" o "aquí tienes la foto/video" si no llamaste a la función correspondiente — el cliente no recibirá nada si solo lo dices en texto.
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
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
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
            await sock.sendMessage(userId, { text: 'No logré entender el audio 🙏. ¿Me lo puedes escribir?' });
            return;
          }
          io.emit('log', `🎙️ Transcripción: ${messageText}`);
        } catch (e) {
          console.error('Error transcribiendo audio:', e);
          await sock.sendMessage(userId, { text: 'No pude procesar el audio 🙏. ¿Me lo escribes en texto?' });
          return;
        }
      }

      if (!messageText) return; // otro tipo de mensaje (sticker, ubicación, etc.) — lo ignoramos por ahora

      if (!conversations.has(userId)) {
        conversations.set(userId, [{ role: 'system', content: buildSystemPrompt() }]);
      }
      const history = conversations.get(userId);
      history[0] = { role: 'system', content: buildSystemPrompt() }; // refresca por si cambiaron productos/config
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
        await sock.sendMessage(userId, { text: cfg.welcomeMessage });
      }

      await sleep((cfg.responseDelaySeconds ?? 5) * 1000);

      // ---- Primera llamada a la IA, con las herramientas de imagen y video disponibles ----
      let aiMessage = await getAIMessage(history, [productImageTool, productVideoTool]);

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

      // ---- Responder con audio (voz clonada) según el modo configurado ----
      // voiceMode: 'off' (siempre texto), 'voice' (siempre audio),
      // 'mirror' (responde en el mismo formato en que llegó el mensaje).
      const voiceMode = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
      const minimaxReady = cfg.minimaxApiKey && cfg.minimaxGroupId && cfg.minimaxVoiceId;
      const shouldReplyWithVoice =
        minimaxReady &&
        (voiceMode === 'voice' || (voiceMode === 'mirror' && isVoiceMessage));

      if (shouldReplyWithVoice) {
        try {
          await sendVoiceReply(userId, reply);
        } catch (err) {
          console.error('Error generando audio con MiniMax, se responde en texto:', err);
          io.emit('log', `⚠️ Falló la voz (MiniMax), respondí en texto: ${err.message}`);
          await sock.sendMessage(userId, { text: reply });
        }
      } else {
        await sock.sendMessage(userId, { text: reply });
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

      io.emit('log', `💬 ${userId}: ${messageText}`);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
      io.emit('log', `❌ Error: ${err.message}`);
      const isRateLimit = err?.status === 429;
      const fallbackMsg = isRateLimit
        ? 'Estamos con muchos mensajes en este momento 🙏. Dame un minuto y te respondo enseguida.'
        : 'Disculpa, tuve un problema técnico 🙏. ¿Puedes repetir tu mensaje?';
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: fallbackMsg });
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

    const audioBuffer = await minimaxTextToSpeech(cfg, text);
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
