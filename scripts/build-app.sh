#!/bin/bash
# Builds "Agent 信鸽.app" and a DMG into dist/.
#
#   scripts/build-app.sh            ad-hoc signed build (runs on this Mac; others: right-click → 打开)
#   SIGN_ID="Developer ID Application: …" NOTARY_PROFILE=… scripts/build-app.sh
#                                   Developer ID signed + notarized (for GitHub releases)
#
# Needs: bun (engine → one binary), swift (the shell), hdiutil. No Xcode project, no Electron.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="$(sed -nE 's/^export const VERSION = "([^"]+)".*/\1/p' src/core/version.js)"
BUILD="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
BUNDLE_ID="${BUNDLE_ID:-io.github.shrekcg.agentpigeon}"
ARCH="${ARCH:-arm64}"
OUT="$ROOT/dist"
APP="$OUT/Agent 信鸽.app"
SIGN_ID="${SIGN_ID:--}"

echo "==> Agent 信鸽 v$VERSION ($ARCH, build $BUILD)"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> engine (bun --compile)"
[ -d node_modules/@larksuiteoapi ] || npm ci --omit=dev --no-audit --no-fund
# See scripts/bundle-engine.mjs: no build-machine paths baked in, no .env/bunfig autoload.
bun scripts/bundle-engine.mjs "$APP/Contents/MacOS/agent-pigeon-engine" "bun-darwin-$ARCH"

echo "==> shell (swift build)"
( cd app/macos && swift build -c release --arch "$ARCH" >/dev/null )
cp "app/macos/.build/$ARCH-apple-macosx/release/AgentPigeon" "$APP/Contents/MacOS/AgentPigeon" 2>/dev/null \
  || cp app/macos/.build/release/AgentPigeon "$APP/Contents/MacOS/AgentPigeon"

echo "==> resources"
sed -e "s/@VERSION@/$VERSION/" -e "s/@BUILD@/$BUILD/" -e "s/@BUNDLE_ID@/$BUNDLE_ID/" app/macos/Info.plist > "$APP/Contents/Info.plist"
cp app/assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp app/assets/StatusIcon.png app/assets/StatusIcon@2x.png "$APP/Contents/Resources/"
cp -R app/web "$APP/Contents/Resources/web"
mkdir -p "$APP/Contents/Resources/skill" && cp skill/feishu-topic/SKILL.md "$APP/Contents/Resources/skill/SKILL.md"
cp LICENSE THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/" 2>/dev/null || true

echo "==> sign ($([ "$SIGN_ID" = "-" ] && echo ad-hoc || echo "$SIGN_ID"))"
ENT="$ROOT/app/macos/engine.entitlements"
OPTS=(--force --timestamp=none)
[ "$SIGN_ID" != "-" ] && OPTS=(--force --timestamp --options runtime)
codesign "${OPTS[@]}" --entitlements "$ENT" -s "$SIGN_ID" "$APP/Contents/MacOS/agent-pigeon-engine"
codesign "${OPTS[@]}" -s "$SIGN_ID" "$APP/Contents/MacOS/AgentPigeon"
codesign "${OPTS[@]}" -s "$SIGN_ID" "$APP"
codesign --verify --deep --strict "$APP"

echo "==> dmg"
DMG="$OUT/AgentPigeon-$VERSION-$ARCH.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Agent 信鸽 $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"
[ "$SIGN_ID" != "-" ] && codesign --force --timestamp -s "$SIGN_ID" "$DMG"

if [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "==> notarize"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

du -sh "$APP" "$DMG" | sed 's#'"$ROOT"'/##'
echo "==> done: $DMG"
