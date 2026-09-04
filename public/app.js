// ---------- Licencia / activación ----------
async function checkLicense() {
  const lic = await fetch('/api/license').then((r) => r.json());
  if (lic.activated) {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    initApp();
  } else {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
  }
}

document.getElementById('activateBtn').addEventListener('click', async () => {
  const key = document.getElementById('licenseKeyInput').value.trim();
  const errorEl = document.getElementById('licenseError');
  errorEl.textContent = '';
  if (!key) return;
  const res = await fetch('/api/license/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = await res.json();
  if (data.ok) {
    checkLicense();
  } else {
    errorEl.textContent = 'Código inválido, verifica e intenta de nuevo.';
  }
});

checkLicense();

// ---------- Resto de la app (solo se inicializa si está activada) ----------
function initApp() {

const socket = io();

// ---------- Notificaciones "toast" (reemplazan los alert() feos) ----------
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.2s ease forwards';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// ---------- Aviso de actualización disponible (arriba del panel) ----------
// Se revisa solo, apenas se abre la app (en el navegador o dentro de Electron).
async function checkUpdateBannerOnLoad() {
  const banner = document.getElementById('updateBanner');
  try {
    const data = await fetch('/api/check-update').then((r) => r.json());
    if (data.currentVersion) {
      const label = document.getElementById('currentVersionLabel');
      if (label) label.textContent = data.currentVersion;
    }
    if (data.updateAvailable) {
      banner.style.display = 'flex';
      banner.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:#fef9c3;border-bottom:1px solid #eab308;font-family:inherit;';
      banner.innerHTML = `
        <span>🔔 Hay una actualización disponible: <b>${data.latestVersion}</b>${data.notes ? ' — ' + data.notes : ''}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="bannerUpdateBtn" class="save-btn" style="white-space:nowrap;margin-top:0">⬇ Descargar</button>
          <button id="bannerCloseBtn" title="Cerrar (vuelve a aparecer la próxima vez que abras la app)" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#78350f;padding:0 4px">✕</button>
        </div>
      `;
      document.getElementById('bannerCloseBtn').addEventListener('click', () => {
        banner.style.display = 'none';
      });
      document.getElementById('bannerUpdateBtn').addEventListener('click', async () => {
        if (!confirm('¿Instalar la actualización ahora? Vas a necesitar reiniciar el bot después.')) return;
        banner.innerHTML = 'Instalando actualización...';
        try {
          const res = await fetch('/api/apply-update', { method: 'POST' }).then((r) => r.json());
          if (res.ok) {
            banner.style.background = '#dcfce7';
            banner.innerHTML = `
              <span style="color:#16a34a">✔ ${res.message}</span>
              <button id="bannerRestartBtn" class="save-btn" style="white-space:nowrap">🔄 Reiniciar ahora</button>
            `;
            document.getElementById('bannerRestartBtn').addEventListener('click', async () => {
              banner.innerHTML = '🔄 Reiniciando...';
              await fetch('/api/restart-app', { method: 'POST' }).catch(() => {});
            });
          } else {
            banner.style.background = '#fee2e2';
            banner.innerHTML = `<span style="color:#dc2626">${res.error}</span>`;
          }
        } catch (err) {
          banner.style.background = '#fee2e2';
          banner.innerHTML = `<span style="color:#dc2626">Error: ${err.message}</span>`;
        }
      });
    }
  } catch (err) {
    // Si falla (sin internet, por ejemplo), no interrumpe el uso normal del bot.
  }
}
checkUpdateBannerOnLoad();

// ---------- Tabs (ahora en la barra lateral) ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- Barra lateral: fijar/ocultar con el botón ☰ ----------
const sidebarEl = document.getElementById('sidebar');
document.getElementById('sidebarToggleBtn').addEventListener('click', () => {
  sidebarEl.classList.toggle('pinned');
});

// ---------- Modo oscuro / claro ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
  document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Modo claro' : 'Modo oscuro';
  localStorage.setItem('inversiones360-theme', theme);
}
applyTheme(localStorage.getItem('inversiones360-theme') || 'light');
document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ---------- Estado / QR ----------
const statusBadge = document.getElementById('statusBadge');
const qrImage = document.getElementById('qrImage');
const qrHint = document.getElementById('qrHint');
const logDiv = document.getElementById('log');

const statusLabels = {
  stopped: 'Detenido',
  starting: 'Iniciando...',
  qr: 'Escanea el QR',
  connected: 'Conectado ✅',
};

function setStatus(status) {
  statusBadge.textContent = statusLabels[status] || status;
  statusBadge.className = `badge ${status}`;
  if (status === 'connected') {
    qrImage.style.display = 'none';
    qrHint.textContent = 'El asistente está conectado y respondiendo mensajes.';
  } else if (status === 'qr') {
    qrHint.textContent = 'Escanea este código desde WhatsApp Business > Dispositivos vinculados:';
  }
}

socket.on('status', setStatus);
socket.on('qr', (dataUrl) => {
  qrImage.src = dataUrl;
  qrImage.style.display = 'block';
});
socket.on('log', (line) => {
  const p = document.createElement('div');
  p.textContent = line;
  logDiv.appendChild(p);
  logDiv.scrollTop = logDiv.scrollHeight;
});

document.getElementById('startBtn').addEventListener('click', async () => {
  await fetch('/api/start', { method: 'POST' });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  if (!confirm('¿Cerrar la sesión de WhatsApp? Vas a tener que escanear el QR de nuevo la próxima vez.')) return;
  qrImage.style.display = 'none';
  qrHint.textContent = 'Presiona "Iniciar" y escanea el QR que aparecerá aquí con WhatsApp Business.';
  await fetch('/api/logout', { method: 'POST' });
});

document.getElementById('quitAppBtn').addEventListener('click', async () => {
  if (
    !confirm(
      '¿Cerrar el bot completamente? Se apagará todo el proceso (no queda minimizado junto al reloj) y va a dejar de responder mensajes hasta que lo vuelvas a abrir.'
    )
  )
    return;
  logDiv.appendChild(Object.assign(document.createElement('div'), { textContent: '🛑 Cerrando la aplicación...' }));
  await fetch('/api/quit-app', { method: 'POST' }).catch(() => {});
  // La app se cierra sola desde aquí en adelante; no hay nada más que hacer en pantalla.
});

document.getElementById('restartAppBtn').addEventListener('click', async () => {
  if (!confirm('¿Reiniciar la app? Se va a cerrar y volver a abrir sola en unos segundos.')) return;
  logDiv.appendChild(Object.assign(document.createElement('div'), { textContent: '🔄 Reiniciando la aplicación...' }));
  await fetch('/api/restart-app', { method: 'POST' }).catch(() => {});
  // La app se reinicia sola desde aquí en adelante.
});

fetch('/api/status').then((r) => r.json()).then((d) => setStatus(d.status));

// ---------- Acceso desde otro dispositivo en la misma red ----------
fetch('/api/network-info')
  .then((r) => r.json())
  .then((data) => {
    if (!data.available) return;
    document.getElementById('networkAccessCard').style.display = 'block';
    document.getElementById('networkUrlText').textContent = data.url;
    const qrImg = document.getElementById('networkQrImage');
    qrImg.src = data.qrDataUrl;
    qrImg.style.display = 'block';

    // El comando siempre queda disponible ahí (colapsado), como referencia —
    // no intentamos "adivinar" si el firewall lo está bloqueando o no, porque
    // esa detección puede dar falsos positivos y generar confusión.
    const command = `New-NetFirewallRule -DisplayName "Inversiones360 Panel" -Direction Inbound -Protocol TCP -LocalPort ${data.port} -Action Allow`;
    document.getElementById('firewallCommand').textContent = command;
    document.getElementById('copyFirewallCmdBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(command).then(() => {
        const btn = document.getElementById('copyFirewallCmdBtn');
        btn.textContent = '✔ Copiado';
        setTimeout(() => (btn.textContent = '📋 Copiar comando'), 2000);
      });
    });
  })
  .catch(() => {}); // si falla, simplemente no se muestra la tarjeta — no afecta el resto de la app

// ---------- Configuración ----------
const cfgFields = [
  'assistantName', 'companyName', 'welcomeMessage', 'baseInstructions',
  'responseDelaySeconds', 'notificationPhoneNumber', 'pauseDurationMinutes', 'aiProvider', 'groqApiKey',
  'openaiApiKey', 'deepseekApiKey', 'autoUploadProvider', 'dropiEmail', 'dropiPassword',
];
// groqModel y openaiModel se manejan aparte porque son selects con opción
// "otro personalizado" (por si el modelo que quieren no está en la lista).
// minimaxApiKey, minimaxGroupId y voiceMode se guardan con su propio botón
// (tarjeta de "Voz del bot"), independiente del resto de la configuración.

function setupModelSelect(selectId, customId, value) {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  const knownValues = Array.from(select.options)
    .map((o) => o.value)
    .filter((v) => v !== '__custom__');
  if (value && !knownValues.includes(value)) {
    select.value = '__custom__';
    custom.value = value;
    custom.style.display = 'block';
  } else {
    select.value = value || knownValues[0] || '';
    custom.style.display = 'none';
  }
}

function getModelValue(selectId, customId) {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  return select.value === '__custom__' ? custom.value.trim() : select.value;
}

['cfg-groqModel', 'cfg-openaiModel'].forEach((selectId) => {
  const select = document.getElementById(selectId);
  const custom = document.getElementById(`${selectId}-custom`);
  select.addEventListener('change', () => {
    custom.style.display = select.value === '__custom__' ? 'block' : 'none';
  });
});

async function loadConfig() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  cfgFields.forEach((f) => {
    const el = document.getElementById(`cfg-${f}`);
    if (el) el.value = cfg[f] ?? '';
  });
  // Compatibilidad: si alguien tenía la versión vieja con voiceEnabled (true/false),
  // lo traducimos automáticamente a voiceMode la primera vez que carga.
  document.getElementById('cfg-voiceMode').value = cfg.voiceMode || (cfg.voiceEnabled ? 'voice' : 'off');
  document.getElementById('cfg-confirmOrderDataBeforeClosing').checked = !!cfg.confirmOrderDataBeforeClosing;
  document.getElementById('cfg-dropiUseTestEnv').checked = !!cfg.dropiUseTestEnv;
  document.getElementById('cfg-minimaxApiKey').value = cfg.minimaxApiKey || '';
  document.getElementById('cfg-minimaxGroupId').value = cfg.minimaxGroupId || '';
  updateVoiceCloneStatus(cfg);
  setupModelSelect('cfg-groqModel', 'cfg-groqModel-custom', cfg.groqModel);
  setupModelSelect('cfg-openaiModel', 'cfg-openaiModel-custom', cfg.openaiModel);
  setupModelSelect('cfg-deepseekModel', 'cfg-deepseekModel-custom', cfg.deepseekModel);

  if (!cfg.onboardingCompleted) {
    document.getElementById('onboardingOverlay').style.display = 'flex';
  }
}
loadConfig();

