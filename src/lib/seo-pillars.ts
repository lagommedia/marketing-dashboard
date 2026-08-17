export interface KeywordPillar {
  id:        string;
  label:     string;
  isPrimary: boolean;
  seeds:     string[]; // query must contain at least one seed (case-insensitive)
}

export const KEYWORD_PILLARS: KeywordPillar[] = [
  {
    id: "ai-bookkeeping",
    label: "AI Bookkeeping",
    isPrimary: true,
    seeds: ["ai bookkeeping", "ai-bookkeeping", "artificial intelligence bookkeeping", "automated bookkeeping"],
  },
  {
    id: "ai-accounting",
    label: "AI Accounting",
    isPrimary: true,
    seeds: ["ai accounting", "ai-accounting", "artificial intelligence accounting", "automated accounting"],
  },
  {
    id: "ai-accountant",
    label: "AI Accountant",
    isPrimary: false,
    seeds: ["ai accountant", "ai-accountant", "artificial intelligence accountant"],
  },
  {
    id: "ai-cfo",
    label: "AI CFO",
    isPrimary: false,
    seeds: ["ai cfo", "ai-cfo", "artificial intelligence cfo", "virtual cfo ai", "fractional cfo ai"],
  },
  {
    id: "ai-month-end-close",
    label: "AI Month-End Close",
    isPrimary: false,
    seeds: ["ai month-end", "ai month end", "automated month-end", "automated month end", "ai close"],
  },
  {
    id: "ai-accounts-payable",
    label: "AI Accounts Payable",
    isPrimary: false,
    seeds: ["ai accounts payable", "ai ap ", "automated accounts payable", "ai-powered accounts payable"],
  },
  {
    id: "ai-accounts-receivable",
    label: "AI Accounts Receivable",
    isPrimary: false,
    seeds: ["ai accounts receivable", "ai ar ", "automated accounts receivable", "ai-powered accounts receivable"],
  },
  {
    id: "ai-financial-reporting",
    label: "AI Financial Reporting",
    isPrimary: false,
    seeds: ["ai financial reporting", "ai financial report", "automated financial reporting", "ai-powered financial"],
  },
];

/** Branded queries: contain the company name */
export const BRAND_TERMS = ["zeni"];

export function isBranded(query: string): boolean {
  const q = query.toLowerCase();
  return BRAND_TERMS.some(t => q.includes(t));
}

export function getPillarForQuery(query: string): KeywordPillar | null {
  const q = query.toLowerCase();
  return KEYWORD_PILLARS.find(p => p.seeds.some(s => q.includes(s))) ?? null;
}
