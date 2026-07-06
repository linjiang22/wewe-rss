declare module 'qrcode' {
  export function toBuffer(
    text: string,
    options?: {
      type?: 'png';
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
      margin?: number;
      scale?: number;
      width?: number;
    },
  ): Promise<Buffer>;
}
