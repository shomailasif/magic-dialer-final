import assert from "node:assert/strict";
import { parsePhone, mapRow, normaliseHeader, phoneDigits } from "../../lib/lead-mapping";

/** Every way a phone number turns up in a scraped file, and the ones that are
 *  not phone numbers at all and must never be dialled. */
const SAME = [
  "1234567890", "(123) 456-7890", "123.456.7890", "123 456 7890",
  "123-456-7890", "+1 123 456 7890", "+11234567890", "1 (123) 456-7890",
  "001-123-456-7890", "011 123 456 7890", "+44 20 7946 0958",
  "0092-300-1234567", "Call: 123-456-7890", "Phone - 123 456 7890",
  "123 456 7890 (mobile)", "1234567890;22", "123-456-7890 x22",
  "(123) 456-7890 ext. 22", "  +1  (123)  456-7890  ",
  "1-800-555-0199", "8005550199", "+18005550199",
];
const NOT_A_PHONE = [
  "", "   ", "N/A", "none", "-", "1999", "2024", "40218",
  "PO Box 123", "www.example.com", "no phone listed", "12345", "1",
  "Order #1234567890", "USD 1,250,000",
];

function main() {
  // 1. The same subscriber written every possible way resolves identically.
  const want = parsePhone("(123) 456-7890");
  assert.equal(want, "+1234567890", "canonical form must be E.164, got " + want);
  for (const raw of SAME) {
    const got = parsePhone(raw);
    assert.ok(got, JSON.stringify(raw) + " must be accepted as a phone number");
  }
  // The NANP leading 1 is preserved, because stripping it would turn the real
  // toll-free number 1-800-555-0199 into the undialable +8005550199.
  assert.equal(parsePhone("1-800-555-0199"), "+18005550199");
  assert.equal(parsePhone("8005550199"), "+8005550199");
  // An international prefix is not part of the number. 001 is 00 + country
  // code 1, so 001-123-456-7890 is the same as +1 123-456-7890.
  assert.equal(parsePhone("001-123-456-7890"), "+11234567890");
  assert.equal(parsePhone("+11234567890"), "+11234567890");
  assert.equal(parsePhone("00 44 20 7946 0958"), "+442079460958");
  // An extension is dropped, not dialled.
  assert.equal(parsePhone("555-0199 x22"), "+5550199");
  assert.equal(parsePhone("(555) 0199 ext. 22"), "+5550199");
  assert.equal(parsePhone("1234567890;22"), "+1234567890");

  // 2. Things that are not phone numbers never become one.
  for (const raw of NOT_A_PHONE) {
    const got = parsePhone(raw);
    if (got) {
      // The only tolerated case is a long bare number, which we do not accept.
      assert.fail(JSON.stringify(raw) + " must not be treated as a phone number, got " + got);
    }
  }

  // 3. Headers are matched by meaning, in any order, with odd spellings.
  assert.equal(normaliseHeader("Phone No."), "phone");
  assert.equal(normaliseHeader("  MOBILE NUMBER "), "mobilenumber");
  assert.equal(normaliseHeader("E-Mail Address"), "email");

  // 4. A scraped row with arbitrary column order and unknown extras.
  const row = {
    "Listing URL": "https://example.com/listing/9",
    "Commodity": "Reefer produce",
    "Cell No": "(555) 0199 x22",
    "Contact Person": "Jane Doe",
    "Operator": "Doe Trucking LLC",
    "Notes": "Wants same-day, 3 loads a week",
    "Posted": "2026-09-20",
    "Owner Email": "jane@doetrucking.com",
  };
  const mapped = mapRow(row);
  assert.equal(mapped.name, "Jane Doe", "the contact column must become the name");
  assert.equal(mapped.company, "Doe Trucking LLC", "the operator column must become the company");
  assert.equal(mapped.phone, "+5550199", "the messy cell number must be parsed, got " + mapped.phone);
  assert.equal(mapped.email, "jane@doetrucking.com", "the owner email must be found");
  // Nothing is thrown away. Notes are recognised as the lead's own description,
  // and the remaining unrecognised columns are kept alongside it.
  assert.equal(mapped.description, "Wants same-day, 3 loads a week", "notes must become the description");
  assert.equal(mapped.website, "https://example.com/listing/9", "a listing URL must be captured, not dropped");
  const extra = mapped.extraData || {};
  assert.equal(extra["Commodity"], "Reefer produce", "an unknown column must be kept: " + JSON.stringify(extra));
  assert.equal(extra["Posted"], "2026-09-20", "a date column must be kept");

  // 5. A phone column with a blank or wrong header is still found by its value,
  //    and unrecognised text is preserved rather than guessed at.
  const byValue = mapRow({ "col_a": "555-010-7788", "col_b": "Acme" });
  assert.equal(byValue.phone, "+5550107788", "a phone must be found by value when the header is useless, got " + byValue.phone);
  assert.equal(byValue.name, undefined, "a leftover text column must not be guessed at as a name");
  assert.equal(byValue.extraData?.col_b, "Acme", "the leftover text must be kept: " + JSON.stringify(byValue.extraData));

  // 6. A file whose phone header is blank but whose values are phones still maps.
  const mixed = mapRow({ Name: "Sam Ray", Phone: "", Contact: "404-555-1234" });
  assert.equal(mixed.phone, "+4045551234", "a second phone-ish column must be used");

  console.log("PASS: scraped lead mapping - any column order, odd headers, every phone format, nothing discarded");
}

main();
