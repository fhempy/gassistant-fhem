#!/usr/bin/env bash
#
# Lokaler Test von gassistant-fhem 4.0.0 (Branch claude/clever-cray-rr0j0j)
# ohne git und ohne die global installierte Version zu verändern.
#
# Aufruf:  ./test-local.sh [Optionen für gassistant-fhem]
#   z.B.   ./test-local.sh -c /opt/fhem/.fhemconnect/gassistant-fhem.cfg
#
# Umgebungsvariablen:
#   BRANCH   Branch, der getestet wird   (Standard: claude/clever-cray-rr0j0j)
#   TESTDIR  Installationsverzeichnis    (Standard: ~/gassistant-fhem-test)
#
set -euo pipefail

BRANCH="${BRANCH:-claude/clever-cray-rr0j0j}"
TESTDIR="${TESTDIR:-$HOME/gassistant-fhem-test}"
TARBALL="https://codeload.github.com/fhempy/gassistant-fhem/tar.gz/refs/heads/${BRANCH}"

info() { echo -e "\033[1;34m==>\033[0m $*"; }
fail() { echo -e "\033[1;31mFEHLER:\033[0m $*" >&2; exit 1; }

# --- Voraussetzungen ---------------------------------------------------------
for cmd in node npm curl tar; do
  command -v "$cmd" >/dev/null || fail "'$cmd' ist nicht installiert."
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $(node -v) ist zu alt, benötigt wird Node.js 20 oder neuer."
fi
info "Node.js $(node -v), npm $(npm -v)"

# --- Download & Installation -------------------------------------------------
info "Lade Branch '$BRANCH' nach $TESTDIR ..."
rm -rf "$TESTDIR"
mkdir -p "$TESTDIR"
curl -fsSL "$TARBALL" | tar xz -C "$TESTDIR" --strip-components=1

cd "$TESTDIR"
info "Version: $(node -p 'require("./package.json").version')"

info "Installiere Abhängigkeiten (npm ci) ..."
npm ci --omit=dev --no-fund --no-audit

info "Starte Tests ..."
npm test

# --- Laufende Instanz stoppen ------------------------------------------------
RUNNING="$(pgrep -x fhem-connect || true)"
if [ -n "$RUNNING" ]; then
  echo
  echo "Es läuft bereits gassistant-fhem (PID: $RUNNING)."
  read -r -p "Jetzt stoppen, um die neue Version zu testen? [j/N] " answer
  if [[ "$answer" =~ ^[jJyY]$ ]]; then
    kill $RUNNING 2>/dev/null || sudo kill $RUNNING
    sleep 3
    pgrep -x fhem-connect >/dev/null && fail "Prozess läuft noch. Wird er von FHEM automatisch neu gestartet?"
  else
    fail "Abgebrochen, es kann nur eine Instanz laufen."
  fi
fi

# --- Starten -----------------------------------------------------------------
echo
info "Starte gassistant-fhem $(node -p 'require("./package.json").version') im Debug-Modus. Beenden mit Strg+C."
info "Bitte prüfen: Login/Verbindung, Sprachbefehle, Statusänderungen in der Google Home App, Local Home."
echo
set +e
node "$TESTDIR/bin/gassistant-fhem" -D "$@"
set -e

echo
info "Test beendet. Die global installierte Version wurde nicht verändert."
info "Alte Version wieder starten: so wie bisher (z.B. über FHEM oder 'gassistant-fhem')."
info "Testinstallation entfernen:  rm -rf $TESTDIR"