// ---------- Configuración en acordeón — se arma solo, sin tocar el HTML de
// cada tarjeta (así no se rompe ninguna lógica de mostrar/ocultar campos que
// ya tenían adentro, como el modelo personalizado) ----------
function setupCollapsibleCards() {
  document.querySelectorAll('.collapsible-card').forEach((card) => {
    if (card.dataset.accordionReady) return;
    const h2 = card.querySelector('h2');
    if (!h2) return;
    card.dataset.accordionReady = 'true';

    const header = document.createElement('div');
    header.className = 'card-accordion-header';
    h2.parentNode.insertBefore(header, h2);
    header.appendChild(h2);
    const chevron = document.createElement('span');
    chevron.className = 'card-accordion-chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'card-accordion-body';
    while (card.children.length > 1) {
      body.appendChild(card.children[1]);
    }
    card.appendChild(body);

    header.addEventListener('click', () => card.classList.toggle('open'));
  });
}
setupCollapsibleCards();

// ---------- Asistente de configuración inicial (onboarding) ----------
function showOnboardingStep(n) {
  [1, 2, 3, 4].forEach((i) => {
    document.getElementById(`onboardingStep${i}`).style.display = i === n ? 'block' : 'none';
  });
}
async function finishOnboarding() {
  document.getElementById('onboardingOverlay').style.display = 'none';
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onboardingCompleted: true }),
  });
}
document.getElementById('onboardingStartBtn').addEventListener('click', () => showOnboardingStep(2));
document.getElementById('onboardingStep2NextBtn').addEventListener('click', () => showOnboardingStep(3));
document.getElementById('onboardingStep3NextBtn').addEventListener('click', () => showOnboardingStep(4));
document.getElementById('onboardingGoConfigBtn').addEventListener('click', () => document.querySelector('.nav-item[data-tab="config"]').click());
document.getElementById('onboardingGoInicioBtn').addEventListener('click', () => document.querySelector('.nav-item[data-tab="inicio"]').click());
document.getElementById('onboardingGoProductosBtn').addEventListener('click', () => document.querySelector('.nav-item[data-tab="productos"]').click());
document.getElementById('onboardingFinishBtn').addEventListener('click', finishOnboarding);
document.getElementById('onboardingSkipBtn').addEventListener('click', finishOnboarding);

async function saveMainConfig(savedLabelId) {
  const body = {};
  cfgFields.forEach((f) => {
    const el = document.getElementById(`cfg-${f}`);
    body[f] = (f === 'responseDelaySeconds' || f === 'pauseDurationMinutes') ? Number(el.value) : el.value;
  });
  body.groqModel = getModelValue('cfg-groqModel', 'cfg-groqModel-custom');
  body.openaiModel = getModelValue('cfg-openaiModel', 'cfg-openaiModel-custom');
  body.deepseekModel = getModelValue('cfg-deepseekModel', 'cfg-deepseekModel-custom');
  body.confirmOrderDataBeforeClosing = document.getElementById('cfg-confirmOrderDataBeforeClosing').checked;
  body.dropiUseTestEnv = document.getElementById('cfg-dropiUseTestEnv').checked;
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const saved = document.getElementById(savedLabelId);
  saved.textContent = 'Guardado ✔';
  setTimeout(() => (saved.textContent = ''), 2000);
}
document.getElementById('saveConfigBtn').addEventListener('click', () => saveMainConfig('configSaved'));
document.getElementById('saveAiProviderBtn').addEventListener('click', () => saveMainConfig('aiProviderSaved'));

// Botón propio para la tarjeta de voz — guarda API key, Group ID y el modo de voz.
document.getElementById('saveVoiceConfigBtn').addEventListener('click', async () => {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      minimaxApiKey: document.getElementById('cfg-minimaxApiKey').value,
      minimaxGroupId: document.getElementById('cfg-minimaxGroupId').value,
      voiceMode: document.getElementById('cfg-voiceMode').value,
    }),
  });
  const saved = document.getElementById('voiceConfigSaved');
  saved.textContent = 'Guardado ✔';
  setTimeout(() => (saved.textContent = ''), 2000);
});

// ---------- Voz clonada (MiniMax) ----------
function updateVoiceCloneStatus(cfg) {
  const el = document.getElementById('voiceCloneStatus');
  if (cfg.minimaxVoiceId) {
    el.textContent = `✔ Ya tienes una voz clonada (${cfg.minimaxVoiceId}). Puedes clonar otra para reemplazarla.`;
    el.style.color = '#16a34a';
  } else {
    el.textContent = 'Todavía no has clonado ninguna voz.';
    el.style.color = '';
  }
}

document.getElementById('cloneVoiceBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('voice-sample');
  const statusEl = document.getElementById('voiceCloneStatus');
  const file = fileInput.files[0];
  if (!file) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Primero elige un archivo de audio (mínimo 30 segundos).';
    return;
  }
  // Guarda primero la API Key y Group ID actuales, para que el servidor
  // ya las tenga disponibles al clonar.
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      minimaxApiKey: document.getElementById('cfg-minimaxApiKey').value,
      minimaxGroupId: document.getElementById('cfg-minimaxGroupId').value,
    }),
  });

  statusEl.style.color = '';
  statusEl.textContent = 'Clonando voz, puede tardar un momento...';

  const formData = new FormData();
  formData.append('sample', file);
  try {
    const res = await fetch('/api/voice/clone', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.ok) {
      statusEl.style.color = '#16a34a';
      statusEl.textContent = `✔ ${data.message} (ID: ${data.voiceId})`;
    } else {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = data.error || 'No se pudo clonar la voz.';
    }
  } catch (err) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Error de conexión al clonar la voz.';
  }
});

// ---------- Lista de voces clonadas (elegir cuál usar) ----------
document.getElementById('listVoicesBtn').addEventListener('click', async () => {
  const listDiv = document.getElementById('voiceList');
  listDiv.innerHTML = 'Consultando tus voces en MiniMax...';
  try {
    const data = await fetch('/api/voice/list').then((r) => r.json());
    if (data.error) {
      listDiv.innerHTML = `<span style="color:#dc2626">${data.error}</span>`;
      return;
    }
    if (!data.voices || data.voices.length === 0) {
      listDiv.innerHTML = '<span class="hint small">Todavía no tienes voces activas. Recuerda: una voz clonada solo aparece aquí después de usarse al menos una vez para generar audio.</span>';
      return;
    }
    listDiv.innerHTML = data.voices
      .map((v) => {
        const isCurrent = v.voice_id === data.currentVoiceId;
        return `
          <div class="product-item" style="padding:10px">
            <div class="info">
              <b>${v.voice_id}</b>
              <div class="kw">Clonada el ${v.created_time || '?'}${isCurrent ? ' · <span style="color:#16a34a;font-weight:700">✔ en uso</span>' : ''}</div>
            </div>
            <div class="actions">
              <button data-use-voice="${v.voice_id}" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'En uso' : 'Usar esta'}</button>
            </div>
          </div>
        `;
      })
      .join('');

    listDiv.querySelectorAll('[data-use-voice]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch('/api/voice/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceId: btn.dataset.useVoice }),
        });
        document.getElementById('listVoicesBtn').click(); // refresca la lista
        updateVoiceCloneStatus(await fetch('/api/config').then((r) => r.json()));
      });
    });
  } catch (err) {
    listDiv.innerHTML = `<span style="color:#dc2626">Error: ${err.message}</span>`;
  }
});

// ---------- Probar la voz clonada (solo se escucha aquí, no se envía a nadie) ----------
document.getElementById('previewVoiceBtn').addEventListener('click', async () => {
  const btn = document.getElementById('previewVoiceBtn');
  const statusEl = document.getElementById('voicePreviewStatus');
  const audioEl = document.getElementById('voicePreviewAudio');
  const text = document.getElementById('voice-preview-text').value.trim();

  if (!text) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Escribe algo para probar (o deja el mensaje sugerido).';
    return;
  }

  btn.disabled = true;
  statusEl.style.color = '';
  statusEl.textContent = 'Generando audio de prueba...';
  audioEl.style.display = 'none';

  try {
    const res = await fetch('/api/voice/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.style.color = '#16a34a';
      statusEl.textContent = '✔ Listo, dale play abajo.';
      audioEl.src = `data:audio/mp3;base64,${data.audioBase64}`;
      audioEl.style.display = 'block';
      audioEl.play().catch(() => {}); // si el navegador bloquea autoplay, igual queda listo para darle play a mano
    } else {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = data.error || 'No se pudo generar el audio.';
    }
  } catch (err) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Error de conexión al generar el audio.';
  } finally {
    btn.disabled = false;
  }
});

// ---------- Clientes (CRM: tablero + chat en vivo + panel derecho + pausas) ----------
const STATUS_COLUMNS = [
  { key: 'nuevo', label: '🆕 Nuevo', color: '#64748b' },
  { key: 'conversando', label: '💬 En conversación', color: '#3b82f6' },
  { key: 'interesado', label: '🔥 Interesado', color: '#f97316' },
  { key: 'programado', label: '📅 Programado', color: '#a855f7' },
  { key: 'comprado', label: '✅ Compra confirmada', color: '#16a34a' },
  { key: 'guia_generada', label: '📦 Guía generada', color: '#8b5cf6' },
  { key: 'en_camino', label: '🚚 En camino', color: '#0ea5e9' },
  { key: 'con_novedad', label: '⚠️ Con novedad', color: '#ef4444' },
  { key: 'intento_cancelacion', label: '🟠 Intento de cancelación', color: '#f97316' },
  { key: 'entregado', label: '📬 Entregado', color: '#059669' },
  { key: 'devuelto', label: '↩️ Devuelto', color: '#eab308' },
  { key: 'cancelado', label: '❌ Cancelado', color: '#dc2626' },
];
const STATUS_LABELS = Object.fromEntries(STATUS_COLUMNS.map((c) => [c.key, c]));

// Estados exclusivos de Pedidos — "Nuevo/En conversación/Interesado/Compra
// confirmada" son etapas de CONVERSACIÓN con el cliente (viven en el Tablero
// de Clientes de arriba). Un pedido nace directamente en Pendiente, y pasa a
// Confirmado apenas se sube a Dropi/Skydropx con éxito.
const ORDER_STATUS_COLUMNS = [
  { key: 'pendiente', label: '🟡 Pendiente', color: '#f59e0b' },
  { key: 'confirmado', label: '✅ Confirmado', color: '#16a34a' },
  { key: 'guia_generada', label: '📦 Guía generada', color: '#8b5cf6' },
  { key: 'en_camino', label: '🚚 En camino', color: '#0ea5e9' },
  { key: 'con_novedad', label: '⚠️ Con novedad', color: '#ef4444' },
  { key: 'intento_cancelacion', label: '🟠 Intento de cancelación', color: '#f97316' },
  { key: 'entregado', label: '📬 Entregado', color: '#059669' },
  { key: 'devuelto', label: '↩️ Devuelto', color: '#eab308' },
  { key: 'cancelado', label: '❌ Cancelado', color: '#dc2626' },
];
const TAG_LABELS = {
  lead: { label: '🆕 Lead', color: '#64748b' },
  interesado: { label: '🔥 Interesado', color: '#f97316' },
  cliente: { label: '✅ Cliente', color: '#16a34a' },
  descartado: { label: '❌ Descartado', color: '#9ca3af' },
};

