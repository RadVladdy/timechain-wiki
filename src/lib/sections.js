// The Bitcoin KB's own hierarchy, straight from _MOC-Map-Bitcoin: seven top-level
// movements (I–VI + Resources), each grouping the sections beneath it. Each section
// links to its sub-MOC page; `area` is the frontmatter value used to count entries.
export const GROUPS = [
  {
    roman: "I", label: "Foundations",
    blurb: "The monetary and historical bedrock — what money is, and where Bitcoin came from.",
    sections: [
      { title: "Economics and monetary theory", slug: "economics-and-monetary-theory", area: "economics", scope: "Hard money, Austrian roots, and why a currency's monetary properties decide its fate." },
      { title: "History and origins", slug: "history-and-origins", area: "history", scope: "Cypherpunks to Satoshi to the institutional turn." },
    ],
  },
  {
    roman: "II", label: "The case",
    blurb: "Why it matters — the cultural, moral, and civilizational argument for Bitcoin.",
    sections: [
      { title: "Culture, philosophy, and the morality of money", slug: "culture-philosophy-and-the-morality-of-money", area: "culture-philosophy", scope: "Money as moral technology — and the culture a sound one grows." },
      { title: "Civilizational cycles and the Bitcoin moment", slug: "civilizational-cycles-and-the-bitcoin-moment", area: "macro-cycles", scope: "Long-wave history and where Bitcoin sits inside it." },
    ],
  },
  {
    roman: "III", label: "The protocol",
    blurb: "The machine itself — how Bitcoin works, scales, is mined, and evolves.",
    sections: [
      { title: "Technical foundations", slug: "technical-foundations", area: "technical", scope: "Keys, transactions, blocks, consensus, and validation — how it actually works." },
      { title: "Development and governance", slug: "development-and-governance", area: "governance", scope: "How Bitcoin changes without anyone in charge." },
      { title: "Mining", slug: "mining", area: "mining", scope: "Proof-of-work, hardware, pools, energy, and the geopolitics of hashrate." },
      { title: "Scaling and Layer 2", slug: "scaling-and-layer-2", area: "scaling", scope: "Lightning, Liquid, Ark, ecash, and the trust-minimisation ladder." },
    ],
  },
  {
    roman: "IV", label: "Analytical frameworks",
    blurb: "Lenses for reading the market — price models and the data on the chain.",
    sections: [
      { title: "Long-term price models and cycles", slug: "long-term-price-models-and-cycles", area: "price-models", scope: "Halvings, power-law and stock-to-flow debates, the four-year rhythm." },
      { title: "On-chain analytics and market psychology", slug: "on-chain-analytics-and-market-psychology", area: "on-chain", scope: "Reading the chain itself — cohorts, cost basis, and crowd behaviour." },
    ],
  },
  {
    roman: "V", label: "Practice",
    blurb: "Putting it to use — holding your own keys, and taking a position.",
    sections: [
      { title: "Practical self-custody and sovereignty", slug: "practical-self-custody-and-sovereignty", area: "self-custody", scope: "Holding your own keys — threat models, hardware, multisig, inheritance." },
      { title: "Investing and markets", slug: "investing-and-markets", area: "investing", scope: "ETFs, treasuries, the instruments — the case and its critics." },
    ],
  },
  {
    roman: "VI", label: "The discourse",
    blurb: "The arguments — criticisms, internal controversies, and the law.",
    sections: [
      { title: "Criticisms of Bitcoin", slug: "criticisms-of-bitcoin", area: null, scope: "The strongest objections, steel-manned rather than dismissed." },
      { title: "Bitcoin controversies", slug: "bitcoin-controversies", area: null, scope: "The internal fights — argued on their merits." },
      { title: "Regulation, policy, and geopolitics", slug: "regulation-policy-and-geopolitics", area: "regulation", scope: "Law, sovereign adoption, and the macro-monetary frame." },
    ],
  },
  {
    roman: "·", label: "Resources",
    blurb: "Where to learn more — curated sites, curricula, dashboards, and references.",
    sections: [
      { title: "Educational websites and online resources", slug: "educational-websites-and-online-resources", area: "education", scope: "Curated reference sites, curricula, dashboards, and community hubs." },
    ],
  },
];

// Flat list (some callers just want every section).
export const SECTIONS = GROUPS.flatMap((g) => g.sections);
