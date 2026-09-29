import Papa from "papaparse";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { mapRow } from "@/lib/lead-mapping";
import { normalizePhoneForSuppression } from "@/lib/call-compliance";

export interface ImportRowError {
  row: number;
  reason: string;
}

export interface ImportResult {
  imported: number;
  failed: number;
  errors: ImportRowError[];
}

/**
 * Parse a CSV or Excel (xlsx/xls) buffer into lead records.
 * Malformed rows (no usable phone) are reported and skipped while valid
 * rows are imported (see requirement 5 edge case #1).
 */
/** What the file actually is, from its magic bytes. */
function sniffFormat(buffer: Buffer): "xlsx" | "xls" | "csv" {
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03) return "xlsx";
  if (buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return "xls";
  return "csv";
}

/** Excel writes UTF-16 CSVs in some locales. Read those as UTF-16 or every
 *  name comes through as mojibake and nothing matches. */
function decodeCsv(buffer: Buffer): string {
  if (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  if (buffer.length > 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

const HEADER_HINTS = [
  { key: "name", re: /^(?:lead|contact|full|company|person)?[\s_-]*name$/i },
  { key: "phone", re: /^(?:phone|mobile|cell|tel|contact)[\s_-]*(?:no|num|number)?$/i },
  { key: "email", re: /e-?mail/i },
  { key: "company", re: /^(?:comp(?:any)?|biz(?:iness)?)[\s_-]*name$/i },
];

/** The header row is the first row that actually looks like headers. Sheets
 *  routinely have a title, a date or a blank line above the real header, and
 *  assuming row 1 is the header loses every column name - so every row then
 *  fails as "missing name/phone/email" and the import reports 0 with no clue. */
function headerRowIndex(sheet: ExcelJS.Worksheet): number {
  const limit = Math.min(sheet.rowCount || 1, 15);
  for (let r = 1; r <= limit; r++) {
    const values = (sheet.getRow(r).values as unknown[]) || [];
    const filled = values.filter((v) => String(v ?? "").trim() !== "").length;
    const matched = values.filter((v) =>
      HEADER_HINTS.some((h) => h.re.test(String(v ?? "").trim())),
    ).length;
    if (filled >= 2 && matched >= 1) return r;
  }
  return 1;
}

function rowsFromSheet(sheet: ExcelJS.Worksheet): Record<string, unknown>[] {
  const headerRow = headerRowIndex(sheet);
  const headers = (sheet.getRow(headerRow).values as unknown[]) || [];
  const out: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const record: Record<string, unknown> = {};
    let any = false;
    row.eachCell((cell, colNumber) => {
      const text = String(cell.text ?? "").trim();
      if (!text) return;
      const header = String(headers[colNumber] ?? "").trim();
      if (header) { record[header] = text; any = true; }
    });
    if (any) out.push(record);
  });
  return out;
}

export async function parseAndImportLeads(
  userId: string,
  fileName: string,
  buffer: Buffer,
): Promise<ImportResult> {
  const lower = fileName.toLowerCase();
  let rows: Record<string, unknown>[] = [];

  /* Trust the bytes, not the file name. Real uploads arrive as a CSV saved with
   * an .xlsx name, as a UTF-16 CSV that Excel writes by default in some locales,
   * and as a genuine legacy .xls that this parser cannot read at all. Each of
   * those used to fail with a raw parser exception, or silently import nothing. */
  const kind = sniffFormat(buffer);

  if (kind === "xls") {
    throw new Error(
      "That is an older .xls file, which cannot be read here. Open it in Excel or Google Sheets and use \"Save as\" to save it as .xlsx, or save it as .csv, then upload again.",
    );
  }

  if (kind === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(Buffer.from(buffer) as unknown as ExcelJS.Buffer);
    } catch {
      throw new Error(
        "That file looks like an Excel file but could not be opened. It may be an old .xls, or a .csv that was renamed - save it as .xlsx or .csv and try again.",
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Excel file contains no worksheets.");
    rows = rowsFromSheet(sheet);
    if (!rows.length && !sheet.rowCount) {
      throw new Error("That spreadsheet is empty.");
    }
  } else {
    // CSV, whether or not it is called .xlsx, and UTF-8 or UTF-16.
    rows = Papa.parse(decodeCsv(buffer), { header: true, skipEmptyLines: true })
      .data as Record<string, unknown>[];
  }

  const importRec = await prisma.leadImport.create({
    data: { userId, fileName, status: "PROCESSING", totalRows: rows.length },
  });

  const preferredFieldNames: string[] | undefined = undefined;
  const errors: ImportRowError[] = [];
  let imported = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
      /* Columns are identified by meaning, not by name or position, and a phone
       * column with a useless header is still found from its value. The old
       * exact-key list meant a scraped file whose headers were "Contact Person"
       * and "Cell No" imported nothing at all. */
      const mapped = mapRow(raw, { preferredFields: preferredFieldNames });
      const r = {
        name: mapped.name,
        phone: mapped.phone,
        email: mapped.email,
        company: mapped.company,
        // Everything the scrape carried that we did not claim, including the
        // one column nobody asked for and which may be the one that matters.
        extra: {
          ...(mapped.description ? { description: mapped.description } : {}),
          ...(mapped.dotNumber ? { mcNumber: mapped.dotNumber } : {}),
          ...(mapped.website ? { website: mapped.website } : {}),
          ...(mapped.extraData || {}),
        },
      };
      const rowNum = i + 2; // +1 header, +1 for 1-based

      if (!r.name && !r.phone && !r.email) {
        errors.push({ row: rowNum, reason: "Row is empty or missing name/phone/email." });
        continue;
      }
      if (!r.phone) {
        errors.push({ row: rowNum, reason: "No usable phone number in this row." });
        continue;
      }

      // Suppression matching keeps the canonical normaliser so existing suppression
      // lists still match; the stored value is the dialable form from parsePhone.
      const normalizedPhone=normalizePhoneForSuppression(r.phone);
    const suppression=normalizedPhone?await prisma.phoneSuppression.findUnique({where:{userId_normalizedPhone:{userId,normalizedPhone}}}):null;
    await prisma.lead.create({
      data: {
        userId,
        name: r.name || null,
        phone: r.phone,
        email: r.email || null,
        company: r.company || null,
        extraData: r.extra ? JSON.stringify(r.extra) : null,
        status: "PENDING",
        doNotCall: !!suppression,
        doNotCallAt: suppression ? suppression.createdAt : null,
        doNotCallReason: suppression ? "TENANT_PHONE_SUPPRESSION" : null,
        consentStatus: suppression ? "DENIED" : "UNKNOWN",
        consentSource: suppression ? "TENANT_PHONE_SUPPRESSION" : null,
        consentUpdatedAt: suppression ? suppression.createdAt : null,
      },
    });
    imported++;
  }

  await prisma.leadImport.update({
    where: { id: importRec.id },
    data: {
      status: "COMPLETED",
      imported,
      failed: errors.length,
      errorsJson: JSON.stringify(errors),
    },
  });

  return { imported, failed: errors.length, errors };
}

function normalizeRow(raw: Record<string, unknown>) {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        return String(v).trim();
      }
    }
    return undefined;
  };

  const name =
    pick("name", "Name", "full name", "Full Name", "contact", "contact name") ||
    `${pick("first name", "FirstName", "first") || ""} ${pick("last name", "LastName", "last") || ""}`.trim() ||
    undefined;

  const phone =
    pick("phone", "Phone", "phone number", "Phone Number", "mobile", "tel", "Telephone") ||
    pick("Phone_Number", "PHONE") ||
    undefined;

  const email = pick("email", "Email", "Email Address", "E-mail", "e-mail");

  // Capture any remaining unrecognized fields as extra data.
  const known = new Set(["name", "Name", "full name", "Full Name", "contact", "first name", "FirstName", "last name", "LastName", "phone", "Phone", "phone number", "Phone Number", "mobile", "tel", "Telephone", "Phone_Number", "PHONE", "email", "Email", "Email Address", "E-mail", "e-mail", "company", "Company", "Company Name", "company name"]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k) && v !== undefined && v !== null && String(v).trim() !== "") {
      extra[k] = String(v);
    }
  }

  return {
    name,
    phone: phone?.replace(/^["']|["']$/g, ""),
    email,
    company: pick("company", "Company", "Company Name", "company name"),
    extra: Object.keys(extra).length ? extra : undefined,
  };
}