let selectedClientJid = null;
let clientsCache = [];
let productsCacheForRp = [];
let colombiaDataCache = null;

async function loadColombiaData() {
  if (colombiaDataCache) return colombiaDataCache;
  colombiaDataCache = await fetch('/api/colombia').then((r) => r.json());
  return colombiaDataCache;
}

async function populateDepartmentSelect(deptSelectId, citySelectId) {
  const data = await loadColombiaData();
  const deptSelect = document.getElementById(deptSelectId);
  const citySelect = document.getElementById(citySelectId);
  deptSelect.innerHTML = '<option value="">Elegir...</option>' + Object.keys(data).sort().map((d) => `<option value="${d}">${d}</option>`).join('');
  deptSelect.onchange = () => {
    const cities = data[deptSelect.value] || [];
    citySelect.innerHTML = cities.length
      ? '<option value="">Elegir...</option>' + cities.map((c) => `<option value="${c}">${c}</option>`).join('')
      : '<option value="">Elegir departamento primero</option>';
  };
}

function populateManualOrderProducts() {
  const select = document.getElementById('mo-product');
  select.innerHTML = '<option value="">Elegir producto...</option>' + productsCacheForRp.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
}

function checkDuplicateOrderWarning(client) {
  const warningEl = document.getElementById('moDuplicateWarning');
  const UNRESOLVED = ['pendiente', 'confirmado', 'guia_generada', 'en_camino'];
  const duplicate = ordersCache.find(
    (o) =>
      (o.clientJid === client?.jid || o.clientPhone === client?.phone) &&
      UNRESOLVED.includes(o.status) &&
      Date.now() - o.createdAt < 24 * 60 * 60 * 1000
  );
  if (duplicate) {
    warningEl.style.display = 'block';
    warningEl.textContent = `⚠️ Este cliente ya tiene un pedido reciente sin resolver (${duplicate.id}) — si creas otro, van a quedar dos pedidos por separado.`;
  } else {
    warningEl.style.display = 'none';
  }
}

let activeTagFilter = 'todos';
let activeDateFilter = 'todas';
let clientSearchText = '';
let customDateRange = null; // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } | null
let activeBoardDateFilter = 'todas';
let boardCustomDateRange = null;

const AVATAR_COLORS = ['#3b82f6', '#f97316', '#16a34a', '#a855f7', '#ec4899', '#0ea5e9', '#eab308', '#ef4444'];
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}
function getAvatarColor(seed) {
  const str = String(seed || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function avatarHtml(name, phone, size = 36) {
  const initials = getInitials(name || phone);
  const color = getAvatarColor(name || phone);
  return `<div class="avatar" style="background:${color};width:${size}px;height:${size}px;font-size:${size * 0.38}px">${initials}</div>`;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// Los <input type="date"> dan "YYYY-MM-DD" — parsear eso con `new Date(texto)`
// lo interpreta como medianoche en UTC, no en tu hora local, y mezclado con
// .setHours() (que sí usa la hora local) el rango queda desalineado — a veces
// "desde" terminaba después de "hasta", vaciando la lista entera. Separando
// los números a mano se evita ese lío de zona horaria.
function parseLocalDateInput(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isWithinDateFilter(ts, filter, customRange) {
  const range = customRange !== undefined ? customRange : customDateRange;
  if (range && range.from && range.to) {
    if (!ts) return false;
    const t = new Date(ts).setHours(0, 0, 0, 0);
    const from = parseLocalDateInput(range.from).setHours(0, 0, 0, 0);
    const to = parseLocalDateInput(range.to).setHours(23, 59, 59, 999);
    return t >= from && t <= to;
  }
  if (!ts || filter === 'todas') return true;
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (filter === 'hoy') return startOfDay(d) === startOfDay(now);
  if (filter === 'ayer') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return startOfDay(d) === startOfDay(yesterday);
  }
  if (filter === '7dias') return ts >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return true;
}

async function loadClients() {
  const listDiv = document.getElementById('clientList');
  if (listDiv && !clientsCache.length) {
    listDiv.innerHTML = `<div style="text-align:center;padding:20px"><span class="loading-spinner"></span></div>`;
  }
  clientsCache = await fetch('/api/clients').then((r) => r.json());
  renderBoard();
  renderClientList();
}

document.getElementById('refreshClientsBtn').addEventListener('click', loadClients);
document.getElementById('refreshBoardBtn').addEventListener('click', loadClients);

document.querySelectorAll('#boardDateFilters .filter-chip[data-board-date]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#boardDateFilters .filter-chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeBoardDateFilter = btn.dataset.boardDate;
    boardCustomDateRange = null;
    renderBoard();
  });
});
setupDateRangePicker('boardDateRangeBtn', 'boardDateRangePicker', 'boardDateFrom', 'boardDateTo', 'boardDateRangeApplyBtn', '#boardDateFilters .filter-chip', (range) => {
  boardCustomDateRange = range;
  renderBoard();
});

document.querySelectorAll('#chatsTagFilters .filter-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chatsTagFilters .filter-chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTagFilter = btn.dataset.filterTag;
    renderClientList();
  });
});
document.querySelectorAll('#chatsDateFilters .filter-chip[data-filter-date]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chatsDateFilters .filter-chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeDateFilter = btn.dataset.filterDate;
    customDateRange = null;
    renderClientList();
  });
});
document.getElementById('chatSearchInput').addEventListener('input', (e) => {
  clientSearchText = e.target.value;
  renderClientList();
});

