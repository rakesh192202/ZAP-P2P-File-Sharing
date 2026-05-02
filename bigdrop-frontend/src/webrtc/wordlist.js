// wordlist.js — ZAP Human-readable ID generation
//
// BUG FIXED: Old list had 573 words but bit-extraction gives indices up to 2047.
// WORDLIST[582] on a 573-word array = undefined → join gives "idle··hurt" (2 words).
//
// FIX: Use modulo (% WORDLIST.length) on every index so it always stays in bounds.
// This works correctly with any wordlist size.
//
// IMPORTANT: This changes existing IDs stored in IndexedDB.
// Run this in browser console ONCE after deploying this fix:
//   indexedDB.deleteDatabase('ZAP_Identity_v1')
// Then reload — new valid 3-word ID will be generated.

export const WORDLIST = [
  // A
  "able","acid","aged","also","area","army","away","arch","acre","aide",
  "aims","alto","amid","amps","ants","apex","arcs","aria","arms","arts",
  "asks","atom","aunt","aura","auto","avid","evil","axes","axle","azure",
  // B
  "baby","back","ball","band","bank","base","bath","bear","beat","been",
  "bell","best","bird","blow","blue","boat","body","bold","bolt","bone",
  "book","boom","born","both","bowl","burn","busy","bail","bait","bake",
  "bale","balm","bare","bark","barn","bash","bask","bass","beam","bean",
  "beer","beet","berg","bind","bite","blot","blur","boar","bode","bomb",
  "bond","boon","boot","bore","boss","bout","brag","bran","bray","bred",
  "brew","brim","brow","buck","bulb","bull","bump","bunk","buoy","burp",
  "burr","byte","buzz","bled","blew","blab",
  // C
  "calm","came","card","care","case","cash","cast","cave","chef","chip",
  "city","clap","clay","clip","club","clue","coal","coat","code","coil",
  "cold","come","cook","cool","core","corn","cost","crew","crop","crow",
  "cube","cure","curb","curl","cage","cake","calf","call","camp","cane",
  "cape","cart","cell","cent","chat","chew","chin","chop","cite","clad",
  "clam","clan","claw","clog","colt","cone","cope","cord","cork","coup",
  "cozy","crab","crag","cram","crib","crud","crux","cuff","cull","cute",
  // D
  "dark","dart","data","dawn","days","dead","deal","dean","deep","deer",
  "desk","dew","dice","diet","dirt","disk","dive","dock","dome","door",
  "dose","dove","down","draw","drop","drug","drum","dual","dune","dusk",
  "dust","duty","dab","dale","dame","damp","dare","darn","dash","date",
  "deaf","deft","deli","dell","dent","deny","dial","dike","dill","dime",
  "dine","ding","dirk","dire","diva","dolt","dote","dour","drab","drag",
  "dram","drip","drub",
  // E
  "each","earn","ease","east","edge","else","emit","earl","echo","edit",
  "envy","epic","eras","ergo","even","ever","exam","eyes","edgy","etch",
  "euro","exit","expo","eval","ewer",
  // F
  "face","fact","fail","fair","fall","fame","farm","fast","fate","fear",
  "feel","feet","fell","felt","file","fill","film","find","fire","firm",
  "fish","fist","flag","flat","flew","flip","flow","foam","fold","folk",
  "fond","font","food","fool","ford","fork","form","fort","foul","free",
  "from","fuel","full","fund","fuse","fad","fake","fang","fare","fawn",
  "faze","feat","fend","fern","feud","fizz","flak","flan","flap","flaw",
  "flea","fled","flog","flop","flux","foal","foil","fore","fray","fret",
  "frog","frond","frost","frown",
  // G
  "gain","game","gate","gave","gaze","gear","gene","gift","girl","give",
  "glad","glow","glue","goal","gold","gone","good","grab","gray","grew",
  "grid","grin","grip","grow","gulf","gust","gab","gal","gap","garb",
  "gash","gasp","geld","germ","gibe","gild","gill","gilt","gimp","gird",
  "gist","glee","glen","glib","glob","glut","goad","goat","goof","gory",
  "gown","grad",
  // H
  "hail","half","hall","halt","hand","hang","hard","harm","hawk","head",
  "heal","heap","heat","heel","held","help","herb","hero","hide","high",
  "hill","hint","hold","hole","holy","home","hook","hope","horn","host",
  "hour","hull","hunt","hurl","hurt","hack","hade","haft","hale","halo",
  "hank","hare","hark","harp","hash","hasp","hate","haze","hazy","heed",
  "helm","hemp","herd","hewn","hick","hike","hire","hiss","hock","hoot",
  "hops","hose","hove","howl",
  // I
  "idea","idle","inch","into","iron","isle","iced","icon","iffy","ills",
  "imam","inky","ions","iota","irks","itch",
  // J
  "jail","join","joke","jump","june","just","keen","keep","kelp","kind",
  "king","knee","knob","know","keel","kegs","kern","keys","kick","kids",
  "kill","kiln","kilt","kink","kite","kiwi","knap","knit",
  // L
  "lack","lake","lamp","land","lane","last","late","lava","lawn","lead",
  "leaf","lean","leap","left","lend","lens","lift","like","lime","line",
  "link","lion","list","live","load","loan","lock","loft","lone","long",
  "look","loop","lore","lose","lost","loud","love","luck","lung","lace",
  "lair","lamb","lame","lard","lark","lash","laze","lazy","leak","leer",
  "levy","lewd","liar","lick","limp","lisp","lob","lode","loin","loom",
  "loot","luge","lull","lurk",
  // M
  "made","mail","main","make","male","mall","mane","many","mark","mars",
  "mask","mass","mast","mate","math","maze","meal","mean","meat","meet",
  "melt","memo","menu","mesh","mild","mile","milk","mill","mind","mine",
  "mint","mist","mode","mole","moon","more","most","move","much","mule",
  "myth","mace","maid","mare","meek","mess","mice","mock","moat","mold",
  "molt","monk","mope","moss","mote","muck","muff","mull","murk","muse",
  "mire","mere","mend","mews",
  // N
  "nail","name","near","neck","need","nest","news","next","nice","node",
  "noon","norm","nose","note","nova","nab","nag","nap","narc","nave",
  "navy","neap","nerd","newt","nick","nigh","nips","noel","nook","nope",
  "nous","null","numb","nun",
  // O
  "oath","odds","only","open","oral","oval","oven","over","oafs","oaks",
  "oars","oast","obey","ogre","ohms","okra","olds","once","ones","onyx",
  "opts","orbs","ores","outs",
  // P
  "pace","pack","page","paid","pair","pale","palm","park","part","pass",
  "path","peak","peel","peer","pick","pile","pine","pink","pipe","plan",
  "play","plot","plow","plug","plus","poem","poet","pole","pond","pool",
  "poor","port","pose","post","pour","prey","prod","prop","pull","pump",
  "pure","push","pact","pail","pang","pare","pave","pawn","pays","peal",
  "peat","peck","perk","pest","pica","pied","pier","pike","pill","pith",
  "pixy","plod","plop","ploy","plum","pock","pods","poke","polo","pone",
  "pong","pore","pork","pout","prow",
  // Q
  "quiz","quay",
  // R
  "race","rack","rain","rake","ramp","rang","rank","rate","rays","read",
  "real","reef","reel","rely","rest","rice","rich","ride","ring","rise",
  "risk","road","roam","roar","rock","rode","role","roll","roof","room",
  "root","rope","rose","ruin","rule","rush","raft","rage","rail","rasp",
  "rave","reap","reek","rend","rent","rife","rift","rime","rind","riot",
  "ripe","rite","roan","robe","rods","romp","rook","rubs","rugs","rump",
  "rune","runt","ruse","ruts",
  // S
  "safe","sage","sail","sake","salt","sand","sang","save","scan","seal",
  "seed","seek","seem","seen","self","sell","send","shed","ship","shoe",
  "shot","show","shut","side","sift","sign","silk","sing","sink","site",
  "size","skin","skip","slam","slim","slip","slow","snow","soap","sock",
  "soil","sold","sole","some","song","sort","soul","soup","span","spin",
  "spot","star","stay","stem","step","stir","stop","such","suit","sung",
  "sure","surf","swap","sway","sack","sash","sate","says","scab","scam",
  "scar","scat","scow","scud","scum","seam","sear","sect","seep","serf",
  "sewn","shim","shin","shiv","shod","shop","slab","slag","slap","slat",
  "slew","slob","slop","slot","slur","smog","snag","snap","snob","snot",
  "snub","spar","sped","spew","spud","spun","spur","stab","stag","stew",
  "stub","stud",
  // T
  "tail","take","tale","tall","tank","tape","task","team","tear","tell",
  "tend","term","test","text","than","that","them","then","they","thin",
  "tide","tile","time","tiny","tire","toll","tone","tool","torn","toss",
  "tour","town","trap","tree","trim","trip","true","tune","turn","twin",
  "type","tack","tang","tare","tarn","taut","teat","tech","teem","tent",
  "thaw","thou","thud","thug","tick","tiff","tike","till","tilt","tops",
  "tore","tote","tray","trek","trot","troy","tuft","tuna","turf","twig",
  // U-V
  "ugly","unit","upon","used","vale","vast","vein","verb","very","vest",
  "view","vine","void","volt","urge","undo","vane","vamp","vary","vase",
  "veal","veer","veil","vend","vent","vex","vial","vice","vile","vim",
  "vise","vita",
  // W
  "wade","wage","wake","walk","wall","wand","warm","warn","warp","wave",
  "ways","weak","weld","well","went","were","west","when","wide","wild",
  "will","wind","wing","wire","wise","wish","with","wood","wool","word",
  "wore","work","worn","wrap","waft","wail","wane","ware","wary","wean",
  "weep","weft","welt","whim","whip","whir","whit","wile","wilt","wimp",
  "wink","wiry","woes","woke","womb","wonk","wont","woof","worm",
  // X-Y-Z
  "yard","year","your","zone","zoom","yack","yaks","yams","yank","yore",
  "yowl","yuck","yule","zeal","zero","zest","zinc","zing","zaps","zany",
];

