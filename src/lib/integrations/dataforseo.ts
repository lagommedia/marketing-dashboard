export interface AiOverviewCitedItem {
  url:    string;
  domain: string;
  title:  string;
}

export interface AiOverviewResult {
  hasOverview:  boolean;
  zeniCited:    boolean;
  overviewText: string | null;
  citedItems:   AiOverviewCitedItem[];
  topOrganic:   { position: number; url: string; domain: string; title: string }[];
}

interface DataForSeoItem {
  type:     string;
  text?:    string;
  items?:   DataForSeoItem[];
  url?:     string;
  domain?:  string;
  title?:   string;
  rank_group?: number;
}

interface DataForSeoTask {
  result?: {
    items?: DataForSeoItem[];
  }[];
}

interface DataForSeoResponse {
  tasks?: DataForSeoTask[];
}

export async function checkAiOverview(query: string): Promise<AiOverviewResult> {
  const login    = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    throw new Error("DataForSEO credentials not configured — set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD");
  }

  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{
      keyword:       query,
      location_code: 2840,
      language_code: "en",
      device:        "desktop",
      os:            "windows",
      depth:         10,
    }]),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DataForSEO ${res.status}: ${text.slice(0, 300)}`);
  }

  const json: DataForSeoResponse = await res.json();
  const items: DataForSeoItem[]  = json.tasks?.[0]?.result?.[0]?.items ?? [];

  const aiOverviewItem = items.find(i => i.type === "ai_overview");
  const hasOverview    = !!aiOverviewItem;

  const citedItems: AiOverviewCitedItem[] = [];
  if (aiOverviewItem?.items) {
    for (const cited of aiOverviewItem.items) {
      if (cited.url && cited.domain) {
        citedItems.push({
          url:    cited.url,
          domain: cited.domain,
          title:  cited.title ?? "",
        });
      }
    }
  }

  const zeniCited = citedItems.some(c => c.domain.includes("zeni"));

  const overviewText = aiOverviewItem?.text ?? null;

  const topOrganic = items
    .filter(i => i.type === "organic" && i.url && i.domain)
    .slice(0, 10)
    .map((i, idx) => ({
      position: i.rank_group ?? idx + 1,
      url:      i.url!,
      domain:   i.domain!,
      title:    i.title ?? "",
    }));

  return { hasOverview, zeniCited, overviewText, citedItems, topOrganic };
}
