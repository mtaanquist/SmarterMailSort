import { describe, expect, it } from "vitest";
import { buildSummary, type RawHeader, type RawPart } from "../src/core/messageSummary.js";

const header: RawHeader = {
  id: 7,
  author: "News <news@example.com>",
  recipients: ["me@example.com"],
  ccList: [],
  subject: "Weekly digest",
  date: new Date("2026-01-02T03:04:05Z"),
};

describe("buildSummary", () => {
  it("prefers a text/plain body and truncates to maxBodyChars", () => {
    const full: RawPart = {
      contentType: "multipart/alternative",
      parts: [
        { contentType: "text/html", body: "<p>hello html</p>" },
        { contentType: "text/plain", body: "hello plain body that is long" },
      ],
    };
    const summary = buildSummary(header, full, 11);
    expect(summary.bodyExcerpt).toBe("hello plain");
    expect(summary.subject).toBe("Weekly digest");
    expect(summary.date).toBe("2026-01-02T03:04:05.000Z");
  });

  it("falls back to stripped HTML when no plain part exists", () => {
    const full: RawPart = {
      contentType: "text/html",
      body: "<style>x{}</style><p>Hi&nbsp;there</p>",
    };
    const summary = buildSummary(header, full, 100);
    expect(summary.bodyExcerpt).toBe("Hi there");
  });

  it("picks interesting headers and ignores the rest", () => {
    const full: RawPart = {
      contentType: "text/plain",
      body: "body",
      headers: {
        "list-id": ["<promo.example.com>"],
        "x-mailer": ["Mailchimp"],
        "x-random": ["ignored"],
      },
    };
    const summary = buildSummary(header, full, 100);
    expect(summary.headers["list-id"]).toBe("<promo.example.com>");
    expect(summary.headers["x-mailer"]).toBe("Mailchimp");
    expect(summary.headers["x-random"]).toBeUndefined();
  });

  it("tolerates missing body and fields", () => {
    const summary = buildSummary({ id: 1 }, undefined, 100);
    expect(summary.bodyExcerpt).toBe("");
    expect(summary.author).toBe("");
    expect(summary.recipients).toEqual([]);
  });
});
