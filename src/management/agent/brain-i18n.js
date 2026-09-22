/**
 * Multilingual sales brain - full template + detection + scoring layer for the
 * charm engine. Same researched playbook as brain.js, rendered for the lead's
 * language.
 *
 * Supported: en, es (Spanish), fr (French), de (German), pt (Portuguese),
 * hi (Hindi). English is the identity default - behavior for `en` is byte-for-
 * byte the tested English brain.
 *
 * Everything an operator needs is language-aware:
 *   - normalized locale ("auto" resolves via detectLanguage)
 *   - spoken openers/rapport/pivots/closes
 *   - "I need your MC" style field questions + re-asks
 *   - objection detection + soft brush-off detection for scoring
 *   - "is this a rejection?" lexicons for call-runner
 *   - "the lead asked for a real human" escalation
 */

// Strong, high-precision language markers (STT returns lowercase Latin script
// for en/es/fr/de/pt; Hindi comes back as Devanagari only if a Hindi engine is
// installed, so we also accept the common Latin transliterations).
const MARKERS = {
  es: /\b(hola|buenos dias|buenas tardes|buenas noches|si|sí|no me interesa|no gracias|gracias|por favor|señor|señora|camion|camionero|dispatch|mi nombre es|me llamo|estoy ocupado|no me llame)\b/i,
  fr: /\b(bonjour|bonsoir|oui|non merci|non|merci|monsieur|madame|je m' appelle|je suis|pas intéressé|ne me rappelez pas|conducteur|camon|occupé|s'il vous plaît)\b/i,
  de: /\b(hallo|guten tag|guten morgen|guten abend|ja|nein danke|nein|danke|herr|frau|ich heisse|ich bin|nicht interessiert|rufen sie mich nicht an|fahrer|lkw|beschäftigt|bitte)\b/i,
  pt: /\b(olá|ola|bom dia|boa tarde|boa noite|sim|nao|não|não obrigado|obrigado|senhor|senhora|meu nome é|me chamo|estou ocupado|não me ligue|motorista|caminhão|caminhao|por favor)\b/i,
  hi: /(नमस्ते|हाँ|नहीं|धन्यवाद|मेरा नाम|मुझे नहीं चाहिए|ठीक है|रुको|मुझे ना बुलाएं)|(namaste|haan|nahin|theek hai|mujhe nahin chahiye|main karta)\b/i,
};

/** Pick a locale from raw text ("auto"/undefined -> en if nothing matches). */
function detectLanguage(text, fallback = "en") {
  const t = String(text || "");
  for (const [loc, re] of Object.entries(MARKERS)) {
    if (re.test(t)) return loc;
  }
  return fallback;
}

const NORMAL = { en: "en", es: "es", fr: "fr", de: "de", pt: "pt", hi: "hi" };
function normalizeLocale(locale) {
  const raw = String(locale || "en").trim().toLowerCase();
  if (raw === "auto") return "auto";
  const base = raw.split("-")[0];
  return NORMAL[base] || "en";
}

// ---------------------------------------------------------------------------
// Rejection ("no/nope/stop") and soft brush-off lexicons, per language.
// call-runner uses these to decide pivot-vs-exit and to count rejections.
// ---------------------------------------------------------------------------
/**
 * Build a tolerant lexicon RegExp from word/phrase items. Unlike `\b`, this
 * works across scripts: JS word-boundaries only understand ASCII letters, so
 * `moté\b` can never match. We instead require the match to sit between
 * non-word-ish neighbors (any non-ASCII char counts as a boundary).
 */
function lex(items) {
  const body = items
    .map((w) =>
      String(w)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/['\u2019]/g, "['\u2019]")
        .replace(/\s+/g, "\\s+"),
    )
    .join("|");
  return new RegExp("(?:^|[^A-Za-z0-9])(?:" + body + ")(?:$|[^A-Za-z0-9])", "i");
}

