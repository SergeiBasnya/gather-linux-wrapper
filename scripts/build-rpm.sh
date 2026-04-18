#!/usr/bin/env bash
# Build RPM manuellement sans fpm.
#
# Pourquoi : fpm 1.9.3 (embarqué par electron-builder 25) génère des specs
# compatibles RPM 4, mais Fedora 43 utilise RPM 6 qui a retiré le tag `Group`
# et durci la validation. Ce script contourne fpm et appelle rpmbuild
# directement sur le répertoire linux-unpacked déjà produit par electron-builder.
#
# Prérequis : `npm run build:ts && npx electron-builder --linux --dir` a été
# lancé et out/linux-unpacked/ existe.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNPACKED="$PROJECT_DIR/out/linux-unpacked"
OUT_DIR="$PROJECT_DIR/out"

# Métadonnées lues depuis package.json
NAME="gather-linux-wrapper"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
SUMMARY="Desktop wrapper pour Gather Town"
URL="$(node -p "require('$PROJECT_DIR/package.json').homepage || ''")"

if [[ ! -d "$UNPACKED" ]]; then
  echo "Erreur : $UNPACKED introuvable."
  echo "Lance d'abord : npx electron-builder --linux --dir"
  exit 1
fi

BUILD_ROOT="$(mktemp -d /tmp/gather-rpmbuild.XXXXXX)"
trap 'rm -rf "$BUILD_ROOT"' EXIT

echo "==> Workspace: $BUILD_ROOT"
mkdir -p "$BUILD_ROOT"/{BUILD,SPECS,RPMS,SOURCES,SRPMS}

# --- Assets temporaires que le spec référencera via %{assets_dir} ---
mkdir -p "$BUILD_ROOT/BUILD/icons"
cp -a "$UNPACKED" "$BUILD_ROOT/BUILD/linux-unpacked"

for size in 48 64 128 256 512; do
  mkdir -p "$BUILD_ROOT/BUILD/icons/$size"
  magick "$PROJECT_DIR/assets/icon.png" -resize "${size}x${size}" -depth 8 \
    "PNG32:$BUILD_ROOT/BUILD/icons/$size/gather.png"
done

cat > "$BUILD_ROOT/BUILD/gather.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=Gather
GenericName=Virtual HQ
Comment=Wrapper desktop pour Gather Town
Exec=/opt/Gather/gather-linux-wrapper %U
Icon=gather
Terminal=false
Categories=Network;Chat;VideoConference;InstantMessaging;
Keywords=gather;gathertown;meeting;remote;team;virtual;office;
StartupNotify=true
StartupWMClass=Gather
EOF

# --- Spec file (compatible RPM 6) ---
cat > "$BUILD_ROOT/SPECS/$NAME.spec" <<EOF
Name:           $NAME
Version:        $VERSION
Release:        1%{?dist}
Summary:        $SUMMARY
License:        MIT
URL:            $URL
BuildArch:      x86_64

Requires:       libnotify
Requires:       libXScrnSaver
Requires:       pipewire

# On désactive l'auto-détection : les binaires Electron embarquent leurs
# propres libs dans /opt/Gather et leurs .so ne doivent pas leaker comme
# Provides au système.
AutoReqProv:    no

%description
Wrapper Electron non-officiel pour Gather Town avec support WebRTC
(micro, caméra, partage d'écran Wayland via xdg-desktop-portal).

Non affilié à Gather Presence Inc.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt/Gather
cp -a %{assets_dir}/linux-unpacked/. %{buildroot}/opt/Gather/

mkdir -p %{buildroot}/usr/bin
ln -sf /opt/Gather/gather-linux-wrapper %{buildroot}/usr/bin/gather

mkdir -p %{buildroot}/usr/share/applications
install -m 644 %{assets_dir}/gather.desktop \\
  %{buildroot}/usr/share/applications/gather.desktop

for size in 48 64 128 256 512; do
  mkdir -p %{buildroot}/usr/share/icons/hicolor/\${size}x\${size}/apps
  install -m 644 %{assets_dir}/icons/\${size}/gather.png \\
    %{buildroot}/usr/share/icons/hicolor/\${size}x\${size}/apps/gather.png
done

%files
/opt/Gather
/usr/bin/gather
/usr/share/applications/gather.desktop
/usr/share/icons/hicolor/48x48/apps/gather.png
/usr/share/icons/hicolor/64x64/apps/gather.png
/usr/share/icons/hicolor/128x128/apps/gather.png
/usr/share/icons/hicolor/256x256/apps/gather.png
/usr/share/icons/hicolor/512x512/apps/gather.png

%post
# chrome-sandbox doit être SUID root pour que le sandbox Chromium fonctionne
# quand user namespaces ne sont pas disponibles.
chmod 4755 /opt/Gather/chrome-sandbox 2>/dev/null || :
update-desktop-database -q /usr/share/applications 2>/dev/null || :
gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || :

%postun
update-desktop-database -q /usr/share/applications 2>/dev/null || :
gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || :

%changelog
* Sat Apr 18 2026 Sebastien Lafontaine <sebastienlafontaine@proton.me> - $VERSION-1
- Initial package
EOF

echo "==> rpmbuild -bb"
# Sous RPM 6 `%{_builddir}` pointe sur un sous-dossier auto-créé
# (<name>-<version>-build). On utilise notre propre macro `%{assets_dir}`
# résolue en chemin absolu pour que le spec retrouve nos fichiers.
rpmbuild \
  --define "_topdir $BUILD_ROOT" \
  --define "_rpmdir $BUILD_ROOT/RPMS" \
  --define "assets_dir $BUILD_ROOT/BUILD" \
  -bb "$BUILD_ROOT/SPECS/$NAME.spec"

RPM_PATH="$(find "$BUILD_ROOT/RPMS" -name '*.rpm' | head -1)"
if [[ -z "$RPM_PATH" ]]; then
  echo "Erreur : aucun RPM produit."
  exit 1
fi

DEST="$OUT_DIR/$(basename "$RPM_PATH")"
cp "$RPM_PATH" "$DEST"
echo ""
echo "==> RPM produit : $DEST"
ls -lh "$DEST"
