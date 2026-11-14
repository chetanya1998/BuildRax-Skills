import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("buildrax cli", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("buildrax");
  });
});
