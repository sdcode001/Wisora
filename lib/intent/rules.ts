import type { Category } from "../../config/sources";
import type { Budget, Confidence, Intent } from "./types";

const KEYWORDS: Record<Exclude<Category, "general">, string[]> = {
  electronics: [
    "laptop", "notebook", "chromebook", "desktop", "computer", "tablet",
    "ipad", "smartphone", "mobile phone", "cell phone", "kindle", "ereader",
    "e-reader", "smart tv", "television", "headphone", "earphone", "earbud",
    "airpods", "speaker", "soundbar", "home theatre", "camera", "dslr",
    "mirrorless", "gopro", "action camera", "drone", "smartwatch",
    "smart watch", "fitness band", "keyboard", "mouse", "monitor", "printer",
    "scanner", "router", "wifi extender", "hard drive", "ssd", "pen drive",
    "memory card", "charger", "power bank", "powerbank", "gaming console",
    "playstation", "ps5", "xbox", "nintendo", "vr headset", "projector",
    "webcam", "microphone", "graphics card", "gpu", "processor", "motherboard",
    "smart speaker", "alexa", "google home", "tv", "phone",
    "gaming", "coding", "programming", "development", "developer",
    "video editing", "photo editing", "graphic design", "office work",
    "work from home", "wfh", "battery life", " ram ",
  ],
  fashion: [
    "t-shirt", "tshirt", "tee", "shirt", "jeans", "denim", "dress", "gown",
    "kurta", "kurti", "saree", "lehenga", "salwar", "churidar", "jacket",
    "blazer", "coat", "sweater", "sweatshirt", "hoodie", "cardigan",
    "pullover", "shorts", "bermuda", "skirt", "crop top", "trousers",
    "pants", "chinos", "suit", "sherwani", "dhoti", "leggings", "jeggings",
    "palazzo", "jumpsuit", "romper", "ethnic wear", "western wear",
    "clothing", "clothes", "apparel", "outfit", "innerwear", "lingerie",
    "nightwear", "sleepwear", "swimwear", "raincoat", "socks", "belt",
    "tie", "scarf", "stole", "dupatta", "cap", "hat", "handbag",
    "hand bag", "purse", "wallet", "backpack", "sunglasses", "spectacles",
    "eyewear", "top",
  ],
  footwear: [
    "footwear", "running shoes", "sports shoes", "formal shoes",
    "casual shoes", "school shoes", "football boots", "cricket shoes",
    "sneakers", "sneaker", "shoes", "shoe", "sandals", "sandal",
    "flip flops", "flip-flop", "slippers", "slipper", "sliders", "floaters",
    "boots", "boot", "loafers", "loafer", "moccasins", "heels", "stilettos",
    "wedges", "pumps", "ballet flats",
  ],
  beauty: [
    "skincare", "skin care", "serum", "moisturizer", "moisturiser",
    "sunscreen", "sunblock", "face wash", "facewash", "cleanser",
    "cleansing", "toner", "face cream", "night cream", "day cream",
    "lotion", "body lotion", "lipstick", "lip balm", "lip gloss",
    "foundation", "concealer", "compact", "kajal", "eyeliner", "mascara",
    "eyeshadow", "blush", "makeup", "make-up", "cosmetic", "shampoo",
    "conditioner", "hair oil", "hair serum", "hair color", "hair dye",
    "hair mask", "face mask", "face pack", "scrub", "exfoliator",
    "perfume", "deodorant", "deo", "body spray", "talc", "soap",
    "body wash", "shower gel", "hand wash", "sanitizer", "toothpaste",
    "toothbrush", "razor", "trimmer", "epilator", "hair dryer",
    "straightener", "curler", "nail polish", "nail cutter", "beauty",
    "grooming", "anti ageing", "anti-aging", "acne", "pimple",
    "dark spots", "pigmentation", "dandruff", "hair fall",
  ],
  "home-kitchen": [
    "mixer grinder", "mixer", "grinder", "juicer", "food processor",
    "cookware", "pressure cooker", "cooker", "frying pan", "tawa",
    "kadhai", "wok", "kettle", "electric kettle", "toaster",
    "sandwich maker", "microwave", "otg", "oven", "induction cooktop",
    "gas stove", "chimney", "dishwasher", "refrigerator", "fridge",
    "freezer", "washing machine", "washer", "dryer", "vacuum cleaner",
    "vacuum", "mop", "broom", "steam iron", "geyser", "water heater",
    "water purifier", "inverter", "ceiling fan", "table fan", "cooler",
    "air cooler", "heater", "room heater", "lamp", "lamps", "tube light",
    "bulb", "led", "chandelier", "curtain", "curtains", "cushion",
    "cushion cover", "bedsheet", "bed sheet", "blanket", "quilt",
    "comforter", "pillow", "mattress", "topper", "sofa", "couch",
    "chair", "dining table", "study table", "table", "bed", "wardrobe",
    "almirah", "cupboard", "shelf", "rack", "drawer", "furniture",
    "home decor", "decor", "wall art", "photo frame", "mirror", "clock",
    "wall clock", "plant", "planter", "vase", "candle", "diffuser",
    "water bottle", "bottle", "flask", "thermos", "lunch box", "tiffin",
    "lunchbox", "container", "storage box", "organizer", "organiser",
    "basket", "bucket", "dustbin", "laundry bag", "kitchen", "bathroom",
    "bedroom", "living room", "office furniture", "bean bag", "carpet",
    "rug", "doormat", "towel", "bath towel", "napkin", "apron",
    "gloves", "knife set", "knife", "chopping board", "spoon", "fork",
    "dinner set", "plates", "bowls", "glasses", "cups", "mugs",
    "bakeware", "tray", "sieve", "grater", "peeler", "lighter",
    "detergent", "washing powder", "dishwash", "phenyl", "cleaner", "pan",
    "pot",
  ],
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CategoryScore {
  category: Category;
  hits: number;
  firstIndex: number;
}

export function detectCategory(text: string): {
  category: Category;
  confidence: Confidence;
} {
  const scores: CategoryScore[] = [];
  for (const [category, words] of Object.entries(KEYWORDS) as [
    Exclude<Category, "general">,
    string[],
  ][]) {
    let hits = 0;
    let firstIndex = Number.POSITIVE_INFINITY;
    for (const word of words) {
      const stem = escapeRegExp(word.trim());
      const pattern =
        word.startsWith(" ") || word.endsWith(" ")
          ? stem
          : `\\b${stem}(?:s|es)?\\b`;
      const match = new RegExp(pattern, "i").exec(text);
      if (match?.index !== undefined) {
        hits += 1;
        firstIndex = Math.min(firstIndex, match.index);
      }
    }
    if (hits > 0) {
      scores.push({ category, hits, firstIndex });
    }
  }
  if (scores.length === 0) {
    return { category: "general", confidence: "low" };
  }
  scores.sort((a, b) => b.hits - a.hits || a.firstIndex - b.firstIndex);
  const [best, second] = scores as [CategoryScore, CategoryScore?];
  const margin = best.hits - (second?.hits ?? 0);
  const confidence: Confidence =
    best.hits >= 3 || margin >= 2 ? "high" : "medium";
  return { category: best.category, confidence };
}

const MAX_CUES =
  /(under|below|less than|up ?to|within|max(?:imum)?(?: of)?|at most|till|til|until|no more than|not more than|not exceeding|budget(?: of| around| is)?|around|about|~)\s*$/i;
const MIN_CUES =
  /(above|over|more than|greater than|at least|min(?:imum)?(?: of)?|starting(?: from| at| around)?|from)\s*$/i;
// "between 5000 to 10000", "between 50k and 1 lakh"
const BETWEEN_RE =
  /between\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:and|to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?/i;
// "₹5000-10000", "Rs 5000 to 10000"
const CURRENCY_RANGE_RE =
  /(?:₹|rs\.?|inr|rupees?)\s*(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?/i;
// "range 5000-10000", "budget 50k to 1L", "within 5000 to 10000"
const CUE_RANGE_RE =
  /(?:range|budget|price|within)(?:\s*(?:of|is))?\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?/i;
// "from 5000 to 10000"
const FROM_RANGE_RE =
  /from\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?/i;
// "for 5000 to 10000", "shoes for 50k-1L"
const FOR_RANGE_RE =
  /for\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?/i;
// "5000 to 10000 price", "50k-1L range"
const TRAILING_CUE_RANGE_RE =
  /(?<min>[\d,]+(?:\.\d+)?)\s*(?<minUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:to|[-–])\s*(?:₹|rs\.?|inr|rupees?)?\s*(?<max>[\d,]+(?:\.\d+)?)\s*(?<maxUnit>lakhs?|lacs?|thousand|k|l|rupees?)?\s*(?:₹|rs\.?|inr|rupees?|prices?|range|budget)/i;

const RANGE_PATTERNS: Array<{ pattern: RegExp; needsMagnitude: boolean }> = [
  { pattern: BETWEEN_RE, needsMagnitude: false },
  { pattern: CURRENCY_RANGE_RE, needsMagnitude: false },
  { pattern: CUE_RANGE_RE, needsMagnitude: false },
  { pattern: FROM_RANGE_RE, needsMagnitude: false },
  { pattern: FOR_RANGE_RE, needsMagnitude: true },
  { pattern: TRAILING_CUE_RANGE_RE, needsMagnitude: true },
];
const MONEY_RE =
  /(₹|rs\.?|inr|rupees?)?\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|thousand|k|l|rupees?)?\b/gi;
const SCREEN_WORDS = /^\s*(tv|tvs|hd|uhd|fhd|qled|oled|amoled|display|resolution|monitor|screen|refresh|hz)\b/i;

function convertInr(value: number, unit?: string): number {
  switch (unit?.toLowerCase()) {
    case "lakh":
    case "lakhs":
    case "lac":
    case "lacs":
    case "l":
      return Math.round(value * 100000);
    case "thousand":
    case "k":
      return Math.round(value * 1000);
    default:
      return Math.round(value);
  }
}

function toInr(amount: string, unit?: string): number {
  return convertInr(Number.parseFloat(amount.replace(/,/g, "")), unit);
}

export function extractBudgetInr(text: string): {
  budget?: Budget;
  cleaned: string;
} {
  for (const { pattern, needsMagnitude } of RANGE_PATTERNS) {
    const range = pattern.exec(text);
    const groups = range?.groups as
      | { min?: string; minUnit?: string; max?: string; maxUnit?: string }
      | undefined;
    if (!range || !groups?.min || !groups?.max) {
      continue;
    }
    const rawMin = Number.parseFloat(groups.min.replace(/,/g, ""));
    const rawMax = Number.parseFloat(groups.max.replace(/,/g, ""));
    if (
      !Number.isFinite(rawMin) ||
      !Number.isFinite(rawMax) ||
      rawMin <= 0 ||
      rawMax <= 0
    ) {
      continue;
    }
    if (needsMagnitude) {
      // Bare "for 5 to 6 hours" or "16 to 17 price comparison" reads are
      // not prices; require explicit currency/units or plausible magnitude.
      const explicit =
        /₹|rs\.?|inr|rupees?/i.test(range[0]) ||
        groups.minUnit != null ||
        groups.maxUnit != null;
      if (!explicit && Math.max(rawMin, rawMax) < 100) {
        continue;
      }
    }
    // "5 to 10 lakhs" reads the bare side in the same unit; large bare
    // numbers ("5000 to 2 lakh") are left as rupees.
    const minUnit =
      groups.minUnit ?? (rawMin < 1000 ? groups.maxUnit : undefined);
    const maxUnit =
      groups.maxUnit ?? (rawMax < 1000 ? groups.minUnit : undefined);
    const a = convertInr(rawMin, minUnit);
    const b = convertInr(rawMax, maxUnit);
    return {
      budget: { min: Math.min(a, b), max: Math.max(a, b) },
      cleaned: stripLeftoverCues(text.replace(range[0], " ")),
    };
  }

  let min: number | undefined;
  let max: number | undefined;
  const spans: Array<[number, number]> = [];
  MONEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MONEY_RE.exec(text)) !== null) {
    const [full, symbol, amount, unit] = match as unknown as [
      string,
      string | undefined,
      string,
      string | undefined,
    ];
    if (!amount) continue;
    if (unit?.toLowerCase() === "k" && SCREEN_WORDS.test(text.slice(match.index + full.length))) {
      continue; // e.g. "4K TV" is a resolution, not a price
    }
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const hasCue = MAX_CUES.test(before) || MIN_CUES.test(before);
    if (!symbol && !unit && !hasCue) continue; // bare number, not a price
    const value = toInr(amount, unit);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (MAX_CUES.test(before)) {
      max = max === undefined ? value : Math.max(max, value);
    } else if (MIN_CUES.test(before)) {
      min = min === undefined ? value : Math.min(min, value);
    } else {
      max = max === undefined ? value : Math.max(max, value);
    }
    spans.push([match.index, match.index + full.length]);
  }

  let cleaned = text;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    cleaned = `${cleaned.slice(0, start)} ${cleaned.slice(end)}`;
  }
  cleaned = stripLeftoverCues(cleaned);
  const budget: Budget | undefined =
    min === undefined && max === undefined ? undefined : { min, max };
  if (budget?.min !== undefined && budget.max !== undefined && budget.min > budget.max) {
    return { budget: { min: budget.max, max: budget.min }, cleaned };
  }
  return { budget, cleaned };
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripLeftoverCues(s: string): string {
  return collapseSpaces(
    s
      .replace(
        /\b(under|below|above|over|around|about|budget|within|up to|less than|more than|at most|at least|till|til|until|between|range|starting|maximum|minimum|prices?)\b\s*(?=\s|$|[,.])/gi,
        " ",
      )
      .replace(/\b(max|min)\b\s*(?=$|[,.])/gi, " "),
  );
}

function polish(s: string): string {
  return collapseSpaces(s).replace(/\s+([.,!?;:]+)$/, "$1");
}

export function analyzeIntent(query: string): Intent {
  const trimmed = query.trim();
  const { category, confidence } = detectCategory(trimmed);
  const { budget, cleaned } = extractBudgetInr(trimmed);
  return {
    query: trimmed,
    category,
    categoryConfidence: confidence,
    budgetInr: budget,
    searchTerms: polish(cleaned || trimmed),
  };
}
