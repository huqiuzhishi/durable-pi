import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

const renderer = new Renderer();
renderer.code = ({ text, lang }) => {
  const requested = lang?.split(/\s+/, 1)[0];
  const language = requested && hljs.getLanguage(requested) ? requested : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  const className =
    language === "plaintext" ? ' class="hljs"' : ` class="hljs language-${language}"`;
  return `<pre><code${className}>${highlighted}</code></pre>\n`;
};

// Transcripts re-render on every stream frame; cache rendered blocks by their source text.
const cache = new Map<string, string>();
export function markdown(text: string) {
  let html = cache.get(text);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(text, { async: false, renderer }) as string);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
    cache.set(text, html);
  }
  return html;
}
