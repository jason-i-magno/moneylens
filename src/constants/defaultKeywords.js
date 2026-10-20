// Generic keywords shipped with the app. Keywords specific to you (your local stores, your other
// banks, services you use) belong in a gitignored `*.local.js` file next to this one — see
// "Private keywords" in CLAUDE.md. Tests never load it, so they run the same on every machine.
const localModules = import.meta.env.MODE === 'test' ? {} : import.meta.glob('./*.local.js', { eager: true });
const local = Object.assign({}, ...Object.values(localModules));

const BASE_CATEGORY_KEYWORDS = {
  housing: ['mortgage', 'rent', 'hoa', 'property tax', 'homeowner'],
  transport: [
    'gas', 'fuel', 'uber', 'lyft', 'parking', 'toll', 'car wash', 'oil change',
    'autozone', 'auto parts', 'auto repair', 'rent-a-car',
  ],
  groceries: [
    'grocery', 'groceries', 'whole foods', 'wholefds',
    'trader joe', 'kroger', 'aldi',
  ],
  dining: [
    'restaurant', 'doordash', 'grubhub', 'uber eats', 'uber *eats', 'ubereats',
    'starbucks', 'coffee', 'mcdonald', 'chipotle', 'pizza', 'wendy',
    'chick-fil-a', 'taco bell', 'subway', 'panda express',
    'brew', 'cafe', 'bistro', 'sushi', 'thai',
  ],
  utilities: [
    'electric', 'gas bill', 'water bill', 'internet', 'comcast', 'xfinity',
    'verizon', 't-mobile', 'at&t', 'phone bill', 'trash', 'sewer',
  ],
  entertainment: [
    'netflix', 'hulu', 'disney', 'spotify', 'apple music', 'youtube',
    'gaming', 'steam', 'playstation', 'xbox', 'movie', 'theater', 'concert', 'ticket',
  ],
  health: [
    'pharmacy', 'cvs', 'walgreens', 'doctor', 'medical', 'dental',
    'vision', 'hospital', 'urgent care', 'lab', 'health',
  ],
  shopping: [
    'amazon', 'walmart', 'target', 'costco', 'home depot', 'lowes',
    'ikea', 'best buy', 'clothing', 'shoes', 'mall',
  ],
  insurance: ['insurance', 'geico', 'state farm', 'allstate', 'progressive', 'premium'],
  betting: ['casino', 'sportsbook', 'lottery'],
  // Card payment descriptors for the built-in bank profiles, so they aren't counted as spending
  transfers: [
    'amex epayment', 'pmt discover', 'card payment', 'credit card payment',
    'mobile payment - thank you', 'redeem cash back',
    'internet payment - thank you', 'automatic statement credit',
  ],
};

const BASE_SUBSCRIPTION_KEYWORDS = [
  'subscription', 'subscripti', 'recurring', 'membership',
  'annual fee', 'monthly fee',
  'netflix', 'hulu', 'disney+', 'spotify', 'apple music',
  'youtube premium', 'adobe', 'dropbox', 'icloud', 'google one',
];

function mergeKeywordMaps(base, extra = {}) {
  const merged = { ...base };
  for (const [category, terms] of Object.entries(extra)) {
    merged[category] = [...new Set([...(merged[category] || []), ...terms])];
  }
  return merged;
}

export const DEFAULT_CATEGORY_KEYWORDS = mergeKeywordMaps(BASE_CATEGORY_KEYWORDS, local.PRIVATE_CATEGORY_KEYWORDS);

export const DEFAULT_SUBSCRIPTION_KEYWORDS = [
  ...new Set([...BASE_SUBSCRIPTION_KEYWORDS, ...(local.PRIVATE_SUBSCRIPTION_KEYWORDS || [])]),
];
