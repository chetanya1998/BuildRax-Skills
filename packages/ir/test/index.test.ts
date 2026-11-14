import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@buildrax/ir", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@buildrax/ir");
  });
});
