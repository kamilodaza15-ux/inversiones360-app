const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');

// Esto arranca tu servidor Express/whatsapp-web.js exactamente igual que
// antes (server.js no cambia en nada). Solo lo hacemos correr DENTRO del
// mismo proceso de Electron en vez de necesitar "npm start" aparte.
require('./server.js');

let mainWindow;
let tray;

function waitForServerAndOpenWindow() {
  const check = () => {
    http
      .get('http://localhost:3000', () => openWindow())
      .on('error', () => setTimeout(check, 300));
  };
  check();
}

function openWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    icon: path.join(__dirname, 'public', 'logo.png'),
    title: 'Inversiones 360 CHAT',
    autoHideMenuBar: true, // oculta la barra de menú tipo "Archivo, Editar..."
    webPreferences: {
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');

  // Los links que abran una pestaña nueva (si algún día agregas alguno) se
  // abren en el navegador normal, no dentro de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    // Al cerrar la ventana, la app sigue corriendo minimizada en la bandeja
    // del sistema (junto al reloj de Windows), para no cortar el bot sin
    // querer con un clic accidental en la X.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'public', 'logo.png'));
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir panel', click: () => mainWindow?.show() },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('Inversiones 360 CHAT');
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow?.show());
}

app.whenReady().then(() => {
  createTray();
  waitForServerAndOpenWindow();
});

app.on('window-all-closed', () => {
  // En Windows, no cerramos la app aunque se cierre la ventana (queda en
  // la bandeja); solo se cierra de verdad desde el menú "Salir" del ícono.
});