// ---- Calendario de rango de fechas (reutilizable en Chats, Pedidos y Tableros) ----
function setupDateRangePicker(btnId, pickerId, fromId, toId, applyId, chipsSelector, onApply) {
  const btn = document.getElementById(btnId);
  const picker = document.getElementById(pickerId);
  if (!btn || !picker) return;
  btn.addEventListener('click', () => {
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById(applyId).addEventListener('click', () => {
    const from = document.getElementById(fromId).value;
    const to = document.getElementById(toId).value;
    if (!from || !to) {
      showToast('Elige las dos fechas (desde y hasta)', 'error');
      return;
    }
    document.querySelectorAll(chipsSelector).forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    onApply({ from, to });
    picker.style.display = 'none';
  });
}
setupDateRangePicker('chatsDateRangeBtn', 'chatsDateRangePicker', 'chatsDateFrom', 'chatsDateTo', 'chatsDateRangeApplyBtn', '#chatsDateFilters .filter-chip', (range) => {
  customDateRange = range;
  renderClientList();
});

// ---- Vista de Tablero ----
function renderBoard() {
  const container = document.getElementById('crmBoardColumns');
  if (!container) return;
  container.innerHTML = '';
  const dateFiltered = clientsCache.filter((c) => isWithinDateFilter(c.lastMessageAt, activeBoardDateFilter, boardCustomDateRange));
  STATUS_COLUMNS.forEach((col) => {
    const clientsInCol = dateFiltered.filter((c) => c.status === col.key);
    const colDiv = document.createElement('div');
    colDiv.className = 'board-column';
    colDiv.innerHTML = `
      <div class="board-column-header" style="color:${col.color}">
        <span>${col.label}</span><span>${clientsInCol.length}</span>
      </div>
      <div class="board-cards"></div>
    `;
    const cardsDiv = colDiv.querySelector('.board-cards');
    if (clientsInCol.length === 0) {
      cardsDiv.innerHTML = `<div class="empty-state" style="padding:16px 8px"><span class="empty-icon" style="font-size:1.3rem">📭</span>Nadie aquí todavía</div>`;
    }
    clientsInCol
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .forEach((c) => {
        const isPausedNow = c.pausedUntil && c.pausedUntil > Date.now();
        const card = document.createElement('div');
        card.className = 'board-card';
        const optionsHtml = STATUS_COLUMNS.map(
          (s) => `<option value="${s.key}" ${s.key === c.status ? 'selected' : ''}>${s.label}</option>`
        ).join('');
        card.innerHTML = `
          <div class="avatar-row">
            ${avatarHtml(c.name, c.phone, 26)}
            <div style="min-width:0;flex:1">
              <div class="board-card-name">${c.name || c.phone}</div>
              <div class="board-card-meta">${formatTime(c.lastMessageAt)}${isPausedNow ? ' · ⏸️ pausado' : ''}</div>
            </div>
          </div>
          <select data-jid="${c.jid}">${optionsHtml}</select>
        `;
        card.querySelector('.board-card-name').addEventListener('click', () => {
          document.querySelector('.nav-item[data-tab="chats"]').click();
          selectClient(c.jid);
        });
        const select = card.querySelector('select');
        select.addEventListener('click', (e) => e.stopPropagation());
        select.addEventListener('change', async () => {
          await fetch(`/api/clients/${encodeURIComponent(c.jid)}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: select.value }),
          });
        });
        cardsDiv.appendChild(card);
      });
    container.appendChild(colDiv);
  });
}

// ---- Vista de Chats: lista con filtros ----
function renderClientList() {
  const listDiv = document.getElementById('clientList');
  if (!listDiv) return;
  const searchLower = clientSearchText.trim().toLowerCase();
  const filtered = clientsCache
    .filter((c) => activeTagFilter === 'todos' || (c.tag || 'lead') === activeTagFilter)
    .filter((c) => isWithinDateFilter(c.lastMessageAt, activeDateFilter))
    .filter((c) => !searchLower || (c.name || '').toLowerCase().includes(searchLower) || (c.phone || '').includes(searchLower));

  listDiv.innerHTML = '';
  if (filtered.length === 0) {
    listDiv.innerHTML = `<div class="empty-state"><span class="empty-icon">📭</span>No hay clientes que coincidan con este filtro.</div>`;
    return;
  }

  filtered.forEach((c) => {
      const statusInfo = STATUS_LABELS[c.status] || { label: c.status, color: '#6b7280' };
      const isPausedNow = c.pausedUntil && c.pausedUntil > Date.now();
      const tagIcon = { cliente: '✅', interesado: '🔥', descartado: '❌', lead: '' }[c.tag || 'lead'] || '';
      const item = document.createElement('div');
      item.className = 'client-list-item' + (c.jid === selectedClientJid ? ' selected' : '');
      item.innerHTML = `
        <div class="avatar-row">
          ${avatarHtml(c.name, c.phone, 32)}
          <div style="min-width:0;flex:1">
            <div class="name">${c.name || c.phone}</div>
            <div class="meta" style="color:${statusInfo.color}">${statusInfo.label}${isPausedNow ? ' · ⏸️ Pausado' : ''}</div>
            <div class="time">${formatTime(c.lastMessageAt)}</div>
          </div>
          ${tagIcon ? `<span style="font-size:1.1rem" title="${c.tag}">${tagIcon}</span>` : ''}
        </div>
      `;
      item.addEventListener('click', () => {
        selectClient(c.jid);
        if (window.innerWidth <= 860) showMobileChatView();
      });
      listDiv.appendChild(item);
    });
}

async function selectClient(jid) {
  selectedClientJid = jid;
  renderClientList();

  const client = clientsCache.find((c) => c.jid === jid);
  document.getElementById('chatHeader').innerHTML = `<b>${client?.name || client?.phone || jid.split('@')[0]}</b>`;

  document.getElementById('chatsRightPanel').style.display = 'flex';
  renderRightPanel(client);

  const messages = await fetch(`/api/clients/${encodeURIComponent(jid)}/messages`).then((r) => r.json());
  renderMessages(messages);
}

function renderMessages(messages) {
  const container = document.getElementById('chatMessages');
  container.innerHTML = '';
  messages.forEach((m) => appendMessageBubble(m));
  container.scrollTop = container.scrollHeight;
}

function appendMessageBubble(m) {
  const container = document.getElementById('chatMessages');
  const bubble = document.createElement('div');
  const labels = { client: 'Cliente', bot: 'Ángela', owner: 'Tú' };
  bubble.className = `chat-bubble ${m.from || 'client'}`;

  let mediaHtml = '';
  if (m.type === 'image' && m.mediaUrl) {
    mediaHtml = `<img src="${m.mediaUrl}" />`;
  } else if (m.type === 'video' && m.mediaUrl) {
    mediaHtml = `<video controls src="${m.mediaUrl}" style="max-width:220px;border-radius:8px;display:block;margin-top:4px"></video>`;
  } else if ((m.type === 'audio' || m.type === 'voice') && m.mediaUrl) {
    mediaHtml = `<audio controls src="${m.mediaUrl}"></audio>`;
  }
  const icon = m.type === 'voice' && !m.mediaUrl ? '🎙️ ' : '';

  bubble.innerHTML = `
    <div class="bubble-meta">${labels[m.from] || m.from} · ${formatTime(m.timestamp)}</div>
    <div>${icon}${(m.text || '').replace(/</g, '&lt;')}</div>
    ${mediaHtml}
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// ---- Panel derecho: info fija + acciones con scroll ----
async function loadProductsForRp() {
  productsCacheForRp = await fetch('/api/products').then((r) => r.json());
}
loadProductsForRp();

function renderRightPanel(client) {
  if (!client) return;
  const tag = client.tag || 'lead';
  document.getElementById('rpName').textContent = client.name || client.phone;
  document.getElementById('rpPhone').textContent = client.phone;
  document.getElementById('rpTag').value = tag;
  document.getElementById('rpNotes').value = client.notes || '';

  const od = client.orderData || {};
  const fichaFieldDefs = [
    ['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['producto', 'Producto'], ['cantidad', 'Cantidad'],
    ['direccion', 'Dirección'], ['ciudad', 'Ciudad'], ['departamento', 'Departamento'], ['barrio', 'Barrio (opcional)'],
  ];
  const fichaHtml = fichaFieldDefs
    .map(([key, label]) => `
      <label style="margin-top:8px;font-size:0.78rem">${label}</label>
      <input type="text" class="ficha-field" data-field="${key}" value="${(od[key] || '').replace(/"/g, '&quot;')}" style="padding:8px 10px;font-size:0.85rem" />
    `)
    .join('') +
    `<label style="margin-top:8px;font-size:0.78rem">Tipo de entrega</label>
     <select class="ficha-field" data-field="tipoEntrega" style="padding:8px 10px;font-size:0.85rem">
       <option value="" ${!od.tipoEntrega ? 'selected' : ''}>(falta)</option>
       <option value="domicilio" ${od.tipoEntrega === 'domicilio' ? 'selected' : ''}>Domicilio</option>
       <option value="oficina" ${od.tipoEntrega === 'oficina' ? 'selected' : ''}>Oficina</option>
     </select>`;
  document.getElementById('rpOrderData').innerHTML = fichaHtml;

  const scheduleStatusEl = document.getElementById('rpScheduleStatus');
  if (client.scheduledDelivery) {
    scheduleStatusEl.textContent = `Programado para ${client.scheduledDelivery.date}${client.scheduledDelivery.reminderSent ? ' — recordatorio ya enviado' : ' — recordatorio pendiente (se manda 2 días antes)'}`;
  } else {
    scheduleStatusEl.textContent = '';
  }
  document.getElementById('rpScheduleDate').value = client.scheduledDelivery?.date || '';

  const statusSelect = document.getElementById('rpStatusSelect');
  statusSelect.innerHTML = STATUS_COLUMNS.map(
    (s) => `<option value="${s.key}" ${s.key === client.status ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  const productSelect = document.getElementById('rpProductSelect');
  productSelect.innerHTML =
    '<option value="">Elegir producto...</option>' +
    productsCacheForRp.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  document.getElementById('rpWhatsappLink').href = `https://wa.me/${client.phone}`;

  const isPausedNow = client.pausedUntil && client.pausedUntil > Date.now();
  const aiStatusEl = document.getElementById('rpAiStatus');
  if (isPausedNow) {
    const remainingYears = (client.pausedUntil - Date.now()) / (365 * 24 * 60 * 60 * 1000);
    aiStatusEl.innerHTML =
      remainingYears > 1
        ? '⏸️ Pausado indefinidamente <button id="rpResumeBtn" class="cancel-btn" style="margin:4px 0 0">▶ Reanudar</button>'
        : `⏸️ Pausado hasta las ${new Date(client.pausedUntil).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })} <button id="rpResumeBtn" class="cancel-btn" style="margin:4px 0 0">▶ Reanudar</button>`;
    const resumeBtn = document.getElementById('rpResumeBtn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async () => {
        await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/resume`, { method: 'POST' });
      });
    }
  } else {
    aiStatusEl.textContent = '🤖 La IA está respondiendo aquí';
  }
}

document.getElementById('rpTag').addEventListener('change', async (e) => {
  if (!selectedClientJid) return;
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/tag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag: e.target.value }),
  });
});

document.getElementById('rpSaveNotesBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: document.getElementById('rpNotes').value }),
  });
  showToast('Nota guardada.');
});

document.getElementById('rpSaveOrderDataBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const orderData = {};
  document.querySelectorAll('#rpOrderData .ficha-field').forEach((el) => {
    orderData[el.dataset.field] = el.value;
  });
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/order-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderData }),
  });
  showToast('Ficha de datos guardada.');
});

document.getElementById('rpStatusSelect').addEventListener('change', async (e) => {
  if (!selectedClientJid) return;
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: e.target.value }),
  });
});

document.getElementById('rpPauseSelect').addEventListener('change', async (e) => {
  if (!selectedClientJid || !e.target.value) return;
  const body = e.target.value === 'indefinite' ? { indefinite: true } : { minutes: Number(e.target.value) };
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  e.target.value = '';
});

document.getElementById('rpActivateBotBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const btn = document.getElementById('rpActivateBotBtn');
  btn.disabled = true;
  btn.textContent = 'Activando...';
  const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/activate-bot`, { method: 'POST' }).then((r) => r.json());
  btn.disabled = false;
  btn.textContent = '🤖 Activar bot (re-disparar último mensaje)';
  if (!res.ok) showToast(res.error || 'No se pudo activar el bot', 'error');
});

document.getElementById('rpActivateProductBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const productId = document.getElementById('rpProductSelect').value;
  if (!productId) return showToast('Elige un producto primero', 'error');
  const btn = document.getElementById('rpActivateProductBtn');
  btn.disabled = true;
  const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/activate-product`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId }),
  }).then((r) => r.json());
  btn.disabled = false;
  if (!res.ok) showToast(res.error || 'No se pudo activar el asistente', 'error');
});

document.getElementById('rpScheduleDeliveryBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const date = document.getElementById('rpScheduleDate').value;
  if (!date) return showToast('Elige una fecha primero', 'error');
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/schedule-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
  showToast('Entrega programada — se le recordará al cliente 2 días antes.');
});

document.getElementById('rpManualOrderBtn').addEventListener('click', () => {
  if (!selectedClientJid) return;
  const client = clientsCache.find((c) => c.jid === selectedClientJid);
  document.getElementById('mo-clientName').value = client?.orderData?.nombre || client?.name || '';
  // Preferimos el teléfono que el cliente escribió en la conversación (guardado
  // en la ficha de datos) sobre el número de WhatsApp/Baileys, que a veces no
  // es el real — si no hay ninguno guardado, se deja vacío para escribirlo a mano.
  document.getElementById('mo-clientPhone').value = client?.orderData?.telefono || '';
  populateManualOrderProducts();
  document.getElementById('mo-product').value = '';
  document.getElementById('mo-quantity').value = 1;
  document.getElementById('mo-price').value = '';
  document.getElementById('mo-address').value = client?.orderData?.direccion || '';
  populateDepartmentSelect('mo-department', 'mo-city');
  document.getElementById('mo-department').value = '';
  document.getElementById('mo-city').innerHTML = '<option value="">Elegir departamento primero</option>';
  document.getElementById('mo-neighborhood').value = client?.orderData?.barrio || '';
  checkDuplicateOrderWarning(client);
  document.getElementById('manualOrderOverlay').style.display = 'flex';
});
document.getElementById('closeManualOrderBtn').addEventListener('click', () => {
  document.getElementById('manualOrderOverlay').style.display = 'none';
});
document.getElementById('saveManualOrderBtn').addEventListener('click', async () => {
  const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/manual-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: document.getElementById('mo-clientName').value,
      clientPhone: document.getElementById('mo-clientPhone').value,
      product: document.getElementById('mo-product').value,
      quantity: Number(document.getElementById('mo-quantity').value) || 1,
      price: document.getElementById('mo-price').value,
      deliveryType: document.getElementById('mo-deliveryType').value,
      address: document.getElementById('mo-address').value,
      department: document.getElementById('mo-department').value,
      city: document.getElementById('mo-city').value,
      neighborhood: document.getElementById('mo-neighborhood').value,
    }),
  }).then((r) => r.json());
  document.getElementById('manualOrderOverlay').style.display = 'none';
  showToast(`Pedido ${res.id} creado.`);
});

// ---- Plantilla manual "Guía generada" — jala todo del pedido, editable antes de enviar ----
let guideTemplateOrder = null;

function buildGuideTemplateText(order, guideNumber, transportadora) {
  const lines = [
    `¡Hola ${order.clientName || ''}! 😊 Tu pedido *${order.product || ''}* ya tiene guía generada 📦`,
    ``,
    `N° de guía: ${guideNumber || '(pendiente)'}`,
    `Transportadora: ${transportadora || '(pendiente)'}`,
    `Precio: ${order.price || ''}`,
    ``,
    `Usa este número para rastrear tu pedido — llega en aproximadamente 3 a 6 días hábiles.`,
    `¡Gracias por tu compra! 🎉`,
  ];
  return lines.join('\n');
}

document.getElementById('rpGuideTemplateBtn').addEventListener('click', () => {
  if (!selectedClientJid) return;
  guideTemplateOrder = ordersCache
    .filter((o) => o.clientJid === selectedClientJid)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  document.getElementById('guideTemplateOverlay').style.display = 'flex';
  if (!guideTemplateOrder) {
    document.getElementById('guideTemplateNoOrder').style.display = 'block';
    document.getElementById('guideTemplateFields').style.display = 'none';
    return;
  }
  document.getElementById('guideTemplateNoOrder').style.display = 'none';
  document.getElementById('guideTemplateFields').style.display = 'block';
  document.getElementById('gt-guideNumber').value = guideTemplateOrder.dropiGuideNumber || '';
  document.getElementById('gt-transportadora').value = guideTemplateOrder.transportadora || '';
  document.getElementById('gt-message').value = buildGuideTemplateText(
    guideTemplateOrder,
    guideTemplateOrder.dropiGuideNumber,
    guideTemplateOrder.transportadora
  );
});
document.getElementById('closeGuideTemplateBtn').addEventListener('click', () => {
  document.getElementById('guideTemplateOverlay').style.display = 'none';
});
document.getElementById('regenerateGuideTemplateBtn').addEventListener('click', () => {
  if (!guideTemplateOrder) return;
  document.getElementById('gt-message').value = buildGuideTemplateText(
    guideTemplateOrder,
    document.getElementById('gt-guideNumber').value,
    document.getElementById('gt-transportadora').value
  );
});
document.getElementById('sendGuideTemplateBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: document.getElementById('gt-message').value }),
  }).then((r) => r.json());
  if (!res.ok) return showToast(res.error || 'No se pudo enviar', 'error');

  // Guarda también el número de guía/transportadora en el pedido, si se cambiaron aquí.
  if (guideTemplateOrder) {
    await fetch(`/api/orders/${guideTemplateOrder.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dropiGuideNumber: document.getElementById('gt-guideNumber').value,
        transportadora: document.getElementById('gt-transportadora').value,
        status: 'guia_generada',
      }),
    });
  }
  document.getElementById('guideTemplateOverlay').style.display = 'none';
  showToast('Mensaje de guía enviado.');
});

document.getElementById('rpExportChatBtn').addEventListener('click', async () => {
  if (!selectedClientJid) return;
  const client = clientsCache.find((c) => c.jid === selectedClientJid);
  const messages = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/messages`).then((r) => r.json());
  const labels = { client: client?.name || client?.phone || 'Cliente', bot: 'Ángela', owner: 'Tú' };
  const lines = messages.map((m) => `[${formatTime(m.timestamp)}] ${labels[m.from] || m.from}: ${m.text || `(${m.type})`}`);
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Conversación copiada — pégala donde quieras.');
  } catch (e) {
    showToast('No se pudo copiar automático — revisa los permisos del navegador.', 'error');
  }
});
document.getElementById('rpDeleteChatBtn').addEventListener('click', () => deleteSelectedChat(selectedClientJid));

async function deleteSelectedChat(jid) {
  const client = clientsCache.find((c) => c.jid === jid);
  const label = client?.name || client?.phone || jid.split('@')[0];
  if (!confirm(`¿Borrar TODA la conversación con ${label}? Esto borra el chat, la memoria de la IA, y su estado en el CRM. No se puede deshacer.`)) return;
  const res = await fetch(`/api/clients/${encodeURIComponent(jid)}`, { method: 'DELETE' }).then((r) => r.json());
  if (!res.ok) return showToast(res.error || 'No se pudo borrar el chat', 'error');
  selectedClientJid = null;
  document.getElementById('chatHeader').textContent = 'Selecciona un cliente de la lista →';
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('chatsRightPanel').style.display = 'none';
  loadClients();
}

// ---- Enviar texto / imagen / audio ----
document.getElementById('chatSendBtn').addEventListener('click', async () => {
  const input = document.getElementById('chatReplyInput');
  const text = input.value.trim();
  if (!selectedClientJid) return;

  const mediaFile = document.getElementById('chatMediaInput').files[0];
  if (mediaFile) {
    const formData = new FormData();
    formData.append('media', mediaFile);
    const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send-media`, { method: 'POST', body: formData }).then((r) => r.json());
    if (!res.ok) showToast(res.error || 'No se pudo enviar el archivo', 'error');
    document.getElementById('chatMediaInput').value = '';
  }

  if (text) {
    input.value = '';
    const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());
    if (!res.ok) showToast(res.error || 'No se pudo enviar', 'error');
  }
});
document.getElementById('chatReplyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('chatSendBtn').click();
});
document.getElementById('chatMediaInput').addEventListener('change', () => {
  const file = document.getElementById('chatMediaInput').files[0];
  if (file) document.getElementById('chatReplyInput').placeholder = `Adjunto: ${file.name} (dale Enviar)`;
});

// ---- Grabar nota de voz con el micrófono, tipo WhatsApp ----
// Clic para empezar a grabar, clic de nuevo para parar y enviar solo.
// Nota: esto necesita "contexto seguro" del navegador (localhost sí sirve,
// pero acceder por la IP de red tipo 192.168.x.x por http:// normalmente NO
// — es una restricción de seguridad de los navegadores, no un bug nuestro).
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = null;
let recordingTimerInterval = null;
const recordBtn = document.getElementById('recordVoiceBtn');

recordBtn.addEventListener('click', async () => {
  if (!selectedClientJid) {
    showToast('Selecciona un cliente primero', 'error');
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // el propio onstop se encarga de mandar el audio
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recordingTimerInterval);
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎤';

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 800) return; // grabación demasiado corta (clic accidental), no se manda

      const formData = new FormData();
      formData.append('recording', blob, 'nota-de-voz.webm');
      recordBtn.disabled = true;
      try {
        const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send-voice-recording`, {
          method: 'POST',
          body: formData,
        }).then((r) => r.json());
        if (!res.ok) showToast(res.error || 'No se pudo enviar la nota de voz', 'error');
      } catch (err) {
        showToast('Error de conexión al enviar la nota de voz.', 'error');
      } finally {
        recordBtn.disabled = false;
      }
    };

    mediaRecorder.start();
    recordingStartedAt = Date.now();
    recordBtn.classList.add('recording');
    recordBtn.textContent = '⏹️ 0:00';
    recordingTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - recordingStartedAt) / 1000);
      const mm = Math.floor(secs / 60);
      const ss = String(secs % 60).padStart(2, '0');
      recordBtn.textContent = `⏹️ ${mm}:${ss}`;
    }, 500);
  } catch (err) {
    showToast(
      'No se pudo acceder al micrófono. Si estás entrando desde otro dispositivo por la IP de red (no localhost), el navegador bloquea el micrófono por seguridad — usa la PC directamente, o configura HTTPS.',
      'error'
    );
  }
});

// ---- Navegación móvil (lista <-> chat <-> panel) ----
function showMobileChatView() {
  document.querySelector('.chats-sidebar').classList.remove('mobile-visible');
  document.querySelector('.chats-main').classList.add('mobile-visible');
  document.getElementById('chatsRightPanel').classList.remove('mobile-visible');
}
document.getElementById('mobileBackToListBtn')?.addEventListener('click', () => {
  document.querySelector('.chats-sidebar').classList.add('mobile-visible');
  document.querySelector('.chats-main').classList.remove('mobile-visible');
});
document.getElementById('mobileOpenPanelBtn')?.addEventListener('click', () => {
  document.querySelector('.chats-main').classList.remove('mobile-visible');
  document.getElementById('chatsRightPanel').classList.add('mobile-visible');
});
document.getElementById('mobileClosePanelBtn')?.addEventListener('click', () => {
  document.getElementById('chatsRightPanel').classList.remove('mobile-visible');
  document.querySelector('.chats-main').classList.add('mobile-visible');
});

// ---- Actualizaciones en vivo ----
socket.on('chatMessage', ({ jid, entry }) => {
  if (jid === selectedClientJid) appendMessageBubble(entry);
  loadClients();
});
socket.on('clientUpdate', ({ jid, client }) => {
  loadClients();
  if (jid === selectedClientJid) renderRightPanel(client);
});
socket.on('pauseUpdate', async ({ jid, pausedUntil }) => {
  await loadClients();
  if (jid === selectedClientJid) {
    const client = clientsCache.find((c) => c.jid === jid);
    if (client) renderRightPanel(client);
  }
});
socket.on('clientDeleted', ({ jid }) => {
  loadClients();
  if (jid === selectedClientJid) {
    selectedClientJid = null;
    document.getElementById('chatHeader').textContent = 'Selecciona un cliente de la lista →';
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('chatsRightPanel').style.display = 'none';
  }
});

// En celular, arranca mostrando la lista de clientes (no el chat vacío ni el
// panel derecho) — sin esto, ninguna de las tres columnas se vería al abrir.
if (window.innerWidth <= 860) {
  document.querySelector('.chats-sidebar').classList.add('mobile-visible');
}

loadClients();

// ---------- Pedidos ----------
let ordersCache = [];
let activeOrderDateFilter = 'todas';
let ordersCustomDateRange = null;
let editingOrderId = null;
let orderSearchText = '';
let selectedOrderIds = new Set();

async function loadOrders() {
  const tbody = document.getElementById('pedidosTableBody');
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px"><span class="loading-spinner"></span></td></tr>`;
  ordersCache = await fetch('/api/orders').then((r) => r.json());
  selectedOrderIds.clear();
  renderOrderStats();
  renderOrdersTable();
}
document.getElementById('refreshOrdersBtn').addEventListener('click', loadOrders);

document.getElementById('orderStatusFilter').innerHTML +=
  ORDER_STATUS_COLUMNS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');
document.getElementById('orderStatusFilter').addEventListener('change', renderOrdersTable);

document.getElementById('orderSearchInput').addEventListener('input', (e) => {
  orderSearchText = e.target.value;
  renderOrdersTable();
});

document.querySelectorAll('[data-order-date]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-order-date]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeOrderDateFilter = btn.dataset.orderDate;
    ordersCustomDateRange = null;
    renderOrdersTable();
  });
});
setupDateRangePicker('ordersDateRangeBtn', 'ordersDateRangePicker', 'ordersDateFrom', 'ordersDateTo', 'ordersDateRangeApplyBtn', '[data-order-date]', (range) => {
  ordersCustomDateRange = range;
  renderOrdersTable();
});

function renderOrderStats() {
  const div = document.getElementById('pedidosStats');
  const counts = {};
  ordersCache.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });

  const totalCard = document.createElement('div');
  totalCard.className = 'stat-card';
  totalCard.innerHTML = `<b>${ordersCache.length}</b><span>Total</span>`;
  totalCard.style.cursor = 'pointer';
  totalCard.addEventListener('click', () => {
    document.getElementById('orderStatusFilter').value = '';
    renderOrdersTable();
  });

  div.innerHTML = '';
  div.appendChild(totalCard);

  // Clic en cualquier tarjeta de estado filtra la tabla de abajo por ese estado.
  ORDER_STATUS_COLUMNS.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.style.cssText = `color:${s.color};cursor:pointer`;
    card.innerHTML = `<b>${counts[s.key] || 0}</b><span>${s.label}</span>`;
    card.addEventListener('click', () => {
      document.getElementById('orderStatusFilter').value = s.key;
      renderOrdersTable();
    });
    div.appendChild(card);
  });
}

