/**
 * Reading a lead file that was scraped off the internet.
 *
 * The columns will be in whatever order the source put them in, named whatever
 * that source called them, with extra columns nobody asked for. The previous
 * mapping was an exact list - "name", "Name", "full name", "Full Name" - so a
 * perfectly good file with "Contact Person" and "Cell No" as headers imported
 * nothing, and the operator was told 0 rows imported.
 *
 * So columns are identified by meaning, not by position or spelling, and the
 * file's own values are used as evidence when the header is unhelpful. Nothing
 * is thrown away: every unrecognised column is kept, because scraped leads
 * routinely carry the one field that matters most - a listed contact, a
 * commodity, a lane, a source URL - and it is not our job to decide it is
 * worthless.
 */

export type CanonicalField =
  | "name" | "phone" | "email" | "company"
  | "website" | "address" | "city" | "state" | "zip"
  | "sourceUrl" | "dotNumber" | "description";

/** Lowercase, strip everything that is not a letter or digit, and expand the
 *  abbreviations that show up in scraped exports. */
export function normaliseHeader(h: unknown): string {
  let s = String(h ?? "").toLowerCase();
  s = s.replace(/[‘’“”]/g, "");
  s = s.replace(/[^a-z0-9]+/g, "");
  if (!s) return "";
  const expand: Array<[RegExp, string]> = [
    [/^(tel|telephone|telno|telephone|number)$/, "phone"],
    [/^(ph|phoneno|phonenum|mob|mobileno|mobilenum|cell|cellno|cellnum|contactno|contactnum|whatsapp|wechat)$/, "phone"],
    [/^(fn|firstname|givenname|forename)$/, "firstname"],
    [/^(ln|lastname|surname|familyname|family)$/, "lastname"],
    [/^(co|comp|compny|companyname|businessname|bizname|firmname|org|organisation|organization|carrier|carriername|truckingco|truckingcompany)$/, "company"],
    [/^(em|emailaddress|emailaddr|mail|contactemail|contactmail)$/, "email"],
    [/^(url|website|web|link|site|listingurl|profileurl|detailurl|sourceurl)$/, "url"],
    [/^(dot|dotno|dotnum|dotnumber|usdot|usdotno|mc|mcno|mcnum|mcnumber|uscargonumber|fmcsa)$/, "dotnumber"],
    [/^(descr|description|details|summary|notes|note|comment|comments|info|information)$/, "description"],
  ];
  for (const [re, to] of expand) if (re.test(s)) return to;
  return s;
}

/** Header meaning -> canonical field. Matched against the normalised header. */
const SYNONYMS: Array<[CanonicalField, RegExp]> = [
  ["name", /^(name|fullname|leadname|contactname|contactperson|person|personname|driver|drivername|owner|ownername|purchaser|buyer|buyercontact|lead|recipient|consignor|shipper|accountcontact|pointcontact)$/],
  ["company", /^(company|companyname|compname|business|businessname|firm|firmname|organization|organisation|org|carrier|carriername|truckingcompany|trucking|transportcompany|client|account|operator|motorcarrier|broker|brokerage|dispatcher)$/],
  ["name", /^(firstname|fn)$/],
  ["name", /^(lastname|ln|surname)$/],
  ["phone", /^(phone|phonenumber|phonenum|phoneno|phone1|phone2|mobile|mobilenumber|mobilenum|mobileno|cell|cellphone|cellnumber|cellno|telephone|tel|telno|directline|contactnumber|contactno|contactnum|whatsapp|businessphone|workphone|dayphone|anyphone|phonefull|bestphone)$/],
  ["email", /^(email|emailaddress|emailaddr|emailadress|eemail|mail|contactemail|businessemail|workemail|primaryemail)$/],
  ["company", /^(company|companyname|compname|business|businessname|firm|firmname|organization|organisation|org|carrier|carriername|truckingcompany|trucking|transportcompany|client|account)$/],
  ["website", /^(website|web|webaddress|weburl|site|homepage|url|listingurl|profileurl|detailurl|sourceurl|source|origin)$/],
  ["address", /^(address|addr|street|streetaddress|address1|addressline1|fulladdress|shippingaddress|businessaddress)$/],
  ["city", /^(city|town|locality|municipality)$/],
  ["state", /^(state|province|region|county)$/],
  ["zip", /^(zip|zipcode|postal|postalcode|postcode|zippostal)$/],
  ["dotNumber", /^(dot|dotno|dotnum|dotnumber|usdot|usdotno|mc|mcno|mcnum|mcnumber|uscargonumber|fmcsa|fmcsa number)$/],
  ["description", /^(description|descr|details|detail|summary|notes|note|comment|comments|info|information|services|about)$/],
];