const NEGATIVE_BY_LOCALE = {
  en: /\b(no thanks|not interested|no thank you|just say no|stop|don't call|never mind|not now|wrong number|not anymore)\b/i,
  es: lex(["no gracias", "no me interesa", "no quiero", "no me llame", "no me molestes", "para por favor", "déjeme en paz", "no más", "no ahora", "número equivocado", "no me interesan"]),
  fr: lex(["non merci", "pas intéressé", "pas intéresse", "je ne veux pas", "ne me rappelez pas", "arrête", "arrêtez", "arrêtez de m'appeler", "plus jamais", "pas maintenant", "mauvais numéro", "ça ne m'intéresse pas"]),
  de: lex(["nein danke", "nicht interessiert", "ich will nicht", "rufen sie mich nicht an", "hör auf", "aufhören", "nie wieder", "nicht jetzt", "falsche nummer", "nicht mehr"]),
  pt: lex(["não obrigado", "não estou interessado", "não quero", "não me ligue", "para por favor", "chega", "nunca mais", "não agora", "número errado", "não tenho interesse"]),
  hi: lex(["नहीं चाहिए", "नहीं धन्यवाद", "नहीं", "मुझे नहीं चाहिए", "बंद करो", "अभी नहीं", "गलत नंबर", "nahin", "nahin chahiye", "no thanks", "band karo", "abhi nahin", "galat number"]),
};

const SOFT_BY_LOCALE = {
  en: /\b(driving|on the road|rolling|busy|shutting down|about to|send me some|email me|text me|more info|already have|have my own|got a guy|leased to|market is bad|market's bad|no freight|no loads|board is dead|rates are|bad market|slow right now)\b/i,
  es: lex(["estoy conduciendo", "conduciendo", "voy manejando", "manejando", "al volante", "en la carretera", "ocupado", "ya tengo", "mi despachador", "mi jefe", "mándame info", "mándame información", "envíeme información", "el mercado está mal", "no hay carga", "no hay fletes", "las tarifas", "están baratas", "lento"]),
  fr: lex(["je conduis", "sur la route", "occupé", "occupée", "j'ai déjà", "mon dispatcher", "mon courtier", "envoyez-moi", "je suis pressé", "le marché est mauvais", "pas de fret", "pas de chargement", "les tarifs", "au ralenti"]),
  de: lex(["unterwegs", "auf der straße", "beschäftigt", "habe schon", "mein dispatcher", "mein broker", "schicken sie mir", "markt ist schlecht", "keine ladung", "keine fracht", "die tarife", "langsam"]),
  pt: lex(["dirigindo", "na estrada", "ocupado", "já tenho", "meu dispatcher", "meu despachante", "me mande", "envie", "o mercado está ruim", "sem carga", "sem fretes", "as tarifas", "estão baixas", "lento"]),
  hi: lex(["ड्राइविंग", "बिज़ी", "पहले से है", "मेरा डिस्पैचर", "कोई लोड नहीं", "बाज़ार खराब", "भेज दो जानकारी", "driving", "busy", "already have", "mera dispatcher", "no loads", "market bad", "send karo"]),
};

/** Positive and negative word sets for scoreLead, per language. */
const POSITIVE_BY_LOCALE = {
  en: ["yes", "yeah", "interested", "how much", "cost", "price", "quote", "need", "looking for", "that sounds", "go ahead", "sure", "okay", "ok"],
  es: ["sí", "si", "me interesa", "interesado", "cuánto", "precio", "cotización", "necesito", "me gustaría", "adelante", "claro", "de acuerdo", "bueno", "suena bien"],
  fr: ["oui", "intéressé", "intéressée", "combien", "prix", "devis", "j'ai besoin", "je veux", "allez-y", "d'accord", "bien", "ça me va", "pourquoi pas"],
  de: ["ja", "interessiert", "wie viel", "kosten", "preis", "angebot", "ich brauche", "ich will", "los", "okay", "klingt gut", "einverstanden", "gerne"],
  pt: ["sim", "interessado", "quanto", "preço", "orçamento", "preciso", "quero", "pode ser", "claro", "de acordo", "ótimo", "gostei"],
  hi: ["haan", "theek hai", "kitna", "kitna lagta hai", "price", "quote", "chahiye", "mujhe chahiye", "bolo", "lo", "okay", "zaaroor", "चाहिए", "मुझे चाहिए", "ठीक है", "हाँ", "कितना", "कीमत", "भेजो", "जरूर"],
};

const NEGATIVE_WORDS_BY_LOCALE = {
  en: ["no", "not interested", "no thanks", "stop", "don't call", "never mind", "not now"],
  es: ["no", "no me interesa", "no gracias", "no quiero", "déjeme", "no me llame", "nunca"],
  fr: ["non", "pas intéressé", "non merci", "je ne veux pas", "arrêtez", "ne me rappelez pas", "jamais"],
  de: ["nein", "nicht interessiert", "nein danke", "ich will nicht", "hören sie auf", "rufen sie nicht an", "niemals"],
  pt: ["não", "não estou interessado", "não obrigado", "não quero", "chega", "não me ligue", "nunca"],
  hi: ["nahin", "no", "nahin chahiye", "band karo", "mat karo"],
};

/** Phrases that mean "I want to talk to a real person", per language. */
const HUMAN_BY_LOCALE = {
  en: /\b(real person|human|agent|representative|someone else|talk to a person)\b/i,
  es: lex(["persona real", "una persona", "un humano", "hablar con una persona", "habla con una persona", "un representante", "un agente", "alguien de verdad"]),
  fr: lex(["une personne réelle", "une vraie personne", "un vrai humain", "un humain", "parler à une personne", "parler à quelqu'un", "un représentant", "un agent"]),
  de: lex(["eine echte person", "einen menschen", "echten menschen", "mit einem agenten", "einen vertreter", "mit einer person sprechen"]),
  pt: lex(["uma pessoa real", "uma pessoa de verdade", "um humano", "um representante", "um atendente", "falar com uma pessoa", "falar com alguém"]),
  hi: lex(["एक इंसान", "असली इंसान", "एक व्यक्ति", "किसी से बात", "एजेंट", "real person", "insaan", "agent", "kisi se baat", "ek insaan se baat"]),
};

// ---------------------------------------------------------------------------
// Spoken templates per language.
// Pool shapes mirror brain.js: opening/rapport/pivot/closeGood/closeWarm.
// {agent} / {company} are filled at call time (same as English).
// ---------------------------------------------------------------------------
const POOLS_BY_LOCALE = {
  en: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "This is {agent} from {company}. I know this is a cold call - you can hang up right now, or give me twenty seconds to tell you why I called. Your choice.",
        "I'll be straight with you - I know you've got somewhere to be. Can I have thirty seconds to tell you what we do, and then I'm gone either way?"
      ] },
      { key: "hook_reason_first", base: 1.6, pool: [
        "The reason I'm calling is simple: your truck makes money loaded and burns money empty. I keep owner-operators loaded back-to-back at top rates. That's the whole call.",
        "This is {agent} from {company}. The reason for this call is one thing - I stop owner-operators from sitting a day between loads. Can I explain that in thirty seconds?"
      ] },
      { key: "hook_specificity", base: 1.5, pool: [
        "I was checking what's moving out of your area on your rig type this week, and there's a lane running at above board rate. Are you running under your own authority right now?",
        "Quick one from our dispatch desk - we're filling reloads this week and I wanted to see if you're still taking freight in your area. Would that help right now?"
      ] },
      { key: "hook_how_have_you_been", base: 0.9, pool: [
        "{agent} from {company} - how have you been?"
      ] },
      { key: "hook_social_proof", base: 1.2, pool: [
        "We work with owner-operators running out of your area keep them rolling back-to-back - have you heard our name tossed around?",
        "Most of the drivers we talk to were self-dispatching until the empty miles added up - that's exactly who we built this for. Is that you right now?"
      ] }
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "That's great to hear. Before I let you go - a couple of quick seconds and we'll have a real answer for you.",
        "Love it. This will take less than a minute, and we'll have my dispatcher follow up with something concrete.",
        "Awesome. Keeping this short - we'll make it worth your time."
      ] },
      { key: "rapport_mirroring", base: 1.1, pool: [
        "No rush on my end - take your time.",
        "I hear you've got a full plate, so we'll keep this simple. One thing at a time.",
        "I know you're either rolling or about to roll, so I'll be quick with you."
      ] }
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "Fair enough - you don't even know what we do yet, so that's a fair answer. If I told you the average guy loses two hundred dollars a load skipping the counter-offer, would that be worth thirty seconds? If not, I'll let you go right now.",
        "Totally fair. Quick one before I go, just to be safe - do you ever dispatch loads to the southern states? No commitment at all."
      ] },
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "You're driving - I'm not going to hold you up, that's how you make your money. When do you figure you'll be shut down tonight? I'll call you when you're parked - that work?",
        "I know you're on the road, so let's pin the call instead of playing tag. What time do you usually shut down? I'll call you then."
      ] },
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "Happy to send it over, and so I send the right thing - who books your loads right now, you or a dispatcher?",
        "I'll text you a one-pager, and after your next drop I'll circle back - who'd you say handles your load-finding today?"
      ] },
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "Good - that tells me you already know dispatch pays for itself, which is why I'm calling. Real quick: what do you like most about how they work?",
        "If you already run with someone, great - here's all I'm asking: let me find you one load this week, run it through me, compare numbers side by side. If mine isn't better, you keep your guy."
      ] },
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "You're right - the market's been flat for years now. Spot rates have sat around a buck eighty-eight a mile. And that's exactly why it's worth having somebody negotiate every load - guys booking their own take the first offer. Twenty extra dollars a load, three loads a week - that's over three grand a year walking away. Worth a real look?",
        "When rates are flat, the fight is on the tariff, not the road. We counter every load before we book it - that's where the money shows back up. Can I show you in real numbers?"
      ] }
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "Here's what happens next - I set up your profile tonight, and first thing tomorrow I'm out looking for your next load. What time are you usually up? I'll have something waiting.",
        "If this is going to work, the next step is a fifteen-minute talk while you're parked. Do you have your calendar handy?"
      ] },
      { key: "close_one_load_trial", base: 1.5, pool: [
        "The fastest way to tell if this is worth it is one load. You approve it, you run it, you look at the numbers. If it's not better than what you were doing, we shake hands and I'm done. Deal?",
        "Give me your next drop-off city, and I'll have a load waiting by the time you unload. You don't even have to think about it - we'll do the thinking."
      ] }
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "Since you're set up already, here's the deal - let me be your backup for two weeks on the loads they can't get you. No charge. If one of my loads pays better, you'll know exactly what I'm worth.",
        "Look, you don't have to commit to anything today. All I'm asking is that you don't book your next deadhead run until I show you what's on the board. If I've got nothing better, you lose nothing."
      ] }
    ]
  },
  es: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "Hola, soy {agent} de {company}. Sé que es una llamada en frío - puede colgar ahora mismo, o darme veinte segundos para contarle por qué llamo. Usted decide.",
        "Le hablo claro - sé que tiene prisa. ¿Me da treinta segundos para contarle qué hacemos? Después me retiro, de todas maneras.",
      ]},
      { key: "hook_reason_first", base: 1.6, pool: [
        "La razón de mi llamada es simple: su camión gana dinero cargado y pierde dinero vacío. Yo mantengo a los propietarios-operadores con fletes seguidos y a buenas tarifas. Eso es toda la llamada.",
        "Soy {agent} de {company}. Llamo por una sola cosa: evitar que los camioneros pasen días sin carga. ¿Le explico en treinta segundos?",
      ]},
      { key: "hook_specificity", base: 1.5, pool: [
        "Estaba revisando qué carga está saliendo de su zona esta semana para su tipo de unidad, y hay un corredor pagando por encima de la tarifa normal. ¿Está trabajando bajo su propia autoridad?",
        "Un dato rápido de nuestro escritorio de despacho - estamos llenando fletes de regreso esta semana y quería saber si está tomando carga en su zona. ¿Le serviría ahora?",
      ]},
      { key: "hook_social_proof", base: 1.2, pool: [
        "Trabajamos con propietarios-operadores de su zona para mantenerlos rodando sin parar - ¿ha escuchado nuestro nombre por ahí?",
        "La mayoría de los conductores con los que hablamos se despachaban solos hasta que los kilómetros vacíos se acumularon - para eso exactamente lo construimos. ¿Ese es su caso?",
      ]},
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "Qué bueno escucharlo. Antes de dejarlo ir - un par de segundos y le damos una respuesta real.",
        "Me alegra. Esto tomará menos de un minuto, y mi despachador le seguirá con algo concreto.",
      ]},
      { key: "rapport_mirroring", base: 1.1, pool: [
        "No hay prisa de mi parte - tómese su tiempo.",
        "Sé que está ocupado, así que lo mantendremos simple. Una cosa a la vez.",
      ]},
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "Entiendo - todavía ni sabe lo que hacemos, así que es justo. Si le dijera que el promedio pierde doscientos dólares por flete al saltarse la contraoferta, ¿valdría treinta segundos? Si no, lo dejo ir ahora mismo.",
        "Totalmente justo. Una pregunta rápida antes de irme, para estar seguro - ¿alguna vez despacha fletes hacia el sur? Sin ningún compromiso.",
      ]},
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "Va manejando - no lo voy a detener, así es como hace su dinero. ¿A qué hora piensa que se detiene esta noche? Lo llamo cuando esté estacionado, ¿le funciona?",
        "Sé que va en la carretera, mejor fijamos la llamada. ¿A qué hora suele detenerse? Lo llamo en ese momento.",
      ]},
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "Con gusto se la envío, y para mandarle lo correcto - ¿quién le reserva sus fletes ahora, usted o un despachador?",
        "Le mando un resumen por texto, y después de su próxima entrega vuelvo a llamar - ¿quién maneja hoy su búsqueda de carga?",
      ]},
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "Bien - eso me dice que ya sabe que el despacho se paga solo. Rápido: ¿qué es lo que más le gusta de cómo trabajan?",
        "Si ya trabaja con alguien, perfecto - solo le pido esto: déjeme encontrarle UN flete esta semana, córralo conmigo y comparemos números lado a lado.",
      ]},
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "Tiene razón - el mercado lleva años plano. Por eso vale la pena que alguien negocie cada flete por usted. Veinte dólares más por flete, tres fletes a la semana - más de tres mil dólares al año regalados. ¿Vale la pena verlo?",
        "Cuando las tarifas están planas, la pelea está en la tarifa, no en la carretera. Nosotros contraofertamos cada flete antes de reservarlo. ¿Se lo muestro con números reales?",
      ]},
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "Esto es lo que sigue - le preparo su perfil esta noche y mañana temprano salgo a buscar su siguiente flete. ¿Tiene su calendario a la mano?",
        "Si esto va a funcionar, el siguiente paso es una conversación de quince minutos cuando esté estacionado. ¿A qué hora suele levantarse?",
      ]},
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "Como ya está trabajando con alguien, aquí está el trato - déjeme ser su respaldo por dos semanas en los fletes que no le consiguen. Sin costo.",
        "Hoy no tiene que comprometerse a nada. Solo le pido que no reserve su siguiente viaje en vacío hasta que le muestre lo que hay en la pizarra.",
      ]},
    ],
  },

  fr: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "Bonjour, je suis {agent} de {company}. Je sais que c'est un appel à froid - vous pouvez raccrocher tout de suite, ou me donner vingt secondes pour vous dire pourquoi j'appelle. À vous de choisir.",
        "Je vais être franc - je sais que vous avez autre chose à faire. Est-ce que je peux avoir trente secondes pour vous expliquer ce qu'on fait ? Ensuite je raccroche, promis.",
      ]},
      { key: "hook_reason_first", base: 1.6, pool: [
        "La raison de mon appel est simple : votre camion gagne de l'argent chargé et perd de l'argent vide. Je garde les propriétaires-exploitants chargés sans arrêt, à de bons tarifs. C'est tout l'appel.",
        "Je suis {agent} de {company}. J'appelle pour une seule chose : empêcher les camionneurs de rester des jours sans chargement. Je peux vous expliquer en trente secondes ?",
      ]},
      { key: "hook_specificity", base: 1.5, pool: [
        "Je regardais ce qui bouge dans votre région cette semaine pour votre type de camion, et il y a une ligne qui paie au-dessus du tarif du marché. Vous roulez sous votre propre autorité en ce moment ?",
        "Une info rapide de notre bureau de dispatch - on remplit des retours cette semaine et je voulais savoir si vous prenez toujours du fret dans votre région. Ça vous aiderait maintenant ?",
      ]},
      { key: "hook_social_proof", base: 1.2, pool: [
        "On travaille avec des propriétaires-exploitants de votre région pour les garder chargés sans arrêt - vous avez déjà entendu notre nom ?",
        "La plupart des chauffeurs à qui on parle se dispatcheaient eux-mêmes jusqu'à ce que les kilomètres à vide s'accumulent - c'est exactement pour ça qu'on a construit ça. C'est votre cas ?",
      ]},
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "C'est bon à entendre. Avant de vous laisser aller - deux petites secondes et on aura une vraie réponse pour vous.",
        "Parfait. Ça prendra moins d'une minute, et mon dispatcher vous rappellera avec quelque chose de concret.",
      ]},
      { key: "rapport_mirroring", base: 1.1, pool: [
        "Pas de pression de mon côté - prenez votre temps.",
        "Je sais que vous êtes occupé, alors on reste simple. Une chose à la fois.",
      ]},
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "Compréhensible - vous ne savez même pas encore ce qu'on fait, c'est juste. Si je vous disais qu'en moyenne on perd deux cents dollars par chargement en sautant la contre-offre, ça vaudrait trente secondes ? Si non, je vous laisse tout de suite.",
        "Tout à fait juste. Une petite question avant de partir, pour être sûr - vous dispatcheez parfois des chargements vers le sud ? Sans aucun engagement.",
      ]},
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "Vous conduisez - je ne vais pas vous retenir, c'est comme ça que vous gagnez votre argent. Vous pensez vous arrêter quand ce soir ? Je vous rappelle quand vous êtes garé - ça marche ?",
        "Je sais que vous êtes sur la route, alors fixons l'appel plutôt que de jouer au chat et à la souris. Vous vous arrêtez habituellement à quelle heure ?",
      ]},
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "Avec plaisir, et pour vous envoyer la bonne chose - qui réserve vos chargements en ce moment, vous ou un dispatcher ?",
        "Je vous envoie un résumé, et après votre prochaine livraison je reviens vers vous - qui s'occupe de trouver vos chargements aujourd'hui ?",
      ]},
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "Bien - ça me dit que vous savez déjà que le dispatch se rentabilise. Vite : qu'est-ce que vous aimez le plus dans leur façon de travailler ?",
        "Si vous travaillez déjà avec quelqu'un, parfait - je vous demande seulement ceci : laissez-moi vous trouver UN chargement cette semaine, testez, comparons les chiffres côte à côte.",
      ]},
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "Vous avez raison - le marché est plat depuis des années. C'est exactement pour ça qu'il vaut le coup que quelqu'un négocie chaque chargement. Vingt dollars de plus par chargement, trois par semaine - plus de trois mille dollars par an perdus. Ça vaut un vrai regard ?",
        "Quand les tarifs sont plats, le combat se joue sur le fret, pas sur la route. On négocie chaque chargement avant de le réserver. Je vous montre avec de vrais chiffres ?",
      ]},
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "Voilà ce qui se passe ensuite - je prépare votre profil ce soir, et demain matin je cherche votre prochain chargement. Vous avez votre calendrier sous la main ?",
        "Si ça doit fonctionner, la prochaine étape est une conversation de quinze minutes quand vous êtes garé. Vous vous levez à quelle heure ?",
      ]},
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "Comme vous êtes déjà équipé, voici le deal - laissez-moi être votre secours pendant deux semaines sur les chargements qu'ils ne trouvent pas. Sans frais.",
        "Vous n'avez rien à décider aujourd'hui. Je vous demande juste de ne pas réserver votre prochain trajet à vide avant que je vous montre ce qu'il y a sur le tableau.",
      ]},
    ],
  },

  de: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "Hallo, hier ist {agent} von {company}. Ich weiß, dass das ein Kaltanruf ist - Sie können jetzt auflegen oder mir zwanzig Sekunden geben, um zu erklären, warum ich anrufe. Ihre Entscheidung.",
        "Ich bin direkt - ich weiß, dass Sie zu tun haben. Geben Sie mir dreißig Sekunden, um zu erklären, was wir machen? Danach bin ich weg, egal was passiert.",
      ]},
      { key: "hook_reason_first", base: 1.6, pool: [
        "Der Grund meines Anrufs ist einfach: Ihr Lkw verdient Geld, wenn er beladen ist, und verliert Geld, wenn er leer fährt. Ich halte Inhaber-Fahrer bei guten Tarifen durchgehend mit Ladung versorgt. Das ist der ganze Anruf.",
        "Hier ist {agent} von {company}. Ich rufe aus einem einzigen Grund an - ich verhindere, dass Inhaber-Fahrer tagelang ohne Ladung sitzen. Darf ich das in dreißig Sekunden erklären?",
      ]},
      { key: "hook_specificity", base: 1.5, pool: [
        "Ich habe gerade geprüft, was diese Woche aus Ihrer Region für Ihren Fahrzeugtyp läuft, und da ist eine Route, die über dem Standard-Tarif bezahlt. Sind Sie gerade unter eigener Genehmigung unterwegs?",
        "Eine kurze Frage von unserer Disposition - wir füllen diese Woche Rückladungen und ich wollte wissen, ob Sie in Ihrer Region noch Fracht annehmen. Würde das jetzt helfen?",
      ]},
      { key: "hook_social_proof", base: 1.2, pool: [
        "Wir arbeiten mit Inhaber-Fahrern aus Ihrer Region und halten sie durchgehend geladen - haben Sie unseren Namen schon mal gehört?",
        "Die meisten Fahrer, mit denen wir sprechen, haben sich selbst disponiert, bis sich die Leerkilometer anhäuften - genau dafür haben wir das gebaut. Sind Sie das gerade?",
      ]},
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "Schön zu hören. Bevor ich Sie lasse - ein paar schnelle Sekunden und wir haben eine echte Antwort für Sie.",
        "Super. Das dauert weniger als eine Minute, und mein Disponent meldet sich mit etwas Konkretem bei Ihnen.",
      ]},
      { key: "rapport_mirroring", base: 1.1, pool: [
        "Keine Eile bei mir - nehmen Sie sich Zeit.",
        "Ich weiß, dass Sie viel zu tun haben, also bleiben wir einfach. Eins nach dem anderen.",
      ]},
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "Verstanden - Sie wissen ja noch gar nicht, was wir machen, das ist fair. Wenn ich Ihnen sage, dass der Durchschnitt zweihundert Dollar pro Ladung verliert, wenn er das Gegenangebot überspringt - wären das dreißig Sekunden wert? Wenn nicht, lasse ich Sie sofort gehen.",
        "Absolut fair. Eine schnelle Frage, bevor ich gehe - disponieren Sie manchmal Ladungen in den Süden? Ganz ohne Verpflichtung.",
      ]},
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "Sie fahren - ich halte Sie nicht auf, so verdienen Sie Ihr Geld. Wann sind Sie heute Abend ungefähr fertig? Ich rufe an, wenn Sie geparkt haben - passt das?",
        "Ich weiß, dass Sie unterwegs sind, also legen wir den Anruf fest, statt uns zu jagen. Wann machen Sie normalerweise Feierabend?",
      ]},
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "Gerne schicke ich es Ihnen - und damit ich das Richtige schicke: Wer bucht Ihre Ladungen gerade, Sie oder ein Disponent?",
        "Ich schicke Ihnen eine Zusammenfassung, und nach Ihrer nächsten Entladung melde ich mich wieder - wer sucht heute Ihre Ladungen?",
      ]},
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "Gut - das sagt mir, dass Sie schon wissen, dass sich Disposition bezahlt macht. Kurz: Was schätzen Sie an der Arbeit am meisten?",
        "Wenn Sie schon mit jemandem arbeiten, super - ich bitte nur um eines: Lassen Sie mich diese Woche EINE Ladung für Sie finden, testen Sie, vergleichen wir die Zahlen.",
      ]},
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "Sie haben recht - der Markt ist seit Jahren flach. Genau deshalb lohnt es sich, dass jemand jede Ladung für Sie verhandelt. Zwanzig Dollar mehr pro Ladung, drei pro Woche - über dreitausend Dollar pro Jahr, die verschenkt werden. Ist das einen echten Blick wert?",
        "Wenn die Tarife flach sind, wird der Kampf um den Tarif geführt, nicht um die Straße. Wir verhandeln jede Ladung, bevor wir sie buchen. Darf ich es Ihnen mit echten Zahlen zeigen?",
      ]},
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "Hier ist, was als Nächstes passiert - ich richte heute Abend Ihr Profil ein und morgen früh suche ich Ihre nächste Ladung. Haben Sie Ihren Kalender zur Hand?",
        "Wenn das funktionieren soll, ist der nächste Schritt ein Gespräch von fünfzehn Minuten, wenn Sie geparkt haben. Um welche Zeit stehen Sie normalerweise auf?",
      ]},
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "Da Sie schon eingerichtet sind, hier das Angebot - lassen Sie mich zwei Wochen lang Ihr Backup für die Ladungen sein, die sie nicht finden. Kostenlos.",
        "Sie müssen heute nichts entscheiden. Ich bitte nur darum, dass Sie Ihre nächste Leerfahrt nicht buchen, bevor ich Ihnen zeige, was auf dem Board ist.",
      ]},
    ],
  },

  pt: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "Olá, aqui é {agent} da {company}. Eu sei que é uma ligação a frio - você pode desligar agora, ou me dar vinte segundos para contar o porquê da minha ligação. Você escolhe.",
        "Vou ser direto - sei que você está ocupado. Me dá trinta segundos para explicar o que fazemos? Depois eu encerro, de qualquer forma.",
      ]},
      { key: "hook_reason_first", base: 1.6, pool: [
        "O motivo da minha ligação é simples: seu caminhão ganha dinheiro carregado e perde dinheiro vazio. Eu mantenho os proprietários-operadores carregados sem parar, com boas tarifas. Isso é toda a ligação.",
        "Aqui é {agent} da {company}. Ligo por uma única coisa - impedir que caminhoneiros fiquem dias sem carga. Posso explicar em trinta segundos?",
      ]},
      { key: "hook_specificity", base: 1.5, pool: [
        "Eu estava verificando o que está saindo da sua região esta semana para o seu tipo de caminhão, e tem uma rota pagando acima da tarifa normal. Você está rodando por conta própria agora?",
        "Um aviso rápido do nosso escritório - estamos preenchendo fretes de volta esta semana e queria saber se você ainda está aceitando carga na sua região. Ajudaria agora?",
      ]},
      { key: "hook_social_proof", base: 1.2, pool: [
        "Trabalhamos com proprietários-operadores da sua região para mantê-los rodando sem parar - você já ouviu falar do nosso nome?",
        "A maioria dos motoristas com quem falamos se despachava sozinho até os quilômetros vazios se acumularem - foi exatamente para isso que construímos. É o seu caso?",
      ]},
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "Que bom ouvir isso. Antes de deixar você ir - alguns segundos e teremos uma resposta real para você.",
        "Ótimo. Vai levar menos de um minuto, e meu despachante vai entrar em contato com algo concreto.",
      ]},
      { key: "rapport_mirroring", base: 1.1, pool: [
        "Sem pressa da minha parte - fique à vontade.",
        "Sei que você está ocupado, então vamos manter simples. Uma coisa por vez.",
      ]},
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "Entendo - você ainda nem sabe o que fazemos, então é justo. Se eu dissesse que em média se perdem duzentos dólares por frete ao pular a contraproposta, valeria trinta segundos? Se não, eu já encerro agora.",
        "Totalmente justo. Uma pergunta rápida antes de ir, só para garantir - você despacha fretes para o sul? Sem compromisso nenhum.",
      ]},
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "Você está dirigindo - não vou te segurar, é assim que você ganha seu dinheiro. A que horas acha que vai parar hoje à noite? Eu te ligo quando estiver estacionado - serve?",
        "Sei que está na estrada, então vamos fixar a ligação em vez de ficar de telefone contando. A que horas você costuma parar?",
      ]},
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "Com prazer te envio, e para mandar a coisa certa - quem reserva seus fretes agora, você ou um despachante?",
        "Te mando um resumo, e depois da sua próxima entrega eu volto a contatar - quem cuida da sua busca de carga hoje?",
      ]},
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "Ótimo - isso me diz que você já sabe que despacho se paga. Rápido: o que você mais gosta em como eles trabalham?",
        "Se você já trabalha com alguém, perfeito - só peço isto: deixa eu encontrar UM frete esta semana, rode comigo, compare os números lado a lado.",
      ]},
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "Você tem razão - o mercado está parado há anos. É exatamente por isso que vale a pena ter alguém negociando cada frete. Vinte dólares a mais por frete, três por semana - mais de três mil por ano jogados fora. Vale dar uma olhada?",
        "Quando as tarifas estão paradas, a briga é no frete, não na estrada. Nós contraofertamos cada frete antes de reservar. Posso mostrar com números reais?",
      ]},
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "Isso é o que acontece agora - eu preparo seu perfil hoje à noite e amanhã cedo saio procurando seu próximo frete. Você tem seu calendário à mão?",
        "Se isso vai funcionar, o próximo passo é uma conversa de quinze minutos quando você estiver estacionado. A que horas você costuma acordar?",
      ]},
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "Como você já está com alguém, aqui está a proposta - deixa eu ser seu plano B por duas semanas nos fretes que eles não conseguem. Sem custo.",
        "Você não precisa decidir nada hoje. Só peço que não reserve seu próximo trajeto vazio antes de eu te mostrar o que está no quadro.",
      ]},
    ],
  },

  hi: {
    opening: [
      { key: "hook_permission_timebox", base: 1.4, pool: [
        "नमस्ते, मैं {agent} हूँ, {company} से। मुझे पता है यह ठंडी कॉल है - आप अभी फ़ोन रख सकते हैं, या मुझे बीस सेकंड दे दीजिए कि मैं बताऊँ कि मैंने क्यों कॉल किया। आपकी मर्ज़ी।",
        "मैं सीधी बात करती हूँ - मुझे पता है आप व्यस्त हैं। क्या आप मुझे तीस सेकंड देंगे कि मैं बता दूँ हम क्या करते हैं? फिर मैं चली जाती हूँ, चाहे कुछ भी हो।",
      ]},
      { key: "hook_reason_first", base: 1.6, pool: [
        "मेरी कॉल की वजह सीधी है: आपका ट्रक लदा हो तो पैसा कमाता है और खाली हो तो पैसा खर्च। मैं मालिक-ड्राइवरों को लगातार अच्छी दरों पर लदा रखती हूँ। बस यही पूरी कॉल है।",
        "मैं {agent} हूँ, {company} से। एक ही वजह से कॉल कर रही हूँ - ट्रक चालकों को बिना माल दिन ना बीतने दूँ। क्या मैं तीस सेकंड में समझा दूँ?",
      ]},
      { key: "hook_specificity", base: 1.5, pool: [
        "मैं देख रही थी कि इस हफ़्ते आपके इलाके से आपके ट्रक के लिए क्या माल निकल रहा है, और एक रूट मानक दर से ऊपर पैसा दे रहा है। क्या आप अभी अपने अधिकार में चला रहे हैं?",
        "हमारे डिस्पैच डेस्क से एक बात - इस हफ़्ते हम वापसी माल भर रहे हैं और जानना चाहते थे कि क्या आप अपने इलाके में माल ले रहे हैं। अभी मददगार होगा?",
      ]},
      { key: "hook_social_proof", base: 1.2, pool: [
        "हम आपके इलाके के मालिक-ड्राइवरों को लगातार लदा रखते हैं - क्या आपने हमारा नाम सुना है?",
        "हम जिन ड्राइवरों से बात करते हैं वे खुद डिस्पैच करते थे जब तक खाली किलोमीटर बढ़ नहीं गए - ठीक इसी के लिए हमने यह बनाया है। क्या यह आपकी बात है?",
      ]},
    ],
    rapport: [
      { key: "rapport_we_language", base: 1.5, pool: [
        "यह सुनकर अच्छा लगा। जाने से पहले - बस कुछ सेकंड और हमारे पास आपके लिए सही जवाब होगा।",
        "बहुत अच्छा। इसमें एक मिनट से कम लगेगा, और मेरा डिस्पैचर कुछ ठोस लेकर संपर्क करेगा।",
      ]},
      { key: "rapport_mirroring", base: 1.1, pool: [
        "मेरी तरफ से कोई जल्दी नहीं - आप अपना समय लीजिए।",
        "मैं जानती हूँ आप व्यस्त हैं, इसलिए बात सीधी रखेंगे। एक-एक करके।",
      ]},
    ],
    pivot: [
      { key: "obj_not_interested", base: 1.3, pool: [
        "ठीक है - आपको अभी पता ही नहीं हम क्या करते हैं, तो यह सही जवाब है। अगर मैं कहूँ कि औसत चालक हर माल पर दो सौ डॉलर गँवाता है काउंटर-ऑफर छोड़ने से, तो क्या तीस सेकंड देंगे? नहीं तो मैं अभी जाती हूँ।",
        "बिल्कुल सही। जाने से पहले एक त्वरित बात - क्या आप कभी दक्षिण राज्यों में माल भेजते हैं? कोई बंधन नहीं।",
      ]},
      { key: "obj_busy_callback_slot", base: 1.5, pool: [
        "आप गाड़ी चला रहे हैं - मैं आपको रोकूँगी नहीं, इसी से आप कमाते हैं। आज रात आप कब तक रुकेंगे? जब आप पार्क हों तब कॉल करूँ - चलेगा?",
        "मैं जानती हूँ आप रास्ते में हैं, तो कॉल तय कर लेते हैं। आप आमतौर पर कब रुकते हैं?",
      ]},
      { key: "obj_send_info_qualify", base: 1.4, pool: [
        "खुशी से भेज दूँगी, और सही चीज़ भेजने के लिए - आपके माल अभी कौन बुक करता है, आप या कोई डिस्पैचर?",
        "मैं आपको एक सारांश भेज दूँगी, और आपकी अगली डिलीवरी के बाद फिर बात करूँगी - आज माल कौन ढूँढता है?",
      ]},
      { key: "obj_have_dispatcher_one_load", base: 1.4, pool: [
        "अच्छा - इसका मतलब आप जानते हैं कि डिस्पैच खुद पैसा लाता है। जल्दी बताइए: उनके काम करने में आपको सबसे अच्छा क्या लगता है?",
        "अगर आप पहले से किसी के साथ हैं, बढ़िया - बस इतना कह रही हूँ: इस हफ़्ते मुझे एक माल ढूँढने दीजिए, चलाइए, नंबर साथ-साथ देखिए।",
      ]},
      { key: "obj_rates_loss_aversion", base: 1.2, pool: [
        "आप सही हैं - बाज़ार सालों से सपाट है। इसीलिए हर माल पर कोई सौदा करना ज़रूरी है। बीस डॉलर ज़्यादा हर माल पर, हफ़्ते में तीन - साल में तीन हज़ार से ज़्यादा डॉलर हाथ से जाते हैं। क्या असली नज़र डालना चाहिए?",
        "जब दरें सपाट होती हैं, लड़ाई दर पर होती है, सड़क पर नहीं। हम हर माल बुक करने से पहले काउंटर करते हैं। असली नंबर दिखाऊँ?",
      ]},
    ],
    closeGood: [
      { key: "close_assumptive", base: 1.5, pool: [
        "अब आगे यह होगा - मैं आज रात आपकी प्रोफ़ाइल बना दूँगी, और सुबह सबसे पहले आपके अगले माल की तलाश करूँगी। क्या आपके पास कैलेंडर है?",
        "अगर यह काम करना है, अगला कदम पंद्रह मिनट की बात है जब आप पार्क हों। आप आमतौर पर कितने बजे उठते हैं?",
      ]},
    ],
    closeWarm: [
      { key: "close_backup_two_weeks", base: 1.4, pool: [
        "चूँकि आप पहले से किसी के साथ हैं, यह समझौता है - जो माल वे नहीं दे पाते, उसके लिए मैं दो हफ़्ते आपकी बैकअप रहूँ। बिना शुल्क।",
        "आज आपको कुछ तय नहीं करना। बस इतना कि अगली खाली यात्रा बुक मत कीजिए जब तक मैं बोर्ड दिखा न दूँ।",
      ]},
    ],
  },
};

