import { expect, test } from "bun:test";
import { renderMarkdown } from "../src/client/utils/markdown.ts";
import { imageMarkdown, noteImageInsert } from "../src/client/utils/markdown-images.ts";

test("ordinary Markdown previews only HTTPS images on explicitly allowed origins", () => {
  const origins = new Set(["https://images.example.com"]);
  const existing = '![uPic](https://images.example.com/history/photo(1).png "title")';
  expect(renderMarkdown(existing, origins)).toContain('src="https://images.example.com/history/photo(1).png"');
  expect(renderMarkdown(existing, origins)).toContain('referrerpolicy="no-referrer"');
  expect(renderMarkdown(existing)).toContain("img-placeholder");
  for (const denied of ["//images.example.com/a.png", "http://images.example.com/a.png", "https://images.example.com.evil.invalid/a.png", "https://user@images.example.com/a.png", "https://images.example.com:444/a.png", "data:image/svg+xml,abc"]) {
    expect(renderMarkdown("![untrusted](" + denied + ")", origins)).not.toContain("<img ");
  }
  expect(renderMarkdown("<img src='https://images.example.com/a.png'>", origins)).toContain("&lt;img");
  expect(renderMarkdown("    " + existing, origins)).not.toContain("<img ");
  expect(renderMarkdown("| Header |\n| --- |\n| " + existing + " |", origins)).toContain("<img ");
});

test("inserted references escape image labels and parentheses in URL destinations", () => {
  const source = imageMarkdown('label [x] "quote".png', "https://images.example.com/with(1).png?a=1&b=2");
  const html = renderMarkdown(source, new Set(["https://images.example.com"]));
  expect(html).toContain('alt="label [x] &quot;quote&quot;"');
  expect(html).toContain('src="https://images.example.com/with%281%29.png?a=1&amp;b=2"');
});

test("drops on an existing image insert a new line without splitting its Markdown", () => {
  const original = "![first](https://images.example.com/first.png)";
  const added = "![second](https://images.example.com/second.png)";
  const source = original + "\nRemaining text";
  const change = noteImageInsert({ from: 0, to: original.length }, 3, source.length, added);
  const updated = source.slice(0, change.from) + change.insert + source.slice(change.from);
  expect(updated).toBe(original + "\n" + added + "\nRemaining text");
  expect(updated.slice(change.next)).toBe("Remaining text");
});
