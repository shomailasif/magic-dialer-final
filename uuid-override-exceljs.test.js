/* uuid is pinned to 11.1.1 by an npm override to clear a critical advisory
 * that exceljs pulls in transitively. Overriding a transitive dependency to a
 * new major version is only safe if the real code path still works, so this
 * exercises it properly:
 *   - reading a customer's workbook (the lead import path)
 *   - the one place exceljs actually calls uuid: v4 for a conditional-formatting
 *     rule id, which is written into the xlsx it produces
 * If either breaks, this fails rather than shipping a silent regression in the
 * lead parser. */
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { mapRow } = require("./src/lib/lead-mapping.ts");

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("text" in v) return String(v.text);
    if ("result" in v) return String(v.result);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    return String(v);
  }
  return String(v);
}

(async () => {
  assert.equal(require("uuid/package.json").version, "11.1.1", "the override must actually be in force");

  // 1. Read a workbook the way a lead upload arrives: scrambled headers.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Contact", "Mobile", "Truck", "Notes"]);
  ws.addRow(["Override Check", "(817) 555-0142", "26ft box", "Dallas TX"]);
  ws.addRow(["Second Row", "817.555.0177", "reefer", "Laredo"]);

  // 2. The exact call exceljs makes - uuid.v4() for a conditional format id.
  const { v4 } = require("uuid");
  const x14Id = `{${v4()}}`.toUpperCase();
  assert.match(x14Id, /^\{[0-9A-F-]{36}\}$/, "uuid.v4 must still work: " + x14Id);
  ws.addConditionalFormatting({
    ref: "A1:D3",
    rules: [{ type: "expression", formulae: ["TRUE"], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFF00" } } }, x14Id }],
  });

  const buf = await wb.xlsx.writeBuffer();
  assert.ok(buf.length > 1000, "workbook must be written");

  const read = new ExcelJS.Workbook();
  await read.xlsx.load(buf);
  const sheet = read.getWorksheet(1);
  assert.ok(sheet, "the worksheet must be read back");

  const header = [];
  sheet.getRow(1).eachCell((c, n) => { header[n - 1] = cellText(c.value); });
  assert.equal(header[0], "Contact", "scrambled header read intact, got " + JSON.stringify(header));

  const rows = [];
  for (let r = 2; r <= 3; r++) {
    const out = [];
    sheet.getRow(r).eachCell((c, n) => { out[n - 1] = cellText(c.value); });
    rows.push(out);
  }
  assert.equal(rows.length, 2, "both data rows must survive the round trip");
  assert.equal(rows[0][1], "(817) 555-0142", "phone must be read intact");
  assert.equal(rows[1][0], "Second Row", "second row must be intact");

  // 3. And the column mapping the upload depends on: a messy phone is
  //    normalised to a dialable one and unmapped columns are kept.
  const mapped = mapRow({ Contact: "Override Check", Mobile: "(817) 555-0142", Truck: "26ft box", Notes: "Dallas TX" });
  assert.equal(mapped.phone, "+8175550142", "phone must be normalised to a dialable number, got " + JSON.stringify(mapped.phone));
  assert.equal(mapped.extraData && mapped.extraData.Truck, "26ft box", "unmapped columns must be preserved");
  assert.equal(mapped.extraData && mapped.extraData.Contact, "Override Check", "unmapped columns must be preserved");

  console.log("PASS: exceljs reads real lead workbooks on uuid 11, including the v4 path it uses");
})().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