// ---------------------------------------------------------------------------
// Field questions / re-asks / dead-air / reconnects / replies, per language.
// ---------------------------------------------------------------------------
const QUESTIONS_BY_LOCALE = {
  en: [
    [
      "First, can I grab your {f}?",
      "To make sure I route this right - what's your {f}?",
      "Let me get your {f} so our team can reach you directly.",
    ],
    [
      "And your {f}?",
      "Follow-up for you - your {f}?",
      "Need your {f} too, if you have it handy.",
    ],
    [
      "Almost there - your {f}?",
      "One more for the sheet - your {f}?",
    ],
    [
      "Last one - your {f}?",
      "Final one, your {f}?",
    ],
  ],
  es: [
    [
      "Primero, ¿me puede dar su {f}?",
      "Para asegurarme de enrutar bien - ¿cuál es su {f}?",
      "Déjeme tomar su {f} para que nuestro equipo le contacte directo.",
    ],
    [
      "¿Y su {f}?",
      "Para seguir - ¿su {f}?",
      "También necesito su {f}, si lo tiene a la mano.",
    ],
    [
      "Casi terminamos - ¿su {f}?",
      "Una más para el registro - ¿su {f}?",
    ],
    [
      "La última - ¿su {f}?",
      "La final, ¿su {f}?",
    ],
  ],
  fr: [
    [
      "D'abord, est-ce que je peux avoir votre {f} ?",
      "Pour être sûr de bien router - c'est quoi votre {f} ?",
      "Donnez-moi votre {f} pour que notre équipe vous joigne directement.",
    ],
    [
      "Et votre {f} ?",
      "Pour continuer - votre {f} ?",
      "Il me faut aussi votre {f}, si vous l'avez sous la main.",
    ],
    [
      "On y est presque - votre {f} ?",
      "Encore une pour le registre - votre {f} ?",
    ],
    [
      "La dernière - votre {f} ?",
      "La toute dernière, votre {f} ?",
    ],
  ],
  de: [
    [
      "Zuerst, kann ich Ihre {f} bekommen?",
      "Damit ich richtig zuordne - wie lautet Ihre {f}?",
      "Ich brauche Ihre {f}, damit unser Team Sie direkt erreichen kann.",
    ],
    [
      "Und Ihre {f}?",
      "Weiter für Sie - Ihre {f}?",
      "Ich bräuchte auch Ihre {f}, falls Sie es griffbereit haben.",
    ],
    [
      "Fast geschafft - Ihre {f}?",
      "Noch eine für die Liste - Ihre {f}?",
    ],
    [
      "Die letzte - Ihre {f}?",
      "Eine letzte, Ihre {f}?",
    ],
  ],
  pt: [
    [
      "Primeiro, posso pegar seu {f}?",
      "Para garantir o endereçamento certo - qual é o seu {f}?",
      "Me dá seu {f} para que nossa equipe chegue até você direto.",
    ],
    [
      "E seu {f}?",
      "Para seguir - seu {f}?",
      "Preciso do seu {f} também, se estiver à mão.",
    ],
    [
      "Quase lá - seu {f}?",
      "Mais um para o registro - seu {f}?",
    ],
    [
      "O último - seu {f}?",
      "O final, seu {f}?",
    ],
  ],
  hi: [
    [
      "सबसे पहले, क्या मुझे आपका {f} मिल सकता है?",
      "सही मार्ग पर भेजने के लिए - आपका {f} क्या है?",
      "मुझे आपका {f} ले लेने दीजिए ताकि टीम सीधे संपर्क कर सके।",
    ],
    [
      "और आपका {f}?",
      "आगे बढ़ते हैं - आपका {f}?",
      "आपका {f} भी चाहिए, अगर पास में है।",
    ],
    [
      "बस हो गया - आपका {f}?",
      "लिस्ट के लिए एक और - आपका {f}?",
    ],
    [
      "आखिरी एक - आपका {f}?",
      "अंतिम, आपका {f}?",
    ],
  ],
};