// ─── Verify at load time ──────────────────────────────────────────────────────
if (WORDLIST.length < 100) {
  console.error(`[ZAP] wordlist too short: ${WORDLIST.length}`);
}

/**
 * Convert a NodeID (Uint8Array, 20-32 bytes) to a human-readable 3-word ZAP ID.
 *
 * FIXED: Uses modulo (% WORDLIST.length) on every index.
 * This means all indices are ALWAYS in bounds, regardless of wordlist size.
 *
 * Encoding: reads first 5 bytes, extracts three 11-bit numbers, applies modulo.
 *
 * @param {Uint8Array} nodeIdBytes - 20 or 32 byte node ID
 * @returns {string} e.g. "fire·moon·storm"
 */
export function nodeIdToWords(nodeIdBytes) {
  // Ensure we have a proper ArrayBuffer view
  const bytes = nodeIdBytes instanceof Uint8Array
    ? nodeIdBytes
    : new Uint8Array(nodeIdBytes);

  if (bytes.length < 5) {
    console.error('[ZAP] nodeIdToWords: need at least 5 bytes');
    return 'bad·node·id';
  }

  const view  = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const N     = WORDLIST.length;

  // Read 4 bytes as uint32 big-endian, 5th byte for 3rd word
  const n     = view.getUint32(0, false);
  const extra = bytes[4] & 0xFF;

  // Extract three 11-bit indices
  const raw0  = (n >>> 21) & 0x7FF;
  const raw1  = (n >>> 10) & 0x7FF;
  const raw2  = ((n & 0x3FF) << 1) | (extra >>> 7);

  // CRITICAL FIX: modulo keeps indices in bounds for any wordlist size
  const i0    = raw0 % N;
  const i1    = raw1 % N;
  const i2    = raw2 % N;

  const w0    = WORDLIST[i0];
  const w1    = WORDLIST[i1];
  const w2    = WORDLIST[i2];

  // Defensive check — should never happen after modulo fix
  if (!w0 || !w1 || !w2) {
    console.error(`[ZAP] wordlist lookup failed: i0=${i0} i1=${i1} i2=${i2} N=${N}`);
    return `w${i0}·w${i1}·w${i2}`;
  }

  return `${w0}·${w1}·${w2}`;
}

/**
 * Convert ZAP ID back to a DHT lookup key.
 * Normalizes separators and case for consistent DHT storage/lookup.
 *
 * "Fire·Moon·Storm" → "fire·moon·storm"
 * "fire moon storm" → "fire·moon·storm"  (space-separated also accepted)
 */
export function wordsToLookupKey(zapId) {
  if (!zapId) return '';
  return zapId
    .toLowerCase()
    .trim()
    // Normalize any separator (space, dot, dash, middle-dot) to middle-dot
    .replace(/[\s\-._]+/g, '·');
}