function getFilteredOrders() {
  const statusFilter = document.getElementById('orderStatusFilter').value;
  const searchLower = orderSearchText.trim().toLowerCase();
  return ordersCache
    .filter((o) => !statusFilter || o.status === statusFilter)
    .filter((o) => isWithinDateFilter(o.createdAt, activeOrderDateFilter, ordersCustomDateRange))
    .filter(
      (o) =>
        !searchLower ||
        (o.clientName || '').toLowerCase().includes(searchLower) ||
        (o.clientPhone || '').includes(searchLower) ||
        o.id.toLowerCase().includes(searchLower)
    );
}

function renderOrdersTable() {
  const tbody = document.getElementById('pedidosTableBody');
  const filtered = getFilteredOrders();
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><span class="empty-icon">🧾</span>No hay pedidos que coincidan con este filtro.</div></td></tr>`;
    updateOrdersBulkBar();
    return;
  }

  filtered.forEach((o) => {
      const statusInfo = ORDER_STATUS_COLUMNS.find((s) => s.key === o.status) || { label: o.status || 'pendiente', color: '#f59e0b' };
      const tr = document.createElement('tr');
      const dupWarning = o.possibleDuplicateOf ? ` <span class="dup-warning-icon" data-dup-of="${o.possibleDuplicateOf}">⚠️</span>` : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="order-checkbox" data-id="${o.id}" ${selectedOrderIds.has(o.id) ? 'checked' : ''} /></td>
        <td>${o.id}${dupWarning}</td>
        <td>${formatTime(o.createdAt)}</td>
        <td><div class="avatar-row">${avatarHtml(o.clientName, o.clientPhone, 24)}<span>${o.clientName || o.clientPhone || '-'}</span></div></td>
        <td>${o.product || '-'}</td>
        <td>${o.city || '-'}</td>
        <td>${o.price || '-'}</td>
        <td style="color:${statusInfo.color}">${statusInfo.label}</td>
      `;
      tr.querySelector('.order-checkbox').addEventListener('click', (e) => e.stopPropagation());
      tr.querySelector('.order-checkbox').addEventListener('change', (e) => {
        if (e.target.checked) selectedOrderIds.add(o.id);
        else selectedOrderIds.delete(o.id);
        updateOrdersBulkBar();
      });
      const dupIcon = tr.querySelector('.dup-warning-icon');
      if (dupIcon) {
        dupIcon.addEventListener('click', (e) => {
          e.stopPropagation();
          showToast(`Posible duplicado de ${dupIcon.dataset.dupOf} — mismo cliente con otro pedido sin resolver en las últimas 24h.`, 'error');
        });
      }
      tr.addEventListener('click', () => openOrderDetail(o.id));
      tbody.appendChild(tr);
    });
  updateOrdersBulkBar();
}