const RETRY_BY_LOCALE = {
  en: [
    "No worries, I didn't quite catch it - can you say your {f} once more?",
    "Sorry, one crackly line - your {f}?",
  ],
  es: [
    "Sin problema, no le escuché bien - ¿me repite su {f}?",
    "Perdón, la línea se cortó un poco - ¿su {f}?",
  ],
  fr: [
    "Pas de souci, je n'ai pas bien entendu - pouvez-vous répéter votre {f} ?",
    "Désolé, la ligne grésille un peu - votre {f} ?",
  ],
  de: [
    "Kein Problem, ich habe es nicht ganz verstanden - können Sie Ihre {f} noch einmal wiederholen?",
    "Entschuldigung, die Leitung war schlecht - Ihre {f}?",
  ],
  pt: [
    "Sem problema, não entendi direito - pode repetir seu {f}?",
    "Desculpa, a linha caiu um pouco - seu {f}?",
  ],
  hi: [
    "कोई बात नहीं, ठीक से नहीं सुनाई दिया - क्या आप अपना {f} दोहरा सकते हैं?",
    "माफ़ कीजिए, लाइन थोड़ी कट रही थी - आपका {f}?",
  ],
};

const REOPEN_BY_LOCALE = {
  en: [
    "Hello? Just making sure we didn't get cut off - are you still there?",
    "Hello, are you there? I think the line dropped for a second.",
  ],
  es: [
    "¿Hola? Solo para confirmar que no se cortó - ¿sigue ahí?",
    "¿Hola, está ahí? Creo que la línea se cayó un segundo.",
  ],
  fr: [
    "Allô ? Je vérifie juste qu'on ne s'est pas coupés - vous êtes toujours là ?",
    "Allô, vous êtes là ? Je crois que la ligne a sauté une seconde.",
  ],
  de: [
    "Hallo? Nur um sicherzugehen, dass wir nicht unterbrochen wurden - sind Sie noch dran?",
    "Hallo, sind Sie noch da? Ich glaube, die Leitung hat kurz ausgesetzt.",
  ],
  pt: [
    "Olá? Só confirmando que não caímos o sinal - você ainda está aí?",
    "Olá, está aí? Acho que a linha caiu por um segundo.",
  ],
  hi: [
    "हेलो? बस यह सुनिश्चित कर रही हूँ लाइन कटी नहीं - क्या आप वहीं हैं?",
    "हेलो, आप वहाँ हैं? लगता है लाइन एक सेकंड गिर गई थी।",
  ],
};

