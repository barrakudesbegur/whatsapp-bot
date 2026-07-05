/**
 * X-Hub-Signature-256 verification vectors (PLAN 4.1 / 4.8). Uses real
 * WebCrypto (globalThis.crypto) — no mocks.
 */

import { describe, it, expect } from "vitest";
import { hmacSha256Hex, verifySignature } from "../src/lib/signature.ts";

const SECRET = "test-app-secret";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

describe("verifySignature", () => {
  it("accepts a correct sha256 signature over the raw body", async () => {
    const hex = await hmacSha256Hex(SECRET, BODY);
    expect(await verifySignature(SECRET, `sha256=${hex}`, BODY)).toBe(true);
  });

  it("accepts an upper-case hex signature", async () => {
    const hex = (await hmacSha256Hex(SECRET, BODY)).toUpperCase();
    expect(await verifySignature(SECRET, `sha256=${hex}`, BODY)).toBe(true);
  });

  it("rejects a signature computed over a different body (tamper)", async () => {
    const hex = await hmacSha256Hex(SECRET, BODY);
    expect(await verifySignature(SECRET, `sha256=${hex}`, BODY + " ")).toBe(
      false,
    );
  });

  it("rejects a signature under a different secret", async () => {
    const hex = await hmacSha256Hex("other-secret", BODY);
    expect(await verifySignature(SECRET, `sha256=${hex}`, BODY)).toBe(false);
  });

  it("fails closed on a missing header", async () => {
    expect(await verifySignature(SECRET, null, BODY)).toBe(false);
  });

  it("fails closed with no configured secret", async () => {
    const hex = await hmacSha256Hex(SECRET, BODY);
    expect(await verifySignature(undefined, `sha256=${hex}`, BODY)).toBe(false);
  });

  it("rejects a wrong scheme prefix", async () => {
    const hex = await hmacSha256Hex(SECRET, BODY);
    expect(await verifySignature(SECRET, `sha1=${hex}`, BODY)).toBe(false);
  });

  it("rejects a malformed header", async () => {
    expect(await verifySignature(SECRET, "garbage", BODY)).toBe(false);
    expect(await verifySignature(SECRET, "sha256=", BODY)).toBe(false);
  });
});
