export interface ImageDimensions {
    width: number;
    height: number;
}
/** Read dimensions without decoding or resampling the original image bytes. */
export declare function imageDimensions(data: Buffer, mimeType: string): ImageDimensions | undefined;
//# sourceMappingURL=ImageMetadata.d.ts.map