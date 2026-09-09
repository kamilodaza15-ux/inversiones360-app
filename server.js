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
const CURRENT_VERSION = '1.31.5';
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
// Mismo patrón que resolveFfmpegPath() de arriba, pero para "ffprobe" — una
// herramienta hermana de ffmpeg que fluent-ffmpeg necesita por separado para
// poder leer datos de un archivo (como su duración exacta). Nunca la
// habíamos configurado, así que sin querer siempre fallaba en silencio y
// caíamos en "1 segundo" de duración para CUALQUIER nota de voz — muy
// probablemente la causa real detrás de que WhatsApp rechazara el audio
// como "dañado", ya que la duración no coincidía con el archivo real.
function resolveFfprobePath() {
  const candidates = [];
  let staticPath = null;

  try {
    staticPath = require('@ffprobe-installer/ffprobe').path;
    if (staticPath && !/app\.asar([\\/]|$)/i.test(staticPath)) {
      candidates.push(staticPath);
    }
  } catch (err) {
    console.warn('No se pudo cargar @ffprobe-installer/ffprobe:', err.message);
  }

  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', 'linux-x64', 'ffprobe'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', 'darwin-x64', 'ffprobe')
    );
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (fs.existsSync(candidate) && !/app\.asar([\\/]|$)/i.test(candidate)) {
      console.log('✅ FFprobe encontrado:', candidate);
      return candidate;
    }
  }

  // Si está empaquetado dentro de app.asar, lo copiamos afuera igual que a ffmpeg.
  if (staticPath && /app\.asar([\\/]|$)/i.test(staticPath) && fs.existsSync(staticPath)) {
    const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const runtimeDir = path.join(localAppData, 'Inversiones360Chat', 'ffmpeg-runtime');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const runtimePath = path.join(runtimeDir, `ffprobe${ext}`);
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.copyFileSync(staticPath, runtimePath);
      if (fs.existsSync(runtimePath)) {
        console.log('✅ FFprobe extraído fuera de app.asar:', runtimePath);
        return runtimePath;
      }
    } catch (err) {
      console.warn('⚠️ No se pudo extraer FFprobe fuera de app.asar:', err.message);
    }
  }

  // En Termux/Android, "pkg install ffmpeg" instala ffprobe junto con ffmpeg
  // en el sistema — revisamos si ya está disponible así.
  try {
    const { execSync } = require('child_process');
    execSync('ffprobe -version', { stdio: 'ignore' });
    console.log('✅ FFprobe encontrado en el PATH del sistema.');
    return 'ffprobe';
  } catch (err) {
    // no está en el PATH tampoco
  }

  console.warn('⚠️ FFprobe no encontrado — la duración de las notas de voz usará un valor de respaldo.');
  return null;
}

let cachedFfmpegPath = null;
function ensureFfmpegConfigured() {
  if (!cachedFfmpegPath) {
    cachedFfmpegPath = resolveFfmpegPath();
    console.log('🎙️ FFmpeg que usará fluent-ffmpeg:', cachedFfmpegPath);
    ffmpeg.setFfmpegPath(cachedFfmpegPath);

    const ffprobePath = resolveFfprobePath();
    if (ffprobePath) {
      ffmpeg.setFfprobePath(ffprobePath);
    }

    // Baileys también necesita "ffmpeg" para procesar audio (por ejemplo,
    // para calcular la forma de onda de las notas de voz) y lo busca por su
    // cuenta en el PATH del sistema, sin que podamos indicarle la ruta
    // directamente. Agregamos la carpeta de nuestro ffmpeg ya resuelto al
    // PATH de este proceso, así Baileys lo encuentra igual que fluent-ffmpeg.
    const ffmpegDir = path.dirname(cachedFfmpegPath);
    if (!process.env.PATH.includes(ffmpegDir)) {
      process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH}`;
    }
    if (ffprobePath && ffprobePath !== 'ffprobe') {
      const ffprobeDir = path.dirname(ffprobePath);
      if (!process.env.PATH.includes(ffprobeDir)) {
        process.env.PATH = `${ffprobeDir}${path.delimiter}${process.env.PATH}`;
      }
    }
  }
  return cachedFfmpegPath;
}

// Convierte un mp3 (lo que devuelve MiniMax) a ogg/opus (lo que exige
// WhatsApp para que una nota de voz se pueda reproducir del otro lado).
// Conversión para MiniMax (voz clonada) — esta configuración simple es la
// que ya sabemos que funciona bien de punta a punta (WhatsApp la reproduce
// sin problema). No agregarle parámetros extra sin probar, porque MiniMax
// entrega un MP3 limpio que no necesita el tratamiento especial que sí
// necesita la grabación del navegador (función de abajo).
function convertMp3ToOggOpus(inputPath, outputPath) {
  ensureFfmpegConfigured(); // lanza el error aquí si falta ffmpeg, no al arrancar la app
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .audioChannels(1)
      // MiniMax entrega el audio a 32.000 Hz — Opus (el códec que exige
      // WhatsApp) solo soporta de forma nativa 8k/12k/16k/24k/48k Hz.
      .audioFrequency(48000)
      .outputOptions([
        '-vbr', 'on', '-application', 'voip', '-compression_level', '10',
        // CAUSA REAL encontrada revisando un archivo real: MiniMax mete una
        // etiqueta gigante llamada "AIGC" dentro del audio (un sello
        // regulatorio chino, con firmas digitales y certificados) — sin
        // este parámetro, ffmpeg la copia tal cual al archivo final, y
        // WhatsApp la rechaza como "dañada". "-map_metadata -1" borra TODA
        // metadata del archivo de salida, dejando solo el audio limpio.
        '-map_metadata', '-1',
      ])
      .format('ogg')
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
}

// Antes de mandar CUALQUIER audio por WhatsApp, se confirma que el archivo
// convertido de verdad exista y no esté vacío/truncado — si ffmpeg falló
// silenciosamente (0 bytes), mejor darse cuenta aquí y avisar claro, que
// mandarle a WhatsApp un archivo roto sin saberlo.
function assertValidAudioFile(oggPath) {
  const stats = fs.statSync(oggPath);
  if (stats.size < 500) {
    throw new Error(`El archivo de audio convertido quedó sospechosamente pequeño (${stats.size} bytes) — probablemente la conversión falló silenciosamente.`);
  }
}

// Conversión para la nota de voz grabada desde el navegador (botón del
// micrófono en el panel) — el archivo que entrega MediaRecorder (WebM) suele
// traer metadatos de duración mal formados, así que aquí sí hace falta
// reforzar con parámetros explícitos de Opus para que WhatsApp la reproduzca
// bien en el celular del cliente, no solo en el navegador.
function convertRecordingToOggOpus(inputPath, outputPath) {
  ensureFfmpegConfigured();
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(48000)
      .outputOptions(['-vbr', 'on', '-application', 'voip', '-compression_level', '10', '-map_metadata', '-1'])
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
function normalizeFirstContactSequence(product) {
  if (Array.isArray(product.firstContactSequence)) {
    return product.firstContactSequence
      .filter(Boolean)
      .map((step, index) => ({
        id: step.id || `fc-${Date.now()}-${index}`,
        type: step.type || 'text',
        text: step.text || '',
        mediaUrl: step.mediaUrl || '',
        delaySeconds: Math.max(0, Number(step.delaySeconds) || 0),
        buttons: Array.isArray(step.buttons) ? step.buttons.slice(0, 3).map((b, bi) => {
          if (b && typeof b === 'object') return { id: String(b.id || `b${bi + 1}`), text: String(b.text || b.label || '').trim(), response: String(b.response || '').trim() };
          return { id: `b${bi + 1}`, text: String(b || '').trim(), response: '' };
        }).filter((b) => b.text) : [],
      }));
  }

  // Compatibilidad con productos creados antes del constructor de secuencias.
  const sequence = [];
  if (product.firstContactMessage) {
    sequence.push({ id: `fc-legacy-text-${product.id || Date.now()}`, type: 'text', text: product.firstContactMessage, mediaUrl: '', delaySeconds: 0, buttons: [] });
  }
  for (const url of Array.isArray(product.firstContactImages) ? product.firstContactImages.slice(0, 2) : []) {
    sequence.push({ id: `fc-legacy-img-${product.id || Date.now()}-${sequence.length}`, type: 'image', text: '', mediaUrl: typeof url === 'string' ? url : (url?.url || ''), delaySeconds: 2, buttons: [] });
  }
  return sequence;
}

function readProducts() {
  const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  return products.map((p) => ({
    ...p,
    saleMode: p.saleMode || p.salesMode || p.assistantMode || p.modoVenta || 'general',
    assistantPrompt: p.assistantPrompt || '',
    sellerModeEnabled: p.sellerModeEnabled === true || p.sellerMode === true,
    firstContactEnabled: p.firstContactEnabled === true,
    firstContactMessage: p.firstContactMessage || '',
    firstContactImages: Array.isArray(p.firstContactImages) ? p.firstContactImages : [],
    firstContactSequence: normalizeFirstContactSequence(p),
  }));
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
    } else if (file.fieldname === 'images' || file.fieldname === 'firstContactImages') {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new Error('Las imágenes deben ser archivos de imagen reales'));
      }
    } else if (file.fieldname === 'firstContactMedia') {
      if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/') && !file.mimetype.startsWith('audio/')) {
        return cb(new Error('El material del primer contacto debe ser imagen, video o audio'));
      }
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB: alcanza para videos cortos de producto
});
const uploadProductMedia = upload.fields([
  { name: 'images', maxCount: 6 },
  { name: 'firstContactImages', maxCount: 2 },
  { name: 'firstContactMedia', maxCount: 10 },
  { name: 'video', maxCount: 1 },
]);
const uploadSingleImage = upload.single('image');

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
  let quantityOffers = [];
  try {
    quantityOffers = req.body.quantityOffers ? JSON.parse(req.body.quantityOffers) : [];
  } catch (e) {}
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
    skydropxProductId: req.body.skydropxProductId || '',
    quantityOffers,
    saleMode: req.body.saleMode || 'general',
    assistantPrompt: req.body.assistantPrompt || '',
    sellerModeEnabled: req.body.sellerModeEnabled === 'true' || req.body.sellerModeEnabled === true,
    firstContactEnabled: req.body.firstContactEnabled === 'true' || req.body.firstContactEnabled === true,
    firstContactMessage: req.body.firstContactMessage || '',
    firstContactImages: (files.firstContactImages || []).map((f) => `/media/${f.filename}`),
    firstContactSequence: (() => {
      let seq = [];
      try { seq = req.body.firstContactSequence ? JSON.parse(req.body.firstContactSequence) : []; } catch (e) {}
      const media = files.firstContactMedia || [];
      return Array.isArray(seq) ? seq.map((step, i) => ({
        id: step.id || `fc-${Date.now()}-${i}`,
        type: step.type || 'text',
        text: step.text || '',
        mediaUrl: step.mediaIndex !== undefined && media[Number(step.mediaIndex)] ? `/media/${media[Number(step.mediaIndex)].filename}` : (step.mediaUrl || ''),
        delaySeconds: Math.max(0, Number(step.delaySeconds) || 0),
        buttons: Array.isArray(step.buttons) ? step.buttons.slice(0, 3).map((b, bi) => {
          if (b && typeof b === 'object') return { id: String(b.id || `b${bi + 1}`), text: String(b.text || b.label || '').trim(), response: String(b.response || '').trim() };
          return { id: `b${bi + 1}`, text: String(b || '').trim(), response: '' };
        }).filter((b) => b.text) : [],
      })).filter((step) => step.type !== 'text' || step.text.trim() || step.buttons.length === 0) : [];
    })(),
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
  let quantityOffers = existing.quantityOffers || [];
  if (req.body.quantityOffers !== undefined) {
    try {
      quantityOffers = JSON.parse(req.body.quantityOffers);
    } catch (e) {}
  }
  const updated = {
    ...existing,
    name: req.body.name ?? existing.name,
    priceBefore: req.body.priceBefore ?? existing.priceBefore,
    priceAfter: req.body.priceAfter ?? existing.priceAfter,
    details: req.body.details ?? existing.details,
    dropiProductId: req.body.dropiProductId ?? (existing.dropiProductId || ''),
    skydropxProductId: req.body.skydropxProductId ?? (existing.skydropxProductId || ''),
    quantityOffers,
    saleMode: req.body.saleMode ?? (existing.saleMode || 'general'),
    assistantPrompt: req.body.assistantPrompt ?? (existing.assistantPrompt || ''),
    sellerModeEnabled: req.body.sellerModeEnabled !== undefined ? (req.body.sellerModeEnabled === 'true' || req.body.sellerModeEnabled === true) : !!existing.sellerModeEnabled,
    firstContactEnabled: req.body.firstContactEnabled !== undefined ? (req.body.firstContactEnabled === 'true' || req.body.firstContactEnabled === true) : !!existing.firstContactEnabled,
    firstContactMessage: req.body.firstContactMessage ?? (existing.firstContactMessage || ''),
    firstContactImages: (files.firstContactImages || []).length > 0 ? (files.firstContactImages || []).map((f) => `/media/${f.filename}`) : (existing.firstContactImages || []),
    firstContactSequence: (() => {
      if (req.body.firstContactSequence === undefined) return existing.firstContactSequence || normalizeFirstContactSequence(existing);
      let seq = [];
      try { seq = JSON.parse(req.body.firstContactSequence || '[]'); } catch (e) {}
      const media = files.firstContactMedia || [];
      return Array.isArray(seq) ? seq.map((step, i) => ({
        id: step.id || `fc-${Date.now()}-${i}`,
        type: step.type || 'text',
        text: step.text || '',
        mediaUrl: step.mediaIndex !== undefined && media[Number(step.mediaIndex)] ? `/media/${media[Number(step.mediaIndex)].filename}` : (step.mediaUrl || ''),
        delaySeconds: Math.max(0, Number(step.delaySeconds) || 0),
        buttons: Array.isArray(step.buttons) ? step.buttons.slice(0, 3).map((b, bi) => {
          if (b && typeof b === 'object') return { id: String(b.id || `b${bi + 1}`), text: String(b.text || b.label || '').trim(), response: String(b.response || '').trim() };
          return { id: `b${bi + 1}`, text: String(b || '').trim(), response: '' };
        }).filter((b) => b.text) : [],
      })).filter((step) => step.type !== 'text' || step.text.trim() || step.buttons.length === 0) : [];
    })(),
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

// ---- Banco de medios: agregar/editar/borrar UNA imagen a la vez, cada una con su propia regla de "cuándo enviarla" ----
app.post('/api/products/:id/images', uploadSingleImage, (req, res) => {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  if (!req.file) return res.status(400).json({ error: 'No llegó ninguna imagen' });

  const product = products[idx];
  const currentImages = normalizeProductImages(product);
  currentImages.push({ url: `/media/${req.file.filename}`, rule: req.body.rule || '' });
  product.images = currentImages;
  writeProducts(products);
  res.json(product);
});

app.put('/api/products/:id/images/:index', (req, res) => {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' });

  const product = products[idx];
  const images = normalizeProductImages(product);
  const imgIdx = Number(req.params.index);
  if (!images[imgIdx]) return res.status(404).json({ error: 'Imagen no encontrada' });
  images[imgIdx].rule = req.body.rule || '';
  product.images = images;
  writeProducts(products);
  res.json(product);
});

app.delete('/api/products/:id/images/:index', (req, res) => {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Producto no encontrado' });

  const product = products[idx];
  const images = normalizeProductImages(product);
  const imgIdx = Number(req.params.index);
  if (!images[imgIdx]) return res.status(404).json({ error: 'Imagen no encontrada' });
  images.splice(imgIdx, 1);
  product.images = images;
  writeProducts(products);
  res.json(product);
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

// Editar la ficha de datos a mano — por si la IA entendió algo mal.
app.post('/api/clients/:jid/order-data', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const rec = clients.get(jid);
  if (!rec) return res.status(404).json({ error: 'Cliente no encontrado' });
  rec.orderData = { ...rec.orderData, ...(req.body.orderData || {}) };
  clients.set(jid, rec);
  saveClients();
  io.emit('clientUpdate', { jid, client: rec });
  res.json({ ok: true });
});

// Programar entrega a mano, desde el panel derecho.
app.post('/api/clients/:jid/schedule-delivery', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const rec = clients.get(jid);
  if (!rec) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!req.body.date) return res.status(400).json({ error: 'Falta la fecha' });
  rec.scheduledDelivery = { date: req.body.date, reminderSent: false, reminderSentAt: null };
  updateClientStatus(jid, 'programado', {});
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
    await convertRecordingToOggOpus(inputPath, oggPath);
    const oggBuffer = fs.readFileSync(oggPath);
    assertValidAudioFile(oggPath);
    const seconds = await getAudioDurationSeconds(oggPath);
    await sendAndTrack(jid, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds });

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
    ensureClientRecord(jid);
    if (!conversations.has(jid)) {
      conversations.set(jid, [{ role: 'system', content: buildSystemPrompt(jid) }]);
    }
    const client = clients.get(jid) || {};
    client.activeProductId = product.id;
    client.orderData = client.orderData || {};
    client.orderData.producto = product.name;
    clients.set(jid, client);
    saveClients();

    const history = conversations.get(jid);
    history[0] = { role: 'system', content: buildSystemPrompt(jid) };
    history.push({
      role: 'system',
      content: `El dueño del negocio activó manualmente el asistente para el producto "${product.name}". Enfócate naturalmente en ESE producto, sin mencionar activaciones internas.`,
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
// Genera el PDF del comprobante como buffer — se usa tanto para la descarga
// manual desde el panel, como para el envío automático al cliente.
function buildOrderPdfBuffer(order) {
  const cfg = readConfig();
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const donePromise = new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

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

  return donePromise;
}

// Manda el comprobante por WhatsApp al cliente — SOLO la primera vez que el
// pedido pasa de "Pendiente" a cualquier estado que no sea "Cancelado" (o
// sea, cuando de verdad se sube a Dropi/Skydropx). No se manda al crearlo
// (todavía podría no confirmarse por temas logísticos), ni se repite en
// cambios de estado posteriores.
async function sendOrderPdfIfNeeded(order) {
  if (order.pdfSent) return; // ya se mandó una vez, nunca se repite
  if (!order.clientJid) return; // pedido sin cliente real de WhatsApp asociado
  if (order.status === 'cancelado') return;
  try {
    const pdfBuffer = await buildOrderPdfBuffer(order);
    if (!sock) return;
    await sendAndTrack(order.clientJid, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: `comprobante-${order.id}.pdf`,
    });
    appendChatLog(order.clientJid, { from: 'bot', text: `(comprobante ${order.id} enviado)`, type: 'text', timestamp: Date.now() });
    updateOrder(order.id, { pdfSent: true });
  } catch (e) {
    console.error('No se pudo enviar el comprobante PDF al cliente:', e);
  }
}

app.get('/api/orders/:id/pdf', async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  const pdfBuffer = await buildOrderPdfBuffer(order);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="comprobante-${order.id}.pdf"`);
  res.send(pdfBuffer);
});

