import { renderWikiHtml } from "../../frontend/src/lib/wiki-markdown";

describe("renderWikiHtml link safety", () => {
  it("allows ordinary HTTPS links", () => {
    expect(renderWikiHtml("[docs](https://example.com/docs)", [])).toContain(
      'href="https://example.com/docs"',
    );
  });

  it.each(["javascript:alert(1)", "data:text/html,boom", "//evil.example/path"])(
    "neutralizes an unsafe link target: %s",
    (href) => {
      const html = renderWikiHtml(`[unsafe](${href})`, []);
      expect(html).toContain('href="#"');
      expect(html).not.toContain(`href="${href}"`);
    },
  );
});
