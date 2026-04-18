// Preload : patche l'empreinte "Electron" que Cloudflare Turnstile détecte.
//
// Pourquoi : Turnstile échoue quand il voit "Electron" dans
// `navigator.userAgentData.brands` ou quand `navigator.webdriver` est truthy.
// Ces propriétés vivent dans le *main world* ; avec contextIsolation: true,
// le preload a son propre contexte et ne peut pas réécrire directement la
// valeur vue par la page. On injecte donc un <script> inline qui exécute
// dans le main world avant les scripts de Gather/Turnstile.
//
// Couche HTTP (Client Hints `sec-ch-ua`) : gérée dans main.ts via
// onBeforeSendHeaders. Les deux couches doivent rester cohérentes (même
// version de Chrome), sinon Turnstile détecte l'incohérence.

const CHROME_MAJOR = '130';
const CHROME_FULL = '130.0.6723.117';

const PATCH_CODE = `
(() => {
  const brands = [
    { brand: 'Chromium', version: '${CHROME_MAJOR}' },
    { brand: 'Google Chrome', version: '${CHROME_MAJOR}' },
    { brand: 'Not?A_Brand', version: '99' },
  ];
  const fullBrands = [
    { brand: 'Chromium', version: '${CHROME_FULL}' },
    { brand: 'Google Chrome', version: '${CHROME_FULL}' },
    { brand: 'Not?A_Brand', version: '99.0.0.0' },
  ];

  // 1) navigator.userAgentData : retirer "Electron" de la liste de marques
  try {
    if ('userAgentData' in navigator && navigator.userAgentData) {
      const uaData = navigator.userAgentData;
      Object.defineProperty(uaData, 'brands', {
        get: () => brands.map((b) => ({ ...b })),
        configurable: true,
      });
      Object.defineProperty(uaData, 'platform', {
        get: () => 'Linux',
        configurable: true,
      });
      Object.defineProperty(uaData, 'mobile', {
        get: () => false,
        configurable: true,
      });

      // getHighEntropyValues : certaines lib (Turnstile inclus) le lisent
      // pour obtenir fullVersionList. On renvoie des valeurs cohérentes.
      const original = uaData.getHighEntropyValues?.bind(uaData);
      if (original) {
        uaData.getHighEntropyValues = async (hints) => {
          const values = await original(hints);
          values.brands = brands.map((b) => ({ ...b }));
          values.fullVersionList = fullBrands.map((b) => ({ ...b }));
          values.platform = 'Linux';
          values.platformVersion = '6.19.0';
          values.architecture = 'x86';
          values.bitness = '64';
          values.model = '';
          values.mobile = false;
          values.wow64 = false;
          values.uaFullVersion = '${CHROME_FULL}';
          return values;
        };
      }
    }
  } catch (e) {
    console.warn('[gather-wrapper] userAgentData patch failed:', e);
  }

  // 2) navigator.webdriver : Chrome renvoie false, jamais true
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  } catch (e) {
    /* déjà défini en getter non-configurable — on ignore */
  }

  // 3) window.chrome : Turnstile vérifie son existence et la présence de
  // .runtime. Electron ne l'expose pas par défaut.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} },
        writable: true,
        configurable: true,
      });
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  } catch (e) {
    /* ignore */
  }

  // 4) navigator.plugins : Chrome Linux expose toujours le PDF Viewer.
  // Un tableau vide est un signal headless / bot.
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const fakePlugin = {
        name: 'PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 1,
      };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [fakePlugin, fakePlugin, fakePlugin, fakePlugin, fakePlugin],
        configurable: true,
      });
    }
  } catch (e) {
    /* ignore */
  }
})();
`;

// Injection synchrone aussi tôt que possible. À ce stade le preload
// s'exécute avant tout script de la page, et documentElement existe déjà
// (document a été créé par Chromium avant l'appel du preload).
function injectPatch(): void {
  try {
    const script = document.createElement('script');
    script.textContent = PATCH_CODE;
    const target = document.documentElement || document.head || document.body;
    if (target) {
      target.prepend(script);
      script.remove();
    }
  } catch (e) {
    console.error('[gather-wrapper] patch injection failed:', e);
  }
}

injectPatch();

// Trace utile pour vérifier que le preload tourne dans les iframes Turnstile
// (challenges.cloudflare.com). Apparaîtra deux fois en console : main + iframe.
console.log('[gather-wrapper] preload active @', window.location.hostname);

export {};
