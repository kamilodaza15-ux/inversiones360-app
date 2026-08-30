require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ---------- Sistema de actualizaciones ----------
// Cada vez que mejores el código: 1) subes ESTE archivo (server.js) actualizado
// a tu repo de GitHub, y 2) subes el número de "version" en latest.json para
// que coincida con el que pongas aquí abajo (CURRENT_VERSION). El botón del
// panel compara ambos números para saber si hay algo nuevo.
const CURRENT_VERSION = '1.0.0';
const UPDATE_MANIFEST_URL =
  'https://raw.githubusercontent.com/jarandres16-lang/inversiones360-bot-updates/main/latest.json';

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

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const crypto = require('crypto');
const os = require('os');

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

// ---------- Subida de imágenes ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      const id = req.body.id || req.params.id || 'producto';
      cb(null, `${id}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

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

app.post('/api/products', upload.array('images', 6), (req, res) => {
  const products = readProducts();
  const id = req.body.id || `prod-${Date.now()}`;
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
    images: (req.files || []).map((f) => `/media/${f.filename}`),
  };
  products.push(newProduct);
  writeProducts(products);
  res.json(newProduct);
});

app.put('/api/products/:id', upload.array('images', 6), (req, res) => {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });

  const existing = products[idx];
  const newImages = (req.files || []).map((f) => `/media/${f.filename}`);
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

// ---------- Tool: enviar imagen del producto ----------
// En vez de depender de palabras clave, dejamos que el modelo decida cuándo
// llamar esta "herramienta". Solo cuando el modelo la invoca de verdad se
// disparan las imágenes reales por WhatsApp.
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
      const media = MessageMedia.fromFilePath(imgPath);
      await client.sendMessage(userId, media);
    }
  }
  return true;
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
      return `- ${p.name} | ${priceLine}\n  Detalle: ${p.details}`;
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
Nunca digas frases como "ya te la envío" o "aquí tienes la foto" si no llamaste a esa función — el cliente no recibirá nada si solo lo dices en texto.
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Cliente de WhatsApp ----------
let client = null;
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

function startBot() {
  if (client) return;
  botStatus = 'starting';
  io.emit('status', botStatus);

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', async (qr) => {
    botStatus = 'qr';
    const qrImage = await QRCode.toDataURL(qr);
    io.emit('qr', qrImage);
    io.emit('status', botStatus);
  });

  client.on('ready', () => {
    botStatus = 'connected';
    io.emit('status', botStatus);
    io.emit('log', `✅ Bot conectado.`);
  });

  client.on('disconnected', (reason) => {
    botStatus = 'stopped';
    io.emit('status', botStatus);
    io.emit('log', `⚠️ Desconectado: ${reason}`);
    client = null;
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('@g.us') || msg.isStatus) return;
    // Encola el mensaje: si el mismo cliente manda varios seguidos, se procesan
    // uno por uno y en orden, sin pisarse entre sí.
    enqueueForUser(msg.from, () => processMessage(msg));
  });

  async function processMessage(msg) {
    try {
      const cfg = readConfig();
      const userId = msg.from;
      const isNewUser = !seenUsers.has(userId);
      seenUsers.add(userId);

      // ---- Notas de voz: transcribir antes de seguir el flujo normal ----
      let messageText = msg.body;
      if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
        try {
          const media = await msg.downloadMedia();
          io.emit('log', `🎙️ Transcribiendo audio de ${userId}...`);
          messageText = await transcribeAudio(media.data, media.mimetype);
          if (!messageText) {
            await msg.reply('No logré entender el audio 🙏. ¿Me lo puedes escribir?');
            return;
          }
          io.emit('log', `🎙️ Transcripción: ${messageText}`);
        } catch (e) {
          console.error('Error transcribiendo audio:', e);
          await msg.reply('No pude procesar el audio 🙏. ¿Me lo escribes en texto?');
          return;
        }
      }

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
        const chat = await msg.getChat();
        await chat.sendStateTyping();
      } catch (e) {
        // sin problema si no se puede mostrar "escribiendo..."
      }

      if (isNewUser) {
        await client.sendMessage(userId, cfg.welcomeMessage);
      }

      await sleep((cfg.responseDelaySeconds ?? 5) * 1000);

      // ---- Primera llamada a la IA, con la herramienta de imagen disponible ----
      let aiMessage = await getAIMessage(history, [productImageTool]);

      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        // El modelo decidió enviar la imagen: lo hacemos de verdad.
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
          }

          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultText,
          });
        }

        // Segunda llamada para que la IA redacte el mensaje final ya sabiendo
        // que la imagen sí se envió (o no).
        aiMessage = await getAIMessage(history);
      }

      const reply = (aiMessage.content || '').trim() || 'Listo 😊';
      history.push({ role: 'assistant', content: reply });
      saveConversations();
      await msg.reply(reply);

      io.emit('log', `💬 ${userId}: ${messageText}`);
    } catch (err) {
      console.error('Error procesando mensaje:', err);
      io.emit('log', `❌ Error: ${err.message}`);
      const isRateLimit = err?.status === 429;
      const fallbackMsg = isRateLimit
        ? 'Estamos con muchos mensajes en este momento 🙏. Dame un minuto y te respondo enseguida.'
        : 'Disculpa, tuve un problema técnico 🙏. ¿Puedes repetir tu mensaje?';
      try {
        await msg.reply(fallbackMsg);
      } catch (e) {}
    }
  }

  client.initialize();
}

app.post('/api/start', (req, res) => {
  startBot();
  res.json({ status: botStatus });
});

app.get('/api/status', (req, res) => res.json({ status: botStatus }));

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

app.post('/api/apply-update', async (req, res) => {
  try {
    const manifestResponse = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!manifestResponse.ok) throw new Error('No se pudo consultar el manifiesto');
    const manifest = await manifestResponse.json();
    if (!manifest.serverUrl) throw new Error('El manifiesto no incluye la URL del archivo nuevo');

    const fileResponse = await fetch(manifest.serverUrl, { cache: 'no-store' });
    if (!fileResponse.ok) throw new Error('No se pudo descargar el archivo actualizado');
    const newCode = await fileResponse.text();

    // Guarda una copia de respaldo del server.js actual, por si algo sale mal.
    const currentPath = path.join(__dirname, 'server.js');
    const backupPath = path.join(__dirname, `server.js.bak-${Date.now()}`);
    fs.copyFileSync(currentPath, backupPath);
    fs.writeFileSync(currentPath, newCode, 'utf8');

    res.json({
      ok: true,
      newVersion: manifest.version,
      message: 'Actualización descargada. Cierra el bot y ábrelo de nuevo (Iniciar.bat) para aplicar los cambios.',
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
