import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@buildrax/ingest", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@buildrax/ingest");
  });
});
