import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const ROOT = process.cwd();

console.log('Running design token policy checks...');

let hasErrors = false;

function error(msg) {
  console.error(`❌ [check-design-tokens] ${msg}`);
  hasErrors = true;
}

function success(msg) {
  console.log(`✅ [check-design-tokens] ${msg}`);
}

const WEB_SOURCE_ROOTS = ['apps/web/src', 'packages/ui/src'];
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.tsx', '.jsx', '.ts', '.js']);

function findWebFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === '.turbo'
      ) {
        continue;
      }
      results.push(...findWebFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (STYLE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const webFiles = [];
for (const subDir of WEB_SOURCE_ROOTS) {
  const fullSubDir = resolve(ROOT, subDir);
  webFiles.push(...findWebFiles(fullSubDir));
}

if (webFiles.length === 0) {
  success('No Web style/source files found during Phase 2 (clean skip).');
  process.exit(0);
}

console.log(`Scanning ${webFiles.length} Web files for design token hierarchy violations...`);

// Raw color literals (only allowed in primitive token definitions)
const rawHexPattern = /#[0-9a-fA-F]{3,8}\b/;
const rawColorFunctionPattern =
  /\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i;

// Standard CSS named colors (prohibited outside primitive token definitions; transparent and currentColor are approved keywords)
const CSS_NAMED_COLORS = [
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
];

const CSS_NAMED_COLOR_SOURCE = CSS_NAMED_COLORS.join('|');

const namedColorsPattern = new RegExp(
  `(?<![a-zA-Z0-9_-])(${CSS_NAMED_COLOR_SOURCE})(?![a-zA-Z0-9_-])`,
  'i',
);

const jsxNamedColorAttributePattern = new RegExp(
  `\\b(?:color|fill|stroke|[a-zA-Z][a-zA-Z0-9_-]*(?:color|colour))\\s*=\\s*(?:"(${CSS_NAMED_COLOR_SOURCE})"|'(${CSS_NAMED_COLOR_SOURCE})'|\\{\\s*"(${CSS_NAMED_COLOR_SOURCE})"\\s*\\}|\\{\\s*'(${CSS_NAMED_COLOR_SOURCE})'\\s*\\}|\\{\\s*\`(${CSS_NAMED_COLOR_SOURCE})\`\\s*\\})`,
  'i',
);

function checkNamedColor(line) {
  const cleaned = line
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '')
    .trim();
  if (!cleaned) return null;

  const jsxAttributeMatch = cleaned.match(jsxNamedColorAttributePattern);
  if (jsxAttributeMatch) {
    return jsxAttributeMatch.slice(1).find(Boolean) ?? null;
  }

  const colonIdx = cleaned.indexOf(':');
  if (colonIdx !== -1) {
    let valuePart = cleaned.slice(colonIdx + 1);
    valuePart = valuePart.replace(/var\([^)]*\)/g, '');
    const match = valuePart.match(namedColorsPattern);
    if (match) return match[1];
  }
  return null;
}

// Direct primitive token patterns (Tier 1 tokens that semantic tokens may consume, but component/feature UI must not)
const directPrimitiveTokenPatterns = [
  /--primitive-[a-zA-Z0-9_-]+/,
  /--color-(gray|red|blue|green|slate|zinc|amber|purple|emerald|cyan|violet|neutral|yellow|orange|rose)-\d+/,
  /--space-\d+/,
  /--radius-(none|xs|sm|md|lg|xl|2xl|3xl|full)/,
  /--font-size-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)/,
  /--shadow-(none|sm|md|lg|xl|2xl)/,
  /--z-index-(hide|base|dropdown|sticky|modal|popover|toast)/,
];

for (const filePath of webFiles) {
  const relPath = filePath.replace(ROOT + '/', '');

  const isPrimitiveTokenDefinition =
    relPath.includes('tokens/primitive') ||
    relPath.includes('theme/primitive') ||
    relPath.includes('primitives.css');

  const isSemanticTokenDefinition =
    relPath.includes('tokens/semantic') ||
    relPath.includes('theme/semantic') ||
    relPath.includes('semantic.css');

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    // 1. Raw colors are prohibited outside Tier 1 primitive token definitions
    if (!isPrimitiveTokenDefinition) {
      if (rawHexPattern.test(line)) {
        error(
          `${relPath}:${idx + 1} uses hardcoded hex color outside primitive token definition: "${line.trim()}"`,
        );
      }
      if (rawColorFunctionPattern.test(line)) {
        error(
          `${relPath}:${idx + 1} uses hardcoded CSS color function outside primitive token definition: "${line.trim()}"`,
        );
      }
      const namedColorMatch = checkNamedColor(line);
      if (namedColorMatch) {
        error(
          `${relPath}:${idx + 1} uses hardcoded named color "${namedColorMatch}" outside primitive token definition: "${line.trim()}"`,
        );
      }
    }

    // 2. Direct primitive token consumption is prohibited in component and feature UI (only semantic tokens may consume primitives)
    if (!isPrimitiveTokenDefinition && !isSemanticTokenDefinition) {
      for (const pattern of directPrimitiveTokenPatterns) {
        if (pattern.test(line)) {
          error(
            `${relPath}:${idx + 1} directly consumes primitive token instead of semantic token: "${line.trim()}"`,
          );
          break;
        }
      }
    }
  });
}

if (!hasErrors) {
  success(`Three-tier design token hierarchy validated across ${webFiles.length} files.`);
}

if (hasErrors) {
  console.error('\ncheck-design-tokens failed with errors.');
  process.exit(1);
} else {
  console.log('\ncheck-design-tokens passed successfully.');
}
