// archiver v8 (ESM, sans export par défaut) : classes par format.
// Déclaration minimale limitée à l'usage du projet (export-shapefile.ts).
declare module "archiver" {
  import { Transform } from "stream";

  interface ZipOptions {
    zlib?: { level?: number };
    store?: boolean;
    comment?: string;
  }

  class Archiver extends Transform {
    append(source: Buffer | string, data: { name: string }): this;
    finalize(): Promise<void>;
  }

  class ZipArchive extends Archiver {
    constructor(options?: ZipOptions);
  }
  class TarArchive extends Archiver {
    constructor(options?: object);
  }
  class JsonArchive extends Archiver {
    constructor(options?: object);
  }

  export { Archiver, ZipArchive, TarArchive, JsonArchive };
}