const DEADAIR_BY_LOCALE = {
  en: "I can't hear you at the moment. I'll give you a call back a little later - take care and talk soon!",
  es: "No le escucho en este momento. Le vuelvo a llamar más tarde - ¡cuídese y hablamos pronto!",
  fr: "Je ne vous entends plus pour le moment. Je vous rappelle un peu plus tard - prenez soin de vous et à bientôt !",
  de: "Ich kann Sie gerade nicht hören. Ich rufe Sie später noch einmal an - passen Sie auf sich auf und bis bald!",
  pt: "Não estou conseguindo te ouvir agora. Vou te ligar de volta mais tarde - se cuide e a gente se fala!",
  hi: "मैं अभी आपको सुन नहीं पा रही हूँ। मैं थोड़ी देर बाद फिर कॉल करूँगी - अपना ख्याल रखिए और जल्दी बात करेंगे!",
};

const HANDOFF_BY_LOCALE = {
  en: "No problem at all - one second, I'll get you straight over to one of our real people.",
  es: "Sin problema - un segundo, le paso directo con una persona real de nuestro equipo.",
  fr: "Pas de souci - une seconde, je vous passe directement à une vraie personne de notre équipe.",
  de: "Kein Problem - einen Moment, ich verbinde Sie direkt mit einer echten Person aus unserem Team.",
  pt: "Sem problema - um segundo, vou te passar direto para uma pessoa real do nosso time.",
  hi: "कोई बात नहीं - एक सेकंड, मैं आपको सीधे हमारी असली टीम से जोड़ देती हूँ।",
};

