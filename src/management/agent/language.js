"use strict";

// V2 spoken-language contract. These locales have neural female voice coverage
// in voice.js and are accepted for automatic call-language routing.
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
  english:"en", spanish:"es", french:"fr", german:"de", portuguese:"pt",
  italian:"it", dutch:"nl", polish:"pl", russian:"ru", ukrainian:"uk",
  turkish:"tr", arabic:"ar", hindi:"hi", urdu:"ur", chinese:"zh",
  mandarin:"zh", japanese:"ja", korean:"ko", indonesian:"id", malay:"ms",
  vietnamese:"vi", thai:"th", hebrew:"he", greek:"el", czech:"cs",
  romanian:"ro", swedish:"sv", danish:"da", finnish:"fi", norwegian:"nb",
  slovak:"sk", slovenian:"sl",
});

function normalizeLanguage(code, fallback="en") {
  const raw=String(code||"").trim().toLowerCase().replace(/_/g,"-");
  if (ALIASES[raw]) return ALIASES[raw];
  const base=raw.split("-")[0];
  const normalized=ALIASES[base]||base;
  return SUPPORTED_LANGUAGES[normalized] ? normalized : fallback;
}

function languageName(code) {
  const c=normalizeLanguage(code);
  return SUPPORTED_LANGUAGES[c]||SUPPORTED_LANGUAGES.en;
}

// High-precision text markers used when STT returns no language field.
const TEXT_MARKERS = Object.freeze({
  es: /\b(hola|buenos dias|buenas tardes|buenas noches|gracias|por favor|señor|señora|me llamo|estoy ocupado|no me llame|no me interesa|no gracias|sí|si)\b/i,
  fr: /\b(bonjour|bonsoir|merci|monsieur|madame|je suis|pas intéressé|ne me rappelez pas|s'il vous plaît|oui|non merci)\b/i,
  de: /\b(hallo|guten tag|guten morgen|guten abend|danke|herr|frau|ich bin|nicht interessiert|rufen sie mich nicht an|bitte|nein danke)\b/i,
  pt: /\b(olá|ola|bom dia|boa tarde|boa noite|obrigado|senhor|senhora|meu nome|estou ocupado|não me ligue|por favor|não obrigado)\b/i,
  it: /\b(buongiorno|buonasera|grazie|come stai|mi chiamo|occupato|non mi chiamare|per favore|prego|salve)\b/i,
  nl: /\b(goedemorgen|goedemiddag|goedenavond|dank je|alsjeblieft|met wie spreekt u|niet geïnteresseerd|bel me niet)\b/i,
  pl: /\b(dzień dobry|dzień dobry|proszę|dziękuję|nie jestem zainteresowany|nie dzwoń|kto mówi)\b/i,
  ru: /\b(привет|здравствуйте|добрый день|доброе утро|спасибо|пожалуйста|не интересует|не звоните|меня зовут)\b/i,
  tr: /\b(merhaba|günaydın|iyi akşamlar|teşekkür ederim|lütfen|ilgilenmiyorum|aramayın|beni aramayın)\b/i,
  ar: /\b(مرحبا|السلام عليكم|صباح الخير|مساء الخير|شكرا|من فضلك|لا أهتم|لا تتصل)\b/i,
  hi: /(नमस्ते|हाँ|नहीं|धन्यवाद|मेरा नाम|मुझे नहीं चाहिए|ठीक है)|(namaste|nahin|theek hai|mujhe nahin chahiye)\b/i,
  ja: /(こんにちは|おはよう|ありがとう|すみません|お願いします|興味ありません|名前)/,
  ko: /(안녕하세요|감사합니다|반갑습니다|이름이|관심 없습니다)/,
  vi: /\b(xin chào|cảm ơn|không cảm ơn|tôi là|không quan tâm)\b/i,
  id: /\b(halo|selamat pagi|terima kasih|nama saya|tidak tertarik|jangan telepon)\b/i,
});

/** Fallback language detection from transcribed text when STT omits language. */
function detectLanguageText(text, fallback = "en") {
  const t = String(text || "");
  for (const [loc, re] of Object.entries(TEXT_MARKERS)) {
    if (re.test(t)) return loc;
  }
  return fallback;
}

module.exports={SUPPORTED_LANGUAGES,normalizeLanguage,languageName,detectLanguageText};
