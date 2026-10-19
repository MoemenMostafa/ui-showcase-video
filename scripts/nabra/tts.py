"""Nabra, a local Arabic (MSA) voice for narrate.ts (NARRATOR_ENGINE=nabra). Set up with scripts/nabra/setup.sh.

Loads the model once, then reads requests from stdin, one JSON object per line:
    {"text": "مرحبا بك في نبرة", "file": "/abs/out.wav", "speed": 1.0}
and answers each on stdout with one JSON line, in order:
    {"file": "/abs/out.wav", "seconds": 1.82, "ms": 410}      or      {"error": "..."}
Writes 24 kHz mono 16-bit WAVs. Prints {"ready": true} once the model is loaded. Everything runs on this machine:
the model and camel-tools data come from local caches (setup.sh fetched them), so the text never leaves it.

Text is diacritized (short-vowel marks, tashkeel, restored) with camel-tools first, keeping the marks the writer put in;
a line where every word already has tashkeel is read as written.
"""
import json
import os
import sys
import time

# offline: everything was fetched by setup.sh
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = "oddadmix/Nabra-82M-v0.1"
REVISION = "adf6abf35c46db5f2b08803b5067a12c759b1ee1"  # the revision setup.sh fetched
RATE = 24000

# the protocol owns stdout; anything the libraries print goes to stderr
out = sys.stdout
sys.stdout = sys.stderr


def reply(obj: dict) -> None:
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


def load():
    import numpy as np
    import soundfile as sf
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline
    from kokoro import pipeline as kpipeline
    from camel_tools.disambig.mle import MLEDisambiguator
    from camel_tools.tokenizers.word import simple_word_tokenize
    from arabic_g2p import EXTRA_SYMBOLS, agrees, clean_phonemes, has_tashkeel, mostly_marked, normalize, strip_tashkeel

    fetch = lambda f: hf_hub_download(REPO, f, revision=REVISION, local_files_only=True)
    # config + weights passed explicitly, so no base model is fetched; real-valued STFT (as the model card does)
    model = KModel(repo_id=REPO, config=fetch("config.json"), model=fetch("kokoro_arabic.pth"), disable_complex=True).eval()
    model.vocab.update(EXTRA_SYMBOLS)
    voice = torch.load(fetch(os.environ.get("NABRA_VOICE", "af_msa") + ".pt"), map_location="cpu", weights_only=True)
    kpipeline.LANG_CODES.setdefault("ar", "ar")
    pipe = KPipeline(lang_code="ar", repo_id=REPO, model=model)
    espeak = pipe.g2p
    pipe.g2p = lambda t: (lambda r: (clean_phonemes(r[0]), r[1]))(espeak(t))
    mle = MLEDisambiguator.pretrained()

    def other_readings(word: str) -> list[str]:
        """All the dictionary's readings of `word`, likeliest first: the MLE gives only its best one."""
        try:
            found = {a["diac"]: a.get("pos_lex_logprob", -99.0) for a in mle._analyzer.analyze(word)}
        except Exception:  # a private attribute of camel-tools; without it, the MLE's reading is used
            return []
        return sorted(found, key=lambda r: -found[r])

    def diacritize(text: str) -> str:
        words = simple_word_tokenize(text)
        if not any(any(c.isalpha() for c in w) and not has_tashkeel(w) for w in words):
            return text  # every word already has tashkeel: read it as written
        best = []
        for word, d in zip(words, mle.disambiguate([strip_tashkeel(w) for w in words])):
            readings = [a.analysis.get("diac", word) for a in d.analyses]
            if has_tashkeel(word) and not any(agrees(word, r) for r in readings):
                readings += other_readings(strip_tashkeel(word))
            # the likeliest reading that agrees with the marks the writer put in (e.g. the shadda in تتصفّى)
            best.append(next((r for r in readings if agrees(word, r)), word if mostly_marked(word) or not readings else readings[0]))
        return " ".join(best)

    def speak(text: str, file: str, speed: float) -> float:
        text = diacritize(normalize(text))
        results = [r for r in pipe(text, voice=voice, speed=speed) if r.audio is not None]
        if not results:
            raise ValueError(f"nothing to say in {text!r}")
        if os.environ.get("NABRA_DEBUG"):  # what was read: diacritized text and phonemes
            print(f"nabra: {text} -> {' '.join(r.phonemes for r in results)}", file=sys.stderr)
        parts = [r.audio.detach().cpu().numpy() for r in results]
        wav = np.concatenate(parts).astype(np.float32)
        sf.write(file, wav, RATE, subtype="PCM_16")
        return len(wav) / RATE

    return speak


def main() -> None:
    try:
        speak = load()
    except Exception as e:  # missing packages or data: say how to fix it
        reply({"error": f"Nabra could not load ({type(e).__name__}: {e}); run scripts/nabra/setup.sh"})
        sys.exit(1)
    reply({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            t0 = time.perf_counter()
            seconds = speak(req["text"], req["file"], float(req.get("speed", 1.0)))
            reply({"file": req["file"], "seconds": round(seconds, 3), "ms": round((time.perf_counter() - t0) * 1000)})
        except Exception as e:
            reply({"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