const GRACEFUL_BY_LOCALE = {
  en: [
    "Alright, I hear you - I'll take you off the list. If a hot load in your lane ever needs a truck, can our dispatcher email you as a courtesy? Either way, have a safe one.",
    "No problem at all. I'll make a note not to bother you again. If you ever want loads, just give us a shout - take care!",
  ],
  es: [
    "Entiendo - lo quito de la lista. Si alguna vez un buen flete en su zona necesita camión, ¿puede nuestro despachador enviarle un correo como cortesía? De cualquier forma, buen viaje.",
    "Sin problema. Anoto que no le molestamos más. Si algún día necesita fletes, solo avísenos - ¡cuídese!",
  ],
  fr: [
    "Très bien, je comprends - je vous retire de la liste. Si un bon chargement dans votre secteur a besoin d'un camion, notre dispatcher peut-il vous écrire par courtoisie ? Dans tous les cas, bonne route.",
    "Pas de souci. Je note de ne plus vous déranger. Si vous avez besoin de chargements un jour, appelez-nous - prenez soin de vous !",
  ],
  de: [
    "Alles klar, ich verstehe - ich nehme Sie von der Liste. Wenn mal eine heiße Ladung in Ihrer Region einen Lkw braucht, darf unser Disponent Ihnen höflich schreiben? Wie auch immer - gute Fahrt.",
    "Kein Problem. Ich mache mir eine Notiz, Sie nicht mehr zu stören. Wenn Sie je Ladung brauchen, melden Sie sich einfach - passen Sie auf sich auf!",
  ],
  pt: [
    "Tudo bem, eu entendi - vou te tirar da lista. Se algum dia um bom frete na sua região precisar de caminhão, nosso despachante pode te avisar por e-mail como cortesia? De qualquer jeito, boa viagem.",
    "Sem problema. Vou anotar para não te incomodar mais. Se um dia precisar de fretes, é só chamar - se cuida!",
  ],
  hi: [
    "ठीक है, मैं समझ गई - मैं आपको सूची से हटा देती हूँ। अगर कभी आपके इलाके में कोई अच्छा माल ट्रक माँगे, तो क्या हमारा डिस्पैचर आपको ईमेल कर सकता है? फिर भी, यात्रा शुभ हो।",
    "कोई बात नहीं। मैं ध्यान दे लूँगी कि दोबारा परेशान न करूँ। अगर कभी माल चाहिए, बस बता दीजिए - ध्यान रखिए!",
  ],
};

