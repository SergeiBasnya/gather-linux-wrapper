import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  desktopCapturer,
  session,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';

// URL cible — Gather V2 (app.v2.gather.town). La V1 (app.gather.town) a été
// largement remplacée ; on pointe par défaut sur la V2 et on laisse la V1
// comme origine reconnue pour ne pas casser les anciens liens partagés.
const GATHER_URL = 'https://app.v2.gather.town';

// Origines considérées comme "internes" : navigation, permissions et
// window.open restent dans la fenêtre ; tout le reste part dans le navigateur
// système.
const GATHER_ORIGINS: readonly string[] = [
  'https://app.v2.gather.town',
  'https://v2.gather.town',
  'https://app.gather.town',
  'https://gather.town',
];

// Origines additionnelles autorisées pendant le flow OAuth (login).
const AUTH_ORIGINS: readonly string[] = [
  'https://accounts.google.com',
  'https://auth.gather.town',
  'https://appleid.apple.com',
];

function isGatherOrigin(url: string): boolean {
  return GATHER_ORIGINS.some((o) => url.startsWith(o));
}

function isAllowedNavigation(url: string): boolean {
  return isGatherOrigin(url) || AUTH_ORIGINS.some((o) => url.startsWith(o));
}

// Version Chrome qu'on veut simuler. Doit rester cohérente entre l'UA,
// les Client Hints (sec-ch-ua) et le patch navigator.userAgentData du
// preload (voir src/preload.ts — CHROME_MAJOR/CHROME_FULL y sont dupliqués
// car les deux fichiers sont compilés séparément).
const CHROME_MAJOR = '130';

