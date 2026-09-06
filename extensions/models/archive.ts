/**
 * Safely extract local archive files into a newly created directory.
 *
 * @module
 */
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "npm:zod@4";
import { UntarStream } from "jsr:@std/tar@0.1.10";
import { Reader, ZipReader } from "jsr:@zip-js/zip-js@2.11.1";

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "must be an absolute path",
});

const GlobalArgsSchema = z.object({
  sourceArchives: z.array(AbsolutePathSchema).min(1).describe(
    "Absolute paths of .tar, .tar.gz, .tgz, or .zip files to extract in order.",
  ),
  destinationDirectory: AbsolutePathSchema.describe(
    "New absolute destination directory. It must not already exist.",
  ),
});

const SummarySchema = z.object({
  sourceArchives: z.array(z.string()),
  destinationDirectory: z.string(),
  archiveCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  directoryCount: z.number().int().nonnegative(),
  uncompressedBytes: z.number().int().nonnegative(),
  completedAt: z.iso.datetime(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type ArchiveFormat = "tar" | "zip";

interface ExtractionSummary {
  sourceArchives: string[];
  destinationDirectory: string;
  archiveCount: number;
  fileCount: number;
  directoryCount: number;
  uncompressedBytes: number;
  completedAt: string;
}

/** Random-access ZIP reader backed by a Deno file without buffering the archive. */
class DenoFileReader extends Reader<Deno.FsFile> {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: Deno.FsFile) {
    super(file);
  }

  override async init(): Promise<void> {
    await super.init?.();
    this.size = (await this.file.stat()).size;
  }

  override readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const result = this.#queue.then(async () => {
      await this.file.seek(index, Deno.SeekMode.Start);
      const output = new Uint8Array(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const count = await this.file.read(output.subarray(bytesRead));
        if (count === null) return output.subarray(0, bytesRead);
        bytesRead += count;
      }
      return output;
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

interface ExtractionCounters {
  members: Map<string, "file" | "directory">;
  fileCount: number;
  directoryCount: number;
  uncompressedBytes: number;
}

const PAX_HEADER_MAX_BYTES = 1024 * 1024;

/** Read a small tar metadata entry without accepting an unbounded allocation. */
async function readMetadataEntry(
  readable: ReadableStream<Uint8Array> | undefined,
  path: string,
): Promise<string> {
  if (!readable) {
    throw new Error(`Archive metadata member ${path} has no content`);
  }
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > PAX_HEADER_MAX_BYTES) {
        throw new Error(
          `Archive metadata member ${path} exceeds ${PAX_HEADER_MAX_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Parse POSIX PAX records ("<length> <key>=<value>\\n"). */
function parsePaxAttributes(
  content: string,
  memberPath: string,
): Map<string, string> {
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(" ", offset);
    if (space === -1) throw new Error(`Invalid PAX header in ${memberPath}`);
    const length = Number.parseInt(content.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1) {
      throw new Error(`Invalid PAX record length in ${memberPath}`);
    }
    const end = offset + length;
    if (end > content.length || content[end - 1] !== "\n") {
      throw new Error(`Invalid PAX record boundary in ${memberPath}`);
    }
    const record = content.slice(space + 1, end - 1);
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error(`Invalid PAX record in ${memberPath}`);
    attributes.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return attributes;
}

function archiveFormat(path: string): ArchiveFormat {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".zip")) return "zip";
  if (
    lowerPath.endsWith(".tar") || lowerPath.endsWith(".tgz") ||
    lowerPath.endsWith(".tar.gz")
  ) return "tar";
  throw new Error(
    `Unsupported archive format for ${path}; expected .tar, .tar.gz, .tgz, or .zip`,
  );
}

/** Validate one archive member path before it is written to disk. */
export function assertSafeArchivePath(path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("Archive contains an empty or NUL-containing member path");
  }
  if (path.includes("\\")) {
    throw new Error(`Archive member uses unsupported backslashes: ${path}`);
  }
  if (path.startsWith("/")) {
    throw new Error(`Archive member uses an absolute path: ${path}`);
  }
  const components = path.split("/").filter((component) => component !== "");
  if (components.length === 0 || components.some((part) => part === "..")) {
    throw new Error(`Archive member escapes its destination: ${path}`);
  }
  return components.filter((part) => part !== ".").join("/");
}

function outputPath(destinationDirectory: string, archivePath: string): string {
  const safePath = assertSafeArchivePath(archivePath);
  const output = resolve(destinationDirectory, safePath);
  const outputRelativePath = relative(destinationDirectory, output);
  if (
    outputRelativePath === "" || outputRelativePath === ".." ||
    outputRelativePath.startsWith(`..${"/"}`) || isAbsolute(outputRelativePath)
  ) {
    throw new Error(`Archive member escapes its destination: ${archivePath}`);
  }
  return output;
}

function recordMember(
  counters: ExtractionCounters,
  archivePath: string,
  kind: "file" | "directory",
  size: number,
): void {
  const path = assertSafeArchivePath(archivePath);
  const existing = counters.members.get(path);
  if (existing && (existing !== "directory" || kind !== "directory")) {
    throw new Error(`Archive members conflict at ${path}`);
  }
  if (existing) return;
  counters.members.set(path, kind);
  if (kind === "file") {
    counters.fileCount++;
    counters.uncompressedBytes += size;
  } else {
    counters.directoryCount++;
  }
}

async function extractTarArchive(
  sourceArchive: string,
  destinationDirectory: string,
  counters: ExtractionCounters,
): Promise<void> {
  // The readable stream owns this file and closes it when it is consumed or cancelled.
  const source = await Deno.open(sourceArchive, { read: true });
  const compressed = sourceArchive.toLowerCase().endsWith(".tgz") ||
    sourceArchive.toLowerCase().endsWith(".tar.gz");
  const archiveStream = compressed
    ? source.readable.pipeThrough(new DecompressionStream("gzip"))
    : source.readable;
  let pendingPath: string | undefined;
  for await (const entry of archiveStream.pipeThrough(new UntarStream())) {
    if (entry.header.typeflag === "x") {
      const attributes = parsePaxAttributes(
        await readMetadataEntry(entry.readable, entry.path),
        entry.path,
      );
      pendingPath = attributes.get("path") ?? pendingPath;
      continue;
    }
    if (entry.header.typeflag === "L") {
      pendingPath = (await readMetadataEntry(entry.readable, entry.path))
        .replace(/\0.*$/, "");
      continue;
    }
    const kind = entry.header.typeflag === "5"
      ? "directory"
      : entry.header.typeflag === "" || entry.header.typeflag === "0"
      ? "file"
      : undefined;
    if (!kind) {
      throw new Error(
        `Archive ${sourceArchive} contains unsupported type ${entry.header.typeflag} member ${entry.path}`,
      );
    }
    const archivePath = pendingPath ?? entry.path;
    pendingPath = undefined;
    recordMember(counters, archivePath, kind, entry.header.size);
    const target = outputPath(destinationDirectory, archivePath);
    if (kind === "directory") {
      await Deno.mkdir(target, { recursive: true, mode: 0o750 });
      continue;
    }
    if (!entry.readable) {
      throw new Error(
        `Archive ${sourceArchive} has no content for ${archivePath}`,
      );
    }
    await Deno.mkdir(dirname(target), { recursive: true, mode: 0o750 });
    const output = await Deno.open(target, {
      write: true,
      createNew: true,
      mode: 0o640,
    });
    await entry.readable.pipeTo(output.writable);
  }
}

async function extractZipArchive(
  sourceArchive: string,
  destinationDirectory: string,
  counters: ExtractionCounters,
): Promise<void> {
  const source = await Deno.open(sourceArchive, { read: true });
  const reader = new ZipReader(new DenoFileReader(source), {
    strictness: "strict",
  });
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (entry.encrypted) {
        throw new Error(
          `Archive ${sourceArchive} contains encrypted member ${entry.filename}`,
        );
      }
      const kind = entry.directory ? "directory" : "file";
      recordMember(counters, entry.filename, kind, entry.uncompressedSize);
      const target = outputPath(destinationDirectory, entry.filename);
      if (entry.directory) {
        await Deno.mkdir(target, { recursive: true, mode: 0o750 });
        continue;
      }
      await Deno.mkdir(dirname(target), { recursive: true, mode: 0o750 });
      const output = await Deno.open(target, {
        write: true,
        createNew: true,
        mode: 0o640,
      });
      await entry.getData(output.writable);
    }
  } finally {
    try {
      await reader.close();
    } finally {
      source.close();
    }
  }
}

async function extractOneArchive(
  sourceArchive: string,
  destinationDirectory: string,
  counters: ExtractionCounters,
): Promise<void> {
  if (archiveFormat(sourceArchive) === "tar") {
    await extractTarArchive(sourceArchive, destinationDirectory, counters);
  } else {
    await extractZipArchive(sourceArchive, destinationDirectory, counters);
  }
}

async function assertRegularFile(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Archive does not exist: ${path}`);
    }
    throw error;
  }
  if (!info.isFile || info.isSymlink) {
    throw new Error(`Archive must be a regular file: ${path}`);
  }
}

async function assertNewDestination(
  destinationDirectory: string,
): Promise<void> {
  try {
    await Deno.lstat(destinationDirectory);
    throw new Error(`Destination already exists: ${destinationDirectory}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

/** Extract source archives atomically into a new destination directory. */
export async function extractArchives(
  sourceArchives: string[],
  destinationDirectory: string,
): Promise<ExtractionSummary> {
  if (new Set(sourceArchives).size !== sourceArchives.length) {
    throw new Error(
      "sourceArchives must not contain the same path more than once",
    );
  }
  await Promise.all(sourceArchives.map(assertRegularFile));
  await assertNewDestination(destinationDirectory);

  const parentDirectory = dirname(destinationDirectory);
  const destinationName = basename(destinationDirectory);
  const stagingDirectory = join(
    parentDirectory,
    `.${destinationName}.extracting-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(stagingDirectory, { mode: 0o750 });
  const counters: ExtractionCounters = {
    members: new Map(),
    fileCount: 0,
    directoryCount: 0,
    uncompressedBytes: 0,
  };
  try {
    for (const sourceArchive of sourceArchives) {
      await extractOneArchive(sourceArchive, stagingDirectory, counters);
    }
    await Deno.rename(stagingDirectory, destinationDirectory);
  } catch (error) {
    await Deno.remove(stagingDirectory, { recursive: true }).catch(() =>
      undefined
    );
    throw error;
  }

  return {
    sourceArchives,
    destinationDirectory,
    archiveCount: sourceArchives.length,
    fileCount: counters.fileCount,
    directoryCount: counters.directoryCount,
    uncompressedBytes: counters.uncompressedBytes,
    completedAt: new Date().toISOString(),
  };
}

/** Local archive extraction model. */
export const model = {
  type: "@dieter/archive",
  version: "2026.09.06.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.06.2",
      description:
        "Support POSIX PAX tar metadata; global arguments are unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    summary: {
      description: "Summary of a completed archive extraction",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    extract: {
      description:
        "Extract configured archives into a new destination directory",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (
              message: string,
              properties?: Record<string, unknown>,
            ) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: ExtractionSummary,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info(
          "Extracting {count} archive(s) into {destination}",
          {
            count: context.globalArgs.sourceArchives.length,
            destination: context.globalArgs.destinationDirectory,
          },
        );
        const summary = await extractArchives(
          context.globalArgs.sourceArchives,
          context.globalArgs.destinationDirectory,
        );
        const handle = await context.writeResource(
          "summary",
          "extract-summary",
          summary,
        );
        context.logger.info("Extracted {files} file(s) into {destination}", {
          files: summary.fileCount,
          destination: summary.destinationDirectory,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
