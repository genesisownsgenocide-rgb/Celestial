"use strict";

const { rememberBanatReply, pickBanatReply } = require("./banat-memory");

// Banat-only local reply pools. Nothing here calls an AI service.
// Playful, light teasing only: no profanity, no slurs, no personal/family insults.
// That keeps the bot fun and much less likely to be flagged or blocked by Facebook.
const groups = [
  {
    name: "bot",
    triggers: ["bot", "robot", "ai"],
    replies: [
      "bot daw, ang cute mo magtanong 😌",
      "ay may nakapansin sa akin",
      "bot na kung bot, andito pa rin ako 😎",
      "hala na-expose ako",
      "bot ba talaga? sure ka?",
      "ikaw ba nagpa-tawag sa akin?",
      "andito lang ako, wag mo akong hanapin masyado 😭",
      "bakit, miss mo ako?",
      "bot na may personality, sorry na lang",
      "ang kulit mo, pero sige, pansin kita",
      "teka, sino ba nagpa-bot ng usapan?",
      "may bot pala dito? ayos ah",
      "ako 'yan, ang certified kausap mo ngayon",
      "bot man o hindi, mas masaya pa rin ako kausap",
      "tinawag mo ako, kaya andito na ako",
      "ang galing mo mag-observe, detective ka ba?",
      "oo na, ako na 'yung bot 😭",
      "ano na naman kailangan mo sa akin?",
      "kapag bot ba hindi na pwedeng makipagkulitan?",
      "grabe, bot agad? hindi man lang hi muna"
    ]
  },
  {
    name: "trash-talk",
    triggers: ["weak", "laro", "tanginamo", "lala", "patawa", "gago", "bobo", "tanga", "hahahaa", "pake ko", "sino yan"],
    replies: [
      "ang tapang mo ngayon ah 😏",
      "saan mo hinugot 'yang confidence mo?",
      "may resibo ka ba o vibes lang?",
      "ang yabang mo, cute",
      "nag-iisip ka ba o nagpapacute lang?",
      "tuloy mo lang, natutuwa akong panoorin ka",
      "may tutorial ba para maintindihan kita?",
      "ang ganda ng confidence mo, sayang naligaw",
      "behave ka muna, makulit ka na nga, cute pa",
      "kailangan mo ba ng hug bago ka ulit magsalita?",
      "calm down, baka maubos cute points mo",
      "ang dramatic mo, parang teleserye",
      "bakit every sentence mo may plot twist?",
      "ikaw na certified little menace ko",
      "ang lakas ng aura mo, kaso naligaw",
      "wag masyadong seryoso, bagay sa'yo ang cute na sablay",
      "ang sipag mo gumawa ng gulo ah",
      "proud ka talaga sa ganyang take?",
      "ang confidence mo parang unlimited data",
      "ang logic mo naka-trial version",
      "nag-buffer ba utak mo? 😭",
      "cute ng argument mo pero hindi convincing",
      "sige explain mo pa, gusto kong marinig ang sequel",
      "ang haba ng speech mo, nasaan ang point?",
      "may point ka ba o nagbabakasyon?",
      "balik tayo sa reality, miss ka na doon",
      "ang layo ng sagot mo sa tanong",
      "ang cute mo kapag trying hard",
      "don't worry, tutulungan kitang hanapin 'yang point mo",
      "confidence muna bago logic?",
      "wag kang magalit, bagay sa'yo ang pikon",
      "cute ng tampo mo, kaso mali ka pa rin 😌",
      "okay, noted 'yan",
      "ikaw na CEO ng drama",
      "may citation ba 'yang claim mo?",
      "source? o galing lang sa imagination?",
      "ang effort, pero saan napunta ang sense?",
      "ang daldal mo, pero sige, favorite kita",
      "ang ingay mo, pero cute kaya pagbibigyan kita",
      "bakit parang hobby mo akong kulitin?",
      "gusto mo ng soundtrack sa pagka-dramatic mo?",
      "may script ba tayo o improv lang 'to?",
      "defend your thesis, hinihintay ko",
      "hug muna bago natin ayusin ang usapan",
      "breathe ka, hindi ka hinahabol ng facts",
      "relax, hindi contest ang pagiging tama",
      "GPS ba utak mo? bakit off-route?",
      "recalculating ang logic mo",
      "destination: tamang sagot. ETA: unknown",
      "may detour yata 'yang argument mo",
      "bakit parang side quest lahat ng sagot mo?",
      "ang banat mo cute, parang ikaw",
      "roast mo pa ako, nakakatuwa ka",
      "obvious na gusto mo ng attention, nakuha mo na 😌",
      "congrats, ikaw ang little problem of the day",
      "may medal ba sa pagiging makulit? deserve mo",
      "ang taas ng confidence, ang baba ng accuracy",
      "perfect delivery, questionable content",
      "ang smooth mong magsalita, sayang sablay ang punchline",
      "baka kailangan natin ng search party para sa point mo",
      "saan nag-road trip ang common sense mo?",
      "ang reply mo nag-lag sa landing",
      "ikaw ang definition ng cute disaster",
      "sino nag-imbita sa'yo sa usapan na 'to 😭",
      "nag-load ka pa ba o stuck ka sa 99%?",
      "NPC energy ka ngayon, paulit-ulit",
      "ang lakas mo mag-flex ng wala",
      "nag-error 404 ang punchline mo",
      "ang daming sinabi, wala namang plot",
      "parang wifi mo ang utak mo, putol-putol",
      "pahinga ka muna, napapagod na ako para sa'yo",
      "ikaw na ang MVP ng kalokohan",
      "ang cute mong magkamali ulit",
      "hindi kita naiintindihan, at okay lang 'yon",
      "may problema ka ba sa katahimikan?",
      "ang lalim ng sinabi mo, parang kiddie pool",
      "may plano ka ba o bara-bara lang?",
      "mukha kang buffering na video 😭",
      "ang yabang mo parang may sponsor",
      "ang corny mo, pero dala mo",
      "tawa ako, pero hindi sa joke mo",
      "may nagtanong ba? wala eh, pero sige na",
      "nag-effort ka, sayang hindi umubra",
      "ang arte ng reply mo, wala namang punto",
      "masyado kang seryoso para sa ganyang take",
      "ang dami mong drama, walang script",
      "wala ka bang ibang hobby kundi mang-asar?",
      "ikaw ba 'yung laging late sa punchline?",
      "lagi ka na lang nauuna sa kalokohan",
      "nagkamali ka ng GC na pinasukan 😭",
      "lakas ng energy mo, mali lang ng direksyon",
      "ang gulo ng sinabi mo, parang spaghetti",
      "sige lang, ituloy mo, may popcorn ako 🍿",
      "ang bilis mong magsalita, ang bagal mong mag-isip",
      "ikaw ba ang final boss ng kakulitan?",
      "nakakaaliw ka, parang circus",
      "ang bigat ng aura mo, pero walang laman",
      "may sumbong ka ba o trip mo lang mang-gulo?",
      "tapos ka na ba sa speech mo? ang haba",
      "ang bilis mo mapikon, parang microwave",
      "puro ka angas, wala namang laban 😌",
      "ang galing mo mag-reply, kulang lang sa sense",
      "baka naman pwedeng umupo ka muna",
      "lagi kang may paliwanag kahit mali",
      "wala kang chill, parang kumukulong tubig",
      "hindi pa tapos ang kalokohan mo, may part 2 pa",
      "ang hirap mong intindihin, parang lumang manual",
      "napaka-extra mo talaga",
      "pahinga ka muna sa kakaisip, mapapagod ka",
      "masyado kang confident para sa resulta mo",
      "ikaw na ang bida ng eksena",
      "ang dami mong chika, walang resibo",
      "sino nagsabi sa'yong magaling ka? charot",
      "bukas ka na lang bumawi, ngayon sablay ka",
      "nagkakamali ka na naman, tradisyon na ba 'yan?",
      "wag ka nang magsalita, baka mapahiya ka pa 😭",
      "ang lakas mo sa yabang, mahina sa tama",
      "tapos na ang show mo, uwi ka na",
      "trip mo ba talagang mapahiya?",
      "bakit ang daldal mo? anong kailangan mo?",
      "lagi kang may pasabog na walang sabog",
      "ayos ka lang? mukhang nag-crash ang brain mo",
      "ang astig mo sana kung may sense 😌",
      "ang yabang mo, pero nauutal ang logic",
      "may exam ba sa kakulitan? top 1 ka",
      "ang tindi mo, hindi ko kinaya ang ingay",
      "ang haba ng kuwento, ang liit ng punto",
      "wala kang pag-asa, pero keep trying",
      "ang gulo mo, parang kable ng headset",
      "puro ka porma, wala namang laman",
      "ang cute ng yabang mo, sayang walang laman",
      "pwede ka bang mag-mute muna?",
      "ang lakas ng impact mo, parang unan",
      "ano ba talaga pinaglalaban mo?",
      "hindi ko alam kung matatawa ako o maaawa 😭",
      "bakit ang yabang ng taong walang resibo?",
      "ang daming reklamo, wala namang solusyon",
      "kakaiba ka, wala kang katulad na sablay",
      "ang hirap mong i-take seriously",
      "palitan mo na 'yang strategy mo, bulok",
      "pasensya na, hindi kita ma-gets",
      "tawagin mo na lang ako kapag may sense ka na",
      "lakas ng trip mo, puro sablay",
      "hindi mo ba napansin, ikaw ang joke?",
      "gising na, nananaginip ka pa ng panalo",
      "wag kang umasa, wala kang chance",
      "wala ka bang kahihiyan? pahiram ako",
      "tama na ang drama, wala namang nanonood",
      "ikaw ang walking error message 😭",
      "anong meron sa'yo, bakit ang yabang?",
      "pang-ilang beses mo na 'yang pagkakamali?",
      "may gusto ka bang patunayan? hindi uubra",
      "bagay sa'yo ang katahimikan, subukan mo",
      "ang bagal ng reply mo, parang sulat",
      "mabuti na lang cute ka, kaya pasado ka",
      "puro ka tunog, walang tono",
      "ayusin mo muna buhay mo bago ka mang-asar",
      "tapos na ang oras mo, next na",
      "wala kang laban sa akin, uwi ka na 😌",
      "bukas ka na ulit, pagod na ang brain mo",
      "hindi ka nakakatakot, nakakatawa ka",
      "sablay na naman, consistent ka talaga",
      "salamat sa tawa, ha",
      "ikaw ang dahilan bakit may mute button",
      "ano 'yang pinagsasasabi mo, parang random",
      "kaya mo pa ba? mukhang hindi na",
      "gising ka na ba, parang tulog pa utak mo"
    ]
  }
];

function normalize(text) { return String(text || "").toLowerCase().replace(/\s+/g, " ").trim(); }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function findGroups(body) {
  const text = normalize(body);
  return groups.filter(group => group.triggers.some(trigger => {
    const t = String(trigger).toLowerCase();
    return t.length <= 4 ? new RegExp("\\b" + escapeRegex(t) + "\\b", "i").test(text) : text.includes(t);
  }));
}

function getTriggerReply(body, threadID = "") {
  const matched = findGroups(body);
  if (!matched.length) return null;
  const group = matched[Math.floor(Math.random() * matched.length)];
  const reply = pickBanatReply(threadID, group.replies);
  if (reply) rememberBanatReply(threadID, reply);
  return reply;
}

function getBanatConversationReply(body, threadID = "") {
  const direct = getTriggerReply(body, threadID);
  if (direct) return direct;
  const fallback = groups.flatMap(g => g.replies);
  const reply = pickBanatReply(threadID, fallback);
  if (reply) rememberBanatReply(threadID, reply);
  return reply;
}

module.exports = { groups, getTriggerReply, getBanatConversationReply };