// ---- Selección múltiple en Pedidos ----
document.getElementById('ordersSelectAllCheckbox').addEventListener('change', (e) => {
  const filtered = getFilteredOrders();
  if (e.target.checked) filtered.forEach((o) => selectedOrderIds.add(o.id));
  else filtered.forEach((o) => selectedOrderIds.delete(o.id));
  renderOrdersTable();
});

document.getElementById('ordersBulkStatusSelect').innerHTML =
  ORDER_STATUS_COLUMNS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');

function updateOrdersBulkBar() {
  const bar = document.getElementById('ordersBulkBar');
  const count = selectedOrderIds.size;
  bar.classList.toggle('visible', count > 0);
  document.getElementById('ordersSelectedCount').textContent = `${count} seleccionado${count === 1 ? '' : 's'}`;
}

document.getElementById('ordersBulkDeleteBtn').addEventListener('click', async () => {
  if (!confirm(`¿Eliminar ${selectedOrderIds.size} pedido(s) seleccionados? No se puede deshacer.`)) return;
  await Promise.all(Array.from(selectedOrderIds).map((id) => fetch(`/api/orders/${id}`, { method: 'DELETE' })));
  showToast(`${selectedOrderIds.size} pedido(s) eliminados.`);
  selectedOrderIds.clear();
  loadOrders();
});

document.getElementById('ordersBulkChangeStatusBtn').addEventListener('click', async () => {
  const newStatus = document.getElementById('ordersBulkStatusSelect').value;
  await Promise.all(
    Array.from(selectedOrderIds).map((id) =>
      fetch(`/api/orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
    )
  );
  showToast(`Estado actualizado en ${selectedOrderIds.size} pedido(s).`);
  selectedOrderIds.clear();
  loadOrders();
});

function openOrderDetail(id) {
  const order = ordersCache.find((o) => o.id === id);
  if (!order) return;
  editingOrderId = id;
  document.getElementById('orderDetailTitle').textContent = `Pedido ${order.id}`;
  document.getElementById('od-clientName').value = order.clientName || '';
  document.getElementById('od-clientPhone').value = order.clientPhone || '';
  const productSelect = document.getElementById('od-product');
  productSelect.innerHTML = '<option value="">Elegir producto...</option>' + productsCacheForRp.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
  productSelect.value = order.product || '';
  if (productSelect.value !== order.product && order.product) {
    // El producto guardado ya no está en el catálogo actual — se agrega como opción aparte, para no perder el dato.
    productSelect.innerHTML += `<option value="${order.product}" selected>${order.product} (fuera del catálogo actual)</option>`;
  }
  document.getElementById('od-quantity').value = order.quantity || 1;
  document.getElementById('od-price').value = order.price || '';
  document.getElementById('od-deliveryType').value = order.deliveryType || 'domicilio';
  document.getElementById('od-address').value = order.address || '';
  populateDepartmentSelect('od-department', 'od-city').then(() => {
    document.getElementById('od-department').value = order.department || '';
    document.getElementById('od-department').dispatchEvent(new Event('change'));
    document.getElementById('od-city').value = order.city || '';
  });
  document.getElementById('od-neighborhood').value = order.neighborhood || '';
  document.getElementById('od-transportadora').value = order.transportadora || '';
  document.getElementById('od-guideNumber').value = order.dropiGuideNumber || '';
  const statusSelect = document.getElementById('od-status');
  statusSelect.innerHTML = ORDER_STATUS_COLUMNS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');
  statusSelect.value = order.status || 'pendiente';
  document.getElementById('uploadStatus').textContent = '';
  document.getElementById('orderDetailOverlay').style.display = 'flex';
}
document.getElementById('closeOrderDetailBtn').addEventListener('click', () => {
  document.getElementById('orderDetailOverlay').style.display = 'none';
});

document.getElementById('saveOrderBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  await fetch(`/api/orders/${editingOrderId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: document.getElementById('od-clientName').value,
      clientPhone: document.getElementById('od-clientPhone').value,
      product: document.getElementById('od-product').value,
      quantity: Number(document.getElementById('od-quantity').value) || 1,
      price: document.getElementById('od-price').value,
      deliveryType: document.getElementById('od-deliveryType').value,
      address: document.getElementById('od-address').value,
      department: document.getElementById('od-department').value,
      city: document.getElementById('od-city').value,
      neighborhood: document.getElementById('od-neighborhood').value,
      transportadora: document.getElementById('od-transportadora').value,
      dropiGuideNumber: document.getElementById('od-guideNumber').value,
      status: document.getElementById('od-status').value,
    }),
  });
  document.getElementById('orderDetailOverlay').style.display = 'none';
  loadOrders();
});

document.getElementById('downloadPdfBtn').addEventListener('click', () => {
  if (!editingOrderId) return;
  window.open(`/api/orders/${editingOrderId}/pdf`, '_blank');
});

document.getElementById('deleteOrderBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  if (!confirm(`¿Eliminar el pedido ${editingOrderId}? No se puede deshacer.`)) return;
  await fetch(`/api/orders/${editingOrderId}`, { method: 'DELETE' });
  document.getElementById('orderDetailOverlay').style.display = 'none';
  loadOrders();
});

document.getElementById('uploadDropiBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  const statusEl = document.getElementById('uploadStatus');
  statusEl.style.color = '';
  statusEl.textContent = 'Subiendo a Dropi...';
  const res = await fetch(`/api/orders/${editingOrderId}/upload-dropi`, { method: 'POST' }).then((r) => r.json());
  statusEl.style.color = res.ok ? '#16a34a' : '#dc2626';
  statusEl.textContent = res.ok ? '✔ Subido a Dropi' : res.error;
  if (res.ok) loadOrders();
});
document.getElementById('generateGuideDropiBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  const statusEl = document.getElementById('uploadStatus');
  statusEl.style.color = '';
  statusEl.textContent = 'Generando guía...';
  const res = await fetch(`/api/orders/${editingOrderId}/generate-guide-dropi`, { method: 'POST' }).then((r) => r.json());
  statusEl.style.color = res.ok ? '#16a34a' : '#dc2626';
  statusEl.textContent = res.ok ? '✔ Guía generada' : res.error;
  if (res.ok) loadOrders();
});
document.getElementById('refreshStatusDropiBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  const statusEl = document.getElementById('uploadStatus');
  statusEl.style.color = '';
  statusEl.textContent = 'Consultando estado real en Dropi...';
  const res = await fetch(`/api/orders/${editingOrderId}/refresh-status-dropi`, { method: 'POST' }).then((r) => r.json());
  statusEl.style.color = res.ok ? '#16a34a' : '#dc2626';
  statusEl.textContent = res.ok ? `✔ Estado actualizado: ${res.status}` : res.error;
  if (res.ok) loadOrders();
});
document.getElementById('uploadSkydropxBtn').addEventListener('click', async () => {
  if (!editingOrderId) return;
  const statusEl = document.getElementById('uploadStatus');
  statusEl.style.color = '';
  statusEl.textContent = 'Subiendo a Skydropx...';
  const res = await fetch(`/api/orders/${editingOrderId}/upload-skydropx`, { method: 'POST' }).then((r) => r.json());
  statusEl.style.color = res.ok ? '#16a34a' : '#dc2626';
  statusEl.textContent = res.ok ? '✔ Subido a Skydropx' : res.error;
});

socket.on('orderUpdate', () => loadOrders());

