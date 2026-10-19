/** Decode canonical Base64 without a repeating regular expression on large values. */
export function decodeCanonicalBase64(value: string): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0) throw new TypeError("invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError("invalid base64");
  return decoded;
}
