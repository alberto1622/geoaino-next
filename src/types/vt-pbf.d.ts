declare module "vt-pbf" {
  /** Sérialise une (ou plusieurs) couche(s) issue(s) de geojson-vt en MVT (protobuf). */
  export function fromGeojsonVt(
    layers: Record<string, unknown>,
    options?: { version?: number; extent?: number },
  ): Uint8Array;

  const vtpbf: {
    fromGeojsonVt: typeof fromGeojsonVt;
  };
  export default vtpbf;
}
