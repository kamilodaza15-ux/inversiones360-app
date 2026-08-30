// ---------- Licencia / activación ----------
async function checkLicense() {
  const lic = await fetch('/api/license').then((r) => r.json());
  if (lic.activated) {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
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
        <button id="bannerUpdateBtn" class="save-btn" style="white-space:nowrap">⬇ Descargar</button>
      `;
      document.getElementById('bannerUpdateBtn').addEventListener('click', async () => {
        if (!confirm('¿Instalar la actualización ahora? Vas a necesitar reiniciar el bot después.')) return;
        banner.innerHTML = 'Instalando actualización...';
        try {
          const res = await fetch('/api/apply-update', { method: 'POST' }).then((r) => r.json());
          if (res.ok) {
            banner.style.background = '#dcfce7';
            banner.innerHTML = `<span style="color:#16a34a">✔ ${res.message}</span>`;
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

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
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

fetch('/api/status').then((r) => r.json()).then((d) => setStatus(d.status));

// ---------- Configuración ----------
const cfgFields = [
  'assistantName', 'companyName', 'welcomeMessage', 'baseInstructions',
  'responseDelaySeconds', 'notificationPhoneNumber', 'aiProvider', 'groqApiKey',
  'openaiApiKey',
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
  updateVoiceCloneStatus(cfg);
  setupModelSelect('cfg-groqModel', 'cfg-groqModel-custom', cfg.groqModel);
  setupModelSelect('cfg-openaiModel', 'cfg-openaiModel-custom', cfg.openaiModel);
}
loadConfig();

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
  const body = {};
  cfgFields.forEach((f) => {
    const el = document.getElementById(`cfg-${f}`);
    body[f] = f === 'responseDelaySeconds' ? Number(el.value) : el.value;
  });
  body.groqModel = getModelValue('cfg-groqModel', 'cfg-groqModel-custom');
  body.openaiModel = getModelValue('cfg-openaiModel', 'cfg-openaiModel-custom');
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const saved = document.getElementById('configSaved');
  saved.textContent = 'Guardado ✔';
  setTimeout(() => (saved.textContent = ''), 2000);
});

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
          updateResultDiv.innerHTML = `<span style="color:#16a34a">✔ ${res.message}</span>`;
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

function resetProductForm() {
  productForm.reset();
  document.getElementById('p-id').value = '';
  document.getElementById('p-video-current').textContent = '';
  cancelEditBtn.style.display = 'none';
  formTitle.textContent = 'Agregar producto';
}

function priceTagHTML(p) {
  if (p.priceBefore && p.priceAfter) {
    return `<span class="price-tag"><span class="before">${p.priceBefore}</span><span class="after">${p.priceAfter}</span></span>`;
  }
  return `<span class="price-tag after">${p.priceAfter || p.priceBefore || 'Sin precio'}</span>`;
}

async function loadProducts() {
  const products = await fetch('/api/products').then((r) => r.json());
  const list = document.getElementById('productList');
  list.innerHTML = '';
  products.forEach((p) => {
    const images = p.images && p.images.length ? p.images : [''];
    const thumbs = images
      .slice(0, 3)
      .map((img) => `<img src="${img}" onerror="this.style.visibility='hidden'" />`)
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
        <button data-edit="${p.id}">Editar</button>
        <button data-del="${p.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(item);
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
    alert(err.error || 'No se pudo guardar el producto (revisa el tamaño/tipo del video).');
    return;
  }

  resetProductForm();
  loadProducts();
});

}