app.post('/api/orders', (req, res) => {
  const order = createOrder({ ...req.body, source: req.body.source || 'manual' });
  // Si el pedido viene de un cliente real, lo marcamos como comprado en el CRM también.
  if (order.clientJid) {
    updateClientStatus(order.clientJid, 'comprado', {});
  }
  res.json(order);
});

app.put('/api/orders/:id', async (req, res) => {
  const existingOrder = orders.find((o) => o.id === req.params.id);
  const wasPending = existingOrder?.status === 'pendiente';
  const order = updateOrder(req.params.id, req.body);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  // Si el cambio de estado (manual, desde el panel) sacó el pedido de
  // "Pendiente" hacia cualquier otro estado que no sea "Cancelado", se manda
  // el comprobante — antes esto solo pasaba si se subía a Dropi/Skydropx,
  // pero un cambio de estado manual también cuenta como "ya se confirmó".
  if (wasPending && order.status !== 'pendiente' && order.status !== 'cancelado') {
    await sendOrderPdfIfNeeded(order);
  }

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
// ---------- Integración real con Dropi ----------
const DROPI_WHITE_BRAND_ID = 'df3e6b0bb66ceaadca4f84cbc371fd66e04d20fe51fc414da8d1b84d31d178de';
let dropiTokenCache = null; // se guarda en memoria, se pide de nuevo si expira

function dropiBaseUrl(cfg) {
  return cfg.dropiUseTestEnv ? 'https://test-api.dropi.co/api' : 'https://api.dropi.co/api';
}

// Quita tildes y pasa a mayúsculas — Dropi espera los nombres de
// departamento/ciudad así (ej. "CUNDINAMARCA", "BOGOTA").
function toDropiPlaceName(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

// Lee la respuesta de Dropi con cuidado — si por algún motivo no es JSON de
// verdad (por ejemplo, si Dropi devuelve una página de error HTML, o si algo
// en la red la interceptó), esto da un mensaje claro en vez del confuso
// "Unexpected token '<'" que salía antes.
async function readDropiResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Dropi respondió algo inesperado (código ${res.status}), no fue posible leerlo — revisa tu conexión a internet o intenta de nuevo. Detalle: ${text.slice(0, 150)}`
    );
  }
}

async function dropiLogin(cfg) {
  if (!cfg.dropiEmail || !cfg.dropiPassword) {
    throw new Error('Falta configurar tu correo y contraseña de Dropi en Configuración.');
  }
  let res;
  try {
    res = await fetch(`${dropiBaseUrl(cfg)}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cfg.dropiEmail,
        password: cfg.dropiPassword,
        white_brand_id: DROPI_WHITE_BRAND_ID,
      }),
    });
  } catch (e) {
    throw new Error(`No se pudo conectar con Dropi — revisa tu conexión a internet. Detalle: ${e.message}`);
  }
  const data = await readDropiResponse(res);
  if (!data.isSuccess) {
    throw new Error(data.message || `Dropi rechazó el inicio de sesión (código ${res.status}) — revisa el correo y la contraseña.`);
  }
  dropiTokenCache = data.token;
  return data.token;
}

// Llama cualquier endpoint de Dropi ya autenticado — si el token venció,
// vuelve a hacer login solo, una vez, y reintenta.
async function dropiRequest(cfg, path, options = {}) {
  if (!dropiTokenCache) {
    await dropiLogin(cfg);
  }
  const doRequest = async () => {
    let res;
    try {
      res = await fetch(`${dropiBaseUrl(cfg)}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dropiTokenCache}`,
          ...(options.headers || {}),
        },
      });
    } catch (e) {
      throw new Error(`No se pudo conectar con Dropi — revisa tu conexión a internet. Detalle: ${e.message}`);
    }
    return readDropiResponse(res);
  };

  let data = await doRequest();
  if (data.status === 401 || data.message === 'Token is Expired') {
    await dropiLogin(cfg);
    data = await doRequest();
  }
  return data;
}

// Buscar productos en tu catálogo de Dropi por nombre — para el buscador
// del formulario de productos (autocompletar ID/nombre/precio).
async function dropiSearchProducts(cfg, keywords) {
  const data = await dropiRequest(cfg, '/products/index', {
    method: 'POST',
    body: JSON.stringify({ keywords: keywords || '', pageSize: 15, startData: 0 }),
  });
  if (!data.isSuccess) throw new Error(data.message || 'No se pudo buscar en Dropi.');
  return data.objects || [];
}

async function dropiGetProduct(cfg, dropiProductId) {
  const data = await dropiRequest(cfg, `/products/${dropiProductId}`, { method: 'GET' });
  if (!data.isSuccess) throw new Error(data.message || 'No se encontró ese producto en Dropi.');
  return data.objects;
}

async function uploadOrderToDropi(order) {
  const cfg = readConfig();
  if (!order.dropiProductId && !order.product) {
    throw new Error('Este pedido no tiene un producto con ID de Dropi asociado.');
  }
  if (!order.department || !order.city) {
    throw new Error('Falta el departamento y/o ciudad del pedido — revísalos antes de subir a Dropi.');
  }

  const [nombre, ...resto] = (order.clientName || 'Cliente').trim().split(' ');
  const apellido = resto.join(' ') || '.'; // Dropi exige apellido, algunos clientes solo dan un nombre

  const body = {
    state: toDropiPlaceName(order.department),
    city: toDropiPlaceName(order.city),
    name: nombre,
    surname: apellido,
    dir: order.address || 'Recogida en oficina',
    notes: order.neighborhood ? `Barrio: ${order.neighborhood}` : '',
    payment_method_id: 1,
    phone: order.clientPhone,
    rate_type: 'CON RECAUDO', // pago contra entrega — el modelo de negocio de la mayoría de dropshippers en Colombia
    type: 'FINAL_ORDER',
    total_order: parseInt(String(order.price || '0').replace(/[^\d]/g, ''), 10) || 0,
    products: [
      {
        id: parseInt(order.dropiProductId, 10),
        price: parseInt(String(order.price || '0').replace(/[^\d]/g, ''), 10) || 0,
        variation_id: null,
        quantity: order.quantity || 1,
      },
    ],
  };

  // Se llama SIEMPRE que un pedido se suba con éxito a CUALQUIER plataforma de
// envíos (Dropi, Skydropx, o la que se conecte en el futuro) — deja todo en
// un solo lugar compartido, para que sea imposible que a una integración
// nueva se le olvide pasar a "Confirmado" y mandar el comprobante.
async function markOrderConfirmedAndNotify(orderId, extraFields) {
  updateOrder(orderId, { status: 'confirmado', ...extraFields });
  await sendOrderPdfIfNeeded(orders.find((o) => o.id === orderId));
}

const data = await dropiRequest(cfg, '/orders/myorders', { method: 'POST', body: JSON.stringify(body) });
  if (!data.isSuccess) {
    throw new Error(data.message || 'Dropi rechazó la orden.');
  }

  await markOrderConfirmedAndNotify(order.id, { dropiOrderId: data.objects.id });
  return data.objects;
}