const ACK_BY_LOCALE = {
  en: [
    "That's good to know, thanks.",
    "I really appreciate you sharing that.",
    "Perfect, that helps me a lot.",
    "Got it, that makes sense.",
    "Thanks for the detail - that's exactly what I needed.",
  ],
  es: [
    "Bueno saberlo, gracias.",
    "Aprecio mucho que me lo comparta.",
    "Perfecto, eso me ayuda bastante.",
    "Entendido, tiene sentido.",
    "Gracias por el detalle - es justo lo que necesitaba.",
  ],
  fr: [
    "C'est bon à savoir, merci.",
    "J'apprécie vraiment que vous me le partagiez.",
    "Parfait, ça m'aide beaucoup.",
    "Compris, ça a du sens.",
    "Merci pour le détail - c'est exactement ce qu'il me fallait.",
  ],
  de: [
    "Gut zu wissen, danke.",
    "Ich weiß es wirklich zu schätzen, dass Sie das teilen.",
    "Perfekt, das hilft mir sehr.",
    "Verstanden, das ergibt Sinn.",
    "Danke für das Detail - genau das brauchte ich.",
  ],
  pt: [
    "Que bom saber, obrigado.",
    "Agradeço muito você compartilhar isso.",
    "Perfeito, isso me ajuda bastante.",
    "Entendi, faz sentido.",
    "Obrigado pelo detalhe - é exatamente o que eu precisava.",
  ],
  hi: [
    "यह जानकर अच्छा लगा, धन्यवाद।",
    "आपके शेयर करने की बहुत सराहना।",
    "बिल्कुल सही, इससे मुझे बहुत मदद मिलती है।",
    "समझ गई, यह समझ आता है।",
    "जानकारी के लिए धन्यवाद - बिल्कुल वही जो मुझे चाहिए था।",
  ],
};

