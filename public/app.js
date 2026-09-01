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
  document.getElementById('cfg-minimaxApiKey').value = cfg.minimaxApiKey || '';
  document.getElementById('cfg-minimaxGroupId').value = cfg.minimaxGroupId || '';
  updateVoiceCloneStatus(cfg);
  setupModelSelect('cfg-groqModel', 'cfg-groqModel-custom', cfg.groqModel);
  setupModelSelect('cfg-openaiModel', 'cfg-openaiModel-custom', cfg.openaiModel);
}
loadConfig();

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
  const body = {};
  cfgFields.forEach((f) => {
    const el = document.getElementById(`cfg-${f}`);
    body[f] = (f === 'responseDelaySeconds' || f === 'pauseDurationMinutes') ? Number(el.value) : el.value;
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

// ---------- Clientes (CRM: tablero + chat en vivo + pausas) ----------
const STATUS_COLUMNS = [
  { key: 'nuevo', label: '🆕 Nuevo', color: '#64748b' },
  { key: 'conversando', label: '💬 En conversación', color: '#3b82f6' },
  { key: 'interesado', label: '🔥 Interesado', color: '#f97316' },
  { key: 'comprado', label: '✅ Compra confirmada', color: '#16a34a' },
  { key: 'cancelado', label: '❌ Cancelado', color: '#dc2626' },
];
const STATUS_LABELS = Object.fromEntries(STATUS_COLUMNS.map((c) => [c.key, c]));

let selectedClientJid = null;
let clientsCache = [];

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---- Alternar entre vista de Tablero y vista de Chats ----
function showTablerosView() {
  document.getElementById('crmTablerosView').style.display = 'block';
  document.getElementById('crmChatsView').style.display = 'none';
  document.getElementById('crmViewTablerosBtn').className = 'save-btn';
  document.getElementById('crmViewChatsBtn').className = 'cancel-btn';
  renderBoard();
}
function showChatsView() {
  document.getElementById('crmTablerosView').style.display = 'none';
  document.getElementById('crmChatsView').style.display = 'block';
  document.getElementById('crmViewTablerosBtn').className = 'cancel-btn';
  document.getElementById('crmViewChatsBtn').className = 'save-btn';
  renderClientList();
}
document.getElementById('crmViewTablerosBtn').addEventListener('click', showTablerosView);
document.getElementById('crmViewChatsBtn').addEventListener('click', showChatsView);
document.getElementById('refreshClientsBtn').addEventListener('click', loadClients);

async function loadClients() {
  clientsCache = await fetch('/api/clients').then((r) => r.json());
  renderBoard();
  renderClientList();
}

// ---- Vista de Tablero (columnas por etapa, automático) ----
function renderBoard() {
  const container = document.getElementById('crmBoardColumns');
  if (!container) return;
  container.innerHTML = '';
  STATUS_COLUMNS.forEach((col) => {
    const clientsInCol = clientsCache.filter((c) => c.status === col.key);
    const colDiv = document.createElement('div');
    colDiv.style.cssText = 'min-width:230px;flex:1;background:#f9fafb;border-radius:10px;padding:10px;max-height:70vh;display:flex;flex-direction:column';
    colDiv.innerHTML = `
      <div style="font-weight:700;color:${col.color};margin-bottom:8px;display:flex;justify-content:space-between;font-size:14px">
        <span>${col.label}</span><span>${clientsInCol.length}</span>
      </div>
      <div class="crm-cards" style="overflow-y:auto"></div>
    `;
    const cardsDiv = colDiv.querySelector('.crm-cards');
    clientsInCol
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .forEach((c) => {
        const isPausedNow = c.pausedUntil && c.pausedUntil > Date.now();
        const card = document.createElement('div');
        card.style.cssText =
          'background:white;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.1)';
        card.innerHTML = `
          <div style="font-weight:600;font-size:13px">${c.name || c.phone}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">${formatTime(c.lastMessageAt)}${isPausedNow ? ' · ⏸️ pausado' : ''}</div>
        `;
        card.addEventListener('click', () => {
          showChatsView();
          selectClient(c.jid);
        });
        cardsDiv.appendChild(card);
      });
    container.appendChild(colDiv);
  });
}

// ---- Vista de Chats (lista + conversación) ----
function renderClientList() {
  const listDiv = document.getElementById('clientList');
  if (!listDiv) return;
  listDiv.innerHTML = '';
  clientsCache.forEach((c) => {
    const statusInfo = STATUS_LABELS[c.status] || { label: c.status, color: '#6b7280' };
    const isPausedNow = c.pausedUntil && c.pausedUntil > Date.now();
    const item = document.createElement('div');
    item.style.cssText =
      'padding:8px;border-radius:8px;cursor:pointer;margin-bottom:6px;' +
      (c.jid === selectedClientJid ? 'background:#eff6ff' : '');
    item.innerHTML = `
      <div style="font-weight:600">${c.name || c.phone}</div>
      <div style="font-size:12px;color:${statusInfo.color}">${statusInfo.label}${isPausedNow ? ' · ⏸️ Pausado' : ''}</div>
      <div style="font-size:11px;color:#9ca3af">${formatTime(c.lastMessageAt)}</div>
    `;
    item.addEventListener('click', () => selectClient(c.jid));
    listDiv.appendChild(item);
  });
}

async function selectClient(jid) {
  selectedClientJid = jid;
  renderClientList();

  const client = clientsCache.find((c) => c.jid === jid);
  const statusInfo = STATUS_LABELS[client?.status] || { label: client?.status || '', color: '#6b7280' };
  document.getElementById('chatHeader').innerHTML = `
    <b>${client?.name || client?.phone || jid.split('@')[0]}</b>
    <span style="color:${statusInfo.color}"> · ${statusInfo.label}</span>
    <a href="https://wa.me/${client?.phone}" target="_blank" style="margin-left:8px">💬 Abrir en WhatsApp</a>
  `;

  const messages = await fetch(`/api/clients/${encodeURIComponent(jid)}/messages`).then((r) => r.json());
  renderMessages(messages);
  renderPauseBar(client?.pausedUntil);
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
  const styles = {
    client: 'align-self:flex-start;background:#f3f4f6;color:#111827',
    bot: 'align-self:flex-end;background:#dcfce7;color:#111827',
    owner: 'align-self:flex-end;background:#fef9c3;color:#111827',
  };
  const labels = { client: 'Cliente', bot: 'Ángela', owner: 'Tú' };
  bubble.style.cssText = `max-width:75%;padding:8px 12px;border-radius:10px;font-size:14px;${styles[m.from] || styles.client}`;

  let mediaHtml = '';
  if (m.type === 'image' && m.mediaUrl) {
    mediaHtml = `<img src="${m.mediaUrl}" style="max-width:220px;border-radius:8px;display:block;margin-top:4px" />`;
  } else if ((m.type === 'audio' || m.type === 'voice') && m.mediaUrl) {
    mediaHtml = `<audio controls src="${m.mediaUrl}" style="margin-top:4px;max-width:220px"></audio>`;
  }
  const icon = m.type === 'voice' && !m.mediaUrl ? '🎙️ ' : '';

  bubble.innerHTML = `
    <div style="font-size:11px;opacity:0.6;margin-bottom:2px">${labels[m.from] || m.from} · ${formatTime(m.timestamp)}</div>
    <div>${icon}${(m.text || '').replace(/</g, '&lt;')}</div>
    ${mediaHtml}
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// ---- Barra de pausa: siempre visible, con botones proactivos o de reanudar ----
function renderPauseBar(pausedUntil) {
  const div = document.getElementById('pauseBar');
  const isPausedNow = pausedUntil && pausedUntil > Date.now();
  div.style.display = 'block';

  if (isPausedNow) {
    const until = new Date(pausedUntil).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <span>⏸️ Bot pausado en este chat hasta las ${until}</span>
      <button id="resumeNowBtn" class="cancel-btn" style="margin-left:8px">▶ Reanudar ya</button>
      <button id="extend10Btn" class="cancel-btn">+10 min</button>
      <button id="extend30Btn" class="cancel-btn">+30 min</button>
    `;
    document.getElementById('resumeNowBtn').addEventListener('click', async () => {
      await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/resume`, { method: 'POST' });
    });
    document.getElementById('extend10Btn').addEventListener('click', () => pauseSelected(10));
    document.getElementById('extend30Btn').addEventListener('click', () => pauseSelected(30));
  } else {
    div.innerHTML = `
      <span class="hint small">El bot está respondiendo automático aquí. Pausarlo manualmente:</span>
      <button id="pause10Btn" class="cancel-btn" style="margin-left:8px">⏸️ 10 min</button>
      <button id="pause30Btn" class="cancel-btn">⏸️ 30 min</button>
      <button id="pause60Btn" class="cancel-btn">⏸️ 60 min</button>
    `;
    document.getElementById('pause10Btn').addEventListener('click', () => pauseSelected(10));
    document.getElementById('pause30Btn').addEventListener('click', () => pauseSelected(30));
    document.getElementById('pause60Btn').addEventListener('click', () => pauseSelected(60));
  }
}

async function pauseSelected(minutes) {
  if (!selectedClientJid) return;
  await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  });
}

// ---- Enviar texto ----
document.getElementById('chatSendBtn').addEventListener('click', async () => {
  const input = document.getElementById('chatReplyInput');
  const text = input.value.trim();
  if (!selectedClientJid) return;

  const mediaFile = document.getElementById('chatMediaInput').files[0];
  if (mediaFile) {
    const formData = new FormData();
    formData.append('media', mediaFile);
    const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send-media`, {
      method: 'POST',
      body: formData,
    }).then((r) => r.json());
    if (!res.ok) alert(res.error || 'No se pudo enviar el archivo');
    document.getElementById('chatMediaInput').value = '';
  }

  if (text) {
    input.value = '';
    const res = await fetch(`/api/clients/${encodeURIComponent(selectedClientJid)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then((r) => r.json());
    if (!res.ok) alert(res.error || 'No se pudo enviar');
  }
});
document.getElementById('chatReplyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('chatSendBtn').click();
});
document.getElementById('chatMediaInput').addEventListener('change', () => {
  const file = document.getElementById('chatMediaInput').files[0];
  if (file) document.getElementById('chatReplyInput').placeholder = `Adjunto: ${file.name} (dale Enviar)`;
});

// ---- Actualizaciones en vivo, sin recargar nada ----
socket.on('chatMessage', ({ jid, entry }) => {
  if (jid === selectedClientJid) appendMessageBubble(entry);
  loadClients();
});
socket.on('clientUpdate', () => loadClients());
socket.on('pauseUpdate', ({ jid, pausedUntil }) => {
  loadClients();
  if (jid === selectedClientJid) renderPauseBar(pausedUntil);
});

loadClients();

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
