#!/usr/bin/env bash
# Optional: set up Nabra, the local Arabic (MSA) narrator voice (NARRATOR_ENGINE=nabra).
# Only needed for Arabic narration; nothing else in this tool uses Python. Run it by hand, any number of times:
#   bash scripts/nabra/setup.sh
# It creates a Python venv (NABRA_VENV, default ~/.cache/nabra/venv), installs the pinned packages, fetches the
# camel-tools MSA diacritizer data and the Nabra model (Hugging Face cache). About 2 GB on disk, mostly PyTorch.
# Behind a TLS-inspecting proxy set PIP_CERT / REQUESTS_CA_BUNDLE / SSL_CERT_FILE / GIT_SSL_CAINFO to its CA certificate.
set -euo pipefail

VENV="${NABRA_VENV:-$HOME/.cache/nabra/venv}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Kokoro from the Nabra author's fork, pinned to the reviewed commit (upstream hexgrad/kokoro dfb907a + one line
# naming the Nabra weights file; tts.py passes config and weights explicitly, so nothing else differs).
KOKORO='kokoro @ git+https://github.com/Oddadmix/kokoro.git@df50e07df746aec0bd7a6f237752d7109ace0b3d'
PINS=(torch==2.14.1 'misaki[en]==0.9.4' camel-tools==1.6.0 soundfile==0.13.1 huggingface_hub)
MODEL=oddadmix/Nabra-82M-v0.1
MODEL_REV=adf6abf35c46db5f2b08803b5067a12c759b1ee1

# misaki 0.9.4 needs Python < 3.13, camel-tools 1.6 needs >= 3.11: use the newest 3.12 or 3.11 there is
pick_python() {
  local c
  for c in "${NABRA_BASE_PYTHON:-}" python3.12 python3.11 \
           "$HOME"/.pyenv/versions/3.12*/bin/python3 "$HOME"/.pyenv/versions/3.11*/bin/python3 \
           "$HOME"/.local/bin/python3.12 "$HOME"/.local/bin/python3.11 python3; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || continue
    if "$c" -c 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] <= (3, 12) else 1)' 2>/dev/null; then echo "$c"; return; fi
  done
  echo "Nabra needs Python 3.11 or 3.12 (misaki < 3.13, camel-tools >= 3.11); install one (brew install python@3.12) or set NABRA_BASE_PYTHON" >&2
  exit 1
}

if ! command -v espeak-ng >/dev/null; then
  if command -v brew >/dev/null; then brew install espeak-ng; else echo "install espeak-ng first" >&2; exit 1; fi
fi

if [ ! -x "$VENV/bin/python" ]; then
  BASE="$(pick_python)"
  echo "creating $VENV with $("$BASE" --version)"
  mkdir -p "$(dirname "$VENV")"
  "$BASE" -m venv "$VENV"
fi
PY="$VENV/bin/python"
# A proxy CA alone would replace the public roots (and not every host is intercepted), so trust both:
# the usual roots (pip's bundled certifi) plus the proxy's certificate, for pip, huggingface_hub and camel_data.
EXTRA_CA="${PIP_CERT:-${REQUESTS_CA_BUNDLE:-${SSL_CERT_FILE:-}}}"
BUNDLE="$(dirname "$VENV")/ca-bundle.pem"
if [ -n "$EXTRA_CA" ] && [ -f "$EXTRA_CA" ] && [ "$EXTRA_CA" != "$BUNDLE" ]; then
  cat "$("$PY" -c 'from pip._vendor import certifi; print(certifi.where())')" "$EXTRA_CA" > "$BUNDLE"
  export PIP_CERT="$BUNDLE" REQUESTS_CA_BUNDLE="$BUNDLE" SSL_CERT_FILE="$BUNDLE" GIT_SSL_CAINFO="$BUNDLE"
fi
"$PY" -m pip install -q --upgrade pip
"$PY" -m pip install -q "${PINS[@]}" "$KOKORO"

# camel-tools' MSA diacritizer (MLE, calima-msa-r13), into ~/.camel_tools (CAMELTOOLS_DATA overrides)
if ! "$PY" -c 'from camel_tools.disambig.mle import MLEDisambiguator; MLEDisambiguator.pretrained()' >/dev/null 2>&1; then
  "$VENV/bin/camel_data" -i disambig-mle-calima-msa-r13
fi

# the model and the af_msa voice, pinned to the reviewed revision, into the Hugging Face cache
"$PY" -I -c "
from huggingface_hub import hf_hub_download
for f in ('config.json', 'kokoro_arabic.pth', 'af_msa.pt'):
    hf_hub_download('$MODEL', f, revision='$MODEL_REV')
"
echo "Nabra is ready: NARRATOR_ENGINE=nabra (python: $PY)"
echo 'smoke test: echo '"'"'{"text":"مرحبا بك في نبرة","file":"/tmp/nabra.wav"}'"'"' | '"$PY $HERE/tts.py"