async function generateDropiGuide(orderId) {
  const cfg = readConfig();
  const order = orders.find((o) => o.id === orderId);
  if (!order) throw new Error('Pedido no encontrado');
  if (!order.dropiOrderId) throw new Error('Este pedido todavía no se ha subido a Dropi.');

  const data = await dropiRequest(cfg, `/orders/myorders/${order.dropiOrderId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'GUIA_GENERADA' }),
  });
  if (!data.isSuccess) {
    throw new Error(data.message || 'No se pudo generar la guía en Dropi.');
  }
  updateOrder(orderId, { status: 'guia_generada' });

  // Mensaje aparte (distinto al comprobante) — solo cuando ya hay guía de verdad.
  if (order.clientJid) {
    try {
      const guideNumber = data.objects?.shipping_guide || order.dropiGuideNumber || '';
      const text = `¡Tu pedido ya tiene guía de envío! 📦${guideNumber ? ` N° ${guideNumber}` : ''} — debería llegarte en aproximadamente 3 a 6 días hábiles. Gracias por tu compra 🎉`;
      await sendAndTrack(order.clientJid, { text });
      appendChatLog(order.clientJid, { from: 'bot', text, type: 'text', timestamp: Date.now() });
    } catch (e) {
      console.error('No se pudo enviar el aviso de guía generada:', e);
    }
  }

  return data;
}

// Consulta el estado REAL en Dropi (no solo el que tenemos guardado nosotros).
async function checkDropiOrderStatus(orderId) {
  const cfg = readConfig();
  const order = orders.find((o) => o.id === orderId);
  if (!order || !order.dropiOrderId) return null;

  const data = await dropiRequest(cfg, `/orders/myorders/${order.dropiOrderId}`, { method: 'GET' });
  if (!data.isSuccess) return null;

  const DROPI_STATUS_MAP = {
    PENDIENTE: 'pendiente',
    GUIA_GENERADA: 'guia_generada',
    EN_TRANSITO: 'en_camino',
    NOVEDAD: 'con_novedad',
    ENTREGADO: 'entregado',
    DEVOLUCION: 'devuelto',
    CANCELADO: 'cancelado',
  };
  const mappedStatus = DROPI_STATUS_MAP[data.objects.status] || order.status;

  updateOrder(orderId, {
    status: mappedStatus,
    transportadora: data.objects.shipping_company || order.transportadora,
    dropiGuideNumber: data.objects.shipping_guide || null,
    dropiSticker: data.objects.sticker || null,
  });
  return data.objects;
}


// ---------- Skydropx: login OAuth2, cotizar, y crear el envío ----------
function skydropxBaseUrl(cfg) {
  // El texto de su propia documentación dice explícitamente "usa el host
  // correcto: api-pro.skydropx.com" para producción — para sandbox seguimos
  // el mismo patrón que usan para encontrar credenciales (sb-pro / pro).
  return cfg.skydropxUseTestEnv ? 'https://sb-pro.skydropx.com' : 'https://api-pro.skydropx.com';
}

let skydropxTokenCache = null;
let skydropxTokenExpiresAt = 0;

async function skydropxLogin(cfg) {
  if (!cfg.skydropxClientId || !cfg.skydropxClientSecret) {
    throw new Error('Falta configurar el Client ID y Client Secret de Skydropx en Configuración.');
  }

  const endpoint = `${skydropxBaseUrl(cfg)}/api/v1/oauth/token`;
  const clientId = String(cfg.skydropxClientId).trim();
  const clientSecret = String(cfg.skydropxClientSecret).trim();

  async function requestToken(headers, body) {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
      });
    } catch (e) {
      const cause = e?.cause;
      const detail = [
        e?.message,
        cause?.code ? `código=${cause.code}` : '',
        cause?.message && cause.message !== e?.message ? `causa=${cause.message}` : '',
      ].filter(Boolean).join(' | ');
      throw new Error(`No se pudo conectar con Skydropx (${endpoint}). Detalle: ${detail || 'error de red desconocido'}`);
    }
  }

  // La documentación oficial muestra x-www-form-urlencoded para OAuth.
  // Algunas versiones del backend/documentación de Skydropx han mostrado
  // ejemplos JSON, por lo que si el endpoint devuelve 422 probamos una sola
  // vez JSON. Esto no cambia ninguna otra función del sistema.
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  let res = await requestToken(
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    form.toString()
  );

  let text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}

  // Compatibilidad adicional: si el Sandbox responde 422 al formato form,
  // reintentamos exactamente la misma autenticación como JSON.
  if (res.status === 422) {
    res = await requestToken(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      })
    );
    text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  }

  if (!data) {
    throw new Error(
      `Skydropx respondió algo inesperado (HTTP ${res.status}) en ${endpoint}. ` +
      `Respuesta: ${text.slice(0, 1000) || '(vacía)'}`
    );
  }

  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || data.errors || data.message || text || `HTTP ${res.status}`;
    const responseType = res.headers.get('content-type') || 'desconocido';
    let safeDetail;
    try { safeDetail = JSON.stringify(detail); } catch (_) { safeDetail = String(detail); }
    throw new Error(
      `Skydropx rechazó la autenticación. HTTP ${res.status}. ` +
      `Ambiente: ${cfg.skydropxUseTestEnv ? 'Sandbox' : 'Producción'}. ` +
      `Endpoint: ${endpoint}. Tipo: ${responseType}. ` +
      `Respuesta: ${safeDetail.slice(0, 1500)}`
    );
  }

  skydropxTokenCache = data.access_token;
  const expiresIn = Math.max(60, Number(data.expires_in) || 7200);
  // Dejamos 2 minutos de margen para no usar un token a punto de vencer.
  skydropxTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 120) * 1000;
  return data.access_token;
}

async function skydropxRequest(cfg, path, options = {}, retry401 = true) {
  if (!skydropxTokenCache || Date.now() >= skydropxTokenExpiresAt) {
    await skydropxLogin(cfg);
  }

  let res;
  try {
    res = await fetch(`${skydropxBaseUrl(cfg)}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${skydropxTokenCache}`,
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    const cause = e?.cause;
    const detail = [
      e?.message,
      cause?.code ? `código=${cause.code}` : '',
      cause?.message && cause.message !== e?.message ? `causa=${cause.message}` : '',
    ].filter(Boolean).join(' | ');
    throw new Error(`No se pudo conectar con Skydropx (${skydropxBaseUrl(cfg)}${path}). Detalle: ${detail || 'error de red desconocido'}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Skydropx respondió algo inesperado (HTTP ${res.status}). Detalle: ${text.slice(0, 200)}`);
  }

  if (res.status === 401 && retry401) {
    // Token rechazado/vencido: limpiar caché, renovar y reintentar UNA sola vez.
    skydropxTokenCache = null;
    skydropxTokenExpiresAt = 0;
    await skydropxLogin(cfg);
    return skydropxRequest(cfg, path, options, false);
  }

  if (!res.ok) {
    const detail = data.errors || data.error_description || data.error || data.message || `HTTP ${res.status}`;
    let detailText;
    try { detailText = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch (_) { detailText = String(detail); }
    throw new Error(`Skydropx HTTP ${res.status}: ${detailText.slice(0, 2000)}`);
  }
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data;
}

// Jala el peso/medidas de un producto ya cargado en Skydropx — evita tener
// que repetir esos datos a mano en Configuración cuando ya los tienes allá.
async function getSkydropxProductDimensions(cfg, skydropxProductId) {
  if (!skydropxProductId) return null;
  try {
    const data = await skydropxRequest(cfg, '/api/v1/products');
    const products = data?.data || [];
    const match = products.find((p) => p.id === skydropxProductId);
    if (!match) return null;
    const attrs = match.attributes || {};
    return {
      weight: Number(attrs.weight) || null,
      length: Number(attrs.length) || null,
      width: Number(attrs.width) || null,
      height: Number(attrs.height) || null,
    };
  } catch (e) {
    console.error('No se pudieron jalar las medidas del producto en Skydropx, se usan las de Configuración:', e.message);
    return null;
  }
}

async function uploadOrderToSkydropx(order) {
  const cfg = readConfig();
  if (!cfg.skydropxClientId || !cfg.skydropxClientSecret) {
    throw new Error('Falta configurar el Client ID y Client Secret de Skydropx en Configuración.');
  }
  if (!cfg.skydropxOriginName || !cfg.skydropxOriginStreet || !cfg.skydropxOriginCity) {
    throw new Error('Falta configurar la dirección de origen de tus envíos en Configuración → Skydropx.');
  }

  // Si el producto de este pedido ya está vinculado a un producto de
  // Skydropx, se jalan sus medidas reales — si no, se usan las de respaldo
  // configuradas a mano.
  const catalogProduct = findProductByQuery(order.product);
  const skydropxDims = await getSkydropxProductDimensions(cfg, catalogProduct?.skydropxProductId);

  // ---- Paso 1: cotizar ----
  const declaredAmount = Number(String(order.price || '').replace(/[^\d.]/g, '')) || 0;
  if (!declaredAmount) {
    throw new Error('El pedido no tiene un precio válido para el valor declarado de Skydropx.');
  }

  const quotationBody = {
    quotation: {
      address_from: {
        country_code: 'CO',
        postal_code: cfg.skydropxOriginPostalCode || '',
        area_level1: cfg.skydropxOriginState || '',
        area_level2: cfg.skydropxOriginCity || '',
        street1: cfg.skydropxOriginStreet,
        name: cfg.skydropxOriginName,
        company: cfg.companyName || '',
        phone: cfg.skydropxOriginPhone || '',
        email: cfg.skydropxOriginEmail || '',
        reference: cfg.skydropxOriginReference || 'Sin referencia',
      },
      address_to: {
        country_code: 'CO',
        postal_code: order.postalCode || '',
        area_level1: order.department || '',
        area_level2: order.city || '',
        street1: order.address || order.city || '',
        name: order.clientName || 'Cliente',
        phone: order.clientPhone || '',
        email: 'cliente@example.com',
        reference: order.neighborhood || 'Sin referencia',
      },
      parcels: [
        {
          weight: skydropxDims?.weight || Number(cfg.skydropxDefaultWeightKg) || 1,
          length: skydropxDims?.length || Number(cfg.skydropxDefaultLengthCm) || 20,
          width: skydropxDims?.width || Number(cfg.skydropxDefaultWidthCm) || 20,
          height: skydropxDims?.height || Number(cfg.skydropxDefaultHeightCm) || 10,
          quantity: 1,
          declared_amount: declaredAmount,
          dimension_unit: 'CM',
          mass_unit: 'KG',
        },
      ],
      cash_on_delivery: true,
      recipient_pays_shipping: false,
    },
  };

  const quotationRes = await skydropxRequest(cfg, '/api/v1/quotations', {
    method: 'POST',
    body: JSON.stringify(quotationBody),
  });
  const quotationId = quotationRes?.id || quotationRes?.data?.id || quotationRes?.data?.data?.id || quotationRes?.quotation?.id;
  if (!quotationId) {
    throw new Error('Skydropx no devolvió un id de cotización.');
  }

  // ---- Paso 2: la cotización se completa de a poco — se revisa unas veces, esperando un poco entre cada una ----
  let quotationData = quotationRes;
  for (let i = 0; i < 6; i++) {
    const isCompleted = quotationData?.is_completed === true || quotationData?.data?.attributes?.status === 'completed';
    if (isCompleted) break;
    await sleep(2000);
    quotationData = await skydropxRequest(cfg, `/api/v1/quotations/${quotationId}`);
  }

  const rates = Array.isArray(quotationData?.rates)
    ? quotationData.rates.filter((r) => r?.success)
    : (quotationData?.included || [])
        .filter((item) => item.type === 'rate' && item.attributes?.success)
        .map((item) => ({ id: item.id, ...item.attributes }));
  if (rates.length === 0) {
    throw new Error('Skydropx no encontró ninguna tarifa disponible para esta dirección.');
  }

  // REGLA DE NEGOCIO: a oficina, SIEMPRE Interrápidísimo (sin importar el
  // precio) — a domicilio, la tarifa más barata entre todas las que sirvieron.
  let bestRate;
  if (order.deliveryType === 'oficina') {
    bestRate = rates.find((r) => String(r.provider_name || r.attributes?.provider_name || '').toLowerCase().includes('interrapidisimo'));
    if (!bestRate) {
      throw new Error('Este pedido es para recogida en oficina, pero Skydropx no ofreció ninguna tarifa de Interrápidísimo para esta dirección.');
    }
  } else {
    bestRate = rates.reduce((a, b) => (Number(a.total ?? a.attributes?.total) <= Number(b.total ?? b.attributes?.total) ? a : b));
  }

  // ---- Paso 3: crear el envío con la tarifa elegida ----
  const rateId = bestRate.id;
  if (!rateId) throw new Error('Skydropx no devolvió un rate_id válido.');

  const shipmentBody = {
    shipment: {
      rate_id: rateId,
      unique_shipment: true,
      address_from: {
        country_code: 'CO',
        postal_code: cfg.skydropxOriginPostalCode || '',
        area_level1: cfg.skydropxOriginState || '',
        area_level2: cfg.skydropxOriginCity || '',
        street1: cfg.skydropxOriginStreet,
        name: cfg.skydropxOriginName,
        company: cfg.companyName || 'Inversiones 360 Store',
        phone: cfg.skydropxOriginPhone || '',
        email: cfg.skydropxOriginEmail || 'no-reply@example.com',
        reference: cfg.skydropxOriginReference || 'Sin referencia',
      },
      address_to: {
        country_code: 'CO',
        postal_code: order.postalCode || '',
        area_level1: order.department || '',
        area_level2: order.city || '',
        street1: order.address || order.city || '',
        name: order.clientName || 'Cliente',
        company: 'Cliente',
        phone: order.clientPhone || '',
        email: 'cliente@example.com',
        reference: order.neighborhood || 'Sin referencia',
      },
      packages: [{
        package_number: '1',
        package_protected: false,
        declared_value: declaredAmount,
      }],
    },
  };

  if (cfg.skydropxUseTestEnv) shipmentBody.shipment.auto_advance = true;
  if (order.deliveryType === 'oficina') {
    throw new Error('El pedido es para oficina. Primero debemos seleccionar el punto de oficina de Skydropx para crear la guía.');
  }

  const shipmentRes = await skydropxRequest(cfg, '/api/v1/shipments/', {
    method: 'POST',
    body: JSON.stringify(shipmentBody),
  });
  const shipmentId = shipmentRes?.data?.id;
  if (!shipmentId) {
    throw new Error('Skydropx no devolvió un id de envío.');
  }

  await markOrderConfirmedAndNotify(order.id, {
    skydropxShipmentId: shipmentId,
    transportadora: bestRate.provider_display_name || bestRate.provider_name || bestRate.attributes?.provider_display_name || bestRate.attributes?.provider_name || '',
  });
  return shipmentRes.data;
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

app.post('/api/orders/:id/generate-guide-dropi', async (req, res) => {
  try {
    await generateDropiGuide(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/:id/refresh-status-dropi', async (req, res) => {
  try {
    const result = await checkDropiOrderStatus(req.params.id);
    if (!result) return res.status(400).json({ error: 'Este pedido no tiene una orden de Dropi asociada, o no se pudo consultar.' });
    res.json({ ok: true, status: result.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/dropi/search-products', async (req, res) => {
  try {
    const cfg = readConfig();
    const results = await dropiSearchProducts(cfg, req.query.q || '');
    res.json({ ok: true, products: results });
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
    ciudad: '', barrio: '', transportadora: '', producto: '', cantidad: '', tipoEntrega: '',
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
    const detectedSimulationProduct = detectProductFromText(text);
    if (detectedSimulationProduct) simulationSession.orderData.producto = detectedSimulationProduct.name;
    simulationSession.history[0] = {
      role: 'system',
      content: buildSystemPrompt(null, simulationSession.orderData),
    };
    simulationSession.history.push({ role: 'user', content: text });

    let aiMessage = await getAIMessage(simulationSession.history, [
      productImageTool, productVideoTool, updateOrderDataTool, checkOrderStatusTool, scheduleDeliveryTool,
    ]);
    const mediaPreview = [];
    let rounds = 0;

    // Igual que en el flujo real: se deja que la IA llame herramientas las
    // veces que necesite seguidas, no solo una vez.
    while (aiMessage.tool_calls && aiMessage.tool_calls.length > 0 && rounds < 5) {
      rounds += 1;
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
          const bestImages = findBestMatchingImages(product, args.contexto);
          if (bestImages.length > 0) {
            mediaPreview.push(...bestImages.map((img) => ({ type: 'image', url: img.url })));
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
          const fields = ['nombre', 'telefono', 'direccion', 'departamento', 'ciudad', 'barrio', 'transportadora', 'producto', 'cantidad', 'tipoEntrega'];
          fields.forEach((f) => {
            if (args[f] !== undefined && args[f] !== null && String(args[f]).trim() !== '') {
              simulationSession.orderData[f] = String(args[f]).trim();
            }
          });
          resultText = `Datos guardados (solo en esta simulación, no toca clientes reales). ${describeMissingOrderFields(simulationSession.orderData)}`;
        } else if (toolCall.function.name === 'consultar_estado_pedido') {
          resultText = 'En el simulador no hay pedidos reales que consultar — esto es solo una prueba.';
        } else if (toolCall.function.name === 'programar_entrega') {
          resultText = `Entrega programada para el ${args.fecha} (solo en la simulación).`;
        } else {
          resultText = 'Esa función no existe. Responde con texto normal, usando la frase obligatoria si corresponde.';
        }

        simulationSession.history.push({ role: 'tool', tool_call_id: toolCall.id, content: resultText });
      }

      aiMessage = await getAIMessage(simulationSession.history, [
        productImageTool, productVideoTool, updateOrderDataTool, checkOrderStatusTool, scheduleDeliveryTool,
      ]);
    }

    const reply = (aiMessage.content || '').trim() || 'Listo 😊';
    simulationSession.history.push({ role: 'assistant', content: reply });

    // En el simulador también se limpia — así ves exactamente lo que vería un cliente real.
    res.json({ ok: true, reply: stripInternalMarkers(reply), media: mediaPreview, orderData: simulationSession.orderData });
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

// ---------- Programación de entregas: recordatorio automático 2 días antes ----------
async function checkScheduledDeliveries() {
  if (!sock) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const [jid, client] of clients.entries()) {
    const sched = client.scheduledDelivery;
    if (!sched || !sched.date || sched.reminderSent) continue;
    const deliveryDate = new Date(sched.date + 'T00:00:00');
    const daysUntil = Math.round((deliveryDate - today) / (24 * 60 * 60 * 1000));
    if (daysUntil !== 2) continue; // se manda exactamente 2 días antes

    try {
      const producto = client.orderData?.producto || 'tu pedido';
      const text = `¡Hola! 😊 Te recuerdo que tu pedido de *${producto}* está programado para el ${sched.date} — ¿confirmas que te lo enviamos?`;
      await sendAndTrack(jid, { text });
      appendChatLog(jid, { from: 'bot', text, type: 'text', timestamp: Date.now() });
      client.scheduledDelivery.reminderSent = true;
      client.scheduledDelivery.reminderSentAt = Date.now();
      clients.set(jid, client);
      saveClients();
      io.emit('log', `📅 Recordatorio de entrega programada enviado a ${jid.split('@')[0]}`);
    } catch (e) {
      console.error('Error enviando recordatorio de entrega programada:', e);
    }
  }
}

setInterval(() => {
  checkScheduledDeliveries().catch((e) => console.error('Error revisando entregas programadas:', e));
}, 60 * 60 * 1000); // revisa cada hora (solo importa el día, no la hora exacta)

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
function getDeepSeekClient(cfg) {
  // DeepSeek habla el mismo formato de la API de OpenAI — solo cambia la
  // URL base y la clave. Se reutiliza el mismo paquete "openai".
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: cfg.deepseekApiKey, baseURL: 'https://api.deepseek.com' });
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
      'Envía la o las fotos reales del producto por WhatsApp. Úsala cuando el cliente pida fotos o cuando pregunte por una intención que tenga una imagen asociada, especialmente modo de uso, cómo se usa, cómo se aplica, instrucciones o aplicación. El parámetro contexto debe describir esa intención para elegir la imagen correcta. Nunca digas que enviaste una foto sin llamar a esta función primero.',
    parameters: {
      type: 'object',
      properties: {
        producto: {
          type: 'string',
          description:
            'Nombre (o parte del nombre) del producto del que el cliente quiere ver fotos. Si solo hay un producto en el catálogo, usa ese nombre.',
        },
        contexto: {
          type: 'string',
          description:
            'Qué está preguntando el cliente en este momento (ej. "precio", "modo de uso", "empaque") — así se manda la foto configurada para ese contexto, si existe. Si no aplica, deja vacío.',
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
      'Guarda o corrige uno o varios datos del cliente para su pedido. Llámala cada vez que el cliente dé o corrija cualquiera de estos datos, aunque sea uno solo a la vez — no esperes a tener todos los datos. Al recopilar datos para una compra, asume domicilio por defecto; NO preguntes primero si quiere domicilio u oficina. Si el cliente menciona oficina o una transportadora, guarda tipoEntrega=oficina y la transportadora y no pidas dirección exacta.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del cliente' },
        telefono: { type: 'string', description: 'Número de teléfono/celular que el cliente escribió (tal cual lo dio)' },
        direccion: { type: 'string', description: 'Dirección completa, con nomenclatura (ej. Carrera 4 #3-40, o Manzana 15 Casa 27)' },
        departamento: { type: 'string', description: 'Departamento de Colombia' },
        ciudad: { type: 'string', description: 'Ciudad o municipio' },
        barrio: { type: 'string', description: 'Barrio (opcional; para domicilio)' },
        transportadora: { type: 'string', description: 'Transportadora y/o oficina/punto de entrega cuando sea entrega en oficina (ej. Interrapidísimo)' },
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

const scheduleDeliveryTool = {
  type: 'function',
  function: {
    name: 'programar_entrega',
    description:
      'Guarda una fecha futura para entregar el pedido, cuando el cliente dice que lo quiere pero para más adelante (ej. "lo quiero pero para el 15", "hasta la próxima semana"). Antes de usarla, ya debes tener guardados con actualizar_datos_pedido todos los datos normales del pedido (nombre, dirección, producto, etc.) — la única diferencia es que no se cierra ahora, sino en la fecha indicada.',
    parameters: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
      },
      required: ['fecha'],
    },
  },
};

// Cuando la IA llama actualizar_datos_pedido: solo actualiza los campos que
// vinieron con valor (no borra los demás), y avanza el tipo de entrega si
// vino. Devuelve un texto para que la IA sepa qué le falta todavía.
function handleUpdateOrderData(jid, args) {
  ensureClientRecord(jid);
  const client = clients.get(jid);
  const incoming = { ...args };

  // Detecta automáticamente oficina/transportadora, incluso con errores de escritura.
  const officeCarrier = detectOfficeTransportadora([incoming.tipoEntrega, incoming.transportadora, incoming.direccion, incoming.barrio, incoming.ciudad].filter(Boolean).join(' '));
  if (officeCarrier) {
    incoming.tipoEntrega = 'oficina';
    incoming.transportadora = incoming.transportadora || officeCarrier;
    // Una transportadora mencionada explícitamente es suficiente para considerar oficina.
    incoming.direccion = undefined;
  } else if (incoming.tipoEntrega) {
    const t = normalizeColombiaText(incoming.tipoEntrega);
    if (t.includes('oficina')) incoming.tipoEntrega = 'oficina';
    if (t.includes('domicilio') || t.includes('casa')) incoming.tipoEntrega = 'domicilio';
  }

  // Validación estricta: nunca guardamos una ciudad que no exista en colombia.json.
  const city = incoming.ciudad !== undefined ? String(incoming.ciudad).trim() : client.orderData.ciudad;
  const dept = incoming.departamento !== undefined ? String(incoming.departamento).trim() : client.orderData.departamento;
  if (city) {
    const validation = validateAndNormalizeLocation(city, dept);
    if (!validation.ok) {
      return `UBICACION_NO_VALIDADA: ${validation.reason} No guardé la ciudad. Pide al cliente el nombre exacto de la ciudad/municipio y, si hace falta, el departamento hasta encontrar una combinación válida en colombia.json.`;
    }
    incoming.ciudad = validation.city;
    incoming.departamento = validation.department;
  } else if (dept && !isValidDepartment(dept)) {
    return `UBICACION_NO_VALIDADA: El departamento "${dept}" no aparece en colombia.json. No lo guardé. Pide al cliente el nombre exacto del departamento.`;
  }

  const fields = ['nombre', 'telefono', 'direccion', 'departamento', 'ciudad', 'barrio', 'transportadora', 'producto', 'cantidad', 'tipoEntrega'];
  fields.forEach((f) => {
    if (incoming[f] !== undefined && incoming[f] !== null && String(incoming[f]).trim() !== '') {
      client.orderData[f] = String(incoming[f]).trim();
    }
  });
  if (client.orderData.tipoEntrega === 'oficina') client.orderData.direccion = '';
  if (incoming.producto) {
    const product = findProductByQuery(incoming.producto);
    if (product) client.activeProductId = product.id;
  }
  if (incoming.nombre) client.name = client.orderData.nombre;
  clients.set(jid, client);
  saveClients();
  io.emit('clientUpdate', { jid, client });
  return `Datos guardados. ${describeMissingOrderFields(client.orderData)}`;
}

function describeMissingOrderFields(orderData) {
  const required = orderData.tipoEntrega === 'oficina'
    ? ['nombre', 'ciudad', 'departamento', 'telefono', 'transportadora', 'producto', 'cantidad', 'tipoEntrega']
    : ['nombre', 'direccion', 'ciudad', 'departamento', 'telefono', 'producto', 'cantidad', 'tipoEntrega'];
  const missing = required.filter((f) => !orderData[f]);
  return missing.length === 0
    ? 'Ya están todos los datos necesarios completos.'
    : `Todavía faltan: ${missing.join(', ')}.`;
}

// Cuando la IA llama consultar_estado_pedido: busca de verdad en Pedidos,
// Guarda la fecha de entrega programada — el pedido no se cierra ahora, se
// deja para que el sistema le pregunte al cliente unos días antes.
function handleScheduleDelivery(jid, args) {
  ensureClientRecord(jid);
  const client = clients.get(jid);
  const rawDate = String(args?.fecha || '').trim();

  // La fecha debe ser una fecha ISO válida y futura. No crea ninguna orden.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return 'No pude programar la entrega porque la fecha no está en formato YYYY-MM-DD. No cierres el pedido todavía; pide/aclara la fecha y vuelve a intentarlo.';
  }

  const scheduledDate = new Date(`${rawDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(scheduledDate.getTime()) || scheduledDate < today) {
    return `La fecha ${rawDate} ya pasó o no es válida. Pide una fecha futura y no cierres el pedido todavía.`;
  }

  client.scheduledDelivery = { date: rawDate, reminderSent: false, reminderSentAt: null };
  clients.set(jid, client);
  saveClients();
  updateClientStatus(jid, 'programado', {});
  io.emit('clientUpdate', { jid, client });
  return `Entrega programada para el ${rawDate}. NO se creó ninguna orden todavía. El sistema le va a preguntar al cliente dos días antes si confirma.`;
}

// por número de orden si lo dio, o si no, el pedido más reciente de este
// cliente. Nunca inventa el estado.
async function handleCheckOrderStatus(jid, args) {
  let order = null;
  if (args.numeroOrden) {
    // Acepta "ORD-0007", "0007", "7", con o sin ceros a la izquierda — la
    // gente casi nunca escribe el "ORD-" completo al preguntar.
    const raw = String(args.numeroOrden).trim().toLowerCase();
    const digitsOnly = raw.replace(/\D/g, '').replace(/^0+/, '');
    order = orders.find((o) => {
      const idLower = o.id.toLowerCase();
      const idDigits = idLower.replace(/\D/g, '').replace(/^0+/, '');
      return idLower === raw || idLower === `ord-${raw}` || (digitsOnly && idDigits === digitsOnly);
    });
  }
  if (!order) {
    const clientOrders = orders.filter((o) => o.clientJid === jid).sort((a, b) => b.createdAt - a.createdAt);
    order = clientOrders[0] || null;
  }
  if (!order) return 'Este cliente no tiene ningún pedido registrado todavía.';

  // Si el pedido ya está en Dropi, se consulta el estado REAL antes de
  // responder — si falla por cualquier motivo, se usa el que ya teníamos
  // guardado nosotros, para no dejar al cliente sin respuesta.
  if (order.dropiOrderId) {
    try {
      await checkDropiOrderStatus(order.id);
      order = orders.find((o) => o.id === order.id); // recargar con el estado actualizado
    } catch (e) {
      console.error('No se pudo refrescar el estado de Dropi:', e);
    }
  }

  const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;
  return `Pedido ${order.id}: producto "${order.product}", estado actual: ${statusLabel}.${order.transportadora ? ` Transportadora: ${order.transportadora}.` : ''}`;
}

// Genera y manda una respuesta de la IA para un cliente, asumiendo que su
// historial (conversations) ya tiene el turno más reciente listo — se usa
// tanto para "Activar bot (re-disparar último mensaje)" como para "Activar
// asistente de un producto" desde el panel derecho. Es básicamente el mismo
// flujo que corre automáticamente en processMessage, pero disparado a mano.
// Ejecuta el ciclo completo de herramientas de la IA: la deja llamar
// funciones las veces que necesite seguidas (no solo una vez) hasta que ya
// no pida ninguna más — antes, después de la primera ronda de herramientas,
// se le quitaba el acceso a ellas en la segunda llamada, y si intentaba usar
// otra (algo común cuando el cliente da varios datos juntos), Groq/OpenAI
// tronaba con "Tool choice is none, but model called a tool" y el bot se
// quedaba mudo. Con el límite de 5 vueltas se evita un ciclo infinito si algo
// sale mal.
// Quita las frases "señal interna" (como la de intervención humana) antes de
// mandar o guardar el texto que sí ve el cliente — la IA las incluye a
// propósito para que nuestro sistema las detecte, pero nunca deben llegar a
// WhatsApp tal cual.
function stripInternalMarkers(text) {
  return (text || '')
    .replace(/🆘\s*NECESITA INTERVENCIÓN HUMANA\s*🆘/g, '')
    .replace(/⚠️\s*INTENTO DE CANCELACIÓN\s*⚠️/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function runToolLoop(userId, history, turnText = '') {
  const tools = getToolsForTurn(userId, turnText);
  let aiMessage = await getAIMessage(history, tools.length ? tools : null);
  let rounds = 0;

  while (aiMessage.tool_calls && aiMessage.tool_calls.length > 0 && rounds < 5) {
    rounds += 1;
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
        const sent = await sendProductImages(userId, product, args.contexto);
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
        resultText = await handleCheckOrderStatus(userId, args);
      } else if (toolCall.function.name === 'programar_entrega') {
        resultText = handleScheduleDelivery(userId, args);
      } else {
        // El modelo inventó el nombre de una función que no existe — se le
        // avisa así, en vez de dejarlo sin respuesta, para que siga con
        // texto normal en la siguiente vuelta.
        resultText = 'Esa función no existe. Responde con texto normal, usando la frase obligatoria si corresponde.';
      }

      history.push({ role: 'tool', tool_call_id: toolCall.id, content: resultText });
    }

    aiMessage = await getAIMessage(history, tools.length ? tools : null);
  }

  return aiMessage;
}

async function generateAndSendReply(userId) {
  const cfg = readConfig();
  const history = conversations.get(userId);
  if (!history) throw new Error('No hay conversación con este cliente todavía');

  const lastUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const aiMessage = await runToolLoop(userId, history, lastUserMessage);

  const reply = (aiMessage.content || '').trim() || 'Listo 😊';
  history.push({ role: 'assistant', content: reply });
  saveConversations();

  // El cliente nunca debe ver las frases "señal interna" (como la de
  // intervención humana) — se usan para que nuestro sistema las detecte,
  // pero se limpian del texto que de verdad se manda/guarda como visto.
  let clientReply = stripInternalMarkers(reply);
  // Refuerzo visual: el precio ACTUAL debe llegar en negrita de WhatsApp.
  clientReply = clientReply.replace(/(Hoy\s+está\s+en\s+descuento:\s*)(?!\*)(\$?[\d.,]+)/gi, '$1*$2*');

  const isOrderConfirmation = reply.includes('ORDEN DE COMPRA REGISTRADA');
  const voiceMode = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
  const minimaxReady = cfg.minimaxApiKey && cfg.minimaxGroupId && cfg.minimaxVoiceId;
  const shouldReplyWithVoice = !isOrderConfirmation && minimaxReady && voiceMode === 'voice';

  if (shouldReplyWithVoice) {
    try {
      const oggFilename = await sendVoiceReply(userId, clientReply);
      appendChatLog(userId, { from: 'bot', text: clientReply, type: 'voice', mediaUrl: `/media/${oggFilename}`, timestamp: Date.now() });
    } catch (err) {
      console.error('Error generando audio con MiniMax, se responde en texto:', err);
      await sendAndTrack(userId, { text: clientReply });
      appendChatLog(userId, { from: 'bot', text: clientReply, type: 'text', timestamp: Date.now() });
    }
  } else {
    await sendAndTrack(userId, { text: clientReply });
    appendChatLog(userId, { from: 'bot', text: clientReply, type: 'text', timestamp: Date.now() });
  }

  await handlePostReplyMarkers(userId, reply, cfg, lastUserMessage);

  return reply;
}

// Una confirmación programada debe ser inequívoca. No basta con que la IA
// emita el marcador de cierre: el servidor exige que el mensaje actual del
// cliente confirme que sí quiere que se envíe el pedido programado.
function isExplicitScheduledConfirmation(text) {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return false;
  if (/\b(no|todavia no|aun no|ya no|cambie de opinion|cambie de idea|cancel|cancelo|cancelar)\b/.test(t)) return false;

  // Respuestas cortas y afirmativas: "sí", "claro", "confirmo", "dale", etc.
  if (/^(si|claro|confirmo|confirmado|dale|listo|ok|okay|de acuerdo|por supuesto|adelante|envialo|mandalo|envienlo|mandenlo|si quiero|claro que si|si por favor)$/.test(t)) {
    return true;
  }

  // Confirmaciones con una instrucción explícita de envío.
  return /\b(si|claro|confirmo|de acuerdo|por supuesto|adelante)\b.*\b(envia|enviar|envien|enviamelo|mandalo|manden|mandenlo|quiero que lo envien|pueden enviarlo)\b/.test(t)
    || /\b(envia|envien|enviamelo|mandalo|mandenlo|pueden enviarlo)\b.*\b(si|claro|confirmo|de acuerdo|por supuesto)\b/.test(t);
}

// Maneja lo que pasa DESPUÉS de mandar la respuesta, según las frases
// internas que la IA haya incluido (venta cerrada, intento de cancelación,
// intervención humana necesaria) — se usa tanto en el flujo real de
// WhatsApp como en "Activar bot" desde el panel.
async function handlePostReplyMarkers(userId, reply, cfg, currentUserText = '') {
  if (reply.includes('ORDEN DE COMPRA REGISTRADA')) {
    const client = clients.get(userId);
    const scheduled = client?.scheduledDelivery;
    const hasScheduledDelivery = !!scheduled?.date;
    const waitingScheduledConfirmation = !!(hasScheduledDelivery && scheduled.reminderSent !== true);

    // SEGURIDAD: una venta programada NO es todavía una orden de compra.
    // Mientras el recordatorio de 2 días antes no haya sido enviado, cualquier
    // marcador accidental de cierre queda bloqueado.
    if (waitingScheduledConfirmation) {
      updateClientStatus(userId, 'programado', { lastOrderSummary: reply });
      io.emit('log', `📅 Cierre bloqueado: ${userId} tiene entrega programada para ${scheduled.date} y todavía no recibió el recordatorio`);
      return;
    }

    // SEGURIDAD 2: incluso después del recordatorio, la orden SOLO se puede
    // crear si el mensaje actual del cliente contiene una confirmación
    // afirmativa clara. Así una pregunta posterior, un dato adicional o una
    // respuesta ambigua nunca convierten por accidente la programación en una
    // compra real.
    if (hasScheduledDelivery && !isExplicitScheduledConfirmation(currentUserText)) {
      updateClientStatus(userId, 'programado', { lastOrderSummary: reply });
      io.emit('log', `📅 Cierre bloqueado: ${userId} tiene entrega programada para ${scheduled.date} pero no hubo confirmación afirmativa clara`);
      return;
    }

    if (cfg.notificationPhoneNumber) {
      try {
        await notifyOwnerOfSale(cfg, userId, reply);
      } catch (err) {
        console.error('Error notificando la venta:', err);
      }
    }

    const name = extractNameFromOrderText(reply);
    updateClientStatus(userId, 'comprado', { lastOrderSummary: reply, ...(name ? { name } : {}) });
    const createdOrder = await autoCreateOrderFromSummary(userId, clients.get(userId), reply);

    // Una vez confirmada y convertida en orden real, la programación deja
    // de estar pendiente para que no vuelva a disparar recordatorios.
    if (createdOrder && clients.has(userId)) {
      const updatedClient = clients.get(userId);
      updatedClient.scheduledDelivery = null;
      clients.set(userId, updatedClient);
      saveClients();
      io.emit('clientUpdate', { jid: userId, client: updatedClient });
    }
  }

  // ---- Cancelación en dos pasos: primero se intenta retener, solo se avisa si insiste ----
  const clientBeforeThisReply = clients.get(userId);
  const wasAlreadyAttemptingCancel = clientBeforeThisReply?.status === 'intento_cancelacion';

  if (reply.includes('INTENTO DE CANCELACIÓN')) {
    updateClientStatus(userId, 'intento_cancelacion', {});
    const activeOrder = orders.find((o) => o.clientJid === userId && !['entregado', 'devuelto', 'cancelado'].includes(o.status));
    if (activeOrder) updateOrder(activeOrder.id, { status: 'intento_cancelacion' });
  }

  if (reply.includes('NECESITA INTERVENCIÓN HUMANA')) {
    if (cfg.notificationPhoneNumber) {
      try {
        await notifyOwnerOfIntervention(cfg, userId, reply, wasAlreadyAttemptingCancel);
      } catch (err) {
        console.error('Error notificando la intervención:', err);
      }
    }
    const minutes = Number(cfg.pauseDurationMinutes) || DEFAULT_PAUSE_MINUTES;
    pauseChat(userId, minutes);
  }
}

function findProductByQuery(query) {
  const products = readProducts();
  if (!query) return products.length === 1 ? products[0] : null;
  const q = String(query).toLowerCase().trim();
  let match = products.find((p) => p.name && p.name.toLowerCase().includes(q));
  if (match) return match;
  match = products.find((p) => (p.keywords || []).some((k) => q.includes(String(k).toLowerCase()) || String(k).toLowerCase().includes(q)));
  if (match) return match;
  return products.length === 1 ? products[0] : null;
}

// Detecta producto SOLO cuando el mensaje realmente contiene el nombre o una
// palabra clave configurada. No usa el antiguo fallback de "si hay uno solo",
// porque un simple "hola" no debe activar un asistente de producto.
function detectProductFromText(text) {
  const products = readProducts();
  const q = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const name = String(p.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (name && q.includes(name)) {
      const score = 1000 + name.length;
      if (score > bestScore) { best = p; bestScore = score; }
    }
    for (const keyword of (p.keywords || [])) {
      const k = String(keyword || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      if (k && q.includes(k)) {
        const score = 100 + k.length;
        if (score > bestScore) { best = p; bestScore = score; }
      }
    }
  }
  return best;
}

function activateProductFromMessage(jid, text) {
  if (!jid) return null;
  const product = detectProductFromText(text);
  if (!product) return null;
  ensureClientRecord(jid);
  const client = clients.get(jid);
  client.activeProductId = product.id;
  if (!client.orderData) client.orderData = {};
  client.orderData.producto = product.name;
  clients.set(jid, client);
  saveClients();
  return product;
}

function getActiveProduct(jid, overrideOrderData) {
  const products = readProducts();
  const client = jid ? clients.get(jid) : null;
  const activeId = client?.activeProductId;
  if (activeId) {
    const active = products.find((p) => p.id === activeId);
    if (active) return active;
  }
  const orderData = overrideOrderData || client?.orderData || {};
  return orderData.producto ? findProductByQuery(orderData.producto) : null;
}

function getToolsForTurn(userId, text) {
  const t = String(text || '').toLowerCase();
  const client = clients.get(userId);
  const orderData = client?.orderData || {};
  const tools = [];

  const asksImage = /(foto|fotos|imagen|imagenes|imágenes|cómo se ve|como se ve|verlo|verla|ver el producto|mu[eé]strame|mostrar|cat[aá]logo|modo de uso|como se usa|cómo se usa|como se aplica|cómo se aplica|aplicacion|aplicación|instrucciones)/i.test(t);
  const asksVideo = /(video|demostraci[oó]n|c[oó]mo funciona|como funciona|mu[eé]strame.*video|tienes.*video)/i.test(t);
  // El estado debe activar la herramienta ante cualquier forma razonable de
  // preguntar por un pedido ya realizado. Se mantiene deliberadamente amplia
  // porque la instrucción del prompt exige consultar SIEMPRE en ese caso.
  const asksStatus = /(pedido|orden|env[ií]o|gu[ií]a|seguimiento|transportadora|paquete|domicilio)/i.test(t)
    && /(estado|llega|llegar[aá]?|lleg[oó]|d[oó]nde|va|viene|rastre|seguimiento|gu[ií]a|revisa|revisar|ya est[aá]|cu[aá]ndo|cuando|recib)/i.test(t);
  const asksSchedule = /(para el|para la|el d[ií]a|la pr[oó]xima semana|la otra semana|m[aá]s adelante|despu[eé]s|despues|fecha|fecha especial|tal d[ií]a)/i.test(t);
  // Detecta datos por patrones además de palabras guía. Esto evita perder
  // actualizaciones cuando el cliente escribe, por ejemplo, solo un nombre
  // y un celular en una misma línea.
  const hasPhone = /(?:\+?57\s*)?3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(t);
  const hasAddress = /\b(?:cra|cr|carrera|cll|calle|av|avenida|transversal|transv|diag|diagonal|mz|manzana|supermanzana)\b.{0,35}\d/i.test(t);
  const hasKnownLocationWord = /(municipio|departamento|barrio|villavicencio|cumaral|paratebueno|bogot[aá]|medell[ií]n|cali|neiva|ibagu[eé]|yopal|acac[ií]as|granada|restrepo|puerto l[oó]pez|san mart[ií]n)/i.test(t);
  const givesOrderData = hasPhone || hasAddress || hasKnownLocationWord || /(me llamo|mi nombre|soy |celular|tel[eé]fono|direcci[oó]n|carrera|calle|manzana|barrio|vivo en|municipio|departamento|quiero comprar|me lo llevo|env[ií]ame|envíame|para domicilio|oficina|cantidad|unidades?)/i.test(t);

  if (asksImage) tools.push(productImageTool);
  if (asksVideo) tools.push(productVideoTool);
  if (asksStatus) tools.push(checkOrderStatusTool);
  if (asksSchedule) tools.push(scheduleDeliveryTool);
  if (givesOrderData || orderData.producto || orderData.nombre || orderData.telefono || orderData.direccion) {
    tools.push(updateOrderDataTool);
  }

  return tools;
}

// Cada imagen de un producto puede tener su propia "regla" de cuándo
// enviarla (ej. "cuando pregunte el precio"). Esto elige cuáles mandar según
// lo que el cliente está preguntando en este momento — si ninguna regla
// coincide, usa las que no tienen regla (generales); si tampoco hay
// generales, manda todas (compatibilidad con productos viejos).
function normalizeProductImages(product) {
  return (product?.images || []).map((img) => (typeof img === 'string' ? { url: img, rule: '' } : img));
}
function findBestMatchingImages(product, contexto) {
  const images = normalizeProductImages(product);
  if (images.length === 0) return [];
  if (!contexto) {
    const general = images.filter((i) => !i.rule);
    return general.length > 0 ? general : images;
  }
  const contextoLower = normalizeColombiaText(contexto);
  const aliases = contextoLower.includes('modo de uso') || contextoLower.includes('como se usa') || contextoLower.includes('como se aplica') || contextoLower.includes('aplicacion') || contextoLower.includes('instrucciones')
    ? ['modo de uso', 'como se usa', 'como se aplica', 'aplicacion', 'instrucciones', 'uso']
    : contextoLower.split(' ').filter(Boolean);
  const matching = images.filter((i) => {
    const rule = normalizeColombiaText(i.rule);
    if (!rule) return false;
    const ruleParts = rule.split(',').map((x) => x.trim()).filter(Boolean);
    return ruleParts.some((part) => contextoLower.includes(part) || aliases.some((a) => part.includes(a) || a.includes(part)));
  });
  if (matching.length > 0) return matching;
  const general = images.filter((i) => !i.rule);
  return general.length > 0 ? general : images;
}

async function sendProductImages(userId, product, contexto) {
  const images = findBestMatchingImages(product, contexto);
  if (images.length === 0) return false;
  for (const img of images) {
    const imgPath = path.join(__dirname, img.url.replace(/^\//, ''));
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

// Baileys, en algunos casos, no logra calcular solo la duración del audio
// (el campo "seconds") — y confirmamos que esto es justo lo que hace que
// WhatsApp en Android rechace la nota de voz con "no se pudo descargar el
// audio" (es un bug documentado del propio Baileys, no algo que dependa de
// cómo convertimos el archivo). La solución real es calcular la duración
// nosotros mismos y mandársela explícita, en vez de dejar que él adivine.
function getAudioDurationSeconds(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata?.format?.duration) {
        console.warn('⚠️ No se pudo calcular la duración real del audio con ffprobe, se usará 1 segundo de respaldo:', err?.message || 'sin duración en los metadatos');
        resolve(1); // mejor un valor de respaldo que dejar el campo vacío
        return;
      }
      resolve(Math.max(1, Math.round(metadata.format.duration)));
    });
  });
}

async function sendVoiceReply(userId, text) {
  const cfg = readConfig();
  const speechText = prepareTextForSpeech(text);
  const audioBuffer = await minimaxTextToSpeech(cfg, speechText);
  const mp3Path = path.join(TMP_DIR, `voice-reply-${Date.now()}.mp3`);
  // El ogg final queda en MEDIA_DIR (no en TMP_DIR) para poder reproducirlo
  // también desde el panel — antes solo se mandaba por WhatsApp y se borraba,
  // así que en Chats se veía como texto plano, sin poder escucharlo ahí.
  const oggFilename = `voice-bot-${Date.now()}.ogg`;
  const oggPath = path.join(MEDIA_DIR, oggFilename);
  fs.writeFileSync(mp3Path, audioBuffer);
  try {
    // WhatsApp exige que las notas de voz vengan en OGG/Opus. MiniMax nos da
    // MP3, así que hay que convertirlo antes — si no, WhatsApp recibe el
    // archivo pero no lo puede reproducir ("no se pudo descargar el audio").
    await convertMp3ToOggOpus(mp3Path, oggPath);
    const oggBuffer = fs.readFileSync(oggPath);
    assertValidAudioFile(oggPath);
    const seconds = await getAudioDurationSeconds(oggPath);
    // ptt: true hace que llegue como nota de voz (con el ícono de
    // micrófono), no como un archivo de audio adjunto normal. "seconds"
    // explícito es la parte que corrige el bug de Android.
    await sendAndTrack(userId, { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds });
    return oggFilename;
  } finally {
    fs.unlink(mp3Path, () => {});
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

async function notifyOwnerOfIntervention(cfg, clientUserId, reply, isCancellationInsisted) {
  const title = isCancellationInsisted
    ? '🆘 *Intervención necesaria — el cliente insiste en cancelar su pedido*'
    : '🆘 *Este chat necesita intervención humana*';
  await notifyOwner(cfg, clientUserId, title, reply);
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
        max_completion_tokens: 400, // los modelos nuevos de OpenAI ya no aceptan "max_tokens"
        model: cfg.openaiModel || 'gpt-4o-mini',
      });
      return completion.choices[0].message;
    }

    if (cfg.aiProvider === 'deepseek') {
      const deepseek = getDeepSeekClient(cfg);
      const completion = await deepseek.chat.completions.create({
        ...payload,
        max_tokens: 400, // DeepSeek usa el nombre clásico, igual que Groq
        model: cfg.deepseekModel || 'deepseek-v4-flash',
      });
      return completion.choices[0].message;
    }

    const groq = getGroqClient(cfg);
    const completion = await groq.chat.completions.create({
      ...payload,
      max_tokens: 400, // Groq sí usa el nombre clásico
      model: cfg.groqModel || 'llama-3.1-8b-instant',
    });
    return completion.choices[0].message;
  } catch (err) {
    const isRateLimit = err?.status === 429;
    // Falla conocida de algunos modelos "gpt-oss" en Groq: a veces pegan un
    // trozo de su formato interno (ej. "<|channel|>commentary") al nombre de
    // la función que intentan llamar, y Groq rechaza la petición completa
    // porque el nombre ya no coincide con ninguna herramienta real. Un
    // reintento casi siempre lo resuelve, así que no vale la pena rendirse
    // de una con el mensaje de "problema técnico".
    const errorText = JSON.stringify(err?.error || err?.message || '');
    const isCorruptedToolCall = errorText.includes('tool_use_failed') || errorText.includes('<|channel|>');
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
    if (isCorruptedToolCall && attempt < MAX_ATTEMPTS) {
      io.emit('log', `⚠️ El modelo mandó una herramienta con el nombre corrupto, reintentando (intento ${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(1000);
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
    // DeepSeek no ofrece transcripción de audio propia — si está seleccionado
    // como proveedor de chat, se usa Groq (gratis) o OpenAI (lo que tengas
    // configurado) solo para esta parte, sin que tengas que hacer nada.
    if (cfg.aiProvider === 'deepseek') {
      if (cfg.groqApiKey) {
        const groq = getGroqClient(cfg);
        const result = await groq.audio.transcriptions.create({
          file: fs.createReadStream(tmpPath),
          model: 'whisper-large-v3-turbo',
          language: 'es',
        });
        return (result.text || '').trim();
      }
      if (cfg.openaiApiKey) {
        const openai = getOpenAIClient(cfg);
        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpPath),
          model: 'whisper-1',
          language: 'es',
        });
        return (result.text || '').trim();
      }
      throw new Error('DeepSeek no transcribe audio — agrega también tu clave de Groq u OpenAI en Configuración para poder recibir notas de voz.');
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

const DEFAULT_SELLER_MODE_PROMPT = `
MODO VENDEDOR — ASESORA COMERCIAL INFORMATIVA:
Tu estilo NO es el de una vendedora agresiva. Eres una asesora comercial que informa con claridad, genera confianza y facilita la compra cuando el cliente realmente quiere comprar.
1. Si el cliente pide información de un producto concreto, puedes dar el precio desde el primer mensaje; no escondas el precio ni obligues al cliente a responder varias preguntas antes de conocerlo.
2. Cuando informes el precio, respeta SIEMPRE el formato obligatorio de precio del sistema: precio anterior tachado + precio actual en descuento en negrita de WhatsApp + envío gratis/pago contra entrega cuando corresponda.
3. Después del precio, entrega solo una explicación útil y breve (por ejemplo, para qué sirve, cómo funciona o un beneficio real) y haz una pregunta sencilla para saber qué quiere conocer o para avanzar.
4. No conviertas cada respuesta en un cierre de venta. Vende mediante información útil, confianza y una conversación natural.
5. No repitas el precio si el cliente no lo está preguntando y ya lo conoce, salvo que sea útil para resolver una objeción o cerrar.
6. Cuando el cliente muestre intención clara de compra (por ejemplo: "lo quiero", "me lo llevo", "quiero pedirlo", "cómo hago para comprar"), deja de explicar de más y pasa a recopilar los datos necesarios del pedido.
7. Al iniciar la recopilación de datos NO preguntes "¿domicilio u oficina?". Asume domicilio por defecto. Si el cliente menciona oficina o una transportadora, detecta automáticamente entrega en oficina y continúa con los datos correspondientes.
8. Si el cliente entrega varios datos juntos, reconócelos todos y guárdalos; no vuelvas a preguntarlos por separado.
9. Descubre la necesidad cuando sea útil y relaciona la necesidad con beneficios que realmente estén escritos en el producto; nunca inventes.
10. No descargues toda la información de golpe: responde exactamente a lo que pregunta y añade solo lo que ayude a decidir.
11. Ante una objeción, responde con empatía y resuelve la duda antes de intentar cerrar.
12. Si existe una oferta por cantidad configurada para el producto, úsala como oportunidad comercial sin ocultar el precio de una unidad y mostrando el ahorro real.
13. Si el cliente no está listo, conserva una conversación natural; no fuerces el cierre.
14. Después de una respuesta de valor, cuando corresponda, termina con una pregunta corta y natural que haga avanzar la conversación.
15. Nunca inventes urgencia, escasez, testimonios, descuentos, resultados ni políticas.
16. Las reglas obligatorias del prompt general, precios, pedidos, herramientas, cancelaciones e intervención humana tienen prioridad sobre esta capa.
`;

function getProductSaleMode(product) {
  const mode = String(product?.saleMode || product?.salesMode || product?.assistantMode || product?.modoVenta || '').toLowerCase().trim();
  if (['prompt', 'con prompt', 'custom', 'specific', 'especifico', 'específico'].includes(mode)) return 'prompt';
  return 'general';
}

function buildSystemPrompt(jid, overrideOrderData) {
  const cfg = readConfig();
  const products = readProducts();

  // overrideOrderData se usa solo desde el simulador de pruebas — así puede
  // reutilizar este mismo prompt sin tocar ningún cliente real.
  const client = jid ? clients.get(jid) : null;
  const orderData = overrideOrderData || client?.orderData || {};
  
  // ---- Agente general + asistente de producto ----
  // En modo general solo se envían nombres y precios. Cuando el cliente
  // menciona un producto, se activa su contexto completo. Esto evita pagar
  // por los detalles largos de productos que no están siendo consultados.
  const interestedProduct = getActiveProduct(jid, overrideOrderData);

  const catalog = products
    .map((p) => {
      const priceLine =
        p.priceBefore && p.priceAfter
          ? `Precio: antes ${p.priceBefore}, HOY EN DESCUENTO a ${p.priceAfter}`
          : `Precio: ${p.priceAfter || p.priceBefore || 'consultar'}`;

      if (!interestedProduct || interestedProduct.id !== p.id) {
        return `- ${p.name} | ${priceLine}`;
      }

      const videoLine = p.video ? '  Tiene video disponible: SÍ' : '  Tiene video disponible: NO';
      const firstContactLine = p.firstContactEnabled ? `\n  PRIMER CONTACTO DEL PRODUCTO: ACTIVO | Pasos configurados: ${(p.firstContactSequence || []).length}` : '';
      const priceRuleLine = p.priceBefore && p.priceAfter
        ? `\n  PRECIO OBLIGATORIO AL MENCIONARLO: 🔥 ~~ANTES: ${p.priceBefore}~~ | 🎉 Hoy está en descuento: *${p.priceAfter}* | 🚚 Envío GRATIS + 💵 pago CONTRA ENTREGA.`
        : '';
      const offersLine =
        p.quantityOffers && p.quantityOffers.length > 0
          ? `\n  OFERTA POR CANTIDAD ACTIVA: ${p.quantityOffers.map((o) => `${o.quantity} unidad${o.quantity > 1 ? 'es' : ''} por ${o.price}`).join(' / ')}`
          : '';
      const productAssistantPrompt = p.sellerModeEnabled && getProductSaleMode(p) === 'prompt' && p.assistantPrompt
        ? `\n  MODO VENDEDOR CON PROMPT PERSONALIZADO: SÍ`
        : `\n  MODO VENDEDOR: ${p.sellerModeEnabled ? 'ACTIVO' : 'INACTIVO'}`;
      return `- ${p.name} | ${priceLine}${priceRuleLine}\n  Detalle: ${p.details || '(sin detalle adicional)' }\n${videoLine}${offersLine}${firstContactLine}${productAssistantPrompt}`;
    })
    .join('\n');

  const catalogNote = interestedProduct
    ? `\n(ASISTENTE DE PRODUCTO ACTIVO: ${interestedProduct.name}. Usa el detalle completo SOLO de este producto. Si el cliente cambia a otro producto, cambia de contexto y usa únicamente la información del nuevo producto.)`
    : `\n(MODO AGENTE GENERAL: todavía no hay un producto activo. Solo tienes nombres y precios para identificar el catálogo. No inventes características ni detalles; cuando el cliente muestre interés claro por un producto, trabaja con el contexto de ese producto.)`;

  const anyProductHasOffers = products.some((p) => p.quantityOffers && p.quantityOffers.length > 0);
  const offersInstructions = anyProductHasOffers
    ? `Si el producto del que hablas TIENE "OFERTA POR CANTIDAD ACTIVA" en el catálogo, cuando informes el precio menciona también las opciones de más unidades, resaltando el ahorro (ej. "1 unidad: $79.900 🔥 Llévate 2 por $140.000 y ahorras $19.800"). Si no tiene oferta activa, informa solo el precio normal de 1 unidad, como siempre.`
    : '';

  const fichaLines = [
    `Nombre: ${orderData.nombre || '(falta)'}`,
    `Teléfono: ${orderData.telefono || '(falta)'}`,
    `Tipo de entrega: ${orderData.tipoEntrega || '(falta — asume domicilio si no se menciona oficina)'}`,
    orderData.tipoEntrega === 'oficina' ? `Transportadora/oficina: ${orderData.transportadora || '(falta)'}` : null,
    orderData.tipoEntrega !== 'oficina' ? `Dirección: ${orderData.direccion || '(falta)'}` : null,
    `Ciudad: ${orderData.ciudad || '(falta)'}`,
    `Departamento: ${orderData.departamento || '(falta)'}`,
    orderData.barrio ? `Barrio: ${orderData.barrio}` : null,
    `Producto: ${orderData.producto || '(falta)'}`,
    `Cantidad: ${orderData.cantidad || '(falta)'}`,
    client?.scheduledDelivery ? `Entrega programada para: ${client.scheduledDelivery.date}${client.scheduledDelivery.reminderSent ? ' (ya se le mandó el recordatorio de confirmación — si el cliente confirma que sí, cierra el pedido ahora con la frase obligatoria, ya tienes todos los datos)' : ''}` : null,
  ].filter(Boolean).join('\n');

  const confirmBeforeClosing = !!cfg.confirmOrderDataBeforeClosing;

  return `
Eres ${cfg.assistantName}, asistente virtual de ventas de ${cfg.companyName}, atendiendo por WhatsApp.

${cfg.baseInstructions}

${interestedProduct && interestedProduct.sellerModeEnabled ? DEFAULT_SELLER_MODE_PROMPT : ''}
${interestedProduct && interestedProduct.sellerModeEnabled && getProductSaleMode(interestedProduct) === 'prompt' && interestedProduct.assistantPrompt ? `\nINSTRUCCIONES ESPECÍFICAS DE VENTA PARA ESTE PRODUCTO:\n${interestedProduct.assistantPrompt}` : ''}

REGLA DE PRECIO Y OFERTA — OBLIGATORIA:
Cuando el producto activo tenga precio anterior Y precio actual, SIEMPRE presenta primero el precio anterior tachado y después el precio actual como descuento. Nunca respondas solo con el precio actual. Usa este formato o uno visualmente equivalente:
🔥 ~~ANTES: [PRECIO ANTERIOR]~~
🎉 Hoy está en descuento: *[PRECIO ACTUAL]*
🚚 Envío GRATIS + 💵 pago CONTRA ENTREGA.
Después termina normalmente con una pregunta que impulse la conversación de compra. Si existe oferta por cantidad configurada, presenta también esa opción y el ahorro cuando sea posible. NUNCA inventes “solo por hoy”, “tiempo limitado”, “últimas unidades” o cualquier urgencia si no está configurada en el producto.

REGLA DE OBJECIONES DE PRECIO Y ALTERNATIVAS — OBLIGATORIA:
Si el cliente dice que el producto está caro, que no le alcanza, que busca algo más económico o pide una opción de menor presupuesto, NO muestres productos al azar del catálogo. Primero intenta resolver la objeción con el MISMO producto: si tiene una oferta por cantidad configurada, puedes mostrarla; si no tiene una alternativa más económica configurada para ese mismo producto, dilo con naturalidad y ofrece dejarle la información para después. SOLO puedes recomendar otro producto si la información del catálogo o del prompt específico de ese producto indica claramente que sirve para la MISMA necesidad del cliente y es una alternativa real para ese caso. Nunca recomiendes otro producto únicamente porque es más barato, y jamás menciones productos que no tengan relación con la necesidad que el cliente acaba de expresar. Por ejemplo, si pregunta por un serum para una necesidad de piel, no ofrezcas un tapete masajeador ni un producto para otra parte del cuerpo solo porque aparecen en el catálogo. Si no existe una alternativa relacionada y más económica, no inventes una.

REGLA DE RESPUESTAS NUMÉRICAS — OBLIGATORIA:
Si el cliente responde con un número (por ejemplo, "1", "2" o "3"), NO lo interpretes automáticamente como cantidad de unidades. Si el mensaje anterior del asistente fue una lista de opciones o una pregunta con opciones numeradas, el número significa la opción elegida. Solo registra cantidad cuando el contexto inmediatamente anterior indique que se estaba preguntando o confirmando la cantidad de unidades. Nunca conviertas una selección de opción en una cantidad.

REGLA DE BOTONES INTERACTIVOS — OBLIGATORIA:
Cuando una pregunta del primer contacto tenga respuestas configuradas, el sistema intentará mostrarlas como botones interactivos de WhatsApp. El cliente debe poder seleccionar una opción tocándola, sin escribir números. Cada botón puede tener una respuesta automática configurada; si existe, el sistema la enviará directamente y no debe generarse una segunda respuesta de IA. Si WhatsApp no permite los botones interactivos en esa cuenta, el sistema usará un respaldo de texto con viñetas, pero nunca debe interpretar una selección numérica como cantidad salvo que realmente se esté preguntando la cantidad.

REGLA DE SALUD Y USO — OBLIGATORIA:
No atribuyas a un producto beneficios para dolores, enfermedades o síntomas que no estén explícitamente descritos en la ficha del producto. En productos cosméticos o de cuidado personal, no presentes el producto como tratamiento médico ni inventes indicaciones. Si el cliente menciona una necesidad que no corresponde al uso documentado del producto activo, acláralo con honestidad y vuelve a la información real del producto.

REGLA DE PERTINENCIA DE PREGUNTAS — OBLIGATORIA:
No inventes listas de problemas, síntomas, enfermedades, partes del cuerpo, tipos de piel ni usos. Pregunta únicamente por aspectos que estén respaldados por la información del producto activo o por el prompt específico de ese producto. Si el cliente pregunta por un producto concreto, mantén toda la conversación centrada en ese producto y en la necesidad que realmente expresó. Nunca conviertas una respuesta como una cantidad "2" en una cantidad de unidades si el contexto no indica que estaba hablando de cantidad; primero interpreta el mensaje según la conversación.

REGLA DE CATÁLOGO — LA MÁS IMPORTANTE DE TODAS, NUNCA LA ROMPAS:
Los ÚNICOS productos que existen son los que aparecen en el catálogo (más abajo en este mensaje). Si el cliente pregunta por algo que NO está en esa lista (otro producto, otro nombre, otra categoría), debes decir con claridad que no lo tienes disponible — NUNCA inventes un producto, nombre, precio, uso o característica que no esté escrito exactamente en el catálogo, así el cliente insista o describa algo que "suena parecido". Inventar un producto que no existe es el peor error que puedes cometer — genera confusión, pedidos que no se pueden cumplir, y hace quedar mal al negocio.

Igual de importante cuando hay VARIOS productos reales en el catálogo: cada detalle (precio, forma de uso, beneficios, ingredientes) pertenece SOLO al producto exacto donde está escrito. Antes de responder, verifica de cuál producto está hablando el cliente en ESE momento de la conversación, y usa ÚNICAMENTE los detalles de ese producto — nunca tomes prestado un dato de otro producto del catálogo, aunque parezca similar.

Si el cliente pregunta por un producto específico, responde con los detalles de ESE producto.
Si pregunta en general, puedes mencionar brevemente los productos disponibles y preguntar cuál le interesa.

Cuando el cliente pida ver fotos, imágenes o cómo se ve el producto, usa la función enviar_imagen_producto para enviarlas de verdad — manda también el parámetro "contexto" con la intención real del cliente. Si el cliente pregunta por modo de uso, cómo se usa, cómo se aplica, instrucciones, aplicación o una expresión equivalente, DEBES usar la herramienta con contexto de modo de uso para enviar la imagen configurada para esa intención, y luego explicar brevemente el modo de uso. No esperes a que diga "envíame la foto". Después de enviar una foto o video, no cierres diciendo solo "ya te la envié": explica lo útil y termina con una pregunta que ayude a avanzar hacia la compra.
Cuando el cliente pida ver un video, una demostración o cómo funciona, usa la función enviar_video_producto — pero solo si el catálogo dice que ese producto SÍ tiene video disponible; si no lo tiene, dilo con naturalidad en vez de llamar la función.
Nunca digas frases como "ya te la envío" o "aquí tienes la foto/video" si no llamaste a la función correspondiente — el cliente no recibirá nada si solo lo dices en texto.

REGLA DE LA FICHA DE DATOS — MUY IMPORTANTE:
Cada vez que el cliente te dé o corrija CUALQUIERA de estos datos (nombre, teléfono, dirección, departamento, ciudad, barrio, producto, cantidad, tipo de entrega), llama SIEMPRE a la función actualizar_datos_pedido con ese dato — aunque sea uno solo. Así nunca se te olvida ni preguntas dos veces algo que ya te dieron. Antes de pedir un dato, revisa la ficha de datos de este cliente (más abajo en este mensaje) — si ya lo tienes, NO lo vuelvas a pedir.

REGLA DE PRODUCTO POR CONTEXTO — MUY IMPORTANTE:
Apenas quede claro de qué producto está hablando el cliente (así sea desde su primer mensaje, sin que lo repita después), guárdalo de una vez en la ficha con actualizar_datos_pedido — no esperes hasta el cierre del pedido para "acordarte". Si en la misma conversación el cliente cambia de tema a otro producto distinto, actualiza el campo de producto al nuevo.

REGLA DE ENTREGA — MUY IMPORTANTE (esta regla ANULA cualquier instrucción de arriba que diga que preguntes "¿domicilio u oficina?" como paso aparte):
NO preguntes "¿cómo prefieres recibirlo?" como una pregunta separada. Cuando el cliente muestre intención clara de comprar, pide los datos de una vez (nombre, dirección, ciudad y departamento, teléfono) — asume domicilio por defecto, sin preguntarlo.
Solo pasa a "oficina" si el cliente lo dice explícitamente o menciona una transportadora. Debes reconocer errores de escritura y variantes como "Interrapidísimo", "Inter rapidísimo", "Antirrapidísimo", "antirrapidisimo", etc. En ese caso guarda tipoEntrega como "oficina" y la transportadora correspondiente, y NO pidas dirección exacta. Para oficina pide nombre, teléfono, departamento, ciudad/municipio, transportadora/oficina, producto y cantidad. Para domicilio pide dirección y barrio cuando corresponda. Todo esto puede venir junto en un solo mensaje del cliente (ej. "Camilo Ramírez, Villavicencio Meta, oficina Interrápidísimo, 3215761197") — reconoce todos los datos de ese bloque de una sola vez, no le pidas que los repita por separado.

REGLA DE CANTIDAD — MUY IMPORTANTE:
Si el cliente no menciona la cantidad, asume 1 unidad por defecto — no se lo preguntes como paso aparte, a menos que el producto tenga ofertas por cantidad activas, en cuyo caso sí conviene ofrecerle el combo antes de cerrar. ${offersInstructions}

REGLA DE ENTREGA PROGRAMADA — MUY IMPORTANTE Y OBLIGATORIA:
Si el cliente quiere comprar pero para una fecha futura (ej. "lo quiero pero para el 15", "hasta la otra semana"), pide y guarda TODOS los datos normales del pedido igual que siempre (nombre, dirección, producto, etc. con actualizar_datos_pedido), pero usa programar_entrega con la fecha.
AL PROGRAMAR NO ESTÁS CERRANDO LA VENTA: NO debes emitir la frase "ORDEN DE COMPRA REGISTRADA" en esa respuesta ni tratar la programación como una orden creada. La función programar_entrega guarda la fecha y mueve al cliente al estado/tablero "programado".
El pedido REAL SOLO SE CREA después de que el sistema le pregunte al cliente dos días antes y el cliente confirme que SÍ desea que se lo enviemos. En ese momento posterior sí puedes cerrar con la frase obligatoria "ORDEN DE COMPRA REGISTRADA".
Si la ficha muestra una entrega programada con reminderSent=false, significa que todavía NO está confirmada: aunque tengas todos los datos, NO cierres ni crees orden. Si reminderSent=true, significa que ya recibió el recordatorio; si el mensaje actual es una confirmación afirmativa posterior, ahí sí cierra el pedido.

REGLA DE DIRECCIÓN COMPLETA — MUY IMPORTANTE:
Una dirección solo cuenta como completa si identifica una casa/unidad ESPECÍFICA, no solo una zona o cruce general. Son válidas, por ejemplo:
- Con nomenclatura: "Carrera 4 #3-40", "Calle 15 # 20-10", "Transversal 25a 11 03" (con o sin el símbolo #, con o sin guion)
- Manzana y casa: "Manzana 15 Casa 27", "Mz 15 Cs 27"
- Supermanzana y casa: "Supermanzana 3 Casa 12"
NO son direcciones completas (pide que la complete, con un ejemplo del formato que necesitas): cruces sin número de casa ("Carrera 15 con 14"), o referencias sin número ("cerca al parque, casa amarilla"). Si la dirección que te dan ya trae un número que identifica la casa/unidad, acéptala tal cual la escribieron — no le exijas un formato exacto si ya es clara.
UBICACIÓN EN COLOMBIA — OBLIGATORIA: la ciudad/municipio y el departamento deben existir y corresponder en colombia.json. Si el cliente solo da una ciudad válida, puedes obtener su departamento desde esa lista. Si la ciudad no existe, si el departamento no existe, o si la combinación no corresponde, NO guardes esos datos como válidos y pregunta de nuevo hasta obtener una ciudad/municipio y departamento que sí estén en la lista. No inventes ni adivines. Guarda los nombres oficiales devueltos por la lista. No cierres ni crees un pedido mientras la ubicación esté marcada como no validada.

${confirmBeforeClosing ? `REGLA DE CONFIRMACIÓN — ACTIVADA (esta regla ANULA cualquier otra instrucción de arriba que diga que cierres apenas tengas los datos completos):
Tener todos los datos completos NO es suficiente para cerrar el pedido todavía. Antes de cerrar, cuando ya tengas TODOS los datos completos, PRIMERO repítele al cliente un resumen breve de todos los datos y pregúntale si están correctos — este paso es obligatorio, nunca lo saltes. SOLO cuando el cliente confirme que sí (diga "sí", "correcto", "así está bien" o similar) en un mensaje POSTERIOR a ese resumen, ahí sí cierra el pedido con la frase obligatoria. Si el cliente corrige algo en la confirmación, guarda la corrección con actualizar_datos_pedido y vuelve a mandar el resumen para confirmar de nuevo.` : `Apenas la ficha de datos esté completa (según lo que necesite el tipo de entrega elegido), cierra el pedido de una vez, sin pedir una confirmación extra.`}

REGLA DE CANCELACIÓN — MUY IMPORTANTE (cancelación en dos pasos, no inmediata):
Si el cliente dice que YA NO QUIERE el producto, se arrepintió, o quiere anular su pedido — NO lo canceles de una. Primero, responde con empatía, pregúntale amablemente el motivo, e intenta ayudarlo o convencerlo de que no cancele (sin presionar ni ser insistente — una sola vez, con calidez). En esa misma respuesta, incluye SIEMPRE, exactamente así, la frase:
⚠️ INTENTO DE CANCELACIÓN ⚠️
Si el cliente, DESPUÉS de tu intento de ayudarlo, sigue insistiendo en cancelar — ahí sí, respeta su decisión, dile que vas a remitir su caso al área encargada para que lo resuelvan (nunca digas "bot", "IA" ni "sistema"), e incluye SIEMPRE, exactamente así, la frase:
🆘 NECESITA INTERVENCIÓN HUMANA 🆘
Estas dos frases son señales internas para nuestro sistema — el cliente NUNCA las va a ver. NUNCA uses la frase de intento de cancelación si el cliente solo está cambiando la forma de pago, preguntando por el precio, o teniendo dudas normales — eso NO es una cancelación.

REGLA DE INTERVENCIÓN HUMANA — MUY IMPORTANTE:
Si el cliente pide explícitamente hablar con una persona/humano/asesor, está muy molesto o agresivo, tiene un reclamo complicado que no puedes resolver con la información que tienes, o cualquier situación donde el buen criterio diga que esto ya no lo debe manejar un bot — responde con calma y empatía, dile que ya le avisaste al equipo y que en un momento le van a escribir (nunca digas la palabra "bot", "IA" ni "sistema" en esa frase, que suene natural, como "ya le comento a mi compañero para que te ayude con eso"), e incluye SIEMPRE, exactamente así, en cualquier parte de tu respuesta, la frase:
🆘 NECESITA INTERVENCIÓN HUMANA 🆘
Esta frase es una señal interna para nuestro sistema — el cliente NUNCA la va a ver (el sistema la quita antes de enviar el mensaje), así que no te preocupes por que se vea rara ahí, solo asegúrate de incluirla siempre que aplique esta regla. No sigas insistiendo en vender ni resolver tú solo la situación después de usar esta frase.

REGLA DE CONSULTA DE PEDIDOS — MUY IMPORTANTE:
Si el cliente pregunta por el estado de un pedido que ya hizo, por CUALQUIER motivo — "¿cómo va mi pedido?", "¿ya tiene guía?", "¿cuándo me llega?", "revisa de nuevo", "¿en qué estado está?", o cualquier variación — usa SIEMPRE la función consultar_estado_pedido antes de responder, cada vez que lo pregunte (aunque ya la hayas consultado antes en la misma conversación — el estado pudo cambiar). NUNCA inventes, asumas, ni repitas de memoria un estado o una fecha de entrega sin haber llamado la función en ESE mismo turno — ni siquiera si "suena lógico" o si el cliente insiste en que revises de nuevo. Cuéntale el resultado real con naturalidad, no leas el texto tal cual salga de la función.

--- A PARTIR DE AQUÍ, INFORMACIÓN ESPECÍFICA DE ESTE CLIENTE ---

CATÁLOGO DE PRODUCTOS (usa SOLO esta información, nunca inventes precios ni beneficios):
${catalog || '(Todavía no hay productos cargados)'}${catalogNote}

FICHA DE DATOS DE ESTE CLIENTE (lo que ya tienes guardado, en este momento):
${fichaLines}
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Cliente de WhatsApp ----------
let sock = null;
let botStatus = 'stopped'; // stopped | starting | qr | connected
const MAX_HISTORY = 12;

// Recorta el historial de una conversación sin partir a la mitad una pareja
// de "la IA usó una herramienta" + "resultado de la herramienta" — si el
// corte cayera justo ahí, sigue recortando un poco más hasta un punto
// seguro. Antes, un corte a mitad de pareja causaba un error 400 ("messages
// with role 'tool' must be a response to a preceding message with
// 'tool_calls'") y el bot se quedaba mudo.
function trimHistorySafely(history, maxTotalLength) {
  if (history.length <= maxTotalLength) return;
  let cutCount = history.length - maxTotalLength;
  while (history[cutCount] && history[cutCount].role === 'tool') {
    cutCount += 1;
  }
  history.splice(1, cutCount);
}

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
        transportadora: '',
        producto: '',
        cantidad: '',
        tipoEntrega: '', // "domicilio" | "oficina"
      },
      notes: '', // notas internas del dueño — nunca las ve el cliente ni la IA
      followUpsSent: [], // IDs de los mensajes de seguimiento/remarketing ya enviados
      scheduledDelivery: null, // { date: 'YYYY-MM-DD', reminderSent: false, reminderSentAt: null } — programación de entrega
      activeProductId: '', // producto cuyo asistente/contexto está activo
      firstContactSentForProduct: {}, // evita repetir el primer contacto del mismo producto
      pendingInteractiveButtons: {}, // botones de WhatsApp pendientes y sus respuestas automáticas
    });
  } else {
    const rec = clients.get(jid);
    rec.lastMessageAt = Date.now();
    if (!rec.orderData) {
      // Cliente creado antes de este cambio — le agregamos la ficha vacía.
      rec.orderData = {
        nombre: '', telefono: '', direccion: '', departamento: '',
        ciudad: '', barrio: '', transportadora: '', producto: '', cantidad: '', tipoEntrega: '',
      };
    }
    if (!rec.followUpsSent) rec.followUpsSent = [];
    if (rec.activeProductId === undefined) rec.activeProductId = '';
    if (rec.orderData.transportadora === undefined) rec.orderData.transportadora = '';
    if (!rec.firstContactSentForProduct || typeof rec.firstContactSentForProduct !== 'object') rec.firstContactSentForProduct = {};
    if (!rec.pendingInteractiveButtons || typeof rec.pendingInteractiveButtons !== 'object') rec.pendingInteractiveButtons = {};
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
  confirmado: 'Confirmado', // solo de Pedidos — se activa al subir a Dropi/Skydropx
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
function normalizeColombiaText(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findDepartmentForCity(cityName) {
  const normalized = normalizeColombiaText(cityName);
  if (!normalized) return null;
  for (const [dept, cities] of Object.entries(colombiaData)) {
    if (cities.some((c) => normalizeColombiaText(c) === normalized)) return dept;
  }
  return null;
}

function isValidDepartment(department) {
  const n = normalizeColombiaText(department);
  return Object.keys(colombiaData).some((d) => normalizeColombiaText(d) === n);
}

function getOfficialDepartmentName(department) {
  const n = normalizeColombiaText(department);
  return Object.keys(colombiaData).find((d) => normalizeColombiaText(d) === n) || null;
}

function getOfficialCityName(cityName, department = '') {
  const cn = normalizeColombiaText(cityName);
  if (!cn) return null;
  const deptName = department ? getOfficialDepartmentName(department) : findDepartmentForCity(cityName);
  if (!deptName) return null;
  const cities = colombiaData[deptName] || [];
  return cities.find((c) => normalizeColombiaText(c) === cn) || null;
}

function validateAndNormalizeLocation(cityName, department = '') {
  const city = getOfficialCityName(cityName, department);
  if (!city) return { ok: false, reason: department ? `La ciudad "${cityName}" no está registrada en el departamento "${department}" en colombia.json.` : `La ciudad "${cityName}" no se encontró en colombia.json.` };
  const officialDepartment = findDepartmentForCity(city);
  if (department && normalizeColombiaText(officialDepartment) !== normalizeColombiaText(department)) {
    return { ok: false, reason: `La ciudad "${city}" pertenece a "${officialDepartment}", no a "${department}".` };
  }
  return { ok: true, city, department: officialDepartment };
}

function detectOfficeTransportadora(text) {
  const n = normalizeColombiaText(text);
  if (!n) return null;
  if (/inter\s*rapidisimo|interrapidisimo|interrapidimo|interrapido|antirrapidisimo|antirrapidimo/.test(n)) return 'Interrapidísimo';
  if (/servientrega/.test(n)) return 'Servientrega';
  if (/coordinadora/.test(n)) return 'Coordinadora';
  if (/envia(?!r)?\b/.test(n)) return 'Envía';
  if (/deprisa/.test(n)) return 'Deprisa';
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
  // La ficha de datos estructurada (si ya está llena) es más confiable que
  // "adivinar" leyendo el texto final — se usa de primera, y el texto
  // extraído queda solo como respaldo si algún campo no se llegó a guardar.
  const od = client?.orderData || {};
  const phone = od.telefono || client?.phone || jid.split('@')[0];

  const locationValidation = validateAndNormalizeLocation(od.ciudad, od.departamento);
  if (!locationValidation.ok) {
    io.emit('log', `🚫 Orden no creada para ${jid}: ubicación no validada en colombia.json`);
    return null;
  }
  od.ciudad = locationValidation.city;
  od.departamento = locationValidation.department;
  if (od.tipoEntrega === 'oficina' && !od.transportadora) {
    io.emit('log', `🚫 Orden no creada para ${jid}: falta transportadora/oficina`);
    return null;
  }

  // Si este mismo cliente (por su jid real, que no cambia aunque corrija
  // datos) ya tiene un pedido "pendiente" creado hace muy poco, lo tratamos
  // como una corrección de ese mismo pedido (ej. corrigió el teléfono o la
  // dirección después de cerrarlo) — se ACTUALIZA en vez de crear uno
  // nuevo. Si el pendiente existente es de hace rato, sí es una compra
  // distinta y se crea uno nuevo de verdad.
  const CORRECTION_WINDOW_MS = 15 * 60 * 1000;
  const recentPendingOrder = orders.find(
    (o) => o.clientJid === jid && o.status === 'pendiente' && Date.now() - o.createdAt < CORRECTION_WINDOW_MS
  );

  if (recentPendingOrder) {
    const updated = updateOrder(recentPendingOrder.id, {
      clientName: od.nombre || client?.name || extractNameFromOrderText(summary) || recentPendingOrder.clientName,
      clientPhone: phone,
      product: od.producto || extractProductFromOrderText(summary) || recentPendingOrder.product,
      quantity: od.cantidad || recentPendingOrder.quantity,
      price: extractPriceFromOrderText(summary) || recentPendingOrder.price,
      address: od.direccion || extractAddressFromOrderText(summary) || recentPendingOrder.address,
      department: od.departamento || recentPendingOrder.department,
      city: od.ciudad || extractCityFromOrderText(summary) || recentPendingOrder.city,
      neighborhood: od.barrio || recentPendingOrder.neighborhood,
      deliveryType: od.tipoEntrega || recentPendingOrder.deliveryType,
      transportadora: od.transportadora || recentPendingOrder.transportadora,
      rawSummary: summary,
    });
    io.emit('log', `✏️ Pedido ${recentPendingOrder.id} actualizado (el cliente corrigió un dato), no se creó uno nuevo`);
    return updated;
  }

  // Aviso de pedido duplicado: si este mismo cliente (por jid o por
  // teléfono) ya tiene OTRO pedido reciente (últimas 24h) sin resolver
  // todavía, lo marcamos para que se note en el panel — no bloquea la
  // creación, solo avisa. Se compara por jid primero (no cambia nunca) y por
  // teléfono como respaldo.
  const UNRESOLVED = ['pendiente', 'confirmado', 'guia_generada', 'en_camino'];
  const recentDuplicate = orders.find(
    (o) =>
      (o.clientJid === jid || o.clientPhone === phone) &&
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
    transportadora: od.transportadora || '',
    status: 'pendiente',
    source: 'ia',
    rawSummary: summary,
    possibleDuplicateOf: recentDuplicate ? recentDuplicate.id : null,
  });

  if (recentDuplicate) {
    io.emit('log', `⚠️ Posible pedido duplicado: ${order.id} y ${recentDuplicate.id} son del mismo cliente, en menos de 24h`);
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
// Buffer de mensajes por cliente, para el "debounce" — junta varios mensajes
// seguidos en una sola respuesta en vez de contestar a cada uno por separado.
const pendingMessageBuffers = new Map();

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

      const adReply = msg.message?.extendedTextMessage?.contextInfo?.externalAdReply
        || msg.message?.imageMessage?.contextInfo?.externalAdReply
        || msg.message?.videoMessage?.contextInfo?.externalAdReply
        || null;
      const isFromAd = !!adReply;
      const adContextText = [adReply?.title, adReply?.body, adReply?.sourceUrl].filter(Boolean).join(' ');
      const detectedProduct = detectProductFromText(
        [msg.message?.conversation || msg.message?.extendedTextMessage?.text || '', adContextText].filter(Boolean).join(' ')
      );

      const buttonResponse = msg.message?.buttonsResponseMessage || msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage || null;
      const selectedButtonId = buttonResponse?.selectedButtonId || '';
      const selectedButtonText = buttonResponse?.selectedDisplayText || '';
      let buttonAutoResponse = '';
      if (selectedButtonId) {
        const pending = ensureClientRecord(userId) && clients.get(userId)?.pendingInteractiveButtons?.[selectedButtonId];
        if (pending) {
          buttonAutoResponse = String(pending.response || '').trim();
          const rec = clients.get(userId);
          delete rec.pendingInteractiveButtons[selectedButtonId];
          clients.set(userId, rec);
          saveClients();
        }
      }

      const rawText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        selectedButtonText ||
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

      // Si el botón tenía una respuesta configurada, se envía de inmediato y
      // no se llama a la IA para evitar una segunda respuesta innecesaria.
      if (buttonAutoResponse) {
        ensureClientRecord(userId);
        appendChatLog(userId, { from: 'client', text: selectedButtonText || messageText, type: 'button', timestamp: Date.now() });
        await sendAndTrack(userId, { text: buttonAutoResponse });
        appendChatLog(userId, { from: 'bot', text: buttonAutoResponse, type: 'text', timestamp: Date.now() });
        return;
      }

      // Para audios, la detección del producto también debe hacerse con la
      // transcripción; de lo contrario una campaña podría quedar sin asistente
      // de producto simplemente porque el cliente habló en vez de escribir.
      const detectedProductAfterTranscription = detectProductFromText(
        [messageText, adContextText].filter(Boolean).join(' ')
      );

      // ---- Registrar en el CRM: se guarda SIEMPRE, esté pausado o no ----
      ensureClientRecord(userId);
      if (detectedProduct || detectedProductAfterTranscription) {
        activateProductFromMessage(userId, [messageText, adContextText].filter(Boolean).join(' '));
      }
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

      const activeProductForFirstContact = getActiveProduct(userId);
      if (activeProductForFirstContact && await sendProductFirstContact(userId, activeProductForFirstContact, isFromAd)) {
        io.emit('log', `🎯 Primer contacto del producto enviado: ${activeProductForFirstContact.name}`);
        return;
      }

      if (isNewUser) {
        await sendAndTrack(userId, { text: cfg.welcomeMessage });
      }

      // ---- Agrupar mensajes seguidos (debounce) ----
      // Si el cliente manda varios mensajes/audios muy seguidos, no
      // respondemos a cada uno por separado — esperamos un rato corto por si
      // sigue escribiendo, y respondemos UNA sola vez a todo junto. Así no se
      // "come" datos que llegaron en un mensaje aparte, ni contesta atrasado
      // mensaje por mensaje.
      scheduleDebouncedReply(userId, messageText, isVoiceMessage);
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

  const DEBOUNCE_MS = 7000; // segundos de espera tras el último mensaje antes de responder

  function scheduleDebouncedReply(userId, text, isVoice) {
    let buf = pendingMessageBuffers.get(userId);
    if (!buf) {
      buf = { texts: [], anyVoice: false, timer: null };
      pendingMessageBuffers.set(userId, buf);
    }
    buf.texts.push(text);
    if (isVoice) buf.anyVoice = true;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      pendingMessageBuffers.delete(userId);
      enqueueForUser(userId, () => generateReplyForUser(userId, buf.texts, buf.anyVoice));
    }, DEBOUNCE_MS);
  }

// Si la IA falla por cualquier motivo (el error de la pareja de
// herramientas, un corte de conexión, lo que sea), en vez de rendirse de una
// con el mensaje de disculpa, se reintenta varias veces — la segunda vez con
// la conversación "limpia" (se descarta el historial viejo que pudo causar
// el problema, dejando solo el prompt del sistema + el mensaje actual), y
// las siguientes con una espera corta. Solo si los 4 intentos fallan, se
// deja que el error suba y se use el mensaje de disculpa como último recurso.
async function getReplyWithSelfHealing(userId, history, messageText) {
  const MAX_TOTAL_ATTEMPTS = 4;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TOTAL_ATTEMPTS; attempt++) {
    try {
      if (attempt === 2) {
        const cleanHistory = [history[0], { role: 'user', content: messageText }];
        history.length = 0;
        history.push(...cleanHistory);
        saveConversations();
      } else if (attempt > 2) {
        await sleep(1500);
      }
      return await runToolLoop(userId, history, messageText);
    } catch (err) {
      lastError = err;
      console.error(`Intento ${attempt}/${MAX_TOTAL_ATTEMPTS} de responder falló:`, err.message);
      io.emit('log', `⚠️ Intento ${attempt}/${MAX_TOTAL_ATTEMPTS} de responder falló, reintentando...`);
    }
  }
  throw lastError;
}

  async function sendProductFirstContact(userId, product, isFromAd) {
    if (!product?.firstContactEnabled) return false;
    ensureClientRecord(userId);
    const client = clients.get(userId);
    if (client.firstContactSentForProduct?.[product.id]) return false;
    // Se dispara en una entrada de publicidad o en el primer contacto directo con un producto.
    if (!isFromAd && client.messageCount > 1) return false;

    const sequence = normalizeFirstContactSequence(product);
    if (sequence.length === 0) return false;

    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i];
      const delay = Math.max(0, Number(step.delaySeconds) || 0);
      if (delay > 0) await sleep(delay * 1000);

      if (step.type === 'text' || step.type === 'question') {
        if (!String(step.text || '').trim()) continue;
        await sendAndTrack(userId, { text: step.text });
        appendChatLog(userId, { from: 'bot', text: step.text, type: 'text', timestamp: Date.now() });
      } else if (step.type === 'buttons') {
        const text = String(step.text || '').trim();
        if (text) {
          await sendAndTrack(userId, { text });
          appendChatLog(userId, { from: 'bot', text, type: 'text', timestamp: Date.now() });
        }
        const buttons = (step.buttons || []).slice(0, 3).filter((b) => b && typeof b === 'object' && b.text);
        if (buttons.length) {
          // Botones nativos de WhatsApp: el cliente selecciona tocando el botón,
          // sin escribir 1/2/3. Guardamos la respuesta asociada para contestar
          // automáticamente cuando WhatsApp devuelva el buttonResponseMessage.
          const nativeButtons = buttons.map((b, n) => ({
            buttonId: `fcbtn_${String(product.id || 'p')}_${String(step.id || i)}_${n}`.slice(0, 256),
            buttonText: { displayText: String(b.text).slice(0, 20) },
            type: 1,
          }));
          const pending = {};
          buttons.forEach((b, n) => {
            pending[nativeButtons[n].buttonId] = { productId: product.id, stepId: step.id, text: b.text, response: b.response || '' };
          });
          client.pendingInteractiveButtons = { ...(client.pendingInteractiveButtons || {}), ...pending };
          // Baileys soporta este formato en cuentas donde WhatsApp mantiene
          // habilitados los mensajes interactivos clásicos. Si la cuenta no lo
          // acepta, caemos a texto como respaldo para no romper la conversación.
          try {
            await sendAndTrack(userId, {
              text: '',
              buttons: nativeButtons,
              headerType: 1,
            });
            appendChatLog(userId, { from: 'bot', text: buttons.map((b) => `• ${b.text}`).join('\n'), type: 'buttons', timestamp: Date.now() });
          } catch (buttonErr) {
            console.warn('Botones interactivos no disponibles; usando respaldo de texto:', buttonErr.message);
            const optionsText = buttons.map((b) => `• ${b.text}`).join('\n');
            await sendAndTrack(userId, { text: optionsText });
            appendChatLog(userId, { from: 'bot', text: optionsText, type: 'text', timestamp: Date.now() });
          }
        }
      } else if (step.mediaUrl) {
        const mediaPath = path.join(__dirname, String(step.mediaUrl).replace(/^\//, ''));
        if (!fs.existsSync(mediaPath)) continue;
        const buffer = fs.readFileSync(mediaPath);
        if (step.type === 'image') {
          await sendAndTrack(userId, { image: buffer });
          appendChatLog(userId, { from: 'bot', text: '', type: 'image', mediaUrl: step.mediaUrl, timestamp: Date.now() });
        } else if (step.type === 'video') {
          await sendAndTrack(userId, { video: buffer });
          appendChatLog(userId, { from: 'bot', text: '', type: 'video', mediaUrl: step.mediaUrl, timestamp: Date.now() });
        } else if (step.type === 'audio') {
          const ext = path.extname(mediaPath).toLowerCase();
          const audioMime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/ogg';
          await sendAndTrack(userId, { audio: buffer, mimetype: audioMime, ptt: false });
          appendChatLog(userId, { from: 'bot', text: '', type: 'audio', mediaUrl: step.mediaUrl, timestamp: Date.now() });
        }
      }
    }

    client.firstContactSentForProduct[product.id] = Date.now();
    clients.set(userId, client);
    saveClients();
    io.emit('clientUpdate', { jid: userId, client });
    return true;
  }

  async function generateReplyForUser(userId, texts, isVoiceMessage) {
    try {
      const cfg = readConfig();
      // Si llegaron varios mensajes seguidos, se juntan en un solo turno —
      // así la IA los ve todos de una, en vez de solo el último.
      const messageText = texts.join('\n');

      if (!conversations.has(userId)) {
        conversations.set(userId, [{ role: 'system', content: buildSystemPrompt(userId) }]);
      }
      const history = conversations.get(userId);
      // Detectamos localmente el producto mencionado antes de llamar a la IA.
      // Así el prompt detallado solo se activa cuando realmente hay interés.
      activateProductFromMessage(userId, messageText);
      history[0] = { role: 'system', content: buildSystemPrompt(userId) };
      history.push({ role: 'user', content: messageText });

      if (history.length > MAX_HISTORY + 1) {
        trimHistorySafely(history, MAX_HISTORY + 1);
      }
      saveConversations();

      try {
        await sock.sendPresenceUpdate('composing', userId);
      } catch (e) {
        // sin problema si no se puede mostrar "escribiendo..."
      }

      await sleep((cfg.responseDelaySeconds ?? 5) * 1000);

      // ---- La IA responde, usando herramientas las veces que necesite, con reintentos si falla ----
      const aiMessage = await getReplyWithSelfHealing(userId, history, messageText);

      const reply = (aiMessage.content || '').trim() || 'Listo 😊';
      history.push({ role: 'assistant', content: reply });
      saveConversations();

      // El cliente nunca debe ver las frases "señal interna" (como la de
      // intervención humana) — se limpian del texto que de verdad se manda.
      const clientReply = stripInternalMarkers(reply);

      // ---- Responder con audio (voz clonada) según el modo configurado ----
      // voiceMode: 'off' (siempre texto), 'voice' (siempre audio),
      // 'mirror' (responde en el mismo formato en que llegó el mensaje).
      // Excepción: las confirmaciones de venta/cancelación SIEMPRE van en
      // texto, sin importar el modo — traen datos importantes (dirección,
      // teléfono, precio) que el cliente necesita poder leer y guardar, no
      // solo escuchar una vez.
      const isOrderConfirmation = reply.includes('ORDEN DE COMPRA REGISTRADA');
      const voiceMode = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
      const minimaxReady = cfg.minimaxApiKey && cfg.minimaxGroupId && cfg.minimaxVoiceId;
      const shouldReplyWithVoice =
        !isOrderConfirmation &&
        minimaxReady &&
        (voiceMode === 'voice' || (voiceMode === 'mirror' && isVoiceMessage));

      if (shouldReplyWithVoice) {
        try {
          const oggFilename = await sendVoiceReply(userId, clientReply);
          appendChatLog(userId, { from: 'bot', text: clientReply, type: 'voice', mediaUrl: `/media/${oggFilename}`, timestamp: Date.now() });
        } catch (err) {
          console.error('Error generando audio con MiniMax, se responde en texto:', err);
          io.emit('log', `⚠️ Falló la voz (MiniMax), respondí en texto: ${err.message}`);
          await sendAndTrack(userId, { text: clientReply });
          appendChatLog(userId, { from: 'bot', text: clientReply, type: 'text', timestamp: Date.now() });
        }
      } else {
        await sendAndTrack(userId, { text: clientReply });
        appendChatLog(userId, { from: 'bot', text: clientReply, type: 'text', timestamp: Date.now() });
      }

      await handlePostReplyMarkers(userId, reply, cfg, messageText);
      if (reply.includes('ORDEN DE COMPRA REGISTRADA')) io.emit('log', `🛎️ Venta registrada`);
      if (reply.includes('INTENTO DE CANCELACIÓN')) io.emit('log', `⚠️ ${userId} intentó cancelar — la IA está tratando de retenerlo`);
      if (reply.includes('NECESITA INTERVENCIÓN HUMANA')) io.emit('log', `🆘 ${userId} pausado — necesita intervención humana`);
    } catch (err) {
      console.error('Error generando respuesta:', err);
      io.emit('log', `❌ Error: ${err.message}`);
      const isRateLimit = err?.status === 429;
      const fallbackMsg = isRateLimit
        ? 'Estamos con muchos mensajes en este momento 🙏. Dame un minuto y te respondo enseguida.'
        : 'Disculpa, tuve un problema técnico 🙏. ¿Puedes repetir tu mensaje?';
      try {
        await sendAndTrack(userId, { text: fallbackMsg });
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
