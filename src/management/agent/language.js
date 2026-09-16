"use strict";

// V2 spoken-language contract. These locales all have neural female voice
// coverage in voice.js and are accepted for automatic call-language routing.
const SUPPORTED_LANGUAGES = Object.freeze({
  en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  it: "Italian", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  tr: "Turkish", ar: "Arabic", hi: "Hindi", ur: "Urdu", zh: "Chinese",
  ja: "Japanese", ko: "Korean", id: "Indonesian", ms: "Malay", vi: "Vietnamese",
  th: "Thai", he: "Hebrew", el: "Greek", cs: "Czech", ro: "Romanian",
  sv: "Swedish", da: "Danish", fi: "Finnish", nb: "Norwegian", sk: "Slovak",
  sl: "Slovenian",
});

const ALIASES = Object.freeze({
  eng:"en", spa:"es", fra:"fr", fre:"fr", deu:"de", ger:"de", por:"pt",
  ita:"it", nld:"nl", dut:"nl", pol:"pl", rus:"ru", ukr:"uk", tur:"tr",
  ara:"ar", hin:"hi", urd:"ur", zho:"zh", chi:"zh", cmn:"zh", jpn:"ja",
  kor:"ko", ind:"id", msa:"ms", may:"ms", vie:"vi", tha:"th", heb:"he",
  ell:"el", gre:"el", ces:"cs", cze:"cs", ron:"ro", rum:"ro", swe:"sv",
  dan:"da", fin:"fi", nor:"nb", nob:"nb", slk:"sk", slo:"sk", slv:"sl",
});

function normalizeLanguage(code, fallback="en") {
  const raw=String(code||"").trim().toLowerCase().replace(/_/g,"-");
  const base=raw.split("-")[0];
  const normalized=ALIASES[base]||base;
  return SUPPORTED_LANGUAGES[normalized] ? normalized : fallback;
}

function languageName(code) {
  const c=normalizeLanguage(code);
  return SUPPORTED_LANGUAGES[c]||SUPPORTED_LANGUAGES.en;
}

module.exports={SUPPORTED_LANGUAGES,normalizeLanguage,languageName};
