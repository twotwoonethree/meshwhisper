declare module 'lz4js' {
  /** Compress data into an LZ4 frame. */
  function compress(src: Uint8Array, maxSize?: number): Uint8Array;
  /** Decompress an LZ4 frame. */
  function decompress(src: Uint8Array, maxSize?: number): Uint8Array;
  /** Calculate the maximum compressed size for a given input length. */
  function compressBound(inputSize: number): number;
  /** Calculate the decompressed size from an LZ4 frame header. */
  function decompressBound(src: Uint8Array): number;
  /** Create a buffer of the given size. */
  function makeBuffer(size: number): Uint8Array;
  /** Compress a single block (low-level). */
  function compressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    hashTable: Uint32Array,
  ): number;
  /** Decompress a single block (low-level). */
  function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ): number;
  /** Compress data into an LZ4 frame (low-level, writes into dst). */
  function compressFrame(src: Uint8Array, dst: Uint8Array): number;
  /** Decompress an LZ4 frame (low-level, writes into dst). */
  function decompressFrame(src: Uint8Array, dst: Uint8Array): number;

  export {
    compress,
    decompress,
    compressBound,
    decompressBound,
    makeBuffer,
    compressBlock,
    decompressBlock,
    compressFrame,
    decompressFrame,
  };

  const lz4: {
    compress: typeof compress;
    decompress: typeof decompress;
    compressBound: typeof compressBound;
    decompressBound: typeof decompressBound;
    makeBuffer: typeof makeBuffer;
    compressBlock: typeof compressBlock;
    decompressBlock: typeof decompressBlock;
    compressFrame: typeof compressFrame;
    decompressFrame: typeof decompressFrame;
  };

  export default lz4;
}
