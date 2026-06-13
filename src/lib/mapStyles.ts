export const paletteColors = [
  '#f4512c',
  '#3cdc8c',
  '#3b82f6',
  '#f59e0b',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
]

export const traceColor = (index: number): string =>
  paletteColors[index % paletteColors.length]

export const coloredMarkerDataUri = (color: string): string => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58">
      <path fill="rgba(14, 23, 35, 0.25)" d="M24 58c6.5 0 11.8-1.5 11.8-3.4S30.5 51.2 24 51.2 12.2 52.8 12.2 54.6 17.5 58 24 58Z"/>
      <path fill="${color}" stroke="#fff" stroke-width="3" d="M24 3C13.5 3 5 11.3 5 21.6 5 36.3 24 54 24 54s19-17.7 19-32.4C43 11.3 34.5 3 24 3Z"/>
      <circle cx="24" cy="22" r="9" fill="rgba(255,255,255,0.96)"/>
    </svg>
  `
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}
