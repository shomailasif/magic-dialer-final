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
  // Punjabi is deliberately NOT here. Checked against Microsoft's live voice
  // list: 322 Edge neural voices, zero `pa-*` entries, so Punjabi has no
  // spoken output to route to. Registering it would only produce an English
  // voice reading Punjabi, which is worse than an honest "not available".
  // Add it here once a Punjabi voice exists.
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
//
// Two rules learned the hard way, both from live calls:
//  1. JavaScript's \b is ASCII-only. \b before "привет" can never match, because
//     Cyrillic letters are not \w. Every non-ASCII marker below is deliberately
//     un-anchored - do not add \b back to them.
//  2. Order is precedence, first match wins, and several languages share
//     greeting words (hej in sv/da, hei in fi/nb, terima kasih in ms/id, dobry
//     den in cs/sk). Each language therefore gets markers the others lack, and
//     is placed ahead of its confusable twin.
const TEXT_MARKERS = Object.freeze({
  en: /\b(hello|hi there|thanks|thank you|good (morning|afternoon)|not interested|how are you|call me back|bye|okay|my name is|right away|hold on)\b/i,
  es: /\b(hola|buenos dias|buenas tardes|buenas noches|gracias|por favor|señor|señora|me llamo|estoy ocupado|no me llame|no me interesa|no gracias|sí|si)\b/i,
  fr: /\b(bonjour|bonsoir|merci|monsieur|madame|je suis|pas intéressé|ne me rappelez pas|s'il vous plaît|oui|non merci)\b/i,
  de: /\b(hallo|guten tag|guten morgen|guten abend|danke|herr|frau|ich bin|nicht interessiert|rufen sie mich nicht an|bitte|nein danke)\b/i,
  pt: /\b(olá|ola|bom dia|boa tarde|boa noite|obrigado|senhor|senhora|meu nome|estou ocupado|não me ligue|por favor|não obrigado)\b/i,
  it: /\b(buongiorno|buonasera|grazie|come stai|mi chiamo|occupato|non mi chiamare|per favore|prego|salve)\b/i,
  nl: /\b(goedemorgen|goedemiddag|goedenavond|dank je|alsjeblieft|met wie spreekt u|niet geïnteresseerd|bel me niet)\b/i,
  pl: /dzie[nń] dobry|prosze|proszę|dzi[eę]kuj|nie jestem zainteresowan|nie dzwo[nń]|kto mówi/i,
  ru: /привет|здравствуйте|добрый день|доброе утро|спасибо|пожалуйста|не интересует|не звоните|меня зовут|мне всё равно/i,
  uk: /привіт|дякую|добрий день|не зацікав|не дзвоніть|мене звати|допоможіть|мені байдуже/i,
  tr: /\b(merhaba|günaydın|iyi akşamlar|teşekkür ederim|lütfen|ilgilenmiyorum|aramayın|beni aramayın)\b/i,
  ar: /مرحبا|السلام عليكم|صباح الخير|مساء الخير|شكرا|شكرًا|من فضلك|لا أهتم|لا تتصل|ما اسمك/i,
  hi: /नमस्ते|हाँ|हां|नहीं|धन्यवाद|मेरा नाम|मुझे नहीं चाहिए|ठीक है|\b(namaste|nahin|theek hai|mujhe nahin chahiye)\b/i,
  // Urdu-specific orthography only. A bare Urdu/Arabic letter class also
  // matches plain Arabic, and on the 19:29Z call "ar -> ur" happened.
  ur: /السلام|کیا|ہاں|نہیں|شکریہ|میرا نام|فون کریں|بات کریں|کچھ نہیں|\b(assalam|assalaamu|salam|kya|haan|nahi|shukriya|mera naam|jee haan|theek hai|not interested)\b/i,
  zh: /你好|您好|謝謝|谢谢|不好意思|没有兴趣|沒興趣|没关系|喂|我是/,
  ja: /こんにちは|おはよう|ありがとう|すみません|お願いします|興味ありません|名前/,
  ko: /안녕하세요|감사합니다|반갑습니다|이름이|관심 없습니다/,
  vi: /\b(xin chào|cảm ơn|không cảm ơn|tôi là|không quan tâm)\b/i,
  // ms and id share "terima kasih", so each is given markers the other lacks
  // and Malay is checked first.
  ms: /selamat (pagi|petang|malam)|apa khabar|bagit goed|takde|tak\s+(yang|boleh|nak)|tidak (boleh|mahu)/i,
  id: /\b(halo|selamat pagi|terima kasih|nama saya|tidak tertarik|jangan telepon)\b/i,
  th: /สวัสดี|ขอบคุณ|ไม่สนใจ|คุณชื่อ|ใช่|สบายดี/,
  he: /שלום|תודה|לא מעניין|מה שמך|כן|אני/,
  el: /γεια σας|γειά σας|ευχαριστώ|δεν με ενδιαφέρει|ποιο είναι το όνομά σας|ναι|όχι/i,
  cs: /dobrý den|d[eě]kuji|nem[aá]m z[aá]jem|jak se jmenujete|prosim/i,
  ro: /bun[ăa] ziua|mul[țţ]umesc|nu sunt interesat|cum te cheam[ăa]|va rog/i,
  // sv/da share "hej", fi/nb share "hei", so the confusable word itself is only
  // claimed by the language the others would miss.
  sv: /tack f[öo]r|inte intresserad|vad heter du|kan jag hj[aä]lpa|god (dag|middag)/i,
  fi: /kiitos|en ole kiinnostunut|mik[aä] sinun nimesi on|hei\s+kivaa|auttaako/i,
  nb: /\bhei\b|\btakk\b|ikke interessert|hva heter du|kan jeg hjelpe/i,
  da: /\bhej\b|tak for|meget tak|hvad hedder du|kan jeg hj[aæ]lpe/i,
  sk: /dobrý d[eň]|ďakujem|nem[aá]m z[aá]ujem|ako sa vol[aá]te|m[ôo]zem v[aá]m/i,
  sl: /živjo|hvala|nisem zainteresiran|kako se imenujete|vam lahko/i,
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
