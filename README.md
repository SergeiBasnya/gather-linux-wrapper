# Gather Linux Wrapper

Wrapper desktop Electron **non-officiel** pour [Gather Town](https://www.gather.town/),
pensé pour Linux (Fedora 43 / GNOME Wayland testé).

Pourquoi : Gather n'a pas d'app officielle Linux et ouvrir un onglet navigateur
à chaque session est peu ergonomique. Ce wrapper :

- charge `https://app.v2.gather.town` (Gather V2) dans une fenêtre native
  avec icône GNOME ; la V1 (`app.gather.town`) reste whitelistée pour la
  navigation si tu tombes sur un ancien lien ;
- gère correctement les permissions WebRTC (micro, caméra) ;
- supporte le **partage d'écran sous Wayland** via `xdg-desktop-portal` + PipeWire ;
- persiste la session (cookies, localStorage) entre lancements ;
- se fait passer pour Chrome Desktop auprès de Gather (qui refuse parfois Electron).

## Prérequis

- **Node.js 20+** et npm (développé avec Node 22)
- **Fedora / Wayland** : `xdg-desktop-portal` et `xdg-desktop-portal-gnome`
  (déjà présents sur une installation GNOME standard)
- **PipeWire** (activé par défaut sur Fedora 43)

## Structure

```
src/
  main.ts       # Process principal Electron (fenêtre, permissions, menu)
  preload.ts    # Preload (vide volontairement, contextIsolation activé)
assets/
  icon.png      # Icône 512x512 (placeholder — à remplacer)
build/linux/
  gather-linux.desktop  # Entry GNOME (fournie à titre indicatif ;
                         # electron-builder en génère une automatiquement)
```

## Commandes

```bash
# Installer les dépendances
npm install

# Lancer en mode dev (compile TypeScript puis démarre Electron)
npm run dev

# Compiler TypeScript seul
npm run build:ts

# Builder les artefacts Linux (AppImage + RPM)
npm run dist

# Cibler un seul format
npm run dist:appimage
npm run dist:rpm
```

Les artefacts de build atterrissent dans `out/`.

## Installer l'app packagée

### AppImage (portable, aucune install système)

```bash
chmod +x out/Gather-0.1.0.AppImage
./out/Gather-0.1.0.AppImage
```

Pour intégrer proprement l'icône dans le menu GNOME avec un AppImage, utilise
[AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) ou déplace
l'AppImage dans `~/Applications/` puis lance-le une fois — la plupart des
environnements Linux créent automatiquement l'entrée desktop.

### RPM (install système, intégration GNOME native)

```bash
sudo dnf install ./out/gather-linux-wrapper-0.1.0-1.fc43.x86_64.rpm
```

Après installation :

- L'app apparaît dans le menu GNOME sous **Gather**
- Elle peut être lancée depuis le terminal avec `gather`
- Désinstallation : `sudo dnf remove gather-linux-wrapper`

> **Note sur le build RPM** — electron-builder 25.x embarque fpm 1.9.3 qui
> génère des specs incompatibles avec RPM 6 (Fedora 43+). Le script
> `scripts/build-rpm.sh` contourne le problème en invoquant `rpmbuild`
> directement sur le `linux-unpacked/` produit par electron-builder.
> Prérequis : `sudo dnf install libxcrypt-compat` (pour qu'electron-builder
> puisse lui-même faire sa passe de packaging intermédiaire via fpm).

## Architecture & choix techniques

| Sujet | Choix |
|---|---|
| Isolation | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` |
| Remote module | Désactivé (déprécié, non utilisé) |
| User-Agent | Chrome 130 Linux — Gather bloque l'UA "Electron" sur certaines features |
| Cloudflare Turnstile | `sec-ch-ua` réécrit + `navigator.userAgentData` patché dans toutes les frames (préload avec `nodeIntegrationInSubFrames`) |
| Partage d'écran | `setDisplayMediaRequestHandler` avec `useSystemPicker: true` → portail Wayland |
| Flags Chromium | `--enable-features=WebRTCPipeWireCapturer` + `--ozone-platform-hint=auto` |
| Certificats | Erreurs TLS rejetées sans bypass |
| Instance unique | `requestSingleInstanceLock` — relancer focus la fenêtre existante |

La session est persistée dans le répertoire `userData` standard d'Electron
(`~/.config/Gather/`), donc cookies et localStorage Gather survivent aux
redémarrages.

## Remplacer l'icône

L'icône `assets/icon.png` est un placeholder 512x512 généré avec ImageMagick.
Pour la remplacer, déposez simplement votre propre PNG 512x512 (ou plus, carré)
au même emplacement. electron-builder fera le reste au prochain `npm run dist`.

## Limitations connues

- Gather peut détecter l'environnement et afficher "navigateur non supporté"
  si l'UA n'est pas bien injecté. Si ça arrive, vérifier `CHROME_UA` dans
  `src/main.ts`.
- Sous X11 sans `xdg-desktop-portal`, le partage d'écran tombera sur le
  fallback `desktopCapturer` (pas de sélecteur système).
- L'auto-update n'est pas configuré.

## Licence

MIT. Ce projet n'est pas affilié à Gather Presence Inc.
