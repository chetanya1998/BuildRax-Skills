import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@buildrax/viewer", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@buildrax/viewer");
  });
});
