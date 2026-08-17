import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const adapter = new PrismaLibSql({ url: "file:./dev.db" });
const prisma  = new PrismaClient({ adapter });

const campaigns = [
  { campaignId: "21943051671", campaignName: "DC_Competitor_(Hi-Intent) | Price Extension" },
  { campaignId: "19562421503", campaignName: "KB - General NB" },
  { campaignId: "17458785284", campaignName: "CFO Services For Startups" },
  { campaignId: "18720964456", campaignName: "Display" },
  { campaignId: "21651282874", campaignName: "DC_Non-Brand_AI | Max Conv Value" },
  { campaignId: "18652527796", campaignName: "Discovery - Accounting + Bookkeeping" },
  { campaignId: "21162848836", campaignName: "*KB - Competitor (Hi-Intent) New Demo LP test" },
  { campaignId: "21782522873", campaignName: "DC_Non-Brand_AI | New Landing Page" },
  { campaignId: "21232842632", campaignName: "DC_Beta_Non-Brand_Accounting" },
  { campaignId: "21404612825", campaignName: "DC_Non-Brand_Accounting - Max Conv Value" },
  { campaignId: "20094376441", campaignName: "*KB - Remarketing Display" },
  { campaignId: "22017339791", campaignName: "DC_YouTube_Awareness_TAM_All-Startups" },
  { campaignId: "19940998778", campaignName: "*KB - RLSA" },
  { campaignId: "21233026682", campaignName: "DC_Beta_Non-Brand_Bookkeeping" },
  { campaignId: "17335262546", campaignName: "Startup Bookkeeping Experts" },
  { campaignId: "21943095105", campaignName: "S_Beta_Non-Brand_AI" },
  { campaignId: "23013863929", campaignName: "S_Non-Brand" },
  { campaignId: "18399132672", campaignName: "Accounting - Desktop Only" },
  { campaignId: "19821753087", campaignName: "DC_Competitor" },
  { campaignId: "21023748152", campaignName: "DC_Competitor_(Hi-Intent)" },
  { campaignId: "22594522054", campaignName: "Performance Max" },
  { campaignId: "21949412105", campaignName: "DC_Non-Brand_Accounting | Price Extension" },
  { campaignId: "19823782051", campaignName: "*KB - Top Keywords" },
  { campaignId: "19562421500", campaignName: "KB - AI NB" },
  { campaignId: "22106602207", campaignName: "DC_Competitors_Bench.co-Conquesting" },
  { campaignId: "18399132666", campaignName: "Brand | Exact" },
  { campaignId: "18962704520", campaignName: "Accounting - Mobile + Desktop, Audience Targeting" },
  { campaignId: "21236309719", campaignName: "DC_Non-Brand_AI" },
  { campaignId: "22230279800", campaignName: "S_Gamma_Non-Brand_AI" },
  { campaignId: "19562421497", campaignName: "S_Brand" },
  { campaignId: "21236504356", campaignName: "Competitor General" },
  { campaignId: "23750989655", campaignName: "Demand Gen" },
  { campaignId: "18399132669", campaignName: "Bookkeeping" },
  { campaignId: "19829542781", campaignName: "*KB - TOFU Display Campaign" },
  { campaignId: "21055592876", campaignName: "*KB - Top Keywords - Max Conv Value 2/27/24" },
  { campaignId: "21949394537", campaignName: "DC_Non-Brand_Bookkeeping | Price Extension" },
];

let inserted = 0;
for (const c of campaigns) {
  await prisma.campaignNameMap.upsert({
    where:  { campaignId: c.campaignId },
    create: c,
    update: { campaignName: c.campaignName },
  });
  inserted++;
}

console.log(`✓ ${inserted} campaigns imported successfully.`);
await prisma.$disconnect();
