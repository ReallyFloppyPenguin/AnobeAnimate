declare module 'gifenc' {
  type Palette = number[][];
  type Format = 'rgb565' | 'rgb444' | 'rgba4444';
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, max: number, o?: { format?: Format; oneBitAlpha?: boolean | number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, w: number, h: number, o?: { palette?: Palette; delay?: number; transparent?: boolean; transparentIndex?: number; repeat?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