function headerToField(header: unknown): CanonicalField | null {
  const n = normaliseHeader(header);
  if (!n) return null;
  for (const [field, re] of SYNONYMS) if (re.test(n)) return field;
  return null;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;

/**
 * Turn any way a person or a scraper can write a phone number into a dialable
 * one. All of these are the same number:
 *
 *   1234567890              (123) 456-7890        123.456.7890
 *   1-800-555-0199          +1 (800) 555-0199     001-800-555-0199
 *   923001234567           +92 300 1234567      0092-300-1234567
 *   555-0199 x22            (555) 0199 ext. 22   5550199;22
 *   Call: 555-0199          Phone - 555 0199
 *
 * Returns null when there is no usable number in the value at all, rather than
 * handing a scraper a postcode, a year or an order id to dial.
 */
export function parsePhone(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Trailing annotations people add: "(mobile)", " ext", " office".
  const withoutExt = s
    .replace(/\b(?:ext|extn|x|extension|ex)\.?\s*\d+\s*$/i, "")
    .replace(/[;,]\s*\d{1,6}\s*$/, "")
    // A trailing word with no digits in it is a label, not part of the number.
    .replace(/[\s,;]*\(?\s*[A-Za-z]{3,14}\s*\)?\s*$/, "")
    .trim();

  // Keep digits and a leading international marker only. Letters and symbols
  // people use as separators (spaces, dashes, dots, slashes, brackets) go.
  // A leading word is a label, not part of the number: "Call:", "Phone -",
  // "Tel". Anything else textual means this is not a phone number at all -
  // "Order #1234567890" and "USD 1,250,000" are ten digits too, and dialling
  // either would be worse than skipping the row.
  const body = withoutExt
    .replace(/^\s*[A-Za-z][A-Za-z.\s]{0,14}[:\-–]\s*/, "")
    .replace(/^\s*[A-Za-z][A-Za-z.\s]{0,14}\s+(?=\+?\d)/, "")
    .trim();
  if (!/^\+?[\d\s().+\-\/]+$/.test(body)) return null;

  const hasPlus = /^\s*\+/.test(body) || /\+\s*\d/.test(body);
  const internationalPrefix = /^[\s(]*(?:00|011)[\s.-]*/.test(body) && !/^\s*\+/.test(body);
  let digits = body.replace(/[^\d]/g, "");

  if (!digits) return null;
  if (internationalPrefix) {
    const cut = withoutExt.match(/^[\s(]*(?:00|011)[\s.-]*/)![0].replace(/\D/g, "").length;
    digits = digits.slice(cut);
  }

  /* A leading 1 is kept, not stripped. It was tempting to treat it as a NANP
   * country code, but 1-800-555-0199 is a real toll-free number and stripping
   * the 1 turns it into +800..., which is not a dialable number at all.
   * Ambiguity that corrupts a number is worse than ambiguity that leaves it. */
  if (digits.length < 7 || digits.length > 15) return null;

  // 7 or 8 digits with no separator at all is far more often a year, a postcode
  // or a reference than a phone number.
  if (digits.length <= 8 && !/[\s().+\-\/]/.test(body) && !hasPlus && !internationalPrefix) return null;

  return `+${digits}`;
}

/** Digits only, for suppression-list matching. */
export function phoneDigits(phone: unknown): string {
  return String(phone ?? "").replace(/\D/g, "");
}

function looksLikePhone(v: string): boolean {
  return parsePhone(v) !== null;
}
/** An MC/DOT number is a bare 5-8 digit string. Anything with separators is not
 *  one: "2026-09-20" is a date, and reading it as a carrier number is exactly
 *  the kind of plausible-looking wrong answer that must not happen. */
function looksLikeDot(v: string): boolean {
  return /^\d{5,8}$/.test(v.trim());
}

export interface MappedRow {
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  dotNumber?: string;
  description?: string;
  website?: string;
  extraData?: Record<string, unknown>;
}

export interface MapOptions {
  /** Caller-supplied field names, so a customer's own configuration wins. */
  preferredFields?: string[];
}

/**
 * Map one row onto the fields we store, using headers first and then the values
 * themselves. Every column that is not claimed is preserved in extraData, so
 * nothing the scrape found is thrown away.
 */
export function mapRow(raw: Record<string, unknown>, options: MapOptions = {}): MappedRow {
  const out: MappedRow = {};
  const extra: Record<string, unknown> = {};
  const taken = new Set<string>();

  const claim = (field: CanonicalField, value: string) => {
    const bag = out as Record<string, string | undefined>;
    if (bag[field]) return false;
    if (!value) return false;
    // A claimed phone is normalised on the way in, so "(555) 0199 x22" is
    // stored dialable rather than as the raw scraped text.
    const v = field === "phone" ? parsePhone(value) : value;
    if (!v) return false;
    bag[field] = v;
    return true;
  };

  // Pass 1: the customer's own field names, then header synonyms.
  for (const key of Object.keys(raw)) {
    const value = String(raw[key] ?? "").trim();
    if (!value) continue;
    const wanted = (options.preferredFields || []).find((f) => normaliseHeader(f) === normaliseHeader(key));
    if (wanted) {
      const field = headerToField(wanted);
      if (field && claim(field, value)) { taken.add(key); continue; }
    }
    const field = headerToField(key);
    if (field && claim(field, value)) taken.add(key);
  }

  // Pass 2: unclaimed columns, judged by what they contain. A scraped file
  // regularly has a blank or oddly named phone column, but the values are
  // unmistakable.
  for (const key of Object.keys(raw)) {
    if (taken.has(key)) continue;
    const value = String(raw[key] ?? "").trim();
    if (!value) continue;
    if (!out.phone && looksLikePhone(value) && claim("phone", value)) { taken.add(key); continue; }
    if (!out.email && EMAIL_RE.test(value) && claim("email", value)) { taken.add(key); continue; }
    if (!out.dotNumber && looksLikeDot(value) && claim("dotNumber", value)) { taken.add(key); continue; }
    if (!out.website && URL_RE.test(value) && claim("website", value)) { taken.add(key); continue; }
  }

  // Pass 3: whatever is left belongs to whoever is buying. First name and last
  // name are joined if no single name column existed.
  for (const key of Object.keys(raw)) {
    if (taken.has(key)) continue;
    const value = String(raw[key] ?? "").trim();
    if (!value) continue;
    const n = normaliseHeader(key);
    if (!out.name && (n === "firstname" || n === "fn")) {
      const ln = String(raw[Object.keys(raw).find((k) => ["lastname", "ln", "surname"].includes(normaliseHeader(k))) as string] ?? "").trim();
      if (claim("name", [value, ln].filter(Boolean).join(" "))) taken.add(key);
      continue;
    }
    if (!out.name && (n === "lastname" || n === "ln" || n === "surname")) continue; // joined above
    extra[key] = value;
  }

  // A name can also be inferred: a first and a last name sitting in two columns
  // under names we did not recognise.
  if (!out.name) {
    const first = String(raw[Object.keys(raw).find((k) => normaliseHeader(k) === "firstname") as string] ?? "").trim();
    const last = String(raw[Object.keys(raw).find((k) => normaliseHeader(k) === "lastname") as string] ?? "").trim();
    if (first || last) out.name = [first, last].filter(Boolean).join(" ");
  }

  if (Object.keys(extra).length) out.extraData = extra;
  return out;
}

/** Column names in the file, in the file's own order - for reporting. */
export function describeColumns(raw: Record<string, unknown>): Array<{ column: string; mappedTo: string | null }> {
  return Object.keys(raw).map((column) => ({ column, mappedTo: headerToField(column) }));
}
