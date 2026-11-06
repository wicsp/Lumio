import { describe, test, expect } from "bun:test";
import { renderMarkdown, renderInline, renderMath } from "../src/client/utils/markdown.ts";
import { richBlocks, inlineMath, tableCells } from "../src/client/utils/markdown-extra.ts";

describe("shared Markdown tables", () => {
  test("renders headers, alignment and inline markup without inline styles", () => {
    const html = renderMarkdown("| Method | Score | Formula |\n| :--- | ---: | :---: |\n| **A** | 95 | $x^2$ |\n| [[B|论文]] | 90 | `a|b` |");
    expect(html).toContain("<table>"); expect(html).toContain("<thead>");
    expect(html).toContain('<th scope="col" class="align-right">Score</th>');
    expect(html).toContain('<td class="align-left"><strong>A</strong></td>');
    expect(html).toContain('data-note="B"'); expect(html).toContain("<code>a|b</code>");
    expect(html).toContain("<msup>"); expect(html).not.toMatch(/\sstyle=/);
  });
  test("optional outer pipes, escaped pipes, missing cells and trailing prose", () => {
    const source = "A | B\n--- | ---\na\\|b | c\none |\n\nAfter";
    expect(tableCells("| a\\|b | `c|d` | [[T|alias]] | $|x|$ |")).toEqual(["a\\|b", "`c|d`", "[[T|alias]]", "$|x|$"]);
    const html = renderMarkdown(source);
    expect(html).toContain("<td>a|b</td>"); expect(html).toContain("<td>one</td><td></td>");
    expect(html).toEndWith("<p>After</p>");
    expect(renderMarkdown("A | B\n---\n1 | 2")).not.toContain("<table>");
  });
  test("HTML and unsafe URLs in cells remain inert", () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [bad](javascript:alert) |\n| [[x" onclick="evil|safe]] | ![x](https://evil.invalid/x.png) |');
    expect(html).not.toContain("<img"); expect(html).not.toContain('onclick="evil');
    expect(html).not.toContain('href="javascript:'); expect(html).toContain("&lt;img");
  });
});

describe("shared Markdown formulas", () => {
  test("inline dollar and parentheses, single-line and multiline display delimiters", () => {
    const html = renderMarkdown(String.raw`Inline $E=mc^2$ and \(\frac{a}{b}\).

$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$`);
    expect((html.match(/<math /g) ?? []).length).toBe(5);
    expect((html.match(/class="math-display"/g) ?? []).length).toBe(3);
    expect(html).toContain("<mfrac>"); expect(html).toContain("<mtable");
    expect(html).not.toContain("<script"); expect(html).not.toMatch(/\sstyle=/);
  });
  test("code, escaped dollars, currency and unfinished streaming delimiters stay literal", () => {
    for (const source of ["`$x$`", "```latex\n$x$\n$$y$$\n```", "~~~~\n| A | B |\n| --- | --- |\n$x$\n~~~~", "    $x$", String.raw`\$5 and \$10`, "$5 and $10", "$$incomplete", String.raw`\(incomplete`]) {
      const html = renderMarkdown(source);
      expect(html).not.toContain("<math"); expect(html).not.toContain("<table>");
    }
    expect(renderInline("unfinished $x")).toContain("$x");
    expect(renderInline("finished $x$")).toContain("<math");
    expect(renderInline("**$x$**")).toContain("<strong><span class=\"math-inline\"");
  });
  test("untrusted commands cannot load images, make links or inject attributes", () => {
    for (const tex of [String.raw`\href{javascript:alert(1)}{x}`, String.raw`\includegraphics{https://evil.invalid/a.png}`, String.raw`\htmlStyle{color:red}{x}`, String.raw`\htmlData{onclick=alert(1)}{x}`, String.raw`\text{<script>alert(1)</script>}`]) {
      const html = renderMarkdown(`$${tex}$`);
      expect(html).not.toContain("<script"); expect(html).not.toContain("<img");
      expect(html).not.toContain("<a "); expect(html).not.toContain('style="');
      expect(html).not.toContain('onclick="'); expect(html).not.toContain('src="https://evil');
    }
  });
  test("invalid or excessive formulas fall back to source and macro definitions do not leak", () => {
    expect(renderMarkdown(String.raw`$\notARealCommand{x}$`)).toContain(String.raw`$\notARealCommand{x}$`);
    expect(renderMarkdown("$$\\frac{1}$$")).not.toContain("<math");
    expect(renderMath("x".repeat(4097), false)).toBeUndefined();
    expect(renderMath("{".repeat(65) + "x" + "}".repeat(65), false)).toBeUndefined();
    expect(renderMath(String.raw`\def\a{\a}\a`, false)).toBeUndefined();
    renderMath(String.raw`\gdef\lumio{1}\lumio`, false);
    expect(renderMath(String.raw`\lumio`, false)).toBeUndefined();
  });
});

test("live preview ranges preserve source offsets and exclude code, table cells and link destinations", () => {
  const source = "Intro $x^2$\n\n| A | B |\n| --- | --- |\n| $y$ | 2 |\n\n$$z^2$$\n\n`$code$` [link](note$x$.md)\n    $code$";
  const blocks = richBlocks(source);
  expect(blocks.map(block => block.kind)).toEqual(["table", "math"]);
  expect(source.slice(blocks[0]!.from, blocks[0]!.to)).toBe("| A | B |\n| --- | --- |\n| $y$ | 2 |");
  expect(inlineMath(source, blocks).map(span => source.slice(span.from, span.to))).toEqual(["$x^2$"]);
  expect(richBlocks("<!--\n$$x$$\n-->\n\n```\n| A |\n| --- |\n```")).toEqual([]);
});

test("ASCII and Chinese wiki links share escaped labels and targets, including table cells", () => {
  const html = renderMarkdown("[[Target|Alias]] 【【Target|Alias】】 `【【code】】`\n\n| Link | Value |\n| --- | --- |\n| 【【Target|Alias】】 | 1 |");
  expect(html.match(/data-note="Target"/g)).toHaveLength(3);
  expect(html).toContain("<code>【【code】】</code>");
  expect(html).toContain("<td><a href=\"#\" class=\"note-link\" data-note=\"Target\">Alias</a></td>");
});