// ---- Exportar a Excel (CSV, se abre directo en Excel) ----
document.getElementById('exportOrdersExcelBtn').addEventListener('click', () => {
  const rows = getFilteredOrders();
  if (rows.length === 0) {
    showToast('No hay pedidos para exportar con este filtro.', 'error');
    return;
  }
  const headers = ['Pedido', 'Fecha', 'Cliente', 'Teléfono', 'Producto', 'Cantidad', 'Precio', 'Dirección', 'Departamento', 'Ciudad', 'Barrio', 'Transportadora', 'Estado'];
  const csvRows = [headers.join(',')];
  rows.forEach((o) => {
    const statusInfo = ORDER_STATUS_COLUMNS.find((s) => s.key === o.status);
    const line = [
      o.id, formatTime(o.createdAt), o.clientName, o.clientPhone, o.product, o.quantity, o.price,
      o.address, o.department, o.city, o.neighborhood, o.transportadora, statusInfo ? statusInfo.label : (o.status || 'Pendiente'),
    ].map((v) => `"${String(v || '').replace(/"/g, '""')}"`);
    csvRows.push(line.join(','));
  });
  // El \uFEFF (BOM) al inicio es para que Excel reconozca bien los acentos/ñ.
  const csvContent = '\uFEFF' + csvRows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pedidos-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${rows.length} pedido(s) exportados.`);
});

loadOrders();

// ---------- Respaldo (exportar / importar productos y configuración) ----------
document.getElementById('exportBackupBtn').addEventListener('click', () => {
  const statusEl = document.getElementById('exportBackupStatus');
  statusEl.style.color = '';
  statusEl.textContent = 'Descargando...';
  // Se abre como descarga directa del navegador — no hace falta fetch/JS extra.
  window.location.href = '/api/backup/export';
  setTimeout(() => {
    statusEl.style.color = '#16a34a';
    statusEl.textContent = '✔ Descarga iniciada. Revisa tu carpeta de Descargas.';
  }, 800);
});

document.getElementById('importBackupBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('import-backup-file');
  const statusEl = document.getElementById('importBackupStatus');
  const file = fileInput.files[0];
  if (!file) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Primero elige el archivo .zip del respaldo.';
    return;
  }
  if (
    !confirm(
      'Esto va a reemplazar tus productos y configuración actuales con los del respaldo. ¿Continuar?'
    )
  )
    return;

  statusEl.style.color = '';
  statusEl.textContent = 'Restaurando respaldo...';

  const formData = new FormData();
  formData.append('backup', file);
  try {
    const res = await fetch('/api/backup/import', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.ok) {
      statusEl.style.color = '#16a34a';
      statusEl.textContent = `✔ ${data.message}`;
      loadConfig();
      loadProducts();
    } else {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = data.error || 'No se pudo restaurar el respaldo.';
    }
  } catch (err) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = 'Error de conexión al restaurar el respaldo.';
  }
});

// ---------- Actualizaciones ----------
const updateResultDiv = document.getElementById('updateResult');
const currentVersionLabel = document.getElementById('currentVersionLabel');

document.getElementById('checkUpdateBtn').addEventListener('click', async () => {
  updateResultDiv.innerHTML = 'Buscando...';
  try {
    const data = await fetch('/api/check-update').then((r) => r.json());
    currentVersionLabel.textContent = data.currentVersion || '?';
    if (data.error) {
      updateResultDiv.innerHTML = `<span style="color:#dc2626">${data.error}</span>`;
    } else if (data.updateAvailable) {
      updateResultDiv.innerHTML = `
        <p><b>Nueva versión disponible: ${data.latestVersion}</b> — ${data.notes || ''}</p>
        <button id="applyUpdateBtn" class="save-btn">⬇ Instalar actualización</button>
      `;
      document.getElementById('applyUpdateBtn').addEventListener('click', async () => {
        if (!confirm('¿Instalar la actualización ahora? Vas a necesitar reiniciar el bot después.')) return;
        updateResultDiv.innerHTML = 'Instalando...';
        const res = await fetch('/api/apply-update', { method: 'POST' }).then((r) => r.json());
        if (res.ok) {
          updateResultDiv.innerHTML = `
            <span style="color:#16a34a">✔ ${res.message}</span>
            <br><button id="restartAfterUpdateBtn" class="save-btn" style="margin-top:10px">🔄 Reiniciar ahora</button>
          `;
          document.getElementById('restartAfterUpdateBtn').addEventListener('click', async () => {
            updateResultDiv.innerHTML = '🔄 Reiniciando...';
            await fetch('/api/restart-app', { method: 'POST' }).catch(() => {});
          });
        } else {
          updateResultDiv.innerHTML = `<span style="color:#dc2626">${res.error}</span>`;
        }
      });
    } else {
      updateResultDiv.innerHTML = '<span style="color:#16a34a">Ya tienes la última versión ✔</span>';
    }
  } catch (err) {
    updateResultDiv.innerHTML = `<span style="color:#dc2626">Error: ${err.message}</span>`;
  }
});

// (el chequeo automático de versión al cargar ya lo hace checkUpdateBannerOnLoad,
// que también rellena currentVersionLabel — no hace falta repetirlo aquí)

// ---------- Productos ----------
const productForm = document.getElementById('productForm');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const formTitle = document.getElementById('formTitle');
let quantityOffersState = [];

function renderQuantityOffers() {
  const container = document.getElementById('quantityOffersList');
  container.innerHTML = '';
  quantityOffersState.forEach((offer, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px';
    row.innerHTML = `
      <input type="number" min="2" value="${offer.quantity}" class="qo-quantity" placeholder="Cantidad" style="width:90px" />
      <input type="text" value="${offer.price}" class="qo-price" placeholder="Precio del combo, ej. $140.000" style="flex:1" />
      <button type="button" class="cancel-btn qo-delete" style="margin:0;color:#dc2626">🗑️</button>
    `;
    row.querySelector('.qo-quantity').addEventListener('change', (e) => { quantityOffersState[i].quantity = Number(e.target.value) || 2; });
    row.querySelector('.qo-price').addEventListener('change', (e) => { quantityOffersState[i].price = e.target.value; });
    row.querySelector('.qo-delete').addEventListener('click', () => {
      quantityOffersState.splice(i, 1);
      renderQuantityOffers();
    });
    container.appendChild(row);
  });
}
document.getElementById('addQuantityOfferBtn').addEventListener('click', () => {
  quantityOffersState.push({ quantity: 2, price: '' });
  renderQuantityOffers();
});

function resetProductForm() {
  productForm.reset();
  document.getElementById('p-id').value = '';
  document.getElementById('p-video-current').textContent = '';
  cancelEditBtn.style.display = 'none';
  formTitle.textContent = 'Agregar producto';
  quantityOffersState = [];
  renderQuantityOffers();
}

function priceTagHTML(p) {
  if (p.priceBefore && p.priceAfter) {
    return `<span class="price-tag"><span class="before">${p.priceBefore}</span><span class="after">${p.priceAfter}</span></span>`;
  }
  return `<span class="price-tag after">${p.priceAfter || p.priceBefore || 'Sin precio'}</span>`;
}

// ---- Banco de medios: administrar imágenes con su regla, una por una ----
let mediaBankProductId = null;

async function openMediaBank(productId) {
  mediaBankProductId = productId;
  const products = await fetch('/api/products').then((r) => r.json());
  const product = products.find((p) => p.id === productId);
  document.getElementById('mediaBankTitle').textContent = `🖼️ Banco de medios — ${product.name}`;
  renderMediaBankList(product);
  document.getElementById('mediaBankOverlay').style.display = 'flex';
}

function renderMediaBankList(product) {
  const container = document.getElementById('mediaBankList');
  const images = (product.images || []).map((img) => (typeof img === 'string' ? { url: img, rule: '' } : img));
  if (images.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">🖼️</span>Todavía no hay imágenes — agrega la primera abajo.</div>`;
    return;
  }
  container.innerHTML = images
    .map(
      (img, i) => `
      <div style="display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border-color);border-radius:10px;margin-bottom:8px">
        <img src="${img.url}" style="width:50px;height:50px;object-fit:cover;border-radius:8px" />
        <input type="text" class="mb-rule-input" data-index="${i}" value="${(img.rule || '').replace(/"/g, '&quot;')}" placeholder="General (sin regla)" style="flex:1" />
        <button type="button" class="cancel-btn mb-delete" data-index="${i}" style="margin:0;color:#dc2626">🗑️</button>
      </div>
    `
    )
    .join('');

  container.querySelectorAll('.mb-rule-input').forEach((input) => {
    input.addEventListener('change', async () => {
      await fetch(`/api/products/${mediaBankProductId}/images/${input.dataset.index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule: input.value }),
      });
      showToast('Regla guardada.');
      loadProducts();
    });
  });
  container.querySelectorAll('.mb-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const updated = await fetch(`/api/products/${mediaBankProductId}/images/${btn.dataset.index}`, { method: 'DELETE' }).then((r) => r.json());
      renderMediaBankList(updated);
      loadProducts();
    });
  });
}

document.getElementById('closeMediaBankBtn').addEventListener('click', () => {
  document.getElementById('mediaBankOverlay').style.display = 'none';
});

document.getElementById('mb-addImageBtn').addEventListener('click', async () => {
  const file = document.getElementById('mb-newImage').files[0];
  if (!file) return showToast('Elige una imagen primero', 'error');
  const formData = new FormData();
  formData.append('image', file);
  formData.append('rule', document.getElementById('mb-newRule').value);
  const updated = await fetch(`/api/products/${mediaBankProductId}/images`, { method: 'POST', body: formData }).then((r) => r.json());
  document.getElementById('mb-newImage').value = '';
  document.getElementById('mb-newRule').value = '';
  renderMediaBankList(updated);
  loadProducts();
  showToast('Imagen agregada.');
});

async function loadProducts() {
  const products = await fetch('/api/products').then((r) => r.json());
  const list = document.getElementById('productList');
  list.innerHTML = '';
  products.forEach((p) => {
    const images = p.images && p.images.length ? p.images : [''];
    const thumbs = images
      .slice(0, 3)
      .map((img) => `<img src="${typeof img === 'string' ? img : img.url}" onerror="this.style.visibility='hidden'" />`)
      .join('');
    const videoBadge = p.video ? '<span class="price-tag after">🎥 Video</span>' : '';
    const item = document.createElement('div');
    item.className = 'product-item';
    item.innerHTML = `
      <div class="thumbs">${thumbs}</div>
      <div class="info">
        <b>${p.name}</b>
        ${priceTagHTML(p)}
        ${videoBadge}
        <div class="kw">${(p.keywords || []).join(', ')}</div>
      </div>
      <div class="actions">
        <button data-media="${p.id}">🖼️ Fotos</button>
        <button data-edit="${p.id}">Editar</button>
        <button data-del="${p.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('[data-media]').forEach((btn) => {
    btn.addEventListener('click', () => openMediaBank(btn.dataset.media));
  });

  list.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const products = await fetch('/api/products').then((r) => r.json());
      const p = products.find((x) => x.id === btn.dataset.edit);
      document.getElementById('p-id').value = p.id;
      document.getElementById('p-name').value = p.name;
      document.getElementById('p-priceBefore').value = p.priceBefore || '';
      document.getElementById('p-priceAfter').value = p.priceAfter || '';
      document.getElementById('p-keywords').value = (p.keywords || []).join(', ');
      document.getElementById('p-dropiProductId').value = p.dropiProductId || '';
      quantityOffersState = p.quantityOffers ? [...p.quantityOffers] : [];
      renderQuantityOffers();
      document.getElementById('p-details').value = p.details;
      document.getElementById('p-video-current').textContent = p.video
        ? '🎥 Ya tiene un video cargado. Elige otro archivo aquí solo si quieres reemplazarlo.'
        : '';
      cancelEditBtn.style.display = 'inline-block';
      formTitle.textContent = `Editando: ${p.name}`;
      document.querySelector('[data-tab="productos"]').click();
      window.scrollTo(0, 0);
    });
  });

  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este producto?')) return;
      await fetch(`/api/products/${btn.dataset.del}`, { method: 'DELETE' });
      loadProducts();
    });
  });
}
loadProducts();

