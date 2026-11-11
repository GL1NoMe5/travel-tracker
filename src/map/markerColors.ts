export interface MarkerColors {
  visited: string;
  wishlist: string;
}

export const DEFAULT_MARKER_COLORS: MarkerColors = {
  visited: '#B9492F',
  wishlist: '#8655BF',
};

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map(offset => {
    const component = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Choose the more legible icon/edge for a validated six-digit user color. */
export function markerForeground(color: string): '#FFFFFF' | '#172026' {
  const lightness = luminance(color);
  const whiteContrast = 1.05 / (lightness + 0.05);
  const darkContrast = (lightness + 0.05) / (luminance('#172026') + 0.05);
  return whiteContrast >= darkContrast ? '#FFFFFF' : '#172026';
}
