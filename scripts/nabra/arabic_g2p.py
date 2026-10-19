"""Arabic (MSA) text clean-up and phoneme fix-ups for Nabra-82M (oddadmix/Nabra-82M-v0.1).

Written for this repo from the description on the model card (https://huggingface.co/oddadmix/Nabra-82M-v0.1,
"G2P Pipeline" and "Model Details"). The author's own front-end, a gist, carries no licence, so it is not copied here.

The model card's pipeline: normalize -> diacritize (camel-tools) -> phonemize (espeak-ng, "ar") -> clean.
  1. normalize: drop citation markers ([12]) and Latin-script words (espeak would mangle them), tidy whitespace.
  2. diacritize: tts.py, with camel-tools' MLE disambiguator (calima-msa-r13).
  3. phonemize: misaki's EspeakG2P(language="ar"), inside the Kokoro pipeline.
  4. clean: espeak marks syllable boundaries inside words with "." which Kokoro reads as a pause, so those go;
     the pharyngealisation marker and bracket markers are not in the vocabulary and go too. The pharyngeal
     fricatives ʕ (ع) and ħ (ح) are kept: Nabra gives them the free Kokoro vocabulary ids 7 and 8.
"""
import re

# Nabra's two extra phonemes and their ids in the Kokoro vocabulary (model card: "ʕ→7, ħ→8")
EXTRA_SYMBOLS = {"ʕ": 7, "ħ": 8}

_CITATION = re.compile(r"\[[^\]]*\]")
_LATIN = re.compile(r"[A-Za-z]+")
_SPACES = re.compile(r"\s+")
# a "." stuck to a phoneme is a syllable boundary (inside a word, or at a word's end mid-sentence), not the end of
# a sentence: only a final one, or one standing on its own (the tokenized full stop), is kept
_SYLLABLE_DOT = re.compile(r"(?<=\S)\.(?=\s*\S)")
# markers outside the vocabulary: pharyngealisation (ˤ), dental (U+032A), and the brackets espeak puts round
# text it cannot read
_DROP = str.maketrans("", "", "\u02e4\u032a[]{}")

# Arabic short-vowel and related marks (tashkeel): fathatan .. sukun, plus the superscript alef
TASHKEEL = re.compile("[\u064b-\u0652\u0670]")


def normalize(text: str) -> str:
    """Text the phonemizer can read: no citation markers, no Latin words, single spaces."""
    text = _CITATION.sub(" ", text)
    text = _LATIN.sub(" ", text)
    return _SPACES.sub(" ", text).strip()


def clean_phonemes(phonemes: str) -> str:
    """espeak-ng's Arabic IPA, fitted to Nabra's vocabulary."""
    return _SYLLABLE_DOT.sub("", phonemes).translate(_DROP)


def has_tashkeel(word: str) -> bool:
    return bool(TASHKEEL.search(word))


def strip_tashkeel(word: str) -> str:
    return TASHKEEL.sub("", word)


def _marks(word: str) -> list[set[str]]:
    """The marks on each letter of `word`."""
    out: list[set[str]] = []
    for c in word:
        if TASHKEEL.match(c):
            if out:
                out[-1].add(c)
        else:
            out.append(set())
    return out


def agrees(written: str, reading: str) -> bool:
    """`reading` (a diacritized form) has the same letters as `written` and every mark the writer put on them."""
    if strip_tashkeel(written) != strip_tashkeel(reading):
        return False
    return all(w <= r for w, r in zip(_marks(written), _marks(reading)))


def mostly_marked(word: str) -> bool:
    """At least half the letters carry a mark: the writer meant this reading."""
    marks = _marks(word)
    return bool(marks) and sum(1 for m in marks if m) * 2 >= len(marks)
