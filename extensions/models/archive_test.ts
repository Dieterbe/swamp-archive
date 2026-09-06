import { basename, join } from "node:path";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10";
import { assertSafeArchivePath, extractArchives } from "./archive.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${actual} !== ${expected}`,
  );
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16(bytes, offset, value & 0xffff);
  writeUint16(bytes, offset + 2, value >>> 16);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Create a minimal, uncompressed single-file ZIP fixture. */
function createStoredZip(path: string, content: string): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(path);
  const data = encoder.encode(content);
  const checksum = crc32(data);
  const local = new Uint8Array(30 + name.length + data.length);
  writeUint32(local, 0, 0x04034b50);
  writeUint16(local, 4, 20);
  writeUint32(local, 14, checksum);
  writeUint32(local, 18, data.length);
  writeUint32(local, 22, data.length);
  writeUint16(local, 26, name.length);
  local.set(name, 30);
  local.set(data, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  writeUint32(central, 0, 0x02014b50);
  writeUint16(central, 4, 20);
  writeUint16(central, 6, 20);
  writeUint32(central, 16, checksum);
  writeUint32(central, 20, data.length);
  writeUint32(central, 24, data.length);
  writeUint16(central, 28, name.length);
  central.set(name, 46);

  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 8, 1);
  writeUint16(end, 10, 1);
  writeUint32(end, 12, central.length);
  writeUint32(end, 16, local.length);

  const result = new Uint8Array(local.length + central.length + end.length);
  result.set(local);
  result.set(central, local.length);
  result.set(end, local.length + central.length);
  return result;
}

async function writeTarGz(
  path: string,
  filePath: string,
  content: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  const inputs: TarStreamInput[] = [
    {
      type: "file",
      path: filePath,
      size: bytes.length,
      readable: new Blob([bytes]).stream(),
    },
  ];
  const destination = await Deno.create(path);
  await ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(destination.writable);
}

function writeTarText(
  bytes: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  bytes.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function tarHeader(path: string, typeflag: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTarText(header, 0, 100, path);
  writeTarText(header, 100, 8, "0000644\0");
  writeTarText(header, 108, 8, "0000000\0");
  writeTarText(header, 116, 8, "0000000\0");
  writeTarText(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeTarText(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function paxRecord(key: string, value: string): string {
  let record = ` ${key}=${value}\n`;
  while (true) {
    const withLength = `${
      new TextEncoder().encode(record).length + String(record.length).length
    }${record}`;
    if (
      new TextEncoder().encode(withLength).length ===
        Number.parseInt(withLength, 10)
    ) return withLength;
    record = ` ${key}=${value}\n`;
  }
}

/** Create a minimal tar.gz fixture with a PAX path header before one file. */
async function writePaxTarGz(
  path: string,
  filePath: string,
  content: string,
): Promise<void> {
  const encoder = new TextEncoder();
  const pax = encoder.encode(paxRecord("path", filePath));
  const data = encoder.encode(content);
  const pad = (size: number) => new Uint8Array((512 - (size % 512)) % 512);
  const parts = [
    tarHeader("PaxHeaders.X/metadata", "x", pax.length),
    pax,
    pad(pax.length),
    tarHeader("truncated-name", "0", data.length),
    data,
    pad(data.length),
    new Uint8Array(1024),
  ];
  const length = parts.reduce((total, part) => total + part.length, 0);
  const tar = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  const destination = await Deno.create(path);
  await new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))
    .pipeTo(destination.writable);
}

Deno.test("assertSafeArchivePath rejects traversal and absolute paths", () => {
  assertEquals(
    assertSafeArchivePath("photos/one.jpg"),
    "photos/one.jpg",
    "safe path retained",
  );
  for (const unsafePath of ["../one.jpg", "/one.jpg", "photos\\one.jpg", ""]) {
    let rejected = false;
    try {
      assertSafeArchivePath(unsafePath);
    } catch {
      rejected = true;
    }
    assert(rejected, `unsafe path was accepted: ${unsafePath}`);
  }
});

Deno.test("extractArchives extracts a tar.gz archive into a new destination", async () => {
  const directory = await Deno.makeTempDir({ prefix: "swamp-archive-test-" });
  try {
    const archive = join(directory, "photos.tgz");
    const destination = join(directory, "extracted");
    await writeTarGz(archive, "Takeout/Google Photos/photo.txt", "Ghent");

    const summary = await extractArchives([archive], destination);

    assertEquals(summary.archiveCount, 1, "archive count");
    assertEquals(summary.fileCount, 1, "file count");
    assertEquals(summary.uncompressedBytes, 5, "uncompressed bytes");
    assertEquals(
      await Deno.readTextFile(
        join(destination, "Takeout/Google Photos/photo.txt"),
      ),
      "Ghent",
      "extracted content",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("extractArchives extracts a ZIP archive without external commands", async () => {
  const directory = await Deno.makeTempDir({ prefix: "swamp-archive-test-" });
  try {
    const archive = join(directory, "photos.zip");
    const destination = join(directory, "extracted");
    await Deno.writeFile(
      archive,
      createStoredZip("Takeout/photo.txt", "Limassol"),
    );

    const summary = await extractArchives([archive], destination);

    assertEquals(summary.fileCount, 1, "file count");
    assertEquals(
      await Deno.readTextFile(join(destination, "Takeout/photo.txt")),
      "Limassol",
      "extracted content",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("extractArchives applies PAX paths without materializing metadata headers", async () => {
  const directory = await Deno.makeTempDir({ prefix: "swamp-archive-test-" });
  try {
    const archive = join(directory, "photos.tgz");
    const destination = join(directory, "extracted");
    await writePaxTarGz(
      archive,
      "Takeout/Google Photos/long photo name.txt",
      "Giannitsa",
    );

    const summary = await extractArchives([archive], destination);

    assertEquals(summary.fileCount, 1, "file count excludes PAX metadata");
    assertEquals(
      await Deno.readTextFile(
        join(destination, "Takeout/Google Photos/long photo name.txt"),
      ),
      "Giannitsa",
      "PAX path content",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("extractArchives rejects unsafe ZIP paths without publishing a destination", async () => {
  const directory = await Deno.makeTempDir({ prefix: "swamp-archive-test-" });
  try {
    const archive = join(directory, "unsafe.zip");
    const destination = join(directory, "extracted");
    await Deno.writeFile(archive, createStoredZip("../escape.txt", "no"));

    await extractArchives([archive], destination).then(
      () => {
        throw new Error("unsafe archive was accepted");
      },
      () => undefined,
    );
    await Deno.lstat(destination).then(
      () => {
        throw new Error(`unsafe archive published ${basename(destination)}`);
      },
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
