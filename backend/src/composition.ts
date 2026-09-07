export const OUTPUT_SIZE = { width: 1080, height: 1350 } as const;
export const MEDIA_RECT = { x: 0, y: 159, width: 1080, height: 1072 } as const;
export const BRAND_LOGO_RECT = { x: 400, y: 28, width: 288, height: 118 } as const;

export type TitlePlacement = {
  text: string;
  x: number;
  y: number;
  fontSize: number;
};

export const DEFAULT_TITLE: TitlePlacement = {
  text: "Your story starts here",
  x: 0.055,
  y: 0.165,
  fontSize: 86,
};

export function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function characterWeight(character: string) {
  return /^[\x00-\x7F]$/.test(character) ? 0.56 : 1;
}

export function wrapTitle(text: string, maxUnits = 13) {
  const output: string[] = [];

  for (const explicitLine of text.split(/\r?\n/)) {
    let line = "";
    let units = 0;

    for (const character of explicitLine) {
      const weight = characterWeight(character);
      if (line && units + weight > maxUnits) {
        output.push(line.trimEnd());
        line = character.trimStart();
        units = line ? weight : 0;
      } else {
        line += character;
        units += weight;
      }
    }

    output.push(line || " ");
  }

  return output.slice(0, 4);
}

export function createOverlaySvg(title: TitlePlacement) {
  const text = title.text.trim().slice(0, 180);
  const x = Math.round(clampNumber(title.x, 0.02, 0.92) * OUTPUT_SIZE.width);
  const y = Math.round(clampNumber(title.y, 0.13, 0.84) * OUTPUT_SIZE.height);
  const fontSize = Math.round(clampNumber(title.fontSize, 48, 132));
  const lineHeight = Math.round(fontSize * 1.03);
  const maxUnits = Math.max(7, Math.floor((OUTPUT_SIZE.width * 0.86) / fontSize));
  const lines = wrapTitle(text || " ", maxUnits);
  const textLines = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE.width}" height="${OUTPUT_SIZE.height}" viewBox="0 0 ${OUTPUT_SIZE.width} ${OUTPUT_SIZE.height}">
  <defs>
    <filter id="title-shadow" x="-20%" y="-20%" width="160%" height="180%">
      <feDropShadow dx="0" dy="7" stdDeviation="4" flood-color="#1b130f" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="1080" height="159" fill="#ffffff"/>
  <rect y="1231" width="1080" height="119" fill="#fffdf9"/>
  <rect y="157" width="1080" height="2" fill="#e9e2d9"/>
  <path d="M 0 1276 H 1035 V 236 H 914" fill="none" stroke="#ff5423" stroke-width="7" stroke-linejoin="miter"/>
  <text x="${x}" y="${y}" dominant-baseline="hanging" fill="#ff5423" stroke="#fffdf9" stroke-width="${Math.round(fontSize * 0.11)}" stroke-linejoin="round" paint-order="stroke fill" font-family="Arial Black, Noto Sans CJK TC, PingFang TC, sans-serif" font-size="${fontSize}" font-weight="900" letter-spacing="-2" filter="url(#title-shadow)">${textLines}</text>
</svg>`.trim();
}