/** Callback-number close used when the customer configured a call-back number. */
const CALLBACK_CLOSE_BY_LOCALE = {
  en: "Perfect{who}! My manager will call you back{inTime} from {number}. Keep your phone close - great talking with you!",
  es: "¡Perfecto{who}! Mi gerente le devolverá la llamada{inTime} desde {number}. Tenga el teléfono cerca - ¡fue un gusto hablar con usted!",
  fr: "Parfait{who} ! Mon responsable vous rappellera{inTime} depuis {number}. Gardez votre téléphone près de vous - ce fut un plaisir !",
  de: "Perfekt{who}! Mein Manager ruft Sie{inTime} unter {number} zurück. Halten Sie Ihr Telefon bereit - schön, mit Ihnen gesprochen zu haben!",
  pt: "Perfeito{who}! Meu gerente vai ligar de volta{inTime} do {number}. Deixe o telefone por perto - foi ótimo falar com você!",
  hi: "बिल्कुल सही{who}! मेरे मैनेजर{inTime} {number} से आपको कॉल करेंगे। फ़ोन पास में रखिए - आपसे बात करके अच्छा लगा!",
};

/**
 * Build a locale-aware ack. For English, keeps the digit-word reflection
 * ("great, that's saved - 889901") that test-brain relies on.
 */
function ackFor(locale, leadText, seed) {
  const loc = normalizeLocale(locale);
  const generic = ACK_BY_LOCALE[loc] || ACK_BY_LOCALE.en;
  if (loc === "en") {
    const words = String(leadText || "").split(/\s+/).filter((w) => DIGIT_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")));
    if (words.length >= 2) {
      const map = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", oh: "0", ten: "10", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000" };
      const digits = words.map((w) => map[w.toLowerCase().replace(/[^a-z]/g, "")] || w);
      return `Great, that's saved - ${digits.join("")} ${DONE_BY_LOCALE.en[Math.abs(seed) % 3]}`;
    }
  }
  const digits = String(leadText || "").match(/\d{2,}/);
  if (digits) {
    const done = (DONE_BY_LOCALE[loc] || DONE_BY_LOCALE.en)[Math.abs(seed) % 3];
    return `${generic[Math.abs(seed + 4) % generic.length].replace(/\.$/, "")} - ${digits[0]}, ${done}`;
  }
  return generic[Math.abs(seed) % generic.length];
}

const DONE_BY_LOCALE = {
  en: ["got it.", "on the sheet.", "thank you."],
  es: ["listo.", "en la lista.", "gracias."],
  fr: ["c'est noté.", "sur la liste.", "merci."],
  de: ["notiert.", "auf der Liste.", "danke."],
  pt: ["anotado.", "na lista.", "obrigado."],
  hi: ["नोट हो गया।", "लिस्ट में है।", "धन्यवाद।"],
};

const DIGIT_WORDS = new Set(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "oh", "ten", "twenty", "thirty", "forty", "fifty", "hundred", "thousand"]);

function poolsFor(locale) {
  const loc = normalizeLocale(locale);
  return POOLS_BY_LOCALE[loc] || POOLS_BY_LOCALE.en;
}

function callbackCloseFor(locale, who, inTime, number) {
  const loc = normalizeLocale(locale);
  const tpl = CALLBACK_CLOSE_BY_LOCALE[loc] || CALLBACK_CLOSE_BY_LOCALE.en;
  return tpl.replace(/\{who\}/g, who).replace(/\{inTime\}/g, inTime).replace(/\{number\}/g, number);
}

function questionsFor(locale, field, asked) {
  const loc = normalizeLocale(locale);
  const stages = QUESTIONS_BY_LOCALE[loc] || QUESTIONS_BY_LOCALE.en;
  const pool = stages[Math.min(asked, stages.length - 1)];
  return pool[Math.abs(asked * 7 + field.length) % pool.length].replace(/\{f\}/g, field);
}

function retryFor(locale, field) {
  const loc = normalizeLocale(locale);
  const opts = RETRY_BY_LOCALE[loc] || RETRY_BY_LOCALE.en;
  return opts[String(field).length % opts.length].replace(/\{f\}/g, String(field).toLowerCase());
}

function pick(arr, seed) { return arr[Math.floor(Math.abs(seed)) % arr.length]; }

/**
 * Friendly, warm lines for when the person on the other end says something
 * off-script (small talk, odd questions, anything unplanned). The agent uses
 * these instead of a robotic "back to the pitch"; they keep the conversation
 * human, then gently steer back.
 */
const FRIENDLY_BY_LOCALE = {
  en: [
    "Ha, fair enough - I love a conversation that stays interesting. Quick answer for you, then back to business.",
    "You know what, that's a good question and you deserve a straight one. Here's the honest version, then let me loop back to the reason I called.",
    "Honestly? I'm the type who actually likes hearing that. Let me give you a real answer and then one quick question back.",
    "I appreciate you talking to me like a person - that's rare on these calls. Straight answer coming up.",
    "Totally fair play. Let me answer that in plain English, then I've got a thirty-second thing for you.",
  ],
  es: ["Buena pregunta - te la respondo con franqueza y volvemos al grano."],
  fr: ["Bonne question - je r\u00e9ponds franchement, puis on reprend le fil."],
  de: ["Berechtigte Frage - ich antworte offen und wir kommen schnell zur Sache."],
  pt: ["Boa pergunta - respondo com franqueza e voltamos ao assunto."],
  hi: ["Achha sawal hai - seedha jawaab deta hoon, phir ek chhota sa sawal."],
};

/** Words that mark the start of an unexpected question the caller asks the agent. */
const QUESTION_BY_LOCALE = {
  en: /\b(how|what|why|when|who|where|which|can you|could you|will you|do you|are you|is it|are there)\b/i,
  es: /\b(c\u00f3mo|qu\u00e9|por qu\u00e9|cu\u00e1ndo|qui\u00e9n|d\u00f3nde|puedes|puede)\b/i,
  fr: /\b(comment|quoi|pourquoi|quand|qui|o\u00f9|pouvez|peux)\b/i,
  de: /\b(warum|was|wie|wann|wer|wo|k\u00f6nnen|kannst)\b/i,
  pt: /\b(como|o que|por que|quando|quem|onde|pode|voc\u00ea)\b/i,
  hi: /\b(kya|kaise|kyun|kab|kaun|kahan|aap)\b/i,
};

const STOP_WORDS = new Set(
  ["the","a","an","to","of","on","in","for","and","or","with","about","my","i","you","it","me","is","are","be","have","has","will","would","can","do","we","they","this","that","but","so","because","not","just","only"],
);

/**
 * A small, stable signature of what a caller said so the agent can spot a
 * recurring question/comment across different calls and learn to answer it.
 */
function signatureOf(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const uniq = Array.from(new Set(words)).slice(0, 2);
  return uniq.join(" ");
}

module.exports = {
  normalizeLocale,
  detectLanguage,
  lex,
  poolsFor,
  callbackCloseFor,
  questionsFor,
  retryFor,
  ackFor,
  pick,
  NEGATIVE_BY_LOCALE,
  SOFT_BY_LOCALE,
  POSITIVE_BY_LOCALE,
  NEGATIVE_WORDS_BY_LOCALE,
  HUMAN_BY_LOCALE,
  REOPEN_BY_LOCALE,
  DEADAIR_BY_LOCALE,
  HANDOFF_BY_LOCALE,
  GRACEFUL_BY_LOCALE,
  ACK_BY_LOCALE,
  CALLBACK_CLOSE_BY_LOCALE,
  POOLS_BY_LOCALE,
  SUPPORTED_LOCALES: Object.keys(POOLS_BY_LOCALE),
  FRIENDLY_BY_LOCALE,
  QUESTION_BY_LOCALE,
  signatureOf,
};