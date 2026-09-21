import Papa from "papaparse";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
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
export async function parseAndImportLeads(
  userId: string,
  fileName: string,
  buffer: Buffer,
): Promise<ImportResult> {
  const lower = fileName.toLowerCase();
  let rows: Record<string, unknown>[] = [];

  if (lower.endsWith(".csv")) {
    rows = Papa.parse(buffer.toString("utf8"), {
      header: true,
      skipEmptyLines: true,
    }).data as Record<string, unknown>[];
  } else if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls")
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(buffer) as unknown as ExcelJS.Buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Excel file contains no worksheets.");
    const headers = sheet.getRow(1).values as unknown[];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, unknown> = {};
      row.eachCell((cell, colNumber) => {
        const header = String(headers[colNumber] ?? "").trim();
        if (header) record[header] = cell.text;
      });
      rows.push(record);
    });
  } else {
    throw new Error("Unsupported file type. Please upload a CSV or Excel file.");
  }

  const importRec = await prisma.leadImport.create({
    data: { userId, fileName, status: "PROCESSING", totalRows: rows.length },
  });

  const errors: ImportRowError[] = [];
  let imported = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const r = normalizeRow(raw);
    const rowNum = i + 2; // +1 header, +1 for 1-based

    if (!r.name && !r.phone && !r.email) {
      errors.push({ row: rowNum, reason: "Row is empty or missing name/phone/email." });
      continue;
    }
    if (!r.phone) {
      errors.push({ row: rowNum, reason: "Missing phone number." });
      continue;
    }

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
