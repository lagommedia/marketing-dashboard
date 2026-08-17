import { NextResponse } from "next/server";
import { fetchSheetRange } from "@/lib/integrations/google-sheets";

export const dynamic = "force-dynamic";

const SHEET       = "'Reference Sheet (DO NOT TOUCH)'";
const GROSS_LABEL = "Marketing Gross Costs";
const CHURN_ROW   = 65;
const ARPU_ROW    = 69;
const MARGIN_ROW  = 97;

export async function GET() {
  try {
    // 1. Header row + full label column B
    const [headerRows, labelCol] = await Promise.all([
      fetchSheetRange(`${SHEET}!2:2`),
      fetchSheetRange(`${SHEET}!B:B`),
    ]);
    const headerRow = headerRows[0] ?? [];

    // 2. Find the Marketing Gross Costs row
    let grossRowIdx = -1;
    for (let i = 0; i < labelCol.length; i++) {
      if ((labelCol[i][0] ?? "").trim() === GROSS_LABEL) { grossRowIdx = i; break; }
    }

    // 3. Collect 10 rows of context around the found row (±5 rows)
    const contextRows: Array<{ sheetRow: number; label: string }> = [];
    if (grossRowIdx !== -1) {
      const start = Math.max(0, grossRowIdx - 5);
      const end   = Math.min(labelCol.length - 1, grossRowIdx + 5);
      for (let i = start; i <= end; i++) {
        contextRows.push({ sheetRow: i + 1, label: labelCol[i][0] ?? "" });
      }
    }

    // 4. Fetch the actual data rows we're currently reading
    type DataRows = {
      grossCosts:      { sheetRow: number; label: string; sampleValues: string[] };
      sharedAllocation:{ sheetRow: number; label: string; sampleValues: string[] };
      churnRate:       { sheetRow: number; label: string; sampleValues: string[] };
      arpu:            { sheetRow: number; label: string; sampleValues: string[] };
      grossMargin:     { sheetRow: number; label: string; sampleValues: string[] };
    };

    let dataRows: DataRows | null = null;

    if (grossRowIdx !== -1) {
      const [grossData, sharedData, arpuData, marginData, churnData] = await Promise.all([
        fetchSheetRange(`${SHEET}!${grossRowIdx + 1}:${grossRowIdx + 1}`).then(r => r[0] ?? []),
        fetchSheetRange(`${SHEET}!${grossRowIdx + 2}:${grossRowIdx + 2}`).then(r => r[0] ?? []),
        fetchSheetRange(`${SHEET}!${ARPU_ROW}:${ARPU_ROW}`).then(r => r[0] ?? []),
        fetchSheetRange(`${SHEET}!${MARGIN_ROW}:${MARGIN_ROW}`).then(r => r[0] ?? []),
        fetchSheetRange(`${SHEET}!${CHURN_ROW}:${CHURN_ROW}`).then(r => r[0] ?? []),
      ]);

      // Get label for hardcoded rows from column B
      const churnLabel  = (labelCol[CHURN_ROW  - 1]?.[0] ?? "").trim();
      const arpuLabel   = (labelCol[ARPU_ROW   - 1]?.[0] ?? "").trim();
      const marginLabel = (labelCol[MARGIN_ROW - 1]?.[0] ?? "").trim();
      const sharedLabel = (labelCol[grossRowIdx + 1]?.[0] ?? "").trim();

      // Find first 6 month columns for a sample
      const MONTH_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/i;
      const monthIndices: number[] = [];
      for (let i = 0; i < headerRow.length && monthIndices.length < 6; i++) {
        if (MONTH_RE.test(String(headerRow[i] ?? "").trim())) monthIndices.push(i);
      }
      const sample = (row: string[]) =>
        monthIndices.map(i => `${String(headerRow[i]).trim()}: ${row[i] ?? "(empty)"}`);

      dataRows = {
        grossCosts:       { sheetRow: grossRowIdx + 1,    label: GROSS_LABEL,  sampleValues: sample(grossData)  },
        sharedAllocation: { sheetRow: grossRowIdx + 2,    label: sharedLabel,  sampleValues: sample(sharedData) },
        churnRate:        { sheetRow: CHURN_ROW,          label: churnLabel,   sampleValues: sample(churnData)  },
        arpu:             { sheetRow: ARPU_ROW,           label: arpuLabel,    sampleValues: sample(arpuData)   },
        grossMargin:      { sheetRow: MARGIN_ROW,         label: marginLabel,  sampleValues: sample(marginData) },
      };
    }

    // 5. Pull live Q3 2026 values for Jul / Aug / Sep
    let q3Live: Record<string, { grossCosts: number | string; sharedAllocation: number | string; total: number | string }> | null = null;

    if (grossRowIdx !== -1) {
      const [grossData, sharedData] = await Promise.all([
        fetchSheetRange(`${SHEET}!${grossRowIdx + 1}:${grossRowIdx + 1}`).then(r => r[0] ?? []),
        fetchSheetRange(`${SHEET}!${grossRowIdx + 2}:${grossRowIdx + 2}`).then(r => r[0] ?? []),
      ]);

      const targets: Record<string, boolean> = { "jul 2026": true, "aug 2026": true, "sep 2026": true };
      q3Live = {};
      for (let i = 0; i < headerRow.length; i++) {
        const key = String(headerRow[i] ?? "").trim().toLowerCase();
        if (targets[key]) {
          const gross  = parseFloat(String(grossData[i]  ?? "0").replace(/[$,]/g, "")) || 0;
          const shared = parseFloat(String(sharedData[i] ?? "0").replace(/[$,]/g, "")) || 0;
          q3Live[String(headerRow[i]).trim()] = {
            grossCosts:       gross,
            sharedAllocation: shared,
            total:            gross + shared,
          };
        }
      }
    }

    const q3Total = q3Live
      ? Object.values(q3Live).reduce((s, r) => s + (typeof r.total === "number" ? r.total : 0), 0)
      : null;

    return NextResponse.json({
      grossCostsRowFound: grossRowIdx !== -1,
      grossCostsFoundAtSheetRow: grossRowIdx !== -1 ? grossRowIdx + 1 : null,
      hardcodedRows: { churn: CHURN_ROW, arpu: ARPU_ROW, grossMargin: MARGIN_ROW },
      contextAroundGrossCosts: contextRows,
      rowsBeingRead: dataRows,
      q3_2026_live: {
        note: "Live values read directly from the sheet right now",
        byMonth: q3Live,
        quarterTotal: q3Total,
        cachedTotal: 1362787.21,
        discrepancy: q3Total != null ? q3Total - 1362787.21 : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
