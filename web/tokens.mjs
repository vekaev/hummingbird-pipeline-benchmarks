/**
 * The shared design system for both pages.
 *
 * One module so the article and the results pack cannot drift apart typographically. The
 * light palette is defined on bare `:root`; only the tokens that change are redefined for
 * dark, once under a prefers-color-scheme guard that a `[data-theme="light"]` opt-out can
 * beat, and once under an explicit `[data-theme="dark"]`. A colour defined only inside a
 * media query is a colour that vanishes in the other theme.
 */

/** Figures are authored with literal hex; the page needs them to follow the theme. */
export const FIGURE_COLOURS = {
  '#141920': 'var(--fig-ink)',
  '#5f6b79': 'var(--fig-muted)',
  '#dde2e9': 'var(--fig-rule)',
  '#a92218': 'var(--fig-before)',
  '#0a6146': 'var(--fig-after)',
  '#1f4fd8': 'var(--fig-neutral)',
  '#96450a': 'var(--fig-amber)',
  '#ffffff': 'var(--fig-knockout)',
};

export const CSS = `
:root {
  --bg:#f4f6f8; --surface:#ffffff; --sunk:#eef1f5;
  --ink:#141920; --ink-soft:#3d4753; --muted:#5f6b79;
  --rule:#dde2e9; --accent:#1f4fd8;
  --before:#a92218; --after:#0a6146; --amber:#96450a;
  --fig-ink:#141920; --fig-muted:#5f6b79; --fig-rule:#dde2e9;
  --fig-before:#a92218; --fig-after:#0a6146; --fig-neutral:#1f4fd8;
  --fig-amber:#96450a; --fig-knockout:#ffffff;
  --serif:'IBM Plex Serif',Georgia,serif;
  --sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0e1216; --surface:#161b21; --sunk:#1b2128;
    --ink:#e8ecf1; --ink-soft:#b6bfca; --muted:#8b96a3;
    --rule:#2a323b; --accent:#7ba2ff;
    --before:#f08b80; --after:#5fc79f; --amber:#e0a970;
    --fig-ink:#e8ecf1; --fig-muted:#8b96a3; --fig-rule:#2a323b;
    --fig-before:#f08b80; --fig-after:#5fc79f; --fig-neutral:#7ba2ff;
    --fig-amber:#e0a970; --fig-knockout:#161b21;
    color-scheme:dark;
  }
}
:root[data-theme="dark"] {
  --bg:#0e1216; --surface:#161b21; --sunk:#1b2128;
  --ink:#e8ecf1; --ink-soft:#b6bfca; --muted:#8b96a3;
  --rule:#2a323b; --accent:#7ba2ff;
  --before:#f08b80; --after:#5fc79f; --amber:#e0a970;
  --fig-ink:#e8ecf1; --fig-muted:#8b96a3; --fig-rule:#2a323b;
  --fig-before:#f08b80; --fig-after:#5fc79f; --fig-neutral:#7ba2ff;
  --fig-amber:#e0a970; --fig-knockout:#161b21;
  color-scheme:dark;
}

*,*::before,*::after { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body {
  margin:0; background:var(--bg); color:var(--ink);
  font-family:var(--sans); font-size:16px; line-height:1.62;
  -webkit-font-smoothing:antialiased;
}
.shell { max-width:1180px; margin:0 auto; padding:0 28px; }
.cols { display:grid; grid-template-columns:242px minmax(0,1fr); gap:44px; align-items:start; }
@media (max-width:940px) { .cols { grid-template-columns:1fr; gap:0; } .rail { position:static; padding-top:0; } }

h1 { font-family:var(--serif); font-weight:600; font-size:40px; line-height:1.14; margin:0 0 18px; letter-spacing:-0.015em; text-wrap:balance; }
h2 { font-family:var(--serif); font-weight:600; font-size:25px; line-height:1.24; margin:0 0 14px; text-wrap:balance; }
h3 { font-family:var(--sans); font-weight:620; font-size:16.5px; margin:30px 0 10px; text-wrap:balance; }
p, li { max-width:68ch; color:var(--ink-soft); margin:0 0 15px; }
strong { color:var(--ink); font-weight:620; }
a { color:var(--accent); text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--accent) 32%, transparent); }
a:hover { border-bottom-color:var(--accent); }
code { font-family:var(--mono); font-size:0.885em; background:var(--sunk); padding:1px 5px; border-radius:3px; color:var(--ink); }

.masthead { padding:52px 0 34px; border-bottom:2px solid var(--ink); margin-bottom:0; }
.eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:0.1em; text-transform:uppercase; color:var(--muted); margin:0 0 16px; }
.standfirst { font-size:18.5px; line-height:1.56; color:var(--ink-soft); max-width:74ch; margin:0; }
.standfirst strong { color:var(--ink); }

.ledger { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); margin:34px 0 0; }
@media (max-width:760px) { .ledger { grid-template-columns:repeat(2,1fr); } }
.ledger div { background:var(--surface); padding:15px 17px; }
.ledger dt { font-family:var(--mono); font-size:10.5px; letter-spacing:0.07em; text-transform:uppercase; color:var(--muted); margin:0 0 7px; }
.ledger dd { margin:0; font-family:var(--mono); font-size:20px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums; letter-spacing:-0.01em; }
.ledger dd small { display:block; font-family:var(--sans); font-size:11.5px; font-weight:400; color:var(--muted); letter-spacing:0; margin-top:5px; line-height:1.45; }

.rail { position:sticky; top:26px; padding-top:56px; }
.rail h2 { font-family:var(--mono); font-size:10.5px; letter-spacing:0.09em; text-transform:uppercase; color:var(--muted); font-weight:500; margin:0 0 11px; }
.rail h2 + ul { margin-bottom:24px; }
.rail ul { list-style:none; margin:0; padding:0; }
.rail li { margin:0; max-width:none; }
.rail a { display:block; padding:4px 0; font-size:13.2px; color:var(--ink-soft); border:0; line-height:1.4; }
.rail a:hover { color:var(--accent); }
.rail .tag { font-family:var(--mono); font-size:11px; color:var(--muted); margin-right:7px; }

section { padding:44px 0 8px; }
section + section { border-top:2px solid var(--ink); }
.sec-no { font-family:var(--mono); font-size:11.5px; letter-spacing:0.09em; color:var(--muted); display:block; margin-bottom:9px; }

.claim { border-left:3px solid var(--accent); background:var(--surface); padding:16px 20px; margin:0 0 24px; }
.claim p { margin:0; max-width:70ch; color:var(--ink); font-size:16.5px; }
.claim .stat { font-family:var(--mono); font-weight:600; font-variant-numeric:tabular-nums; }
.claim .interval { display:block; font-family:var(--mono); font-size:12.5px; color:var(--muted); margin-top:8px; }

.verdict { font-family:var(--mono); font-size:13px; padding:11px 15px; background:var(--sunk); border:1px solid var(--rule); margin:0 0 18px; color:var(--ink); }
.verdict b { font-weight:600; }

.caveat { border-left:3px solid var(--amber); background:var(--surface); padding:14px 18px; margin:0 0 24px; }
.caveat .caveat-label { font-family:var(--mono); font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--amber); display:block; margin-bottom:6px; }
.caveat p { margin:0; font-size:14.6px; max-width:72ch; }
.caveat p + p { margin-top:9px; }

.figure { margin:0 0 26px; }
.figure-plate { background:var(--surface); border:1px solid var(--rule); padding:16px; overflow-x:auto; }
.figure-plate svg { display:block; min-width:620px; }
.figure figcaption { font-size:13.4px; color:var(--muted); margin-top:10px; max-width:74ch; }
.figure figcaption b { font-family:var(--mono); font-size:11.5px; color:var(--ink); margin-right:7px; }

.tw { overflow-x:auto; margin:0 0 24px; border:1px solid var(--rule); background:var(--surface); }
table { border-collapse:collapse; width:100%; font-size:13.6px; }
th, td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--rule); vertical-align:top; }
th { font-family:var(--mono); font-size:11px; letter-spacing:0.05em; text-transform:uppercase; color:var(--muted); font-weight:500; background:var(--sunk); white-space:nowrap; }
td { color:var(--ink-soft); }
td.n, th.n { text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
tbody tr:last-child td { border-bottom:0; }
table strong { color:var(--ink); }
.tw.wide th:first-child, .tw.wide td:first-child { position:sticky; left:0; background:var(--surface); z-index:1; }
.tw.wide th:first-child { background:var(--sunk); }

.two { display:grid; grid-template-columns:1fr 1fr; gap:0 1px; background:var(--rule); border:1px solid var(--rule); margin:0 0 24px; }
@media (max-width:760px) { .two { grid-template-columns:1fr; } }
.two > div { background:var(--surface); padding:16px 19px; }
.two h4 { font-family:var(--mono); font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; margin:0 0 9px; color:var(--muted); font-weight:500; }
.two p { font-size:14.4px; margin:0 0 9px; max-width:none; }
.two p:last-child { margin-bottom:0; }

footer { border-top:2px solid var(--ink); margin-top:52px; padding:26px 0 60px; }
footer p { font-size:13.4px; color:var(--muted); max-width:80ch; }
.pagelink { display:inline-block; font-family:var(--mono); font-size:12.5px; padding:9px 15px; border:1px solid var(--rule); background:var(--surface); color:var(--ink); border-bottom:1px solid var(--rule); }
.pagelink:hover { border-color:var(--accent); color:var(--accent); }
`;

export const HEAD = (title, desc) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;620&family=IBM+Plex+Serif:wght@600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>`;