// User-Agent qui imite Chrome Desktop sur Linux.
// Gather/Cloudflare Turnstile détectent "Electron" dans l'UA et les Client
// Hints. On retire toute mention d'Electron et on force la cohérence avec
// les en-têtes sec-ch-ua rewrités plus bas.
const CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// Client Hints que Chrome Linux envoie. Sans ce rewrite, Electron envoie
// `"Electron";v="33", "Chromium";v="130", ...` — signal évident pour Turnstile.
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="99"`;
const SEC_CH_UA_PLATFORM = '"Linux"';
const SEC_CH_UA_MOBILE = '?0';

// Appliqué avant app.ready : couvre toutes les requêtes, y compris les
// workers et sous-frames, pas seulement la webContents principale.
app.userAgentFallback = CHROME_UA;

// --- Flags Chromium passés avant app.ready ---
// WebRTCPipeWireCapturer : active le capturer PipeWire nécessaire pour que
// getDisplayMedia passe par xdg-desktop-portal sous Wayland.
// WaylandWindowDecorations : rend les décorations côté client correctement.
app.commandLine.appendSwitch(
  'enable-features',
  'WebRTCPipeWireCapturer,WaylandWindowDecorations',
);
// ozone-platform-hint=auto : laisse Chromium choisir Wayland si disponible,
// sinon retombe sur X11. Cela évite d'imposer un transport et casse moins
// sur les setups hybrides.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

// Instance unique : si l'utilisateur relance l'app on refocus la fenêtre
// existante plutôt que d'en ouvrir une deuxième (évite deux sessions WebRTC
// concurrentes qui se voleraient le micro).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;

// Inclure (ou non) le son système dans le partage d'écran. Désactivé par
// défaut : sous Linux/PipeWire, `audio: 'loopback'` capture TOUT le son qui
// sort des haut-parleurs, y compris la conversation Gather en cours, ce qui
// crée un effet de boucle pour les autres participants. À activer ponctuel-
// lement (menu View → Include System Audio in Screen Share) pour partager
// une vidéo avec son.
let includeAudioInScreenShare = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Gather',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // webviewTag désactivé : on ne charge qu'une URL, pas de sous-contextes
      webviewTag: false,
      // Nécessaire pour que le preload (et donc le patch navigator.userAgentData
      // anti-Turnstile) s'exécute aussi dans les iframes cross-origin comme
      // challenges.cloudflare.com. Sans ça, le fingerprint "Electron" fuite
      // via le navigator.userAgentData.brands de l'iframe.
      nodeIntegrationInSubFrames: true,
    },
  });

  // User-Agent custom appliqué à la webContents (couvre navigation + fetch)
  mainWindow.webContents.setUserAgent(CHROME_UA);

  const ses = mainWindow.webContents.session;

  // --- Réécriture des Client Hints ---
  // Electron envoie par défaut `sec-ch-ua` avec "Electron" dans la liste de
  // marques, ce que Cloudflare Turnstile détecte immédiatement. On remplace
  // ces en-têtes par ceux que Chrome Desktop Linux enverrait.
  // On ajoute aussi Accept-Language pour rester cohérent avec un Chrome FR.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['sec-ch-ua'] = SEC_CH_UA;
    headers['sec-ch-ua-mobile'] = SEC_CH_UA_MOBILE;
    headers['sec-ch-ua-platform'] = SEC_CH_UA_PLATFORM;
    headers['User-Agent'] = CHROME_UA;
    callback({ requestHeaders: headers });
  });

  // --- Gestion des permissions WebRTC ---
  // On n'autorise que ce dont Gather a besoin. Tout le reste est refusé.
  const allowedPermissions = new Set([
    'media', // micro + caméra
    'display-capture', // partage d'écran
    'notifications',
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
    'pointerLock',
  ]);

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = details.requestingUrl ?? '';
    if (isGatherOrigin(origin) && allowedPermissions.has(permission)) {
      callback(true);
      return;
    }
    callback(false);
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return isGatherOrigin(requestingOrigin) && allowedPermissions.has(permission);
  });

  // --- Partage d'écran (getDisplayMedia) ---
  // Flow sous Wayland + PipeWire (WebRTCPipeWireCapturer actif) :
  //   1. Gather appelle navigator.mediaDevices.getDisplayMedia()
  //   2. Chromium invoque notre handler
  //   3. desktopCapturer.getSources({ types: ['screen'] }) déclenche le
  //      portail xdg-desktop-portal, l'utilisateur choisit un écran
  //   4. On passe la source choisie au callback avec audio en loopback
  //
  // ATTENTION: on demande UNIQUEMENT ['screen']. Avec ['screen', 'window']
  // sous Wayland, le portail double-invoque PipeWire et déclenche
  // `pw_thread_loop_wait() loop->recurse > 0` → freeze du process. Si on
  // voulait le partage de fenêtre un jour, il faudrait un second handler
  // ou un picker custom — pas les deux dans le même getSources.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    console.log('[gather-wrapper] getDisplayMedia demandé — ouverture portail…');
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      console.log(
        `[gather-wrapper] desktopCapturer: ${sources.length} source(s) —`,
        sources.map((s) => ({ id: s.id, name: s.name })),
      );

      if (sources.length === 0) {
        console.warn('[gather-wrapper] Aucune source (utilisateur a annulé ?)');
        callback({});
        return;
      }

      // audio: 'loopback' capture le son système entier (pas filtrable par
      // app sous PipeWire), donc inclut le son de Gather lui-même → boucle.
      // Off par défaut, togglable via le menu View.
      if (includeAudioInScreenShare) {
        console.log('[gather-wrapper] partage avec son système (loopback)');
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({ video: sources[0] });
      }
    } catch (err) {
      console.error('[gather-wrapper] desktopCapturer a échoué:', err);
      callback({});
    }
  });

  // --- Chargement de Gather ---
  mainWindow.loadURL(GATHER_URL, { userAgent: CHROME_UA });

  // Liens externes : la navigation interne (V1 + V2) reste dans la fenêtre,
  // tout autre lien part dans le navigateur système.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isGatherOrigin(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch((err) => {
      console.error('[gather-wrapper] openExternal:', err);
    });
    return { action: 'deny' };
  });

  // On bloque la navigation hors-Gather (hors OAuth) dans la fenêtre principale.
  // Cas particulier `file://` : déclenché quand un fichier est drop hors d'une
  // drop-zone reconnue par Gather. On bloque silencieusement, sinon on
  // ouvrirait le fichier dans le viewer système par erreur.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (url.startsWith('file://')) return;
    shell.openExternal(url).catch(() => undefined);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit', label: 'Quit Gather' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Toggle DevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Include System Audio in Screen Share',
          type: 'checkbox',
          checked: includeAudioInScreenShare,
          click: (menuItem) => {
            includeAudioInScreenShare = menuItem.checked;
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Gather Linux Wrapper',
          click: async () => {
            await dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: 'Gather Linux Wrapper',
              detail:
                'Wrapper Electron non-officiel pour Gather Town.\n\n' +
                `Version: ${app.getVersion()}\n` +
                `Electron: ${process.versions.electron}\n` +
                `Chromium: ${process.versions.chrome}\n` +
                `Node: ${process.versions.node}`,
              buttons: ['OK'],
              noLink: true,
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Open Gather Website',
          click: () => {
            shell.openExternal('https://www.gather.town').catch(() => undefined);
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // On applique le User-Agent globalement sur la session par défaut aussi,
  // pour couvrir les requêtes qui ne passeraient pas par webContents
  session.defaultSession.setUserAgent(CHROME_UA);

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Sous Linux on quitte comme attendu quand toutes les fenêtres sont fermées
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Sécurité : on refuse tout certificat invalide. Pas de bypass, même en dev.
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(false);
});
