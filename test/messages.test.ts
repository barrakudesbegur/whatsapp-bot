/**
 * validateOutMessage limit enforcement + outbound payload builder shape.
 */

import { describe, it, expect } from "vitest";
import {
  validateOutMessage,
  LIMITS,
  type OutMessage,
} from "../src/messages.ts";
import { toOutboundPayload } from "../src/wa/wire.ts";

describe("validateOutMessage", () => {
  it("passes a valid text / buttons / list", () => {
    const ok: OutMessage[] = [
      { kind: "text", body: "hola" },
      { kind: "buttons", body: "?", buttons: [{ id: "a", title: "A" }] },
      {
        kind: "list",
        body: "?",
        button: "Tria",
        rows: [{ id: "r1", title: "Row 1" }],
      },
    ];
    for (const m of ok) expect(validateOutMessage(m)).toEqual([]);
  });

  it("flags >3 buttons and long button titles", () => {
    const msg: OutMessage = {
      kind: "buttons",
      body: "?",
      buttons: [
        { id: "1", title: "x".repeat(LIMITS.BUTTON_TITLE_MAX + 1) },
        { id: "2", title: "b" },
        { id: "3", title: "c" },
        { id: "4", title: "d" },
      ],
    };
    const errs = validateOutMessage(msg);
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it("flags >10 rows, long row titles and duplicate ids", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: "dup",
      title: "r",
    }));
    rows[0]!.title = "x".repeat(LIMITS.ROW_TITLE_MAX + 1);
    const msg: OutMessage = { kind: "list", body: "?", button: "Tria", rows };
    const errs = validateOutMessage(msg);
    expect(errs.some((e) => e.includes("rows count"))).toBe(true);
    expect(errs.some((e) => e.includes("row title"))).toBe(true);
    expect(errs.some((e) => e.includes("duplicate row id"))).toBe(true);
  });

  it("flags empty text", () => {
    expect(validateOutMessage({ kind: "text", body: "" })).not.toEqual([]);
  });
});

describe("toOutboundPayload", () => {
  it("builds a text payload", () => {
    expect(
      toOutboundPayload("34600", { kind: "text", body: "hi" }),
    ).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34600",
      type: "text",
      text: { body: "hi" },
    });
  });

  it("builds an interactive button payload", () => {
    const p = toOutboundPayload("34600", {
      kind: "buttons",
      body: "?",
      buttons: [{ id: "grup", title: "Grup" }],
    });
    expect(p.type).toBe("interactive");
    expect(p.interactive).toMatchObject({
      type: "button",
      body: { text: "?" },
      action: {
        buttons: [{ type: "reply", reply: { id: "grup", title: "Grup" } }],
      },
    });
  });

  it("builds an interactive list payload with one section", () => {
    const p = toOutboundPayload("34600", {
      kind: "list",
      body: "?",
      button: "Tria",
      rows: [{ id: "a", title: "A" }],
    });
    expect(p.interactive).toMatchObject({
      type: "list",
      action: {
        button: "Tria",
        sections: [{ rows: [{ id: "a", title: "A" }] }],
      },
    });
  });
});
