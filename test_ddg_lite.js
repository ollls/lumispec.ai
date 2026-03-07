import { parseHTML } from 'linkedom';

const query = process.argv[2] || 'Node.js 22 release';

console.log(`Searching for: "${query}"\n`);

const res = await fetch('https://lite.duckduckgo.com/lite/', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  },
  body: new URLSearchParams({ q: query }),
});

console.log(`Status: ${res.status}`);

const html = await res.text();
const { document } = parseHTML(html);

// DDG Lite results are in a table - result links have class "result-link"
const links = document.querySelectorAll('a.result-link');
const snippets = document.querySelectorAll('.result-snippet');

const results = [];
for (let i = 0; i < links.length; i++) {
  results.push({
    title: links[i]?.textContent?.trim(),
    url: links[i]?.getAttribute('href'),
    description: snippets[i]?.textContent?.trim() || '',
  });
}

console.log(`Found ${results.length} results:\n`);
results.slice(0, 5).forEach((r, i) => {
  console.log(`${i + 1}. ${r.title}`);
  console.log(`   ${r.url}`);
  console.log(`   ${r.description}\n`);
});