cancelEditBtn.addEventListener('click', resetProductForm);

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('p-id').value;
  const formData = new FormData();
  formData.append('id', id);
  formData.append('name', document.getElementById('p-name').value);
  formData.append('priceBefore', document.getElementById('p-priceBefore').value);
  formData.append('priceAfter', document.getElementById('p-priceAfter').value);
  formData.append('keywords', document.getElementById('p-keywords').value);
  formData.append('dropiProductId', document.getElementById('p-dropiProductId').value);
  formData.append('quantityOffers', JSON.stringify(quantityOffersState.filter((o) => o.price)));
  formData.append('details', document.getElementById('p-details').value);
  const imageFiles = document.getElementById('p-images').files;
  for (const file of imageFiles) formData.append('images', file);
  const videoFile = document.getElementById('p-video').files[0];
  if (videoFile) formData.append('video', videoFile);

  const url = id ? `/api/products/${id}` : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || 'No se pudo guardar el producto (revisa el tamaño/tipo del video).', 'error');
    return;
  }

  resetProductForm();
  loadProducts();
});

// ---------- Buscador de productos de Dropi (autocompletar ID) ----------
document.getElementById('searchDropiBtn').addEventListener('click', async () => {
  const query = document.getElementById('p-name').value.trim();
  const resultsDiv = document.getElementById('dropiSearchResults');
  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = `<div style="text-align:center;padding:10px"><span class="loading-spinner"></span></div>`;

  try {
    const res = await fetch(`/api/dropi/search-products?q=${encodeURIComponent(query)}`).then((r) => r.json());
    if (!res.ok) {
      resultsDiv.innerHTML = `<p class="hint small" style="color:#dc2626">${res.error}</p>`;
      return;
    }
    if (res.products.length === 0) {
      resultsDiv.innerHTML = `<p class="hint small">No se encontraron productos en Dropi con ese nombre.</p>`;
      return;
    }
    resultsDiv.innerHTML = '';
    res.products.forEach((p) => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:8px;border-radius:8px;cursor:pointer;border-bottom:1px solid var(--border-color)';
      item.innerHTML = `<b>${p.name}</b><br><span class="hint small">ID: ${p.id} · $${p.suggested_price || p.sale_price}</span>`;
      item.addEventListener('click', () => {
        document.getElementById('p-dropiProductId').value = p.id;
        document.getElementById('p-name').value = p.name;
        if (p.description) document.getElementById('p-details').value = p.description;
        if (p.suggested_price) document.getElementById('p-priceAfter').value = `$${Number(p.suggested_price).toLocaleString('es-CO')} COP`;
        resultsDiv.style.display = 'none';
        showToast(`Producto de Dropi vinculado: ${p.name}`);
      });
      resultsDiv.appendChild(item);
    });
  } catch (err) {
    resultsDiv.innerHTML = `<p class="hint small" style="color:#dc2626">Error de conexión buscando en Dropi.</p>`;
  }
});

// ---------- Secuencia de seguimiento (remarketing) ----------
let followUpMessagesState = [];

function renderFollowUpMessages() {
  const container = document.getElementById('followUpMessagesList');
  container.innerHTML = '';
  followUpMessagesState.forEach((msg, i) => {
    const row = document.createElement('div');
    row.className = 'followup-row';
    row.innerHTML = `
      <div class="followup-row-top">
        <label style="display:flex;align-items:center;gap:6px;margin:0;flex:1">
          <input type="checkbox" class="fu-enabled" style="width:auto" ${msg.enabled !== false ? 'checked' : ''} />
          Mensaje ${i + 1}
        </label>
        <input type="number" class="fu-delay followup-delay" min="1" value="${msg.delayMinutes}" title="Minutos de espera" />
        <span class="hint small" style="margin:0">min después</span>
        <button type="button" class="cancel-btn fu-delete" style="margin:0;color:#dc2626">🗑️</button>
      </div>
      <textarea class="fu-text" rows="2">${msg.text}</textarea>
    `;
    row.querySelector('.fu-delete').addEventListener('click', () => {
      followUpMessagesState.splice(i, 1);
      renderFollowUpMessages();
    });
    container.appendChild(row);
  });
}

document.getElementById('addFollowUpMessageBtn').addEventListener('click', () => {
  followUpMessagesState.push({
    id: `seguimiento-custom-${Date.now()}`,
    text: '¿Sigues interesado en {producto}? 😊',
    delayMinutes: 60,
    enabled: true,
  });
  renderFollowUpMessages();
});

async function loadFollowUpConfig() {
  const data = await fetch('/api/followup-config').then((r) => r.json());
  document.getElementById('followUpEnabled').checked = data.enabled;
  document.getElementById('followUpHoursStart').value = data.hoursStart || '';
  document.getElementById('followUpHoursEnd').value = data.hoursEnd || '';
  followUpMessagesState = data.messages;
  renderFollowUpMessages();
}
loadFollowUpConfig();

document.getElementById('saveFollowUpBtn').addEventListener('click', async () => {
  // Vuelve a leer los valores actuales de cada fila (por si el usuario los editó) antes de guardar.
  const rows = document.querySelectorAll('#followUpMessagesList .followup-row');
  const messages = Array.from(rows).map((row, i) => ({
    id: followUpMessagesState[i].id,
    text: row.querySelector('.fu-text').value,
    delayMinutes: Number(row.querySelector('.fu-delay').value) || 60,
    enabled: row.querySelector('.fu-enabled').checked,
  }));

  await fetch('/api/followup-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('followUpEnabled').checked,
      hoursStart: document.getElementById('followUpHoursStart').value,
      hoursEnd: document.getElementById('followUpHoursEnd').value,
      messages,
    }),
  });
  followUpMessagesState = messages;
  const saved = document.getElementById('followUpSaved');
  saved.textContent = 'Guardado ✔';
  setTimeout(() => (saved.textContent = ''), 2000);
});

// ---------- Dashboard ----------
async function loadDashboard() {
  const [clientsData, ordersData] = await Promise.all([
    fetch('/api/clients').then((r) => r.json()),
    fetch('/api/orders').then((r) => r.json()),
  ]);

  const totalLeads = clientsData.length;
  const clientesConvertidos = clientsData.filter((c) => (c.tag || 'lead') === 'cliente').length;
  const conversionRate = totalLeads ? Math.round((clientesConvertidos / totalLeads) * 100) : 0;

  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ordersToday = ordersData.filter((o) => startOfDay(new Date(o.createdAt)) === startOfDay(now)).length;
  const ordersWeek = ordersData.filter((o) => o.createdAt >= now.getTime() - 7 * 24 * 60 * 60 * 1000).length;

  const statsDiv = document.getElementById('dashboardStats');
  statsDiv.innerHTML = `
    <div class="stat-card"><b>${totalLeads}</b><span>Total de clientes</span></div>
    <div class="stat-card" style="color:#16a34a"><b>${conversionRate}%</b><span>Tasa de conversión</span></div>
    <div class="stat-card" style="color:#3b82f6"><b>${ordersToday}</b><span>Pedidos hoy</span></div>
    <div class="stat-card" style="color:#f97316"><b>${ordersWeek}</b><span>Pedidos esta semana</span></div>
  `;

  // ---- Ventas de los últimos 7 días ----
  const weekChart = document.getElementById('dashboardWeekChart');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  const dayCounts = days.map((d) => ordersData.filter((o) => startOfDay(new Date(o.createdAt)) === startOfDay(d)).length);
  const maxCount = Math.max(1, ...dayCounts);
  weekChart.innerHTML = days
    .map((d, i) => {
      const label = d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' });
      const pct = Math.round((dayCounts[i] / maxCount) * 100);
      return `
        <div class="bar-row">
          <span class="bar-label">${label}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <span class="bar-value">${dayCounts[i]}</span>
        </div>
      `;
    })
    .join('');

  // ---- Productos más vendidos ----
  const productCounts = {};
  ordersData.forEach((o) => {
    if (!o.product) return;
    productCounts[o.product] = (productCounts[o.product] || 0) + 1;
  });
  const topProducts = Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topDiv = document.getElementById('dashboardTopProducts');
  if (topProducts.length === 0) {
    topDiv.innerHTML = `<div class="empty-state"><span class="empty-icon">📦</span>Todavía no hay pedidos con producto registrado.</div>`;
  } else {
    const maxProductCount = topProducts[0][1];
    topDiv.innerHTML = topProducts
      .map(([name, count]) => {
        const pct = Math.round((count / maxProductCount) * 100);
        return `
          <div class="bar-row">
            <span class="bar-label" style="width:160px" title="${name}">${name.length > 22 ? name.slice(0, 22) + '…' : name}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="bar-value">${count}</span>
          </div>
        `;
      })
      .join('');
  }
}
document.getElementById('refreshDashboardBtn').addEventListener('click', loadDashboard);
document.querySelector('.nav-item[data-tab="dashboard"]').addEventListener('click', loadDashboard);

// ---------- Simulador de pruebas ----------
function appendSimulatorBubble(from, text, mediaList) {
  const container = document.getElementById('simulatorMessages');
  const bubble = document.createElement('div');
  const labels = { client: 'Tú (probando)', bot: 'Ángela' };
  bubble.className = `chat-bubble ${from}`;
  let mediaHtml = '';
  (mediaList || []).forEach((m) => {
    if (m.type === 'image') mediaHtml += `<img src="${m.url}" />`;
    else if (m.type === 'video') mediaHtml += `<video controls src="${m.url}" style="max-width:220px;border-radius:8px;display:block;margin-top:4px"></video>`;
  });
  bubble.innerHTML = `
    <div class="bubble-meta">${labels[from] || from}</div>
    <div>${(text || '').replace(/</g, '&lt;')}</div>
    ${mediaHtml}
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function sendSimulatorMessage() {
  const input = document.getElementById('simulatorInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendSimulatorBubble('client', text);

  const sendBtn = document.getElementById('simulatorSendBtn');
  sendBtn.disabled = true;

  const container = document.getElementById('simulatorMessages');
  const typingBubble = document.createElement('div');
  typingBubble.className = 'chat-bubble bot';
  typingBubble.innerHTML = `<div class="bubble-meta">Ángela</div><div><span class="loading-spinner"></span> escribiendo...</div>`;
  container.appendChild(typingBubble);
  container.scrollTop = container.scrollHeight;

  try {
    const res = await fetch('/api/simulator/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());
    typingBubble.remove();
    if (res.ok) {
      appendSimulatorBubble('bot', res.reply, res.media);
    } else {
      showToast(res.error || 'Error en la simulación', 'error');
    }
  } catch (err) {
    typingBubble.remove();
    showToast('Error de conexión con el simulador.', 'error');
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById('simulatorSendBtn').addEventListener('click', sendSimulatorMessage);
document.getElementById('simulatorInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendSimulatorMessage();
});
document.getElementById('resetSimulatorBtn').addEventListener('click', async () => {
  await fetch('/api/simulator/reset', { method: 'POST' });
  document.getElementById('simulatorMessages').innerHTML = '';
  showToast('Simulador reiniciado.');
});

}
