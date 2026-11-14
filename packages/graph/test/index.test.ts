import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@buildrax/graph", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@buildrax/graph");
  });
});
