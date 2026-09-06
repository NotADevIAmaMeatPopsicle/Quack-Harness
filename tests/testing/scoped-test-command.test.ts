import { buildScopedTestCommand } from "../../src/testing/scoped-test-command";

describe("buildScopedTestCommand", () => {
  it("maps single frontend test scope to that frontend package", () => {
    expect(
      buildScopedTestCommand("bash .quack/verify-web-dashboard.sh test", [
        "frontends/web-dashboard/src/components/inventory/ProductCard.test.jsx",
      ]),
    ).toBe(
      'npm --prefix frontends/web-dashboard test -- "src/components/inventory/ProductCard.test.jsx"',
    );
  });

  it("maps backend src tests to the backend package", () => {
    expect(
      buildScopedTestCommand("npm test", ["src/tests/unit/routes/waitlist.routes.test.js"]),
    ).toBe('npm --prefix src test -- "tests/unit/routes/waitlist.routes.test.js"');
  });

  it("falls back to appending paths for mixed scopes", () => {
    expect(
      buildScopedTestCommand("npm test", [
        "src/tests/unit/routes/waitlist.routes.test.js",
        "frontends/web-dashboard/src/components/inventory/ProductCard.test.jsx",
      ]),
    ).toBe(
      'npm test -- "src/tests/unit/routes/waitlist.routes.test.js" "frontends/web-dashboard/src/components/inventory/ProductCard.test.jsx"',
    );
  });
});
