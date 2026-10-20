const fs = require('node:fs');
const path = require('node:path');

/* The dashboard page every frontend test reads, as it is on disk. */
const html = fs.readFileSync(path.join(__dirname, '../webui/index.html'), 'utf8');

/* index.html from `start` up to the first `end` after it, so a test runs or
   asserts against one named piece of the page. Throws when `start` is missing or
   occurs more than once, or when no `end` follows it: a renamed marker then fails
   the test instead of handing it the rest of the page. `end` may repeat (e.g. the
   next function); only the first one after `start` counts. */
function section(start, end) {
  const from = html.indexOf(start);
  if (from < 0) throw new Error(`section start marker not found: ${JSON.stringify(start)}`);
  const count = html.split(start).length - 1;
  if (count > 1) throw new Error(`section start marker occurs ${count} times: ${JSON.stringify(start)}`);
  const to = html.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`section end marker not found after ${JSON.stringify(start)}: ${JSON.stringify(end)}`);
  return html.slice(from, to);
}

module.exports = {html, section};
