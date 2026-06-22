declare module "shapefile" {
  interface Source {
    read(): Promise<{ done: boolean; value: unknown }>;
  }
  function open(shp: ArrayBuffer, dbf?: ArrayBuffer): Promise<Source>;
}
