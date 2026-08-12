declare module "shapefile" {
  interface Source {
    read(): Promise<{ done: boolean; value: unknown }>;
  }
  function open(shp: ArrayBuffer, dbf?: ArrayBuffer): Promise<Source>;
  function openDbf(
    dbf: ArrayBuffer | Buffer,
    options?: { encoding?: string },
  ): Promise<Source>;
  function read(
    shp: ArrayBuffer | Buffer,
    dbf?: ArrayBuffer | Buffer,
    options?: { encoding?: string },
  ): Promise<GeoJSON.FeatureCollection>;
}